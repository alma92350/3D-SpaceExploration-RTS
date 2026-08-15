// P4-T07 — Freight Lanes: created, crewed, and running.
//
// The row names the legibility risk and this file is built around it: **a lane is periodic**.
// `runLanes` fires once every `LANE_PERIOD` galaxy ticks — ten sim-seconds — and does nothing at
// all in between, which is indistinguishable from broken unless the panel says otherwise. So the
// central test here does not assert that a countdown exists; it steps the galaxy one tick at a time
// for two full periods and asserts that cargo moves on exactly the ticks the countdown predicted
// and on no others. That single assertion covers both halves of the row: the lane runs, and the
// silence between runs is the schedule rather than a fault.
//
// The three vacuity traps specific to lanes, each answered by a paired assertion:
//
//   • **A lane with no ships.** Every "nothing moved" claim below would pass against a lane nobody
//     crewed, so each one is paired with the same lane, crewed, actually delivering.
//   • **A lane with nothing to carry.** `cargoManifest` returns an empty hold for an empty
//     stockpile, so the source world is stocked and the delivered quantity is asserted exactly.
//   • **A capacity that is really a stock level.** The two are equal whenever stock exceeds the
//     hold, so one test deliberately starves the source and asserts the smaller number.
//
// And the consequence the row's own note calls out: `stagedRiders` skips a lane-booked ship, so
// crewing a freighter takes it out of the next jump. That is asserted through the engine's own
// `stagedRiders`, not through the model alone — the panel is only useful here if it agrees with
// what the jump will really lift.

import { describe, expect, it } from "vitest";
import {
  CARGO_GOODS, LANE_PERIOD, UNITS,
  assignShipToLane, cargoManifest, createGalaxy, createLane, freightCapacity, makeBuilding, makeUnit,
  playerSpaceports, stagedRiders, stepGalaxy, unassignShipFromLane,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { lanePanelModel } from "../../src/ui/lane-panel.js";

const SEED = 20260814;
const SEAT = "helix";
/** Two worlds this seed brings up in the background. The lane runs between them, not through the seat. */
const SRC = "ferros";
const DST = "nimbus";

interface Scene {
  g: Galaxy;
  src: State;
  dst: State;
  pad: Building;
  hauler: Unit;
  /** A player unit standing in the same ring that is NOT a freighter. No lane may take it. */
  worker: Unit;
  lane: Lane;
}

/**
 * A source world with a launch pad and a freighter, and a lane to somewhere.
 *
 * Both ends are BACKGROUND worlds with no player presence of their own, and that is what makes the
 * quantities below assertable: nothing on either side gathers, produces or trades, so the only thing
 * that can move a stockpile is the lane. `makeBuilding`/`makeUnit` are the engine's own
 * constructors — the pad is placed rather than built for the same reason
 * `test/bridge/galaxy-save.test.ts` places one.
 */
function scene(commodities: string[] = ["ore"], stock: Resources = { ore: 5000 }): Scene {
  const g = createGalaxy({ seed: SEED, startId: SEAT });
  const src = g.planets.get(SRC)!;
  const dst = g.planets.get(DST)!;

  const base = src.map.bases.player;
  const pad = makeBuilding("spaceport", "player", base.x, base.y);
  pad.constructing = false;
  pad.buildProgress = 1;
  src.buildings.set(pad.id, pad);

  const hauler = makeUnit("hauler", "player", base.x + 30, base.y + 20);
  src.units.set(hauler.id, hauler);
  // A second unit in the same ring that no lane may ever take. Without it, a panel that offered
  // every staged unit as a lane candidate would pass every test in this file — found by mutation.
  const worker = makeUnit("worker", "player", base.x - 30, base.y + 20);
  src.units.set(worker.id, worker);

  Object.assign(src.players.player.resources, stock);

  const lane = createLane(g, SRC, DST, commodities)!;
  expect(lane, "the lane was refused — both worlds must be instantiated in this galaxy").toBeTruthy();
  return { g, src, dst, pad, hauler, worker, lane };
}

/** The two staged units' own numbers, read off the engine's roster rather than typed in here. */
const HOLD = UNITS.hauler!.cargoHold!;
const SUPPLY = UNITS.hauler!.supplyCost!;
const WORKER_SUPPLY = UNITS.worker!.supplyCost!;
const HEAVY_SUPPLY = UNITS.heavyhauler!.supplyCost!;
const HEAVY_HOLD = UNITS.heavyhauler!.cargoHold!;

const only = (g: Galaxy) => lanePanelModel(g, STEP_SECONDS).rows[0]!;
const stock = (s: State, com: string): number => s.players.player.resources[com] ?? 0;
const ore = (s: State) => stock(s, "ore");

/* =================================================================================================
   THE PERIOD
   ================================================================================================= */

describe("a lane is periodic, and the panel says when (P4-T07)", () => {
  it("states the period in the engine's own ticks and in the caller's own seconds", () => {
    const { g } = scene();
    const model = lanePanelModel(g, STEP_SECONDS);

    expect(model.periodTicks, "the panel invented a period instead of reading LANE_PERIOD").toBe(LANE_PERIOD);
    expect(model.periodSeconds, "the period is not the engine's tick count on the caller's clock")
      .toBeCloseTo(LANE_PERIOD * STEP_SECONDS, 9);
    expect(model.runsPerMinute).toBeCloseTo(60 / model.periodSeconds, 9);
    // A fresh galaxy has never run a lane, so the whole period is still ahead of it.
    expect(model.ticksUntilRun).toBe(LANE_PERIOD);
    expect(model.secondsUntilRun).toBeCloseTo(model.periodSeconds, 9);
  });

  it("counts down to the tick cargo actually moves, and to no other", () => {
    // The central assertion of this file. Two full periods, one tick at a time: cargo must move on
    // exactly the ticks where the countdown had reached its last one, and must not move on any of
    // the ~398 ticks in between — which is the "it looks broken" window the row is about.
    const s = crewed(scene());

    const delivered: number[] = [];
    for (let i = 0; i < LANE_PERIOD * 2 + 3; i++) {
      const due = lanePanelModel(s.g, STEP_SECONDS).ticksUntilRun;
      const before = ore(s.dst);
      stepGalaxy(s.g, STEP_SECONDS);
      const moved = ore(s.dst) - before;
      expect(
        moved > 0,
        `galaxy tick ${s.g.tick}: cargo ${moved > 0 ? "moved" : "did not move"} while the panel ` +
        `showed ${due} tick(s) to go`,
      ).toBe(due === 1);
      if (moved > 0) delivered.push(s.g.tick);
    }

    expect(delivered, "the lane did not deliver on exactly the two period boundaries")
      .toEqual([LANE_PERIOD, LANE_PERIOD * 2]);
  });

  it("shows a full period again the moment a run finishes, never zero", () => {
    // A countdown that read zero for the whole tick after a delivery would tell a player a run is
    // imminent for ten seconds after the one they just missed.
    const s = crewed(scene());
    for (let i = 0; i < LANE_PERIOD; i++) stepGalaxy(s.g, STEP_SECONDS);
    expect(s.g.tick % LANE_PERIOD, "the galaxy did not land exactly on a period boundary").toBe(0);
    expect(lanePanelModel(s.g, STEP_SECONDS).ticksUntilRun, "the countdown reads zero after a run")
      .toBe(LANE_PERIOD);
  });
});

/* =================================================================================================
   WHAT THE NEXT RUN CARRIES
   ================================================================================================= */

describe("what a lane will carry is asked of the engine (P4-T07)", () => {
  it("carries nothing without a crew, and says so rather than reading as broken", () => {
    const s = scene();
    let row = only(s.g);
    expect(row.crew, "an uncrewed lane reported a crew").toEqual([]);
    expect(row.capacity, "an uncrewed lane reported capacity").toBe(0);
    expect(row.nextRun, "an uncrewed lane reported a manifest").toEqual([]);
    expect(row.status).toBe("idle");

    // Anti-vacuity: the same lane, crewed, is immediately shipping — so "idle" above is the missing
    // crew rather than a model that always says idle.
    expect(assignShipToLane(s.g, s.lane.id, s.hauler.id)).toBe(true);
    row = only(s.g);
    expect(row.status).toBe("shipping");
    expect(row.capacity, "the crewed lane still reports no capacity").toBeGreaterThan(0);
  });

  it("takes capacity from freightCapacity and the manifest from cargoManifest", () => {
    const s = crewed(scene());
    const row = only(s.g);

    expect(row.capacity, "the panel summed holds itself instead of asking the engine")
      .toBe(freightCapacity([s.hauler]));
    expect(row.capacity, "a Hauler's hold is not what the panel reports").toBe(HOLD);
    const manifest = cargoManifest(s.src, row.capacity, ["ore"]);
    expect(row.nextRun.map((c) => [c.com, c.qty]), "the panel's manifest is not the engine's")
      .toEqual(Object.entries(manifest));

    // And the run itself delivers exactly what the panel said it would.
    const before = ore(s.dst);
    runOnce(s.g);
    expect(ore(s.dst) - before, "the delivery differs from the manifest the panel showed")
      .toBe(row.nextRunTotal);
    expect(row.nextRunTotal, "nothing was ever going to move, so this proves nothing").toBeGreaterThan(0);
  });

  it("reports the stock when the stock is the limit, not the hold", () => {
    // Capacity and manifest are the same number whenever the source is rich, which is how a panel
    // that showed capacity as "what will move" survives every ordinary test.
    const s = crewed(scene(["ore"], { ore: 100 }));
    const row = only(s.g);

    expect(row.capacity, "the hold shrank to the stock, so the two are not being distinguished")
      .toBe(HOLD);
    expect(row.nextRunTotal, "the panel promised a full hold from a 100-unit stockpile").toBe(100);

    const before = ore(s.dst);
    runOnce(s.g);
    expect(ore(s.dst) - before).toBe(100);
    expect(ore(s.src), "the delivery was created rather than moved").toBe(0);

    // Now the source is empty: crewed, capable, and carrying nothing — a state a player will read as
    // broken unless the panel separates it from "no crew".
    const after = only(s.g);
    expect(after.status).toBe("empty");
    expect(after.capacity, "an empty source dropped the lane's capacity").toBeGreaterThan(0);
  });

  it("resolves an empty filter to CARGO_GOODS and loads in the engine's own order", () => {
    // An unfiltered lane does not ship "everything equally": `runLanes` falls back to CARGO_GOODS,
    // which is ordered most-valuable-first, and the hold fills in that order. A panel that showed an
    // unordered set would not tell a player which goods get left behind when the hold is short.
    const s = crewed(scene([], { machinery: 100, metals: 1000 }));
    const model = lanePanelModel(s.g, STEP_SECONDS);
    const row = model.rows[0]!;

    expect(row.filtered, "an unfiltered lane claims a filter").toBe(false);
    expect(row.commodities, "the default commodity list is not the engine's").toEqual([...CARGO_GOODS]);
    expect(model.defaultCommodities, "the advertised default is not the list an unfiltered lane resolves to")
      .toEqual(row.commodities);
    expect(row.nextRun.map((c) => c.com), "the hold is not filled most-valuable-first")
      .toEqual(["machinery", "metals"]);
    expect(row.nextRun.map((c) => c.qty), "the hold did not fill to capacity in that order")
      .toEqual([100, HOLD - 100]);

    const before = { machinery: stock(s.dst, "machinery"), metals: stock(s.dst, "metals") };
    runOnce(s.g);
    expect(stock(s.dst, "machinery") - before.machinery, "the machinery did not travel").toBe(100);
    expect(stock(s.dst, "metals") - before.metals, "the metals did not fill the rest of the hold")
      .toBe(HOLD - 100);
  });

  it("honours a filter: a lane set to one commodity leaves the rest at home", () => {
    const s = crewed(scene(["metals"], { machinery: 500, metals: 500 }));
    const row = only(s.g);
    expect(row.filtered).toBe(true);
    expect(row.nextRun.map((c) => c.com), "a filtered lane offered to carry something else")
      .toEqual(["metals"]);

    runOnce(s.g);
    expect(stock(s.dst, "machinery"), "the filter did not hold — machinery travelled").toBe(0);
    expect(stock(s.src, "machinery"), "the source's machinery left anyway").toBe(500);
  });

  it("states the route's throughput as capacity on the lane's own clock", () => {
    const s = crewed(scene());
    const model = lanePanelModel(s.g, STEP_SECONDS);
    const row = model.rows[0]!;
    expect(row.capacityPerMinute).toBeCloseTo(row.capacity * model.runsPerMinute, 9);

    // Measured, not just multiplied out: two periods really do move two holds.
    const before = ore(s.dst);
    runOnce(s.g);
    runOnce(s.g);
    expect(ore(s.dst) - before, "two periods did not move two holds").toBe(row.capacity * 2);
  });
});

/* =================================================================================================
   THE COST OF CREWING ONE
   ================================================================================================= */

describe("crewing a freighter takes it out of the next jump (P4-T07)", () => {
  it("moves the ship from the staging ring into the crew, and says what that cost", () => {
    // `stagedRiders` excludes a lane-booked ship so a jump cannot sweep a route's freighter
    // off-world. The consequence is that the expedition shrinks — which a player should be able to
    // see BEFORE assigning, not discover when the manifest comes up light.
    const s = scene();
    // A THIRD staged unit, and the only one whose supply is not 1: without it, a panel that counted
    // ships where it claims to report supply reads identically to one that adds `supplyCost` up.
    // Found by mutation — `jumpRingSupply += 1` passed this file until this ship existed.
    const heavy = makeUnit("heavyhauler", "player", s.pad.x + 40, s.pad.y - 20);
    s.src.units.set(heavy.id, heavy);
    expect(HEAVY_SUPPLY, "a Heavy Hauler now costs the same supply as a Hauler").not.toBe(SUPPLY);

    const ring = () => stagedRiders(s.src, playerSpaceports(s.src)[0]!).map((u) => u.id);

    let row = only(s.g);
    expect(ring(), "the freighter is not staged at the pad, so nothing here is being tested")
      .toContain(s.hauler.id);
    // The worker is standing in the same ring and is NOT offered: only a real cargo ship can be
    // crewed, which is `assignShipToLane`'s own first condition.
    expect(ring(), "the worker is not staged either, so the exclusion below proves nothing")
      .toContain(s.worker.id);
    expect(row.candidates.map((c) => c.unitId).sort(), "the panel offered something that is not a freighter")
      .toEqual([s.hauler.id, heavy.id].sort());
    expect(row.jumpRingShips, "the panel's ring count disagrees with stagedRiders").toBe(ring().length);
    expect(row.jumpRingSupply, "the ring reports a head count where it promises supply")
      .toBe(SUPPLY + WORKER_SUPPLY + HEAVY_SUPPLY);
    expect(row.heldFromJump, "a lane with no crew is holding supply out of the ring").toBe(0);
    expect(
      row.candidates.find((c) => c.unitId === heavy.id)!.supplyCost,
      "the panel does not say what assigning this particular ship would cost the jump",
    ).toBe(HEAVY_SUPPLY);

    expect(assignShipToLane(s.g, s.lane.id, s.hauler.id)).toBe(true);

    row = only(s.g);
    expect(ring(), "the engine still stages a lane-booked ship — the exclusion has changed")
      .not.toContain(s.hauler.id);
    expect(row.jumpRingShips, "the panel still counts the booked ship as a jump rider").toBe(2);
    expect(row.jumpRingSupply, "exactly the booked freighter's supply should have left the ring")
      .toBe(WORKER_SUPPLY + HEAVY_SUPPLY);
    expect(row.candidates.map((c) => c.unitId), "a booked ship is still offered as a candidate")
      .toEqual([heavy.id]);
    expect(row.crew.map((c) => c.unitId)).toEqual([s.hauler.id]);
    expect(row.heldFromJump, "the panel does not say what the route is holding back from a jump")
      .toBe(SUPPLY);

    // Crew the heavy one too: the cost of a route is measured in SUPPLY, not in hulls, and a
    // two-ship crew of a Hauler and a Heavy Hauler is worth four supply rather than two.
    expect(assignShipToLane(s.g, s.lane.id, heavy.id)).toBe(true);
    row = only(s.g);
    expect(row.heldFromJump, "the route's cost is being counted in ships rather than in supply")
      .toBe(SUPPLY + HEAVY_SUPPLY);
    expect(row.jumpRingSupply, "the ring should be down to the one unit no lane can take")
      .toBe(WORKER_SUPPLY);
    expect(row.capacity, "two crewed freighters do not carry both their holds").toBe(HOLD + HEAVY_HOLD);
  });

  it("drops a booked ship that no longer exists, rather than showing a crew that is gone", () => {
    // A freighter killed by a raid on the colony leaves its id on the lane until the next cycle
    // revalidates. A panel reading the booking list alone would show a crewed, capable route that
    // cannot move anything — the same "broken, but looks fine" failure as the adrift case.
    const s = crewed(scene());
    expect(only(s.g).crew, "the ship was never crewed").toHaveLength(1);

    s.src.units.delete(s.hauler.id);
    const row = only(s.g);
    expect(row.crew, "a ship that no longer exists is still listed as crew").toEqual([]);
    expect(row.capacity).toBe(0);
    expect(row.status).toBe("idle");

    runOnce(s.g);
    expect(s.g.lanes[0]!.shipIds, "the engine kept a booking for a ship that is gone").toEqual([]);
  });

  it("gives the ship back to the ring when it is unassigned", () => {
    const s = crewed(scene());
    expect(unassignShipFromLane(s.g, s.lane.id, s.hauler.id)).toBe(true);

    const row = only(s.g);
    expect(row.crew, "the ship is still crewed after being pulled off").toEqual([]);
    expect(row.heldFromJump).toBe(0);
    expect(row.jumpRingSupply, "the freed ship did not come back to the staging ring")
      .toBe(SUPPLY + WORKER_SUPPLY);
    expect(row.candidates.map((c) => c.unitId)).toEqual([s.hauler.id]);
    expect(stagedRiders(s.src, playerSpaceports(s.src)[0]!).map((u) => u.id)).toContain(s.hauler.id);
  });

  it("does not offer a freighter that is already working another lane", () => {
    const s = crewed(scene());
    const second = createLane(s.g, SRC, "kybernet", ["ore"])!;
    const rows = lanePanelModel(s.g, STEP_SECONDS).rows;
    const other = rows.find((r) => r.id === second.id)!;

    expect(other.candidates, "the second lane offered a ship the first one is running").toEqual([]);
    expect(other.jumpRingShips, "the worker is no longer staged, so 'no candidates' is not about lanes")
      .toBe(1);
    expect(other.status, "a lane with no crew of its own is not idle").toBe("idle");
    expect(rows.find((r) => r.id === s.lane.id)!.crew.map((c) => c.unitId), "the first lane lost its crew")
      .toEqual([s.hauler.id]);
  });

  it("marks a booked ship that has wandered off the pad, before the lane drops it", () => {
    // `runLanes` revalidates every cycle and silently drops a ship that is no longer standing at one
    // of the source world's pads. Silent is the problem: the lane keeps existing, keeps showing a
    // crew, and stops delivering. This is the one state that really is "broken", and the panel has
    // to separate it from the nine seconds of ordinary waiting.
    const s = crewed(scene());
    s.hauler.x += 4000;
    s.hauler.y += 4000;

    const row = only(s.g);
    expect(row.crew.map((c) => c.standing), "a ship 4000 units from the pad still reads as standing")
      .toEqual([false]);
    expect(row.standingCrew).toBe(0);
    expect(row.capacity, "an adrift ship still contributes capacity").toBe(0);
    expect(row.status).toBe("idle");
    expect(row.heldFromJump, "an adrift ship is still counted against the jump ring").toBe(0);

    // The engine then does exactly what the panel predicted.
    const before = ore(s.dst);
    runOnce(s.g);
    expect(s.g.lanes[0]!.shipIds, "the lane kept a ship that had wandered off the pad").toEqual([]);
    expect(ore(s.dst) - before, "the adrift ship delivered anyway").toBe(0);
  });
});

describe("the lane panel model itself (P4-T07)", () => {
  it("is a pure function of the galaxy it is given", () => {
    const s = crewed(scene());
    expect(lanePanelModel(s.g, STEP_SECONDS)).toEqual(lanePanelModel(s.g, STEP_SECONDS));
  });

  it("reports no lanes when there are none", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const model = lanePanelModel(g, STEP_SECONDS);
    expect(model.rows).toEqual([]);
    // …and still reports the schedule, because "no lanes" is not "no clock".
    expect(model.periodTicks).toBe(LANE_PERIOD);
  });
});

/** The same scene with its freighter crewed onto the lane, checked rather than assumed. */
function crewed(s: Scene): Scene {
  expect(
    assignShipToLane(s.g, s.lane.id, s.hauler.id),
    "the lane refused the freighter — it must be a player cargo ship standing within " +
    "JUMP_LOAD_RADIUS of one of the SOURCE world's own completed Spaceports",
  ).toBe(true);
  return s;
}

/** Advance exactly one lane cycle. */
function runOnce(g: Galaxy): void {
  for (let i = 0; i < LANE_PERIOD; i++) stepGalaxy(g, STEP_SECONDS);
}
