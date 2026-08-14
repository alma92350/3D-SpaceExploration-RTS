// P2-T01/T02/T06 — the economy crosses the bridge (ADR-0012).
//
// Three properties, and the third is the one that keeps the other two honest:
//
//   1. The owner's whole stockpile arrives — all 23 commodities, not the MVP's three.
//   2. Every building carries a four-number production summary, and the stop reason is the
//      ENGINE'S own (`buildingConcern`), never re-derived here. Full commodity buffers arrive only
//      for the selection (Q-07), because only the selection has a panel that reads them.
//   3. None of it allocates per frame. A 23-commodity economy is exactly the kind of breadth that
//      quietly turns a fixed-width snapshot into a per-tick object graph (ADR-0006).

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import {
  CONCERN_BUFFER_FULL, CONCERN_NONE, CONCERN_NO_POWER, CONCERN_PAUSED, CONCERN_STARVED,
  POWER_NONE, SnapshotExtractor, numericId,
} from "../../src/bridge/snapshot.js";
import {
  COM, buildingConcern, makeBuilding, powerEfficiency, POWER_TIERS, storeCapOf,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;

/**
 * A world with a base, a FUELLED reactor and a smelter — the smallest thing with an economy.
 *
 * The fuel is not a detail. Every power source in this game burns something (`BUILDINGS.reactor`
 * has `combust: { fuels: ["radioactives"] }`), and `updateCombustors` only sets `powered` once
 * there is fuel in the source's own local larder, hauled there by a worker. So a reactor that has
 * just been built grants no power at all, and "no power" is a new base's *default* state rather
 * than a fault. Any test that forgets this measures an unpowered base and concludes the grid is
 * broken — which is exactly what the first draft of this file did.
 */
function industrialWorld(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const state = bridge.state;
  const base = [...state.buildings.values()].find((b) => b.owner === "player" && b.type === "command")
    ?? place(bridge, "command", 600, 600);
  const reactor = place(bridge, "reactor", base.x + 100, base.y);
  reactor.input = { radioactives: 200 };
  place(bridge, "smelter", base.x + 160, base.y);
  bridge.step(STEP_SECONDS);                     // updateCombustors runs here and sets `powered`
  return bridge;
}

function place(bridge: WorldBridge, type: string, x: number, y: number): Building {
  const b = makeBuilding(type, "player", x, y);
  bridge.state.buildings.set(b.id, b);
  return b;
}

function extractorFor(bridge: WorldBridge): SnapshotExtractor {
  return new SnapshotExtractor(bridge.state.map);
}

function extract(bridge: WorldBridge, ex: SnapshotExtractor) {
  return ex.extract(bridge.state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
}

describe("the economy crosses the bridge", () => {
  it("carries the owner's whole stockpile, not just the MVP's three commodities", () => {
    const bridge = industrialWorld();
    const res = bridge.state.players.player.resources;
    res.metals = 12.5;
    res.alloys = 3;
    res.ice = 7;

    const snap = extract(bridge, extractorFor(bridge));

    // Every commodity the engine knows about has a slot, so a panel never has to ask "is this one
    // of the three we bothered with?".
    for (const com of Object.keys(COM)) {
      expect(snap.stockpile[com], `commodity ${com} is missing from the snapshot`).toBeDefined();
    }
    expect(snap.stockpile.metals).toBeCloseTo(12.5, 6);
    expect(snap.stockpile.alloys).toBeCloseTo(3, 6);
    expect(snap.stockpile.ice).toBeCloseTo(7, 6);
    // Absent in the engine means zero here, not undefined — a panel showing "undefined ore" is a
    // worse bug than a wrong number, because it looks like a crash.
    expect(snap.stockpile.antimatter).toBe(0);
  });

  it("gives every building a production summary whose stop reason is the engine's own", () => {
    const bridge = industrialWorld();
    const smelter = [...bridge.state.buildings.values()].find((b) => b.type === "smelter")!;
    const ex = extractorFor(bridge);

    // Starved: no inputs hauled in yet, which is the state a fresh factory is actually in.
    let snap = extract(bridge, ex);
    let i = indexOf(snap, smelter.id);
    expect(snap.production.concern[i]).toBe(CONCERN_STARVED);
    expect(buildingConcern(bridge.state, smelter)?.code).toBe("starved");

    // Paused takes priority over everything, exactly as the engine orders it.
    smelter.paused = true;
    snap = extract(bridge, ex);
    i = indexOf(snap, smelter.id);
    expect(snap.production.concern[i]).toBe(CONCERN_PAUSED);
    smelter.paused = false;

    // Fed, so it runs — and the summary says so rather than inventing a reason.
    smelter.input = { ore: 100, energy: 100 };
    bridge.step(STEP_SECONDS);
    snap = extract(bridge, ex);
    i = indexOf(snap, smelter.id);
    expect(snap.production.concern[i]).toBe(CONCERN_NONE);

    // A full output buffer stalls it. This is the case a "progress bar" alone cannot show: the
    // factory is fed, powered and idle, and the only cue is why.
    smelter.store = { metals: storeCapOf("smelter") };
    snap = extract(bridge, ex);
    i = indexOf(snap, smelter.id);
    expect(snap.production.concern[i]).toBe(CONCERN_BUFFER_FULL);
  });

  it("reports no power when the grid is gone, for the same reason the engine does", () => {
    const bridge = industrialWorld();
    const reactor = [...bridge.state.buildings.values()].find((b) => b.type === "reactor")!;
    const smelter = [...bridge.state.buildings.values()].find((b) => b.type === "smelter")!;
    smelter.input = { ore: 100 };
    reactor.paused = true;                       // the grid's only source, switched off by hand
    reactor.powered = false;
    // The engine caches the power throttle for the duration of a tick (`cachedPowerThrottle`), so
    // the grid this smelter sees only changes on the next one. That is 50 ms in the running game
    // and invisible, but a test that extracts without stepping reads the *previous* tick's grid
    // and concludes the building is happily powered.
    bridge.step(STEP_SECONDS);

    const snap = extract(bridge, extractorFor(bridge));
    expect(snap.production.concern[indexOf(snap, smelter.id)]).toBe(CONCERN_NO_POWER);
  });

  it("extracts full commodity buffers for the selection only (Q-07)", () => {
    const bridge = industrialWorld();
    const smelter = [...bridge.state.buildings.values()].find((b) => b.type === "smelter")!;
    smelter.input = { ore: 40 };
    smelter.store = { metals: 9 };
    const ex = extractorFor(bridge);

    // Nothing selected: the summary is there, the buffers are not.
    let snap = extract(bridge, ex);
    expect(snap.buffers.size).toBe(0);

    bridge.state.selection = [smelter.id];
    snap = extract(bridge, ex);
    const buf = snap.buffers.get(smelter.id);
    expect(buf, "a selected factory must carry its buffers").toBeDefined();
    expect(buf!.input.ore).toBeCloseTo(40, 6);
    expect(buf!.output.metals).toBeCloseTo(9, 6);
    expect(buf!.recipe?.out).toBe("metals");

    // And they go away again, so the side table cannot grow without bound over a long session.
    bridge.state.selection = [];
    snap = extract(bridge, ex);
    expect(snap.buffers.size).toBe(0);
  });

  it("carries the power grid as a field of bands, agreeing with the engine cell for cell", () => {
    const bridge = industrialWorld();
    const snap = extract(bridge, extractorFor(bridge));
    const p = snap.power;

    expect(p.cols).toBe(snap.fog.cols);
    expect(p.rows).toBe(snap.fog.rows);

    let onGrid = 0;
    for (let row = 0; row < p.rows; row++) {
      for (let col = 0; col < p.cols; col++) {
        const x = (col + 0.5) * p.cell;
        const y = (row + 0.5) * p.cell;
        const band = p.state[row * p.cols + col]!;
        if (band === POWER_NONE) continue;
        onGrid++;
        // The band is the engine's own tier index, not a distance this file re-derived.
        expect(band - 1).toBe(POWER_TIERS.indexOf(powerEfficiency(bridge.state, "player", x, y)));
      }
    }
    expect(onGrid, "a reactor should light up some of the map").toBeGreaterThan(0);
  });

  it("does not allocate per frame across 600 extractions", () => {
    const bridge = industrialWorld();
    const smelter = [...bridge.state.buildings.values()].find((b) => b.type === "smelter")!;
    bridge.state.selection = [smelter.id];
    const ex = extractorFor(bridge);
    extract(bridge, ex);                          // warm every lazy path first

    const stockpile = ex.snapshot.stockpile;
    const concern = ex.snapshot.production.concern;
    const power = ex.snapshot.power.state;

    for (let i = 0; i < 600; i++) {
      bridge.step(STEP_SECONDS);
      extract(bridge, ex);
    }

    // Identity, not deep equality: a new object each tick is the allocation this forbids.
    expect(ex.snapshot.stockpile).toBe(stockpile);
    expect(ex.snapshot.production.concern).toBe(concern);
    expect(ex.snapshot.power.state).toBe(power);
  });
});

function indexOf(snap: { entities: { count: number; ids: Int32Array } }, engineId: string): number {
  const target = numericId(engineId);
  for (let i = 0; i < snap.entities.count; i++) if (snap.entities.ids[i] === target) return i;
  throw new Error(`${engineId} is not in the snapshot`);
}
