// P2-T03 — the economy's commands, each refused exactly when the engine refuses it (ADR-0012 §5).
//
// The rule this file enforces is one the MVP established with `canPlaceBuilding` and which the
// economy is the first place to make *tempting to break*: the bridge never decides. It asks
// `researchTech`, `issueRecycle`, `buy`/`sell`, `isElectrifiable` — and reports what they said.
//
// A market panel that recomputes a price locally disagrees with the engine within one trade; a
// research button that predicts availability disagrees the first time a prerequisite changes
// upstream. Both bugs look like the UI is lying, because it is.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import {
  TECHS, TRADE_LOT, isElectrifiable, makeBuilding, tradeables, unitPrice,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;

function world(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

function place(bridge: WorldBridge, type: string, x = 600, y = 600): Building {
  const b = makeBuilding(type, "player", x, y);
  bridge.state.buildings.set(b.id, b);
  return b;
}

describe("economy commands", () => {
  it("pauses and resumes a producer", () => {
    const bridge = world();
    const smelter = place(bridge, "smelter");

    expect(bridge.apply({ kind: "pause", buildingId: smelter.id, paused: true })).toBeNull();
    expect(smelter.paused).toBe(true);
    expect(bridge.apply({ kind: "pause", buildingId: smelter.id, paused: false })).toBeNull();
    expect(smelter.paused).toBe(false);
  });

  it("refuses to electrify a building the engine says cannot be electrified", () => {
    const bridge = world();
    const smelter = place(bridge, "smelter");
    const habitat = place(bridge, "habitat", 700, 600);

    // The engine's own predicate decides, so this test cannot drift from the roster: whichever of
    // the two upstream allows, the bridge allows.
    const okType = isElectrifiable("smelter") ? smelter : habitat;
    const badType = isElectrifiable("smelter") ? habitat : smelter;
    expect(isElectrifiable(okType.type)).toBe(true);
    expect(isElectrifiable(badType.type)).toBe(false);

    expect(bridge.apply({ kind: "electrify", buildingId: okType.id, on: true })).toBeNull();
    expect(okType.electrified).toBe(true);

    expect(bridge.apply({ kind: "electrify", buildingId: badType.id, on: true })).toMatch(/cannot be electrified/i);
    expect(badType.electrified).toBeFalsy();
  });

  it("starts research only where the engine allows it, and reports the refusal otherwise", () => {
    const bridge = world();
    const datacenter = place(bridge, "datacenter");
    const res = bridge.state.players.player.resources;

    // Broke: the engine refuses, and the player is told which tech and why rather than nothing.
    res.crystals = 0;
    const refused = bridge.apply({ kind: "research", buildingId: datacenter.id, techId: "metallurgy" });
    expect(refused).toMatch(/metallurgy/i);

    res.crystals = 999;
    res.radioactives = 999;
    expect(bridge.apply({ kind: "research", buildingId: datacenter.id, techId: "metallurgy" })).toBeNull();

    // An unknown tech is a programming error upstream of here, and must not reach the engine.
    expect(bridge.apply({ kind: "research", buildingId: datacenter.id, techId: "nonsuch" })).toMatch(/unknown/i);
    expect(Object.keys(TECHS)).toContain("metallurgy");
  });

  it("recycles through the engine's own order, not by setting a flag", () => {
    const bridge = world();
    const barracks = place(bridge, "barracks");

    expect(bridge.apply({ kind: "recycle", entityId: barracks.id })).toBeNull();
    // `recycling` is a progress record, not a flag — the engine tracks how far along the scrapping
    // is so it can pay out proportionally if cancelled.
    expect(barracks.recycling).toBeTruthy();
    expect(bridge.apply({ kind: "cancelRecycle", entityId: barracks.id })).toBeNull();
    expect(barracks.recycling).toBeFalsy();
  });

  it("trades at the engine's price, never at one the bridge computed", () => {
    const bridge = world();
    const state = bridge.state;
    state.players.player.resources.metals = 500;

    const before = bridge.galaxyCredits;
    const expected = unitPrice(state.market, "metals", "sell");
    const refusal = bridge.apply({ kind: "trade", com: "metals", qty: TRADE_LOT, side: "sell" });

    expect(refusal).toBeNull();
    expect(bridge.galaxyCredits, "selling must move credits").toBeGreaterThan(before);
    // Not an exact-price assertion: `sell` applies slippage as it goes, which is the engine's job
    // and precisely the arithmetic a panel must not attempt. What is asserted is that the proceeds
    // are in the neighbourhood of the engine's own quote rather than of some local formula.
    const proceeds = bridge.galaxyCredits - before;
    expect(proceeds).toBeGreaterThan(0);
    expect(proceeds).toBeLessThanOrEqual(Math.ceil(expected * TRADE_LOT) + 1);
  });

  it("distinguishes 'not traded here' from 'you have none', because the engine does", () => {
    const bridge = world();
    const state = bridge.state;

    // Two different refusals, and conflating them would mislead. A commodity is tradeable on a
    // world if a deposit exists there OR the player holds some (`commodityAvailable`) — so with
    // no antimatter deposit and none in the hold, the market does not list it at all. That is not
    // "you're short", it is "not here", and the message has to say which.
    state.players.player.resources.antimatter = 0;
    expect(bridge.apply({ kind: "trade", com: "antimatter", qty: TRADE_LOT, side: "sell" }))
      .toMatch(/cannot be traded here/i);

    // Ore is listed — Helix has deposits — but an empty hold still cannot fill an order.
    expect(tradeables(state)).toContain("ore");
    state.players.player.resources.ore = 0;
    expect(bridge.apply({ kind: "trade", com: "ore", qty: TRADE_LOT, side: "sell" }))
      .toMatch(/not enough/i);
  });

  it("sets a logistics priority through the engine's own order", () => {
    const bridge = world();
    const smelter = place(bridge, "smelter");
    expect(bridge.apply({ kind: "logiPriority", buildingId: smelter.id, priority: "high" })).toBeNull();
    expect(smelter.logiPriority).toBe("high");
  });

  it("ignores a command aimed at a building that died between the click and the tick", () => {
    const bridge = world();
    // Not a throw and not a crash: the click was legal when it was made, and the frame must not
    // take the exception. This is the same contract `attack` already has.
    expect(bridge.apply({ kind: "pause", buildingId: "b999", paused: true })).toBeNull();
    expect(bridge.apply({ kind: "recycle", entityId: "b999" })).toBeNull();
    expect(bridge.apply({ kind: "electrify", buildingId: "b999", on: true })).toBeNull();
  });
});
