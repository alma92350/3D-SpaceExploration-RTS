// Freight Lanes — standing shipping between worlds you hold (P4-T07, ADR-0012 §4).
//
// **A lane is periodic, and that is the whole legibility problem.** `runLanes` moves cargo once
// every `LANE_PERIOD` galaxy ticks — about ten sim-seconds — and does nothing whatsoever in
// between. A panel that said "active" would leave a player watching a stockpile that does not move
// for ten seconds and concluding the route is broken. So this model leads with the clock: how long
// the period is, and how much of it is left before the next run. "Nothing is happening" and
// "nothing has happened for nine seconds and will in one" are different states, and only one of
// them is a bug.
//
// **What the next run will carry is asked, never estimated.** `freightCapacity` is the engine's own
// sum of the crew's holds and `cargoManifest` is the exact function `runLanes` calls to decide what
// moves — including the most-valuable-first order that decides what gets left behind when the hold
// is short. A panel that multiplied a hold by a stock level would disagree with the delivery.
//
// **Crewing a ship onto a lane costs a jump.** `stagedRiders` skips a lane-booked ship (`!u.laneId`)
// so that a jump cannot sweep a route's freighter off-world, which means assigning one silently
// shrinks the next expedition. That is a real trade and a player should see it *before* they
// commit — hence `jumpRingSupply` and `heldFromJump` on every row, and a candidate list that is
// literally the staging ring the assignment would take the ship out of.
//
// **A booked ship is not the same as a working ship.** `runLanes` revalidates the crew every cycle
// and quietly drops anything that has died, changed hands or wandered off the pad. So `standing`
// distinguishes a crew member the next run will use from one it is about to discard — the exact
// difference between a lane that is slow and a lane that is broken.

import {
  CARGO_GOODS, JUMP_LOAD_RADIUS, LANE_PERIOD, UNITS,
  cargoManifest, freightCapacity, playerSpaceports, stagedRiders,
} from "../engine/index.js";

export interface LaneShip {
  readonly unitId: string;
  readonly type: string;
  /** The hold this ship adds to a run — `UNITS[type].cargoHold`. */
  readonly cargoHold: number;
  /** What it costs a jump to lift. Crewing it onto a lane takes exactly this out of the ring. */
  readonly supplyCost: number;
  /**
   * Still standing at one of the source world's own pads, which is what `runLanes` revalidates
   * against every cycle. A booked ship that is not standing carries nothing and is about to be
   * dropped from the lane.
   */
  readonly standing: boolean;
}

export interface LaneCargo {
  readonly com: string;
  readonly qty: number;
}

export interface LaneRow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** What the next run walks: this lane's filter, or `CARGO_GOODS` when it carries none. */
  readonly commodities: readonly string[];
  /** False when the lane has no filter of its own and is running on the default list. */
  readonly filtered: boolean;
  readonly crew: readonly LaneShip[];
  /** Crew still standing at a pad. Only these carry anything. */
  readonly standingCrew: number;
  /** `freightCapacity` of the standing crew — units of cargo this route moves per run. */
  readonly capacity: number;
  /** Capacity per minute at the lane's own period. What the route can move when stock allows. */
  readonly capacityPerMinute: number;
  /** `cargoManifest` — what the NEXT run moves, in the order it loads them. */
  readonly nextRun: readonly LaneCargo[];
  readonly nextRunTotal: number;
  /** `idle`: nothing standing. `empty`: crewed, but nothing on the source matches the filter. */
  readonly status: "idle" | "empty" | "shipping";
  /** Freighters in the source world's staging ring that this lane could still crew. */
  readonly candidates: readonly LaneShip[];
  /** Ships in that ring — `stagedRiders`, which SKIPS every lane-booked ship. */
  readonly jumpRingShips: number;
  /** …and their supply: what a jump off the source world would try to lift right now. */
  readonly jumpRingSupply: number;
  /** Supply this lane is holding OUT of that ring — the standing cost of the route. */
  readonly heldFromJump: number;
}

export interface LanePanelModel {
  /** The galaxy tick the countdown is measured from. */
  readonly tick: number;
  /** `LANE_PERIOD`, in galaxy ticks — an integer schedule, not a timer. */
  readonly periodTicks: number;
  readonly periodSeconds: number;
  /** Ticks until the next delivery cycle. Never zero: immediately after a run it is a full period. */
  readonly ticksUntilRun: number;
  readonly secondsUntilRun: number;
  readonly runsPerMinute: number;
  /** `CARGO_GOODS` — what an unfiltered lane ships, in the order it loads. */
  readonly defaultCommodities: readonly string[];
  readonly rows: readonly LaneRow[];
}

/**
 * Every standing lane, with the clock that drives them.
 *
 * @param stepSeconds the fixed step the galaxy is advanced by — the app's `STEP_SECONDS`. A lane's
 *   period is counted in galaxy TICKS, so seconds exist only relative to the caller's clock; taking
 *   it as an argument keeps this a pure function of what it is given rather than of an assumed rate.
 */
export function lanePanelModel(galaxy: Galaxy, stepSeconds: number): LanePanelModel {
  const periodSeconds = LANE_PERIOD * stepSeconds;
  // `runLanes` fires when the POST-increment tick is a multiple of the period, so a tick that has
  // just run is a full period away from the next one — never zero ticks away.
  const ticksUntilRun = LANE_PERIOD - (galaxy.tick % LANE_PERIOD);

  return {
    tick: galaxy.tick,
    periodTicks: LANE_PERIOD,
    periodSeconds,
    ticksUntilRun,
    secondsUntilRun: ticksUntilRun * stepSeconds,
    runsPerMinute: periodSeconds > 0 ? 60 / periodSeconds : 0,
    defaultCommodities: CARGO_GOODS,
    rows: galaxy.lanes.map((lane) => laneRow(galaxy, lane, periodSeconds)),
  };
}

function laneRow(galaxy: Galaxy, lane: Lane, periodSeconds: number): LaneRow {
  const from = galaxy.planets.get(lane.from);
  const filtered = lane.commodities.length > 0;
  // The exact fallback `runLanes` applies: an empty filter means every cargo good, in
  // `CARGO_GOODS`' own most-valuable-first order.
  const commodities = filtered ? [...lane.commodities] : [...CARGO_GOODS];

  // A lane whose source world is not instantiated cannot run at all — `runLanes` skips it. Only
  // reachable through a hand-edited save, but a panel that read through the gap would throw on it.
  if (!from) {
    return {
      id: lane.id, from: lane.from, to: lane.to, commodities, filtered,
      crew: [], standingCrew: 0, capacity: 0, capacityPerMinute: 0, nextRun: [], nextRunTotal: 0,
      status: "idle", candidates: [], jumpRingShips: 0, jumpRingSupply: 0, heldFromJump: 0,
    };
  }

  const pads = playerSpaceports(from);
  // `assignShipToLane`'s own catchment, and the one `runLanes` revalidates against each cycle.
  const atPad = (u: Unit): boolean => pads.some((p) => Math.hypot(u.x - p.x, u.y - p.y) <= JUMP_LOAD_RADIUS);

  const crew: LaneShip[] = [];
  const standing: Unit[] = [];
  for (const id of lane.shipIds) {
    const u = from.units.get(id);
    if (!u) continue;                       // died or jumped away; the next cycle drops the booking
    const ok = atPad(u);
    if (ok) standing.push(u);
    crew.push(ship(u, ok));
  }

  // The staging ring as a jump sees it. `stagedRiders` already excludes every lane-booked ship, so
  // this is both the candidate pool and the honest "what a jump would lift" number — one call, not
  // two views that could disagree. Deduplicated by id: overlapping pad catchments can stage the
  // same unit twice.
  const ring = new Map<string, Unit>();
  for (const pad of pads) for (const u of stagedRiders(from, pad)) ring.set(u.id, u);

  let jumpRingSupply = 0;
  const candidates: LaneShip[] = [];
  for (const u of ring.values()) {
    jumpRingSupply += supplyOf(u);
    // Only a real freighter can be crewed. A ship already booked on ANOTHER lane is absent from the
    // ring and therefore not offered here — `assignShipToLane` would move it over, but poaching a
    // running route is a decision to take on that route's row, not this one.
    if (holdOf(u) > 0) candidates.push(ship(u, true));
  }

  const capacity = freightCapacity(standing);
  const manifest = cargoManifest(from, capacity, commodities);
  const nextRun = Object.keys(manifest).map((com) => ({ com, qty: manifest[com]! }));
  const nextRunTotal = nextRun.reduce((sum, c) => sum + c.qty, 0);

  return {
    id: lane.id,
    from: lane.from,
    to: lane.to,
    commodities,
    filtered,
    crew,
    standingCrew: standing.length,
    capacity,
    capacityPerMinute: periodSeconds > 0 ? (capacity * 60) / periodSeconds : 0,
    nextRun,
    nextRunTotal,
    status: capacity <= 0 ? "idle" : nextRunTotal > 0 ? "shipping" : "empty",
    candidates,
    jumpRingShips: ring.size,
    jumpRingSupply,
    heldFromJump: standing.reduce((sum, u) => sum + supplyOf(u), 0),
  };
}

const holdOf = (u: Unit): number => UNITS[u.type]?.cargoHold ?? 0;
const supplyOf = (u: Unit): number => UNITS[u.type]?.supplyCost ?? 0;

const ship = (u: Unit, standing: boolean): LaneShip => ({
  unitId: u.id,
  type: u.type,
  cargoHold: holdOf(u),
  supplyCost: supplyOf(u),
  standing,
});
