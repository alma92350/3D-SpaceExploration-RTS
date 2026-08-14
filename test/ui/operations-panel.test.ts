// P2-T13/T14/T15 — logistics, supply and the recycle preview (ADR-0012 §4).
//
// Three small models rather than one, because they answer three unrelated questions: "is my
// haulage keeping up?", "can I train anything?", and "what do I get back if I scrap this?".
//
// One constraint shapes the first of them. `countLogistics` looks like the query this panel wants
// and is actually a **mutator**: it walks every unit's order and writes `haulers`/`servers`/
// `ferriers` tallies onto buildings and freighters. Calling it from a panel would have the view
// writing sim state on a frame — the one thing ADR-0008's boundary exists to prevent, and a
// determinism bug that would only appear when a panel happened to be open.
//
// So the logistics model *counts* instead, read-only. Counting an order is observation, not a
// second copy of a rule; `assignHaul`'s decision about which building deserves the next worker
// stays entirely in the engine.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { logisticsModel, recyclePreview, supplyModel } from "../../src/ui/operations-panel.js";
import { LOGI_PRIORITIES, makeBuilding, makeUnit, recycleValue } from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;

function world(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

function addUnit(bridge: WorldBridge, type: string, order?: { type: string; buildingId?: string }): Unit {
  const u = makeUnit(type, "player", 600, 600);
  if (order) u.order = order as unknown as Unit["order"];
  bridge.state.units.set(u.id, u);
  return u;
}

describe("the logistics model", () => {
  it("counts haul, service and ferry jobs without touching sim state", () => {
    const bridge = world();
    const smelter = makeBuilding("smelter", "player", 700, 600);
    bridge.state.buildings.set(smelter.id, smelter);
    addUnit(bridge, "hauler", { type: "haul", buildingId: smelter.id });
    addUnit(bridge, "hauler", { type: "service", buildingId: smelter.id });
    addUnit(bridge, "worker", { type: "gather" });

    // The tallies the engine writes must be untouched by looking at them. If this fails, a panel
    // being open changes the simulation.
    const before = { haulers: smelter.haulers, servers: smelter.servers };  // both undefined here
    const model = logisticsModel(bridge.state, "player");
    expect({ haulers: smelter.haulers, servers: smelter.servers }).toEqual(before);

    expect(model.hauling).toBe(1);
    expect(model.servicing).toBe(1);
    expect(model.idle + model.hauling + model.servicing + model.other).toBe(model.total);
  });

  it("offers the engine's own priority list, in the engine's own order", () => {
    const bridge = world();
    expect(logisticsModel(bridge.state, "player").priorities).toEqual([...LOGI_PRIORITIES]);
  });

  it("reports a building's priority as the engine stored it, defaulting to normal", () => {
    const bridge = world();
    const smelter = makeBuilding("smelter", "player", 700, 600);
    bridge.state.buildings.set(smelter.id, smelter);
    expect(logisticsModel(bridge.state, "player").byBuilding.get(smelter.id)?.priority).toBe("normal");

    expect(bridge.apply({ kind: "logiPriority", buildingId: smelter.id, priority: "high" })).toBeNull();
    expect(logisticsModel(bridge.state, "player").byBuilding.get(smelter.id)?.priority).toBe("high");
  });
});

describe("the supply model", () => {
  it("states the block rather than leaving it to be inferred from a failed click", () => {
    // The MVP showed "3 / 3" and let the player discover the cap by clicking a button that did
    // nothing. Supply being full is a thing to DO something about — build a Habitat — so it says so.
    const bridge = world();
    const full = supplyModel(12, 12);
    expect(full.blocked).toBe(true);
    expect(full.advice).toMatch(/habitat/i);

    const room = supplyModel(4, 12);
    expect(room.blocked).toBe(false);
    expect(room.advice).toBeNull();
    expect(room.text).toBe("4 / 12");
    expect(bridge.snapshot.tick).toBeGreaterThan(0);
  });

  it("treats a cap of zero as blocked, not as a division by zero", () => {
    const none = supplyModel(0, 0);
    expect(none.blocked).toBe(true);
    expect(Number.isFinite(none.fraction)).toBe(true);
  });
});

describe("the recycle preview", () => {
  it("shows what the engine will actually refund, before committing", () => {
    // The point of a preview is that it is the same number as the outcome. `recycleValue` includes
    // the building's own buffers as well as a fraction of its cost, which a panel guessing from
    // the cost alone would miss entirely.
    const bridge = world();
    const smelter = makeBuilding("smelter", "player", 700, 600);
    smelter.store = { metals: 30 };
    bridge.state.buildings.set(smelter.id, smelter);

    const preview = recyclePreview(bridge.state, smelter.id);
    expect(preview.canRecycle).toBe(true);
    expect(Object.fromEntries(preview.refund.map((r) => [r.com, r.qty])))
      .toEqual(recycleValue(bridge.state, smelter));
    // The buffered metals are in there, not just a slice of the ore it cost to build.
    expect(preview.refund.find((r) => r.com === "metals")?.qty).toBeCloseTo(30, 6);
  });

  it("is empty for something that does not exist any more", () => {
    const bridge = world();
    expect(recyclePreview(bridge.state, "b999").canRecycle).toBe(false);
  });
});
