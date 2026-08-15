// P1-T16 / PRD F-07 — the HUD is a pure function of a snapshot, and every number in it is the
// engine's own. Nothing here touches the DOM: that is the point of splitting the model out.

import { describe, expect, it } from "vitest";
import { MVP_BUILDINGS, formatClock, hudModel } from "../../src/ui/hud.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { BUILDINGS, UNITS, prereqsMet, supplyCap, supplyUsed } from "../../src/engine/index.js";

const SEED = 20260814;

function opened(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
  const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
  bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  bridge.enqueue({ kind: "deploy" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

describe("hudModel", () => {
  it("reports the engine's own resource and supply numbers, not a copy that can drift", () => {
    const bridge = opened();
    for (let i = 0; i < 40; i++) bridge.step(STEP_SECONDS);
    const model = hudModel(bridge.snapshot);
    const res = bridge.state.players.player.resources;
    expect(model.ore).toBe(Math.floor(res.ore ?? 0));
    expect(model.crystals).toBe(Math.floor(res.crystals ?? 0));
    expect(model.supplyText).toBe(`${supplyUsed(bridge.state, "player")} / ${supplyCap(bridge.state, "player")}`);
  });

  it("is a pure function — the same snapshot always yields the same model", () => {
    const bridge = opened();
    const a = hudModel(bridge.snapshot);
    const b = hudModel(bridge.snapshot);
    expect(b).toEqual(a);
  });

  it("offers Deploy exactly when a colony ship is selected", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    expect(hudModel(bridge.snapshot).canDeploy).toBe(false);

    const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    bridge.step(STEP_SECONDS);
    expect(hudModel(bridge.snapshot).canDeploy, "S6: the one action available at t=0 must be visible").toBe(true);
  });

  it("tells a first-time player what to do, and stops once they have a base (S6)", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    expect(hudModel(bridge.snapshot).prompt).toMatch(/colony ship/i);

    const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    bridge.step(STEP_SECONDS);
    expect(hudModel(bridge.snapshot).prompt, "once the ship is selected, name the action").toMatch(/deploy/i);

    bridge.enqueue({ kind: "deploy" });
    bridge.step(STEP_SECONDS);
    expect(hudModel(bridge.snapshot).prompt, "a player with a base needs no prompt").toBeNull();
  });

  it("offers the build menu only when a worker is selected", () => {
    const bridge = opened();
    expect(hudModel(bridge.snapshot).builds).toHaveLength(0);

    const worker = [...bridge.state.units.values()].find((u) => u.type === "worker" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    bridge.step(STEP_SECONDS);
    const model = hudModel(bridge.snapshot);
    expect(model.builds.map((b) => b.buildingType)).toEqual([...MVP_BUILDINGS]);
  });

  it("offers a selected building's own production list, and no unit the engine would refuse", () => {
    // **This test used to assert the opposite, and it was wrong (P5-T14 / PARITY row 47.)** It
    // pinned `odysseyOnly` as an exclusion — half of `queueProduction`'s `odysseyOnly && !endless`
    // — so six of eighteen units were hidden from a menu the engine would have accepted them into,
    // *by a test*, which is why nobody found it for four phases. The engine's own verdict is the
    // assertion now, and the sweep that would have caught it lives in `production-menu.test.ts`.
    const bridge = opened();
    const cc = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "command")!;
    bridge.enqueue({ kind: "select", ids: [cc.id], additive: false });
    bridge.step(STEP_SECONDS);

    const model = hudModel(bridge.snapshot, bridge.state);
    expect(model.production.length).toBeGreaterThan(0);
    for (const option of model.production) {
      expect(BUILDINGS.command!.produces).toContain(option.unitType);
      expect(prereqsMet(bridge.state, "player", UNITS[option.unitType]!),
        `${option.unitType} is offered with its prerequisites unmet`).toBe(true);
    }
    expect(model.production.map((p) => p.unitType),
      "this world is endless, so the engine accepts a Colony Ship here").toContain("colonyship");
  });

  it("marks what the player cannot afford without hiding it", () => {
    const bridge = opened();
    bridge.state.players.player.resources.ore = 0;
    const worker = [...bridge.state.units.values()].find((u) => u.type === "worker" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    bridge.step(STEP_SECONDS);

    const model = hudModel(bridge.snapshot);
    expect(model.builds.length).toBeGreaterThan(0);
    // Hiding unaffordable options would leave a new player with an empty menu and no idea why.
    expect(model.builds.every((b) => !b.affordable)).toBe(true);
    expect(model.builds[0]!.costText).toMatch(/ore/);
  });

  it("summarises a mixed selection by type and count", () => {
    const bridge = opened();
    const workers = [...bridge.state.units.values()].filter((u) => u.type === "worker" && u.owner === "player");
    expect(workers.length).toBeGreaterThan(1);
    bridge.enqueue({ kind: "select", ids: workers.map((w) => w.id), additive: false });
    bridge.step(STEP_SECONDS);
    expect(hudModel(bridge.snapshot).selectionSummary).toBe(`${workers.length}× ${UNITS.worker!.name}`);
  });

  it("says so plainly when nothing is selected", () => {
    const bridge = opened();
    expect(hudModel(bridge.snapshot).selectionSummary).toBe("Nothing selected");
    expect(hudModel(bridge.snapshot).selection).toHaveLength(0);
  });

  it("flags a supply block, which is the number a stuck player is looking for", () => {
    const bridge = opened();
    const snap = bridge.snapshot;
    snap.resources.supplyUsed = snap.resources.supplyCap;
    expect(hudModel(snap).supplyBlocked).toBe(true);
    snap.resources.supplyUsed = 0;
    expect(hudModel(snap).supplyBlocked).toBe(false);
  });

  it("drops a selected entity from the panel once it is no longer visible", () => {
    // Selection lives in sim state and can outlive visibility. The panel reads the snapshot, so a
    // unit under fog simply is not there — which is what stops the HUD leaking its health.
    const bridge = opened();
    bridge.snapshot.selection.push("u99999");
    expect(hudModel(bridge.snapshot).selection.map((s) => s.id)).not.toContain("u99999");
  });
});

describe("formatClock", () => {
  it("formats sim seconds as mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(3600)).toBe("60:00");
  });

  it("never renders a negative clock", () => {
    expect(formatClock(-5)).toBe("0:00");
  });
});
