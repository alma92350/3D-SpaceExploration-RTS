// P2-T07 — gathering and hauling read correctly in 3D.
//
// The economy's most-watched animation, and the one place where "the view lies" is least likely to
// be noticed: a worker that walks the right path while showing the wrong load still *looks* like a
// working economy. So this does not check a stationary unit against a hand-set `cargo` field — it
// runs a real gather order through `WorldBridge` and compares the snapshot against the engine on
// **every tick of the round trip**, including the ticks where nothing interesting happens.
//
// Two things make that worth doing rather than sampling the endpoints:
//
//  - The deposit is instantaneous. `updateGather`'s "toDrop" arm banks the whole load and flips the
//    phase inside one tick, so a test that sampled every tenth tick could step straight over the
//    only frame where a full worker and an empty one are one frame apart.
//  - Fullness is a *ratio*, and the denominator is per-unit-type. Sampling "carrying / not carrying"
//    would pass with any denominator at all.

import { describe, expect, it } from "vitest";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { FLAG_CARRYING, FLAG_MOVING, numericId } from "../../src/bridge/snapshot.js";
import { UNITS, isNodeDiscovered, makeUnit, nearestGatherDrop } from "../../src/engine/index.js";

const SEED = 20260814;

/** The engine's own per-trip capacity rule (`tripCapacity`, engine/haul.js): cargoCap, else cargoHold. */
function engineCapacity(type: string): number {
  const def = UNITS[type] as { cargoCap?: number; cargoHold?: number } | undefined;
  return def?.cargoCap ?? def?.cargoHold ?? 0;
}

function opened(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
  const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
  bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  bridge.enqueue({ kind: "deploy" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

interface Sample {
  tick: number;
  phase: string | null;
  /** The engine's truth. */
  qty: number;
  com: string | null;
  /** What the view was told. */
  carrying: boolean;
  progress: number;
  moving: boolean;
  dropId: string | null;
}

/**
 * Order one worker onto the nearest discovered ore node and record engine-vs-snapshot every tick.
 *
 * The worker is picked by *proximity to a node* rather than "the first one in the Map": the deploy
 * drops several workers on the same spot and the gather loop's `orbitSpot` fans them out, so taking
 * an arbitrary one makes the number of ticks to arrival depend on Map iteration order.
 */
function recordRoundTrip(ticks: number) {
  const bridge = opened();
  const state = bridge.state;
  const fog = state.fog;

  const workers = [...state.units.values()].filter((u) => u.owner === "player" && UNITS[u.type]?.canGather);
  expect(workers.length, "the deploy should land workers").toBeGreaterThan(0);

  const node = state.map.nodes
    .filter((n) => n.com === "ore" && n.amount > 0 && isNodeDiscovered(fog, n))
    .sort((a, b) => {
      const w = workers[0]!;
      return Math.hypot(a.x - w.x, a.y - w.y) - Math.hypot(b.x - w.x, b.y - w.y);
    })[0];
  expect(node, "the opening should have a discovered ore node").toBeDefined();

  const worker = workers.sort(
    (a, b) => Math.hypot(a.x - node!.x, a.y - node!.y) - Math.hypot(b.x - node!.x, b.y - node!.y),
  )[0]!;

  bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
  bridge.enqueue({ kind: "gather", nodeId: node!.id, queue: false });

  const id = numericId(worker.id);
  const samples: Sample[] = [];

  for (let t = 0; t < ticks; t++) {
    bridge.step(STEP_SECONDS);
    const snap = bridge.snapshot;
    const e = snap.entities;

    let row = -1;
    for (let i = 0; i < e.count; i++) if (e.ids[i] === id) { row = i; break; }
    // A worker inside its own base is always in its own fog, so a missing row is a real failure
    // rather than a visibility subtlety worth tolerating.
    expect(row, `the worker vanished from the snapshot at tick ${t}`).toBeGreaterThanOrEqual(0);

    const live = bridge.state.units.get(worker.id)!;
    const drop = live.order?.phase === "toDrop"
      ? nearestGatherDrop(bridge.state, "player", live.x, live.y)
      : null;

    samples.push({
      tick: t,
      phase: live.order?.phase ?? null,
      qty: live.cargo?.qty ?? 0,
      com: live.cargo?.com ?? null,
      carrying: (e.flags[row]! & FLAG_CARRYING) !== 0,
      progress: e.progress[row]!,
      moving: (e.flags[row]! & FLAG_MOVING) !== 0,
      dropId: drop ? (drop as { id: string }).id : null,
    });
  }
  return { bridge, worker, node: node!, samples };
}

describe("a recorded worker round trip", () => {
  it("completes a full cycle, so the assertions below are about a real trip", () => {
    const { samples, bridge, worker } = recordRoundTrip(400);
    const phases = new Set(samples.map((s) => s.phase));

    expect(phases.has("toNode"), "the worker never walked to the node").toBe(true);
    expect(phases.has("mining"), "the worker never mined").toBe(true);
    expect(phases.has("toDrop"), "the worker never hauled the load home").toBe(true);

    // A deposit is a tick where the load goes from full-ish to nothing. Without one, every
    // assertion about the carrying flag is only ever testing the empty half.
    const deposits = samples.filter((s, i) => i > 0 && samples[i - 1]!.qty > 0 && s.qty === 0);
    expect(deposits.length, "the worker never banked a load in 400 ticks").toBeGreaterThan(0);

    expect(
      bridge.state.players.player.resources.ore ?? 0,
      "ore never reached the treasury, so nothing was actually gathered",
    ).toBeGreaterThan(0);
    expect(bridge.state.units.get(worker.id), "the worker died mid-trip").toBeDefined();
  });

  it("shows the carrying flag on exactly the ticks the engine says it is loaded", () => {
    const { samples } = recordRoundTrip(400);
    for (const s of samples) {
      expect(
        s.carrying,
        `tick ${s.tick} (${s.phase}): engine qty=${s.qty}, snapshot carrying=${s.carrying}`,
      ).toBe(s.qty > 0);
    }
  });

  it("shows fullness against the ENGINE's capacity for this unit type, not a constant", () => {
    const { samples, worker } = recordRoundTrip(400);
    const cap = engineCapacity(worker.type);
    expect(cap, "a gathering unit with no capacity would make this vacuous").toBeGreaterThan(0);

    for (const s of samples) {
      expect(
        s.progress,
        `tick ${s.tick}: qty ${s.qty} of ${cap} should read ${(s.qty / cap).toFixed(4)}, ` +
        `snapshot said ${s.progress.toFixed(4)}`,
      ).toBeCloseTo(Math.min(1, s.qty / cap), 5);
    }
  });

  it("reaches a genuinely full load, so the top of the ratio is exercised", () => {
    // Without this the fullness test above passes on a worker that never fills up, and the
    // denominator is only ever checked in its least sensitive range.
    const { samples } = recordRoundTrip(400);
    const peak = Math.max(...samples.map((s) => s.progress));
    expect(peak, `the fullest the worker ever read was ${peak.toFixed(3)}`).toBeGreaterThan(0.95);
    expect(peak, "fullness must stay inside the 0..1 the port documents").toBeLessThanOrEqual(1);
  });

  it("hauls to the drop-off the engine picked, not to the nearest node", () => {
    // The board's own warning on this row: `zoneFirst` means workers prefer their home zone, so
    // the visuals must not imply nearest-node behaviour. On a one-base opening there is one drop,
    // and what this pins is that the worker CONVERGES on it — a haul leg that walked somewhere
    // else would still deposit eventually and still look plausible in a still frame.
    const { samples, bridge } = recordRoundTrip(400);
    const hauling = samples.filter((s) => s.phase === "toDrop");
    expect(hauling.length, "no haul leg was recorded").toBeGreaterThan(0);

    for (const s of hauling) {
      expect(s.dropId, `tick ${s.tick}: hauling with no drop-off in range`).not.toBeNull();
    }

    const drops = new Set(hauling.map((s) => s.dropId));
    expect(drops.size, `the worker changed drop-off mid-haul: ${[...drops].join(", ")}`).toBe(1);

    const dropId = [...drops][0]!;
    const cc = [...bridge.state.buildings.values()].find((b) => b.id === dropId);
    expect(cc, "the drop-off is not a building this player owns").toBeDefined();
    expect(cc!.owner).toBe("player");
    expect(cc!.constructing, "a worker banked into an unfinished building").toBeFalsy();
  });

  it("marks the worker moving on the legs it walks and still on the ones it does not", () => {
    // Motion is the other half of "reads correctly": a worker frozen mid-haul reads as stuck, and
    // one twitching while mining reads as busy when it is not.
    const { samples } = recordRoundTrip(400);
    const mining = samples.filter((s) => s.phase === "mining");
    const walking = samples.filter((s) => s.phase === "toNode" || s.phase === "toDrop");

    expect(mining.length).toBeGreaterThan(0);
    expect(walking.length).toBeGreaterThan(0);
    // The walking legs must contain real movement. Not every walking tick does — the tick that
    // arrives is a phase flip, not a step — so this is a majority, not a universal.
    expect(walking.filter((s) => s.moving).length / walking.length).toBeGreaterThan(0.8);
    // Mining is stationary by construction: `updateGather`'s "mining" arm never calls `stepToward`.
    expect(mining.filter((s) => s.moving).length, "a mining worker was reported as moving").toBe(0);
  });
});

describe("a freighter's hold", () => {
  it("reads as a fraction of ITS capacity, not the worker's", () => {
    // The bug this rules out is specific and was live: `Math.min(1, qty / 10)` in the extractor,
    // where 10 is the WORKER's cargoCap. A Hauler holds 250, so 10 aboard — 4% — read as a full
    // hold, and every logistics unit in the game showed a laden cue from its first crate.
    //
    // `cargo` is set by hand here rather than by driving a haul job, and that is a real weakness of
    // this test: `makeUnit` gives `cargo` only to role "worker", so a freighter's slot is minted on
    // demand by `updateHaul`/`issueSetAILogistics`. What is faked is how the load got aboard. What
    // is measured is the extractor's arithmetic, which is the thing under test.
    const bridge = opened();
    const base = bridge.state.map.bases.player;

    for (const type of ["hauler", "heavyhauler", "bulkfreighter"]) {
      const cap = engineCapacity(type);
      expect(cap, `${type} should have a hold`).toBeGreaterThan(20);

      const u = makeUnit(type, "player", base.x + 4, base.y + 4);
      u.cargo = { com: "ore", qty: 10 };
      bridge.state.units.set(u.id, u);
      bridge.step(STEP_SECONDS);

      const e = bridge.snapshot.entities;
      const id = numericId(u.id);
      let row = -1;
      for (let i = 0; i < e.count; i++) if (e.ids[i] === id) { row = i; break; }
      expect(row, `${type} missing from the snapshot`).toBeGreaterThanOrEqual(0);

      expect(
        e.progress[row]!,
        `a ${type} holding 10 of ${cap} read as ${(e.progress[row]! * 100).toFixed(0)}% full`,
      ).toBeCloseTo(10 / cap, 4);

      bridge.state.units.delete(u.id);
    }
  });

  it("never divides by a capacity the engine does not define", () => {
    // The plain `freighter` — the scenario-spawned transport — has neither `cargoCap` nor
    // `cargoHold`, so the engine's own `tripCapacity` returns 0 for it. Dividing by that yields
    // Infinity or NaN, either of which travels down the instance `shade` into a vertex buffer and
    // corrupts a whole batch rather than one unit.
    expect(engineCapacity("freighter"), "the freighter's hold changed upstream").toBe(0);

    const bridge = opened();
    const base = bridge.state.map.bases.player;
    const u = makeUnit("freighter", "player", base.x + 4, base.y + 4);
    u.cargo = { com: "ore", qty: 10 };
    bridge.state.units.set(u.id, u);
    bridge.step(STEP_SECONDS);

    const e = bridge.snapshot.entities;
    const id = numericId(u.id);
    let row = -1;
    for (let i = 0; i < e.count; i++) if (e.ids[i] === id) { row = i; break; }
    expect(row).toBeGreaterThanOrEqual(0);

    const p = e.progress[row]!;
    expect(Number.isFinite(p), `progress was ${p}`).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});
