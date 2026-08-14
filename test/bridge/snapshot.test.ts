// P1-T01/T02/T03 — the bridge steps the real engine, and the snapshot is a faithful, allocation-
// free, fog-respecting view of it (ADR-0008).

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import {
  FLAG_BUILDING_KIND, FLAG_SELECTED, FOG_UNEXPLORED, FOG_VISIBLE, SnapshotExtractor, numericId,
} from "../../src/bridge/snapshot.js";
import { interpolatePositions } from "../../src/view/interpolate.js";
import { activeState, createGalaxy, makeUnit, stepGalaxy, supplyCap, supplyUsed } from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;

function stateHash(state: State): string {
  const parts: string[] = [`t${state.tick}`];
  for (const u of [...state.units.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
    parts.push(`${u.id}:${u.type}:${u.x.toFixed(6)}:${u.y.toFixed(6)}:${u.hp.toFixed(4)}`);
  for (const b of [...state.buildings.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
    parts.push(`${b.id}:${b.type}:${b.hp.toFixed(4)}:${b.buildProgress.toFixed(6)}`);
  parts.push(`ore${state.players.player.resources.ore?.toFixed(4)}`);
  return parts.join("|");
}

describe("WorldBridge", () => {
  it("100 bridge steps equal 100 direct stepGalaxy calls", () => {
    // The whole reuse argument (ADR-0003) rests on the bridge being a pass-through. If stepping
    // through it diverged from stepping the engine directly, every determinism fixture recorded
    // here would describe a game upstream does not play.
    //
    // The two runs are SEQUENTIAL, never interleaved, and that is not stylistic: the engine mints
    // entity ids from a module-global counter that `createGameState` resets. Two galaxies alive in
    // one process therefore share and reset each other's id sequence, and since worker assignment
    // is ordered by id, the interleaved version diverges in POSITIONS and reads as a bridge bug.
    // Worth knowing beyond this test — it is a real constraint on ever running two worlds at full
    // rate in one thread, which Phase 4's background worlds will have to respect.
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    for (let i = 0; i < 100; i++) bridge.step(STEP_SECONDS);
    const throughBridge = stateHash(bridge.state);

    const control = createGalaxy({ seed: SEED, startId: "ferros", difficulty: "medium", playerFaction: "frontier" });
    for (let i = 0; i < 100; i++) {
      stepGalaxy(control, STEP_SECONDS);
      activeState(control).events.length = 0;
    }
    expect(throughBridge).toBe(stateHash(activeState(control)));
  });

  it("the same seed produces the same run twice (S4)", () => {
    const run = (): string => {
      const b = new WorldBridge({ seed: SEED, worldId: "ferros" });
      for (let i = 0; i < 200; i++) b.step(STEP_SECONDS);
      return stateHash(b.state);
    };
    expect(run()).toBe(run());
  });

  it("does not let the engine's event queue grow without bound", () => {
    // An undrained `state.events` is a slow leak for the whole session, and upstream's own client
    // drains it every frame. Nothing in the MVP consumes events yet, so the bridge must.
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    for (let i = 0; i < 400; i++) bridge.step(STEP_SECONDS);
    expect(bridge.state.events.length).toBe(0);
  });
});

describe("snapshot extraction", () => {
  it("matches engine state for everything the player can see", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    const snap = bridge.snapshot;
    const state = bridge.state;

    const visibleBuildings = [...state.buildings.values()].filter((b) => b.owner === "player");
    for (const b of visibleBuildings) {
      const idx = indexOf(snap, numericId(b.id));
      expect(idx, `own building ${b.id} (${b.type}) missing from the snapshot`).toBeGreaterThanOrEqual(0);
      expect(snap.entities.x[idx]).toBeCloseTo(b.x, 4);
      expect(snap.entities.y[idx]).toBeCloseTo(b.y, 4);
      expect(snap.entities.hp[idx]).toBeCloseTo(b.hp, 4);
      expect(snap.entities.flags[idx]! & FLAG_BUILDING_KIND).toBeTruthy();
      expect(snap.typeNames[snap.entities.typeIndex[idx]!]).toBe(b.type);
    }
  });

  it("omits enemy units the player cannot see, rather than merely not drawing them (F-02, F-06)", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    const state = bridge.state;
    const enemyUnits = [...state.units.values()].filter((u) => u.owner === "ai");
    expect(enemyUnits.length, "the AI should start with units to hide").toBeGreaterThan(0);

    const snap = bridge.snapshot;
    for (const u of enemyUnits) {
      // At t=0 the enemy base is across the map and unexplored. Nothing of theirs may be present.
      expect(indexOf(snap, numericId(u.id)), `enemy unit ${u.id} leaked into the snapshot under fog`).toBe(-1);
    }
  });

  it("reports the three fog states and only bumps its version when the field changes", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    const snap = bridge.snapshot;
    const seen = new Set(snap.fog.state);
    expect(seen.has(FOG_VISIBLE), "the player's own base should be visible").toBe(true);
    expect(seen.has(FOG_UNEXPLORED), "the far side of the map should be unexplored").toBe(true);

    // Re-extracting an unchanged world must not bump the version — that counter is what stops the
    // renderer re-uploading a texture on every one of the frames a tick spans (ADR-0006).
    const extractor = new SnapshotExtractor(bridge.state.map);
    const opts = { viewer: "player" as OwnerId, credits: 0, supplyUsed: 0, supplyCap: 0 };
    extractor.extract(bridge.state, opts);
    const v = extractor.snapshot.fog.version;
    extractor.extract(bridge.state, opts);
    expect(extractor.snapshot.fog.version).toBe(v);
  });

  it("carries selection through as both a flag and a list", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    const worker = [...bridge.state.units.values()].find((u) => u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    bridge.step(STEP_SECONDS);

    const snap = bridge.snapshot;
    expect(snap.selection).toContain(worker.id);
    const idx = indexOf(snap, numericId(worker.id));
    expect(snap.entities.flags[idx]! & FLAG_SELECTED).toBeTruthy();
  });

  it("allocates nothing across 600 steady-state extractions", () => {
    // ADR-0006's hardest rule. Measured by identity: if every typed array is the same object it
    // was 600 ticks ago, no growth path ran, and growth is the only thing here that allocates.
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    for (let i = 0; i < 60; i++) bridge.step(STEP_SECONDS);   // let the opening settle

    const snap = bridge.snapshot;
    const before = {
      ids: snap.entities.ids, x: snap.entities.x, flags: snap.entities.flags,
      fog: snap.fog.state, nodes: snap.nodes.x,
    };
    for (let i = 0; i < 600; i++) bridge.step(STEP_SECONDS);

    expect(snap.entities.ids, "entity table reallocated mid-match").toBe(before.ids);
    expect(snap.entities.x).toBe(before.x);
    expect(snap.entities.flags).toBe(before.flags);
    expect(snap.fog.state, "fog buffer reallocated").toBe(before.fog);
    expect(snap.nodes.x, "node table reallocated").toBe(before.nodes);
  });

  it("grows in powers of two when the world outgrows the table", () => {
    const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
    const extractor = new SnapshotExtractor(state.map, 64);
    for (let i = 0; i < 300; i++) {
      const u = makeUnit("skiff", "player", state.map.bases.player.x, state.map.bases.player.y);
      state.units.set(u.id, u);
    }
    extractor.extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
    const cap = extractor.snapshot.entities.capacity;
    expect(cap).toBeGreaterThanOrEqual(extractor.snapshot.entities.count);
    expect(Math.log2(cap) % 1, `capacity ${cap} is not a power of two`).toBe(0);
  });
});

describe("interpolation", () => {
  const outX = new Float32Array(64);
  const outY = new Float32Array(64);

  it("blends linearly between the previous and current tick", () => {
    const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
    const extractor = new SnapshotExtractor(state.map);
    const opts = { viewer: "player" as OwnerId, credits: 0, supplyUsed: 0, supplyCap: 0 };

    const base = state.map.bases.player;
    const unit = makeUnit("skiff", "player", base.x, base.y);
    state.units.set(unit.id, unit);
    extractor.extract(state, opts);            // tick 1: it exists, no history
    unit.x = base.x + 100;                     // tick 2: it moved 100 units
    const snap = extractor.extract(state, opts);

    const idx = indexOf(snap, numericId(unit.id));
    interpolatePositions(snap, 0, outX, outY);
    expect(outX[idx]).toBeCloseTo(base.x, 3);
    interpolatePositions(snap, 0.5, outX, outY);
    expect(outX[idx]).toBeCloseTo(base.x + 50, 3);
    interpolatePositions(snap, 1, outX, outY);
    expect(outX[idx]).toBeCloseTo(base.x + 100, 3);
  });

  it("does not fly a newly spawned unit in from somewhere else", () => {
    const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
    const extractor = new SnapshotExtractor(state.map);
    const opts = { viewer: "player" as OwnerId, credits: 0, supplyUsed: 0, supplyCap: 0 };
    extractor.extract(state, opts);

    const base = state.map.bases.player;
    const spawned = makeUnit("skiff", "player", base.x + 40, base.y + 40);
    state.units.set(spawned.id, spawned);
    const snap = extractor.extract(state, opts);

    expect(snap.spawned.has(numericId(spawned.id))).toBe(true);
    const idx = indexOf(snap, numericId(spawned.id));
    for (const alpha of [0, 0.25, 0.5, 0.99]) {
      interpolatePositions(snap, alpha, outX, outY);
      expect(outX[idx], `a unit spawned this tick slid across the map at alpha=${alpha}`).toBeCloseTo(base.x + 40, 3);
      expect(outY[idx]).toBeCloseTo(base.y + 40, 3);
    }
  });

  it("reports a dead unit as removed and stops drawing it entirely", () => {
    const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
    const extractor = new SnapshotExtractor(state.map);
    const opts = { viewer: "player" as OwnerId, credits: 0, supplyUsed: 0, supplyCap: 0 };

    const base = state.map.bases.player;
    const doomed = makeUnit("skiff", "player", base.x, base.y);
    state.units.set(doomed.id, doomed);
    extractor.extract(state, opts);
    state.units.delete(doomed.id);
    const snap = extractor.extract(state, opts);

    expect(snap.removed.has(numericId(doomed.id))).toBe(true);
    expect(indexOf(snap, numericId(doomed.id)), "a dead unit lingered in the snapshot").toBe(-1);
  });

  it("clamps alpha rather than extrapolating past the current tick", () => {
    // Extrapolation overshoots a unit through the wall it just stopped at, and it only happens on
    // a frame that ran long — i.e. exactly on the machines least able to absorb the confusion.
    const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
    const extractor = new SnapshotExtractor(state.map);
    const opts = { viewer: "player" as OwnerId, credits: 0, supplyUsed: 0, supplyCap: 0 };
    const base = state.map.bases.player;
    const unit = makeUnit("skiff", "player", base.x, base.y);
    state.units.set(unit.id, unit);
    extractor.extract(state, opts);
    unit.x = base.x + 100;
    const snap = extractor.extract(state, opts);
    const idx = indexOf(snap, numericId(unit.id));

    interpolatePositions(snap, 3, outX, outY);
    expect(outX[idx]).toBeCloseTo(base.x + 100, 3);
    interpolatePositions(snap, -2, outX, outY);
    expect(outX[idx]).toBeCloseTo(base.x, 3);
  });
});

describe("supply reporting", () => {
  it("matches the engine's own numbers (F-07)", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: "ferros" });
    bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.resources.supplyUsed).toBe(supplyUsed(bridge.state, "player"));
    expect(bridge.snapshot.resources.supplyCap).toBe(supplyCap(bridge.state, "player"));
    expect(bridge.snapshot.resources.ore).toBeCloseTo(bridge.state.players.player.resources.ore ?? 0, 5);
  });
});

function indexOf(snap: { entities: { count: number; ids: Int32Array } }, numeric: number): number {
  for (let i = 0; i < snap.entities.count; i++) if (snap.entities.ids[i] === numeric) return i;
  return -1;
}
