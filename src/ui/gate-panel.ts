// The Antimatter Gate, and the race against the rival's (P5-T05).
//
// **The Gate is a 150-second clock, and a clock is the whole legibility problem.** `updateWonder`
// advances `charge` by `dt / chargeTime` per tick and does nothing visible in between — the same
// shape as P4-T07's lane period, and the same failure if it is left unsaid. So this model leads
// with the countdown: how long a full charge is, how much of it is left, and — the part a period
// did not need — how much of it the stockpile can actually pay for. `secondsRemaining` is not
// decoration; `test/ui/gate-panel.test.ts` steps the simulation and asserts the Gate arrives when
// the model said it would, and stops where the model said it would stop.
//
// **`chargingWonderOf` is the engine's own detector, and it answers `null` four different ways.**
// A wonder is "charging" to that function only while `0 < charge < 1` on a COMPLETED building, so
// one identical `null` covers: no Gate at all, a Gate still under construction, a Gate that has
// never taken a single tick of charge, and a Gate already at full charge. A panel built on that
// answer alone would show the finished Gate and the missing Gate the same way — which is P2-T15's
// `worn` again, and the reason `status`, `started` and `chargingId` are three separate fields here
// rather than one. `chargingId` is the engine's verdict reported raw; `status` and `started` are
// what tell the four `null`s apart. **The engine has no query that makes that distinction — it is
// added here, and every "charging" claim is pinned back to `chargingWonderOf` by test.**
//
// **What the stockpile buys is arithmetic, and it is arithmetic the engine performs.** `updateWonder`
// clamps each step to `stock / (feed[com] * chargeTime)` — "full charges' worth in stock" — and
// spends exactly what it banks, so a fixed stockpile carries the charge a fixed distance and no
// further. `reachableCharge` is that distance. It is a number computed above the bridge, which this
// project distrusts on principle, so it is proved the only way such a number can be: the test
// starves a Gate to a quarter of a charge, runs the simulation far past the point it must stop, and
// asserts it stopped exactly there.
//
// **The rival's Gate is asked for, never looked for.** `galaxyStatus().rivalGate` is the engine's
// own answer and already the starmap's alert (`view/starmap.ts` `alertForWorld`) — this file makes
// the SAME call the bridge makes, so the panel and the map cannot disagree about who is charging or
// how far along they are. Scanning the worlds for an AI wonder would be a second answer to a
// question `checkRivalGate` already answers, and the two would part company the first time its
// selection rule moved.
//
// **And the alert goes out at the worst possible moment.** When a rival Gate completes,
// `checkRivalGate` ascends the world and clears its own tracked record — so `galaxyStatus().rivalGate`
// becomes `null`, and the starmap's alert, which is that field, simply stops being drawn. "Nobody is
// racing you" and "somebody finished" are the same picture on the map. `ascendedWorlds` is
// `checkRivalGate`'s own `rivalAscended` latch reported directly, and it is the only thing in either
// surface that tells those two apart.

import {
  BUILDINGS, activeState, chargingWonderOf, galaxyStatus,
  powerCap, powerDraw, powerThrottle, prereqsMet,
} from "../engine/index.js";

/* -------------------------------------------------------------------------------------------
   Engine shapes the hand-written declarations do not carry.

   Three narrow casts, each for a field that exists in the vendored JavaScript and has never been
   declared. The same move `test/view/starmap.test.ts` makes for `galaxy.rivalGate` and the bridge
   makes for `galaxyStatus`: write the shape down once, next to the only code that reads it.
   ------------------------------------------------------------------------------------------- */

/** `BUILDINGS[t]`'s wonder fields — `entities.js`' `antimatter_gate`, verbatim. */
interface WonderDef {
  wonder?: boolean;
  /** Goods burned per second of charging. A whole charge costs `feed[com] * chargeTime`. */
  feed?: Record<string, number>;
  chargeTime?: number;
  /** Grid load while charging. `industry.js powerDraw` adds it only while `charge < 1`. */
  powerDraw?: number;
  requires?: string[];
  cost?: Record<string, number>;
  name?: string;
}

/** `updateWonder` writes `charge` straight onto the building; `Building` does not declare it. */
interface Charged { charge?: number }

/** What this file reads of `galaxyStatus` — the rival-Gate field, and nothing else. */
interface StatusWithRivalGate { rivalGate: { worldId: string; charge: number } | null }

/** `checkRivalGate`'s own tracking record. Transient galaxy bookkeeping, undeclared upstream. */
interface GalaxyWithRivalGate { rivalGate?: { worldId: string; buildingId: string } | null }

const chargeOf = (b: Building): number => (b as Charged).charge ?? 0;
const defOf = (type: string): WonderDef | undefined => BUILDINGS[type] as WonderDef | undefined;
const isWonder = (b: Building): boolean => defOf(b.type)?.wonder === true;

/** The Gate's own id in `entities.js`. The one type string this file names. */
export const GATE_TYPE = "antimatter_gate";

/* =================================================================================================
   MODEL
   ================================================================================================= */

/**
 * What a Gate is doing right now.
 *
 * Deliberately NOT a re-spelling of `chargingWonderOf`'s boolean: `charging` and `stalled` are both
 * states that function calls "charging", and `building`/`online` are both states it calls nothing at
 * all. Read alongside `started`, these six tell apart every situation the engine's own detector
 * collapses into one `null`.
 */
export type GateStatus = "building" | "charging" | "stalled" | "online";

/** One fed strategic good, with the engine's own clamp term spelled out. */
export interface GateFeed {
  readonly com: string;
  /** Burn rate per second of charging — `def.feed[com]`. */
  readonly perSecond: number;
  /** What a WHOLE charge costs of this good — `feed[com] * chargeTime`. */
  readonly perCharge: number;
  /** The owner's stockpile of it. */
  readonly stock: number;
  /** Full charges' worth in stock — `updateWonder`'s own `res[com] / perCharge`. */
  readonly charges: number;
  /** The good `updateWonder`'s `Math.min` is currently choosing. Ties mark every good that ties. */
  readonly binding: boolean;
}

/** A Gate the player owns, wherever in the galaxy it stands. */
export interface OwnGate {
  readonly worldId: string;
  readonly buildingId: string;
  readonly status: GateStatus;
  /** 0..1, straight off the building. */
  readonly charge: number;
  /**
   * Whether any charge has been banked at all.
   *
   * The field that separates "not started" from "started and stalled" — the distinction this
   * project lost once already (P2-T15's `worn`). A starved Gate sits at `charge === 0` forever and
   * `chargingWonderOf` reports it exactly as it reports a Gate that was never built.
   */
  readonly started: boolean;
  /**
   * `chargingWonderOf(state, "player")?.id` — the ENGINE's verdict, reported raw and never
   * second-guessed. `null` for a Gate that is constructing, unstarted, or already online, which is
   * precisely why `status` exists next to it.
   */
  readonly chargingId: string | null;
  /** `def.chargeTime` — 150 s of charging at full feed. */
  readonly chargeTime: number;
  /** `(1 - charge) * chargeTime`: seconds to full at the fed rate, which is the rate `updateWonder` runs at. */
  readonly secondsRemaining: number;
  readonly feed: readonly GateFeed[];
  /**
   * Where the CURRENT stockpile alone carries the charge, with no further income — `charge` plus
   * the scarcest good's `charges`, capped at 1. `updateWonder` spends exactly what it banks, so
   * this is where the Gate stops, not an estimate of it.
   */
  readonly reachableCharge: number;
  /** That distance as a clock. Zero means the next tick does nothing — `status` is `stalled`. */
  readonly runwaySeconds: number;
  /**
   * The Gate is loading the power grid. `industry.js powerDraw` counts a wonder's draw while it is
   * completed and below full charge, so this is that predicate, and it stops the moment it finishes.
   */
  readonly onGrid: boolean;
  /** Its own contribution to the draw, before the distance-to-Reactor line loss. */
  readonly gridDraw: number;
  /** The owner-wide grid, so the tax the Gate levies on the factories is visible while it runs. */
  readonly power: { readonly draw: number; readonly cap: number; readonly throttle: number };
}

/** The rival Gate the engine is tracking. */
export interface RivalGate {
  /** `galaxyStatus().rivalGate.worldId` — the field the starmap's own alert indexes on. */
  readonly worldId: string;
  readonly charge: number;
  readonly started: boolean;
  readonly secondsRemaining: number;
  /** `checkRivalGate`'s own tracked building id, or null if the record has gone stale. */
  readonly buildingId: string | null;
  /**
   * The tracked Gate is still being BUILT.
   *
   * `checkRivalGate` selects through `aiWonderOn`, which does not skip a constructing building, so a
   * rival Gate is tracked — and alerted on — from the moment its foundation is laid. Without this
   * flag a charge of 0 could equally mean "raised and starving", and those are not the same news.
   */
  readonly constructing: boolean;
}

export interface GatePanelModel {
  /** `chargeTime` from the Gate's own definition. The clock the whole match bends around. */
  readonly chargeTime: number;
  readonly gateName: string;
  /** The Gate's `requires` — the whole Strategic tier — and its build cost, from `entities.js`. */
  readonly requires: readonly string[];
  readonly cost: Readonly<Record<string, number>>;
  /** `prereqsMet` on the SEAT. The answer to "why is there no Gate" when `ours` is empty. */
  readonly seatPrereqsMet: boolean;
  readonly seatWorldId: string;
  /** Every Gate the player owns, in the galaxy's own roster order. Empty means none exists. */
  readonly ours: readonly OwnGate[];
  /** The one `chargingWonderOf` would name on the seat, or null — the engine's answer, unchanged. */
  readonly seatChargingId: string | null;
  /**
   * The tracked rival Gate, or null.
   *
   * `null` covers both "nobody is racing" and "somebody already won the race" — `checkRivalGate`
   * clears its own record on ascension. `ascendedWorlds` is what separates them.
   */
  readonly rival: RivalGate | null;
  /** `galaxy.rivalAscended` — worlds whose rival Gate COMPLETED, in roster order. */
  readonly ascendedWorlds: readonly string[];
  /** True once any rival has finished. Permanent: the latch is never cleared. */
  readonly rivalAscended: boolean;
}

/* =================================================================================================
   BUILD
   ================================================================================================= */

/**
 * The Gate on both sides of the race.
 *
 * Pure: reads galaxy and world state and calls only engine QUERIES. In particular it never calls
 * `checkRivalGate` — that function selects, ascends and raises a milestone, and a panel that ran it
 * on open would make opening the panel change the game.
 */
export function gatePanelModel(galaxy: Galaxy): GatePanelModel {
  const def = defOf(GATE_TYPE) ?? {};
  const chargeTime = def.chargeTime ?? 0;
  const seat = activeState(galaxy);

  const ours: OwnGate[] = [];
  // Roster order, never `galaxy.planets`' insertion order — the same discipline `checkRivalGate`
  // and `checkExpansion` hold themselves to, so two runs of the same galaxy list Gates alike.
  for (const worldId of galaxy.worlds) {
    const state = galaxy.planets.get(worldId);
    if (!state) continue;
    // The engine's detector, asked once per world, and carried into the row it belongs to.
    const charging = chargingWonderOf(state, "player");
    for (const b of state.buildings.values()) {
      if (b.owner !== "player" || !isWonder(b)) continue;
      ours.push(ownGate(state, worldId, b, charging ? charging.id : null));
    }
  }

  const status = galaxyStatus(galaxy) as StatusWithRivalGate;
  const seatCharging = chargingWonderOf(seat, "player");

  return {
    chargeTime,
    gateName: def.name ?? GATE_TYPE,
    requires: def.requires ? [...def.requires] : [],
    cost: def.cost ? { ...def.cost } : {},
    seatPrereqsMet: prereqsMet(seat, "player", def),
    seatWorldId: galaxy.activeId,
    ours,
    seatChargingId: seatCharging ? seatCharging.id : null,
    rival: rivalGate(galaxy, status, chargeTime),
    ascendedWorlds: galaxy.worlds.filter((id) => galaxy.rivalAscended?.has(id) ?? false),
    rivalAscended: (galaxy.rivalAscended?.size ?? 0) > 0,
  };
}

function ownGate(state: State, worldId: string, b: Building, chargingId: string | null): OwnGate {
  const def = defOf(b.type) ?? {};
  const chargeTime = def.chargeTime ?? 0;
  const charge = chargeOf(b);
  const res = state.players.player.resources;

  // `updateWonder`'s own clamp, term for term: a good's whole-charge cost is `feed[com] * chargeTime`
  // and the step is bounded by how many whole charges the stockpile holds of it.
  const feedDef = def.feed ?? {};
  const feed: GateFeed[] = [];
  let scarcest = Infinity;
  for (const com of Object.keys(feedDef)) {
    const perSecond = feedDef[com] ?? 0;
    const perCharge = perSecond * chargeTime;
    const stock = res[com] ?? 0;
    // A good with no cost never limits anything — the engine skips it with `if (perCharge > 0)`,
    // and dividing by it here would put an Infinity into the minimum.
    const charges = perCharge > 0 ? stock / perCharge : Infinity;
    if (charges < scarcest) scarcest = charges;
    feed.push({ com, perSecond, perCharge, stock, charges, binding: false });
  }
  const limited = feed.map((f) => ({ ...f, binding: f.charges === scarcest }));

  const remaining = Math.max(0, 1 - charge);
  // `Math.min(dt / chargeTime, 1 - charge)` first, then the stock clamp — so a stockpile richer
  // than the charge remaining still stops at full, and nothing is spent for charge not banked.
  const affordable = Number.isFinite(scarcest) ? Math.min(remaining, Math.max(0, scarcest)) : remaining;
  const reachableCharge = charge + affordable;

  const online = charge >= 1;
  const onGrid = !b.constructing && !online;
  const status: GateStatus = b.constructing ? "building"
    : online ? "online"
    : affordable > 0 ? "charging"
    : "stalled";

  return {
    worldId,
    buildingId: b.id,
    status,
    charge,
    started: charge > 0,
    chargingId: chargingId === b.id ? b.id : null,
    chargeTime,
    secondsRemaining: remaining * chargeTime,
    feed: limited,
    reachableCharge,
    runwaySeconds: affordable * chargeTime,
    onGrid,
    gridDraw: onGrid ? def.powerDraw ?? 0 : 0,
    power: {
      draw: powerDraw(state, "player"),
      cap: powerCap(state, "player"),
      throttle: powerThrottle(state, "player"),
    },
  };
}

/**
 * The rival's Gate, as the engine reports it.
 *
 * `galaxyStatus` decides whether there is one and how far along it is — the same call, on the same
 * galaxy, that `bridge/galaxy-snapshot.ts` makes for the starmap's alert. The tracked BUILDING is
 * then read off `checkRivalGate`'s own record for the one thing the status object leaves out, and
 * `galaxyStatus`' answer wins wherever the two could differ: a razed Gate leaves the record standing
 * until the next scan, and the map stops alerting on it immediately.
 */
function rivalGate(galaxy: Galaxy, status: StatusWithRivalGate, chargeTime: number): RivalGate | null {
  const live = status.rivalGate;
  if (!live) return null;

  const tracked = (galaxy as GalaxyWithRivalGate).rivalGate ?? null;
  const onTrackedWorld = tracked && tracked.worldId === live.worldId ? tracked : null;
  const b = onTrackedWorld ? galaxy.planets.get(live.worldId)?.buildings.get(onTrackedWorld.buildingId) : undefined;

  return {
    worldId: live.worldId,
    charge: live.charge,
    started: live.charge > 0,
    secondsRemaining: Math.max(0, 1 - live.charge) * chargeTime,
    buildingId: onTrackedWorld ? onTrackedWorld.buildingId : null,
    constructing: b ? b.constructing : false,
  };
}
