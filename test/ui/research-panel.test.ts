// P2-T11 — the research panel's model (ADR-0012 §4, §5).
//
// Swept over ALL of `TECHS`, not spot-checked, because the failure mode is one node's gating
// drifting from the engine's while the rest look fine — and the player's evidence would be a
// button that does nothing.
//
// The panel does not predict availability. It asks `canResearch`, which is a *dry run* of
// `researchTech`'s own gating rather than a copy of it. `researchTech` checks six things in order:
// the building is a finished Datacenter, the tech is not already researched, not already queued,
// exists, its prerequisites are met (counting ones queued ahead on this same Datacenter), and the
// player can afford it. Re-implementing that list here would be wrong the first time upstream
// edits it — and the prereq rule in particular, where a node queued ahead counts as met, is the
// kind of thing nobody would think to copy.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { researchPanelModel } from "../../src/ui/research-panel.js";
import { TECHS, makeBuilding } from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;

function worldWithDatacenter(): { bridge: WorldBridge; datacenter: Building } {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const datacenter = makeBuilding("datacenter", "player", 600, 600);
  bridge.state.buildings.set(datacenter.id, datacenter);
  bridge.step(STEP_SECONDS);
  return { bridge, datacenter };
}

/** What `researchTech` would say, on a throwaway copy of the things it inspects. */
function engineWouldAllow(bridge: WorldBridge, datacenter: Building, techId: string): boolean {
  const res = bridge.state.players.player.resources;
  const saved = { ...res };
  const savedQueue = [...(datacenter.researchQueue ?? [])];
  const allowed = bridge.apply({ kind: "research", buildingId: datacenter.id, techId }) === null;
  // Put everything back — this is a probe, not a move.
  for (const k of Object.keys(res)) delete res[k];
  Object.assign(res, saved);
  datacenter.researchQueue = savedQueue;
  return allowed;
}

describe("the research panel", () => {
  it("lists every tech the engine defines", () => {
    const { bridge, datacenter } = worldWithDatacenter();
    const model = researchPanelModel(bridge.state, datacenter.id);
    expect(model.entries.map((e) => e.id).sort()).toEqual(Object.keys(TECHS).sort());
  });

  it("agrees with the engine about every single tech, not just the first one", () => {
    // The sweep. A panel that gets one node's gating wrong shows a button that does nothing, and
    // spot-checking `metallurgy` would never find it.
    const { bridge, datacenter } = worldWithDatacenter();
    const res = bridge.state.players.player.resources;
    res.crystals = 100;                      // enough for some nodes, not all — both cases matter
    res.radioactives = 20;

    const model = researchPanelModel(bridge.state, datacenter.id);
    for (const entry of model.entries) {
      expect(
        entry.canStart,
        `${entry.id}: panel says ${entry.canStart}, engine says ${engineWouldAllow(bridge, datacenter, entry.id)}`,
      ).toBe(engineWouldAllow(bridge, datacenter, entry.id));
    }
  });

  it("separates 'cannot afford' from 'prerequisite missing', because they are different problems", () => {
    const { bridge, datacenter } = worldWithDatacenter();
    const res = bridge.state.players.player.resources;

    // Rich, so anything unavailable is unavailable for a structural reason.
    res.crystals = 100_000;
    res.radioactives = 100_000;
    const rich = researchPanelModel(bridge.state, datacenter.id);
    const gated = rich.entries.find((e) => (TECHS[e.id]!.requires?.length ?? 0) > 0)!;
    expect(gated.blockedBy).toBe("prereq");

    // Broke, so a root node with no prerequisites is blocked only by cost.
    res.crystals = 0;
    res.radioactives = 0;
    const broke = researchPanelModel(bridge.state, datacenter.id);
    const root = broke.entries.find((e) => (TECHS[e.id]!.requires?.length ?? 0) === 0)!;
    expect(root.blockedBy).toBe("cost");
  });

  it("shows what is queued, in order, with progress", () => {
    const { bridge, datacenter } = worldWithDatacenter();
    const res = bridge.state.players.player.resources;
    res.crystals = 100_000;
    res.radioactives = 100_000;

    expect(bridge.apply({ kind: "research", buildingId: datacenter.id, techId: "metallurgy" })).toBeNull();
    // Queued-ahead counts as a met prerequisite — the engine's own rule, and one a panel that
    // re-implemented prereq checking would get wrong.
    expect(bridge.apply({ kind: "research", buildingId: datacenter.id, techId: "heavyalloys" })).toBeNull();

    const model = researchPanelModel(bridge.state, datacenter.id);
    expect(model.queue.map((q) => q.id)).toEqual(["metallurgy", "heavyalloys"]);
    expect(model.queue[0]!.progress).toBeGreaterThanOrEqual(0);
    expect(model.entries.find((e) => e.id === "metallurgy")!.state).toBe("queued");
  });

  it("marks a completed tech as done and offers no button for it", () => {
    const { bridge, datacenter } = worldWithDatacenter();
    bridge.state.players.player.upgrades.metallurgy = true;
    const model = researchPanelModel(bridge.state, datacenter.id);
    const entry = model.entries.find((e) => e.id === "metallurgy")!;
    expect(entry.state).toBe("done");
    expect(entry.canStart).toBe(false);
  });

  it("is empty when the selected building is not a Datacenter", () => {
    // Research happens at a Datacenter and nowhere else (`researchTech` checks the type). A panel
    // that rendered anyway would offer a button the engine silently refuses.
    const { bridge } = worldWithDatacenter();
    const barracks = makeBuilding("barracks", "player", 700, 600);
    bridge.state.buildings.set(barracks.id, barracks);
    expect(researchPanelModel(bridge.state, barracks.id).entries).toEqual([]);
  });
});
