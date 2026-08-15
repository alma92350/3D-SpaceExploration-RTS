// P4-T14 — the build menu offers what the engine allows, not a hand-written list.
//
// Found by asking a plain question: what can a player actually build today? The answer was **five
// buildings of twenty-nine and five units of eighteen**, because `MVP_BUILDINGS` was a Phase 1
// constant that Phase 2 never widened — while Phase 2 shipped meshes, panel models and economy
// logic for all 29 types.
//
// The damage compounds through the tech tree rather than stopping at the menu: Foundry, Arsenal,
// Spaceport and Star Dock were all unbuildable, so **exactly one of ADR-0016's nine new
// silhouettes was reachable in a real game** — an ADR argued from a measurement, defended by a
// perf gate, and delivering one unit a player could ever see.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { MVP_BUILDINGS, hudModel } from "../../src/ui/hud.js";
import { BUILDINGS, UNITS, makeBuilding, makeUnit, prereqsMet } from "../../src/engine/index.js";

const SEED = 20260814;

/** A base with a worker selected, so the build menu has a builder to answer for. */
function withWorker() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  const w = makeUnit("worker", "player", base.x + 30, base.y);
  bridge.state.units.set(w.id, w);
  bridge.step(STEP_SECONDS);
  bridge.enqueue({ kind: "select", ids: [w.id], additive: false });
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

function menu(bridge: WorldBridge): string[] {
  return hudModel(bridge.snapshot, bridge.state).builds.map((b) => b.buildingType);
}

describe("the build menu is the engine's answer (P4-T14)", () => {
  it("offers every type whose prerequisites the engine says are met", () => {
    // Not "offers more than five" — offers exactly what `prereqsMet` allows for this builder. A
    // menu that merely grew would pass a count assertion while being wrong about which.
    const { bridge } = withWorker();
    const offered = new Set(menu(bridge));
    const worker = UNITS.worker!;
    expect(worker.buildCategories?.length, "the premise: a Worker builds something").toBeGreaterThan(0);

    for (const type of Object.keys(BUILDINGS)) {
      const def = BUILDINGS[type]!;
      const buildable = def.category !== undefined
        && (worker.buildCategories as string[]).includes(def.category)
        && prereqsMet(bridge.state, "player", def);
      expect(offered.has(type), `${type}: engine says ${buildable}, menu says ${offered.has(type)}`)
        .toBe(buildable);
    }
  });

  it("opens the tech tree that the old fixed list sealed shut", () => {
    // The four buildings the hardcoded menu made unreachable, and with them most of the roster.
    // Each is asserted to appear once its own prerequisite stands — not merely to exist.
    const { bridge, base } = withWorker();
    expect(menu(bridge), "a Foundry needs only a Barracks and was never offered").not.toContain("foundry");

    const barracks = makeBuilding("barracks", "player", base.x + 80, base.y);
    barracks.constructing = false;
    bridge.state.buildings.set(barracks.id, barracks);
    bridge.step(STEP_SECONDS);
    expect(menu(bridge), "a finished Barracks did not unlock the Foundry").toContain("foundry");

    const foundry = makeBuilding("foundry", "player", base.x + 120, base.y);
    foundry.constructing = false;
    bridge.state.buildings.set(foundry.id, foundry);
    bridge.step(STEP_SECONDS);
    const after = menu(bridge);
    expect(after, "a finished Foundry did not unlock the Arsenal").toContain("arsenal");
    expect(after, "a finished Foundry did not unlock the Spaceport").toContain("spaceport");
  });

  it("does not offer a building whose prerequisite is still under construction", () => {
    // `prereqsMet` requires `!b.constructing`, and this is the case a snapshot-only menu would get
    // wrong: the shell is on the map and visible, and the engine still refuses.
    const { bridge, base } = withWorker();
    const shell = makeBuilding("barracks", "player", base.x + 80, base.y);
    // `makeBuilding` hands back a FINISHED building, so flipping `constructing` alone is not a
    // half-built one — `buildProgress` is already 1 and the very next tick completes it. The first
    // draft of this test did exactly that and failed, correctly, against working code.
    shell.constructing = true;
    shell.buildProgress = 0.1;
    bridge.state.buildings.set(shell.id, shell);
    bridge.step(STEP_SECONDS);
    expect(menu(bridge), "a half-built Barracks unlocked the Foundry").not.toContain("foundry");
  });

  it("offers nothing when the selection cannot build at all", () => {
    // A Colony Ship is not a builder. Selecting one must empty the menu rather than inherit the
    // last builder's — which is the only builder-shaped behaviour this roster can actually exhibit;
    // see the next test for why.
    const { bridge } = withWorker();
    const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship")!;
    expect(UNITS.colonyship!.buildCategories ?? [], "the premise: a Colony Ship builds nothing")
      .toHaveLength(0);
    bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    bridge.step(STEP_SECONDS);
    expect(menu(bridge), "a non-builder was offered a build menu").toEqual([]);
  });

  it("records that `canBuildType` cannot discriminate on today's roster", () => {
    // **An admission, kept as a test.** Mutation-testing this file found that deleting the
    // `canBuildType` filter entirely changed nothing — and the reason is the data, not the code:
    // the Worker is the ONLY unit with `buildCategories`, and it carries all three that exist. So
    // the filter is inert today and a test claiming it discriminates would be theatre.
    //
    // It is kept in `buildableTypes` anyway, because it is the engine's own rule and it binds the
    // day a second builder appears — and this test is what will notice that day, by failing.
    const builders = Object.keys(UNITS).filter((u) => UNITS[u]!.buildCategories?.length);
    expect(builders, "a second builder type exists — `canBuildType` now discriminates, so assert it")
      .toEqual(["worker"]);
    const categories = new Set(Object.values(BUILDINGS).map((b) => b.category));
    expect([...(UNITS.worker!.buildCategories as string[])].sort(),
      "the Worker no longer covers every category — the filter now bites, so assert what it removes")
      .toEqual([...categories].sort());
  });

  it("filters on prerequisites but NOT on affordability", () => {
    // A building you cannot pay for yet is a plan; one whose Foundry you have not built is not a
    // decision at all. Greying the first and hiding the second is the whole rule.
    const { bridge } = withWorker();
    bridge.state.players.player.resources.ore = 0;
    bridge.step(STEP_SECONDS);
    const model = hudModel(bridge.snapshot, bridge.state);
    expect(model.builds.length, "a broke player was shown an empty menu").toBeGreaterThan(0);
    expect(model.builds.every((b) => !b.affordable), "nothing should read as affordable at 0 ore").toBe(true);
  });

  it("falls back to the Phase 1 subset when no state is passed", () => {
    // `hudModel(snap)` still has callers, and they must keep working rather than lose their menu.
    const { bridge } = withWorker();
    expect(hudModel(bridge.snapshot).builds.map((b) => b.buildingType)).toEqual([...MVP_BUILDINGS]);
  });
});

describe("what this actually unlocks (P4-T14)", () => {
  it("puts ADR-0016's nine silhouettes within a player's reach", () => {
    // The measurement that made this a row rather than a nicety. With the fixed menu, one of the
    // nine units ADR-0016 argued for could ever be built. This asserts the producers are now
    // reachable — the units themselves still need the ore, which is a game, not a gate.
    const { bridge, base } = withWorker();
    for (const [type, at] of [["barracks", 80], ["foundry", 120], ["arsenal", 160], ["spaceport", 200]] as const) {
      const b = makeBuilding(type, "player", base.x + at, base.y + 60);
      b.constructing = false;
      bridge.state.buildings.set(b.id, b);
    }
    bridge.step(STEP_SECONDS);

    const built = new Set([...bridge.state.buildings.values()].filter((b) => !b.constructing).map((b) => b.type));
    const NINE = ["ranger", "wraith", "mender", "breacher", "aegis", "colossus", "dreadnought"];
    for (const u of NINE) {
      const unmet = (UNITS[u]!.requires ?? []).filter((r) => BUILDINGS[r] && !built.has(r));
      expect(unmet, `${UNITS[u]!.name} still needs ${unmet.join(", ")}`).toEqual([]);
    }
    // The two Star Dock units are honestly still further away: it needs an AI Foundry AND a Torpedo
    // Works, which is a real tech investment rather than a menu bug. Recorded, not asserted away.
    expect((BUILDINGS.stardock!.requires ?? []).length,
      "the Star Dock's own gate should stay a real one").toBeGreaterThan(1);
  });
});
