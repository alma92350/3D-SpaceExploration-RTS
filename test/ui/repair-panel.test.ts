// P2-T15, the repair half — "repair targeting matches `pickRepairTarget`", and the
// `NEEDS_REPAIR`/`HEALED` hysteresis is visible rather than something a player has to infer from
// watching Menders change their minds.

import { describe, expect, it } from "vitest";
import { repairPanelModel } from "../../src/ui/repair-panel.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { HEALED, NEEDS_REPAIR, makeBuilding, makeUnit, pickRepairTarget } from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base, cc };
}

/** A building at a chosen share of max HP. */
function damaged(bridge: WorldBridge, type: string, x: number, y: number, frac: number): Building {
  const b = makeBuilding(type, "player", x, y);
  b.hp = b.maxHp * frac;
  bridge.state.buildings.set(b.id, b);
  return b;
}

function entryFor(model: ReturnType<typeof repairPanelModel>, id: string) {
  return model.entries.find((e) => e.id === id);
}

describe("the repair panel", () => {
  it("reports the engine's own thresholds, so the UI can draw the band instead of describing it", () => {
    const { bridge, base } = world();
    const model = repairPanelModel(bridge.state, "player", base);
    expect(model.needsRepairAt).toBe(NEEDS_REPAIR);
    expect(model.healedAt).toBe(HEALED);
    expect(NEEDS_REPAIR, "the premise of this whole panel is that the two differ").toBeLessThan(HEALED);
  });

  it("names the hysteresis band, where a damaged building is left alone on purpose", () => {
    // The failure this row exists to prevent. A building at 90% is damaged and NOTHING is coming
    // for it, because the engine only attracts a repairer below 85%. One "damaged" state would have
    // the player watching an unrepaired wall and concluding the Menders are broken.
    const { bridge, base } = world();
    const worn = damaged(bridge, "turret", base.x + 60, base.y, 0.9);
    const needy = damaged(bridge, "turret", base.x + 90, base.y, 0.5);
    const model = repairPanelModel(bridge.state, "player", base);

    expect(entryFor(model, worn.id)!.state, "0.9 is inside the band — nothing will come").toBe("worn");
    expect(entryFor(model, needy.id)!.state, "0.5 is below the attract threshold").toBe("needsRepair");
    expect(entryFor(model, worn.id)!.state).not.toBe(entryFor(model, needy.id)!.state);
  });

  it("keeps a committed repair reading as in-progress all the way through the band", () => {
    // The other side of the hysteresis: once a repairer is committed it keeps working until HEALED,
    // through the very band that attracts nobody new. Showing that as "worn" would make an actively
    // repairing Mender look like it had given up.
    const { bridge, base } = world();
    const target = damaged(bridge, "turret", base.x + 60, base.y, 0.9);
    const worker = makeUnit("worker", "player", base.x + 50, base.y);
    worker.order = { type: "repair", targetId: target.id };
    bridge.state.units.set(worker.id, worker);

    const model = repairPanelModel(bridge.state, "player", base);
    expect(entryFor(model, target.id)!.state).toBe("healing");
    expect(entryFor(model, target.id)!.repairers).toBe(1);
    expect(model.activeRepairers).toBe(1);
  });

  it("says outright when something is damaged and nothing will be dispatched", () => {
    const { bridge, base } = world();
    damaged(bridge, "turret", base.x + 60, base.y, 0.92);
    const model = repairPanelModel(bridge.state, "player", base);
    expect(model.entries.length).toBeGreaterThan(0);
    expect(model.nextTargetId, "nothing is eligible inside the band").toBeNull();
    expect(model.nothingWillBeDispatched).toBe(true);
  });

  it("stops saying so the moment something is actually eligible", () => {
    const { bridge, base } = world();
    damaged(bridge, "turret", base.x + 60, base.y, 0.92);
    damaged(bridge, "turret", base.x + 90, base.y, 0.4);
    const model = repairPanelModel(bridge.state, "player", base);
    expect(model.nextTargetId).not.toBeNull();
    expect(model.nothingWillBeDispatched).toBe(false);
  });

  it("marks the target the ENGINE would pick, not the one this module would guess", () => {
    // Most-worn-first with distance breaking ties, zone-first before that. The panel asks
    // `pickRepairTarget` rather than sorting its own list and taking the head, so this asserts the
    // two agree — including when they would not.
    const { bridge, base } = world();
    damaged(bridge, "turret", base.x + 60, base.y, 0.5);
    damaged(bridge, "turret", base.x + 300, base.y, 0.3);
    damaged(bridge, "turret", base.x + 120, base.y, 0.7);

    const model = repairPanelModel(bridge.state, "player", base);
    const engine = pickRepairTarget(bridge.state, "player", base.x, base.y) as { id: string } | null;
    expect(model.nextTargetId, "the panel and the engine disagree about the next repair").toBe(engine!.id);

    const flagged = model.entries.filter((e) => e.isNextTarget);
    expect(flagged.length, "exactly one entry is the next target").toBe(1);
    expect(flagged[0]!.id).toBe(engine!.id);
  });

  it("asks from the repairer's own position, because the answer legitimately differs per Mender", () => {
    // Distance breaks ties between equally worn targets, so "what is repaired next" has no
    // position-free answer. A panel that asked from the base would be confidently wrong for every
    // Mender standing somewhere else.
    const { bridge, base } = world();
    const west = damaged(bridge, "turret", base.x - 300, base.y, 0.5);
    const east = damaged(bridge, "turret", base.x + 300, base.y, 0.5);

    const fromWest = repairPanelModel(bridge.state, "player", { x: base.x - 320, y: base.y });
    const fromEast = repairPanelModel(bridge.state, "player", { x: base.x + 320, y: base.y });
    expect(fromWest.nextTargetId).toBe(west.id);
    expect(fromEast.nextTargetId).toBe(east.id);
  });

  it("never lets a repairer pick itself", () => {
    const { bridge, base } = world();
    const mender = makeUnit("mender", "player", base.x + 40, base.y);
    mender.hp = mender.maxHp * 0.4;
    bridge.state.units.set(mender.id, mender);

    const model = repairPanelModel(bridge.state, "player", mender, mender.id);
    expect(entryFor(model, mender.id), "a wounded Mender is still listed").toBeDefined();
    expect(model.nextTargetId, "…but it is not its own next target").not.toBe(mender.id);
  });

  it("lists wounded units as well as buildings, because the engine repairs both", () => {
    const { bridge, base } = world();
    const skiff = makeUnit("skiff", "player", base.x + 40, base.y);
    skiff.hp = skiff.maxHp * 0.4;
    bridge.state.units.set(skiff.id, skiff);

    const model = repairPanelModel(bridge.state, "player", base);
    const e = entryFor(model, skiff.id)!;
    expect(e.kind).toBe("unit");
    expect(e.state).toBe("needsRepair");
  });

  it("ignores buildings under construction, which are not damaged, only unfinished", () => {
    // `pickRepairTarget` skips them explicitly. A shell at 20% hp listed as "needs repair" would
    // put the whole opening of a match at the top of the panel.
    const { bridge, base } = world();
    const shell = makeBuilding("turret", "player", base.x + 60, base.y, { constructing: true });
    shell.hp = shell.maxHp * 0.2;
    bridge.state.buildings.set(shell.id, shell);

    const model = repairPanelModel(bridge.state, "player", base);
    expect(entryFor(model, shell.id)).toBeUndefined();
    expect(model.nextTargetId).toBeNull();
  });

  it("does not write to the simulation, which the engine's own counter does", () => {
    // `countRepairJobs` looks exactly like the query this panel wants and it is a MUTATOR: it
    // writes a `repairers` tally onto every building and unit. Calling it here would be the view
    // writing sim state on a frame (ADR-0008) — a determinism bug visible only while a panel
    // happened to be open. Same trap as `countLogistics` in P2-T13, which is why this is asserted
    // rather than merely commented.
    const { bridge, base } = world();
    const target = damaged(bridge, "turret", base.x + 60, base.y, 0.5);
    const worker = makeUnit("worker", "player", base.x + 50, base.y);
    worker.order = { type: "repair", targetId: target.id };
    bridge.state.units.set(worker.id, worker);

    const touched = () => [...bridge.state.buildings.values(), ...bridge.state.units.values()]
      .map((e) => (e as { repairers?: number }).repairers);
    const before = touched();
    const model = repairPanelModel(bridge.state, "player", base);

    expect(model.activeRepairers, "the count still has to be right").toBe(1);
    expect(touched(), "the panel wrote `repairers` onto sim entities").toEqual(before);
    expect(
      (bridge.state.buildings.get(target.id) as { repairers?: number }).repairers,
      "reading a panel must not stamp a tally the engine owns",
    ).toBeUndefined();
  });

  it("orders most-worn first, breaking ties on id rather than on Map order", () => {
    const { bridge, base } = world();
    damaged(bridge, "turret", base.x + 60, base.y, 0.8);
    damaged(bridge, "turret", base.x + 90, base.y, 0.3);
    damaged(bridge, "turret", base.x + 120, base.y, 0.55);

    const fractions = repairPanelModel(bridge.state, "player", base).entries.map((e) => e.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  it("is empty and calm when nothing has fallen past the engine's release point", () => {
    const { bridge, base } = world();
    const model = repairPanelModel(bridge.state, "player", base);
    expect(model.entries).toEqual([]);
    expect(model.nextTargetId).toBeNull();
    // Crucially NOT true: there is nothing to dispatch to, which is different from "something needs
    // help and none is coming".
    expect(model.nothingWillBeDispatched).toBe(false);
  });

  it("does not list every building in the game, which `hp < maxHp` alone would", () => {
    // The finding that shaped the filter. Odyssey structures WEAR OUT — `updateDecay` sheds 0.06%
    // of max HP per second from every completed building — so `hp < maxHp` is true for a player's
    // entire base, permanently, from the first second. A panel filtering on "damaged" would be a
    // list of everything they own and would mean nothing.
    const { bridge, base, cc } = world();
    for (let i = 0; i < 40; i++) bridge.step(STEP_SECONDS);

    const live = bridge.state.buildings.get(cc.id)!;
    expect(live.hp, "decay should have nicked the Command Center").toBeLessThan(live.maxHp);
    expect(live.hp / live.maxHp, "…but nowhere near the release point yet").toBeGreaterThan(HEALED);
    expect(repairPanelModel(bridge.state, "player", base).entries).toEqual([]);
  });

  it("picks a building up once decay alone carries it past the release point", () => {
    // The other half: the filter is the ENGINE's release point, not an arbitrary tidiness cutoff,
    // so a building that decays through it does appear — as `worn`, with nothing coming, which is
    // the state this panel was built to explain.
    const { bridge, base } = world();
    const b = damaged(bridge, "turret", base.x + 60, base.y, HEALED - 0.001);
    const e = entryFor(repairPanelModel(bridge.state, "player", base), b.id)!;
    expect(e.state).toBe("worn");
    expect(e.isNextTarget).toBe(false);
  });
});
