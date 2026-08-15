// The galaxy snapshot: the flat, read-only description of the roster the starmap draws (P4-T03).
//
// `bridge/snapshot.ts` describes ONE world for one tick. This describes the galaxy ABOVE that
// world — eleven entries, none of them entities, on a clock of their own. It is a second table
// rather than four more columns on `Snapshot` for the reason ADR-0008 gives for the first one: the
// view consumes flat typed arrays it cannot write, and the two subjects grow and change at
// completely different rates. A starmap redraw does not want the battlefield's 400-row tables in
// the same object, and `extract` here is cheap enough to run on every sim tick precisely because it
// is not walking entities.
//
// **`galaxyStatus` is the engine's own per-world summary and this module COPIES it.** Nine channels
// per world — `id, status, income, pacified, stance, industry, tech, faction, controlledBy` — plus
// seven galaxy-wide ones, all computed upstream. Re-deriving any of them here would disagree with
// the simulation the first time upstream changes its mind about what "colony" means (ADR-0012 §5,
// the rule `buildingConcern` established for the battlefield). Three things are *not* copies, and
// each is named where it happens:
//
//   1. The status STRING becomes a small integer, through a table. The mapping is total and its
//      failure is loud: an unrecognised status becomes `WORLD_UNKNOWN` and is recorded by name in
//      `unknownStatuses`, never quietly folded into an existing code.
//   2. Faction ids are INTERNED to indices, the same trick `typeNames` plays, because a string
//      comparison per world per frame is a string comparison per world per frame.
//   3. `x` is read from `PLANETS`. See `planetXOf` — it is the one engine rule copied here, and
//      `test/engine/galaxy-coordinates.test.ts` is what stops the copy drifting.
//
// **There is exactly one coordinate column, and that is ADR-0019's premise made structural.** The
// galaxy has one number that says where a world is; a `y` here would mean the ADR's supersede
// trigger had fired, and the test named above asserts that this file still carries one coordinate
// as well as that `PLANETS` does.

import { PLANETS, canJumpTo, galaxyStatus, jumpCost } from "../engine/index.js";

/* -------------------------------------------------------------------------------------------
   What `galaxyStatus` returns.

   Its declaration says `unknown` (`src/engine/types/engine/galaxy.d.ts`), which is honest — the
   vendored function is JavaScript and nobody has typed it. Narrowing it is exactly this module's
   job: the bridge is the typed seam (ADR-0003), so the shape is written down ONCE, here, and
   everything above sees typed arrays.
   ------------------------------------------------------------------------------------------- */

/** One world, as the engine describes it. Field for field, `galaxy.js`'s own `galaxyStatus`. */
interface EngineWorldStatus {
  id: string;
  /** `seat` | `colony` | `contested` | `pacified` | `unexplored` — see `WORLD_STATUS_CODES`. */
  status: string;
  /** Credits/min from this colony, already capped and turret-excluded by the engine. */
  income: number;
  pacified: boolean;
  /** The neighbour's attitude, -1..1, or null for a world the player has never reached. */
  stance: number | null;
  industry: number;
  tech: number;
  /** The world's FIXED cultural origin, from `data.js`. */
  faction: string | null;
  /** The DYNAMIC faction that has claimed it (`checkExpansion`), or null. */
  controlledBy: string | null;
}

interface EngineGalaxyStatus {
  credits: number;
  activeId: string;
  visited: number;
  total: number;
  pacified: number;
  dominationTarget: number;
  rivalGate: { worldId: string; charge: number } | null;
  worlds: EngineWorldStatus[];
}

/* -------------------------------------------------------------------------------------------
   World status, as a small integer.
   ------------------------------------------------------------------------------------------- */

/** Never reached. The engine hides its neighbour's stance too, so `stanceKnown` is 0 here. */
export const WORLD_UNEXPLORED = 0;
/** Where the player is standing right now — `galaxy.activeId`. */
export const WORLD_SEAT = 1;
/** Been there, still hold a building there. */
export const WORLD_COLONY = 2;
/** Been there, hold nothing there any more. The only status that reports a loss. */
export const WORLD_CONTESTED = 3;
/** The neighbour's Command Center is razed and stays razed. Sticky, and it pays income. */
export const WORLD_PACIFIED = 4;
/**
 * Upstream grew a status this bridge has never heard of.
 *
 * A sentinel rather than a silent fallback to `WORLD_UNEXPLORED`, which is what a `?? 0` would
 * have done: a sixth status rendering as "never been there" is a wrong picture that nobody would
 * ever debug. The name is kept in `unknownStatuses` so a test — and a person — can see what it was.
 */
export const WORLD_UNKNOWN = 255;

/**
 * The engine's five status strings, mapped to codes.
 *
 * These five are `galaxyStatus`'s complete vocabulary today, and
 * `test/view/starmap.test.ts` pins that against the engine's own source rather than against this
 * comment — a table that silently stopped covering the roster is precisely the failure
 * `WORLD_UNKNOWN` exists to make visible, and the source scan is what makes it visible *early*.
 */
export const WORLD_STATUS_CODES: Readonly<Record<string, number>> = {
  unexplored: WORLD_UNEXPLORED,
  seat: WORLD_SEAT,
  colony: WORLD_COLONY,
  contested: WORLD_CONTESTED,
  pacified: WORLD_PACIFIED,
};

/**
 * One engine status string, as a code. `WORLD_UNKNOWN` for anything the table above does not know.
 *
 * A named function rather than an inline `?? WORLD_UNKNOWN` because it is the one place the bridge
 * can be wrong about the engine's vocabulary, and a fallback nobody has ever seen taken is a
 * fallback nobody can trust. `test/view/starmap.test.ts` takes it, and separately pins the table
 * against the set of literals `galaxy.js` can actually assign.
 */
export function statusCodeOf(status: string): number {
  const code = WORLD_STATUS_CODES[status];
  return code === undefined ? WORLD_UNKNOWN : code;
}

/** No faction: an unclaimed world, or one whose cultural origin `data.js` leaves blank. */
export const NO_FACTION = -1;

/**
 * A parallel-array table of worlds, in `galaxy.worlds` order.
 *
 * Roster order is load-bearing rather than incidental: the background scheduler keys on a world's
 * index in that array (`stepGalaxy`), and the starmap's cross-axis stagger keys on the same index
 * (`view/starmap.ts`). Sorting this table would silently re-lay the plate.
 */
export class WorldTable {
  capacity: number;
  count = 0;

  /**
   * Engine world ids, in roster order. A string array rather than interned indices because it is
   * rebuilt only when the roster itself changes — which is at load, not per tick.
   */
  ids: string[] = [];
  /**
   * **The one coordinate a world has** (ADR-0019). The axis the engine's own two spatial functions
   * read, and the axis the plate is laid out on.
   *
   * A second column here would not be a feature; it would be the ADR's supersede trigger firing.
   */
  x: Float32Array;
  /** One of the `WORLD_*` codes. */
  status: Uint8Array;
  /** The neighbour's stance, -1..1. Meaningless unless `stanceKnown[i]` is 1. */
  stance: Float32Array;
  /**
   * 1 when the engine reported a stance at all.
   *
   * A flag rather than a sentinel value, because the sentinel would have to live inside the
   * stance's own range: -1 is *hostile*, a perfectly ordinary reading, and a map that drew an
   * unvisited world as a world that hates you would be worse than one that drew nothing.
   */
  stanceKnown: Uint8Array;
  /** Credits/min, the engine's own capped, turret-excluded figure. */
  income: Float32Array;
  /** `data.js` ratings, 1..10. Why a world is worth settling. */
  industry: Uint8Array;
  tech: Uint8Array;
  /** Index into `GalaxySnapshot.factionNames`, or `NO_FACTION`. The world's fixed origin. */
  faction: Int8Array;
  /** Index into `GalaxySnapshot.factionNames`, or `NO_FACTION`. Who has CLAIMED it since. */
  claim: Int8Array;
  pacified: Uint8Array;
  /**
   * `jumpCost`'s answer for this destination, in credits, right now.
   *
   * Carried and not re-derived, for the reason the board row gives P4-T04: `FUEL_DISCOUNT_BY_TIER`
   * makes the price depend on the origin Spaceport's tier, so anything showing `JUMP_COST` would be
   * wrong for every upgraded pad. It is on the starmap's table rather than the jump panel's because
   * ADR-0019's whole case is that **the axis IS the cost** — and `test/view/starmap.test.ts` checks
   * the drawn plate against this column, which is the only way that claim can stay true.
   */
  jumpCost: Float32Array;
  /** `canJumpTo`'s answer — not "do I have a Spaceport", which is a different and wrong question. */
  reachable: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.status = new Uint8Array(capacity);
    this.stance = new Float32Array(capacity);
    this.stanceKnown = new Uint8Array(capacity);
    this.income = new Float32Array(capacity);
    this.industry = new Uint8Array(capacity);
    this.tech = new Uint8Array(capacity);
    this.faction = new Int8Array(capacity).fill(NO_FACTION);
    this.claim = new Int8Array(capacity).fill(NO_FACTION);
    this.pacified = new Uint8Array(capacity);
    this.jumpCost = new Float32Array(capacity);
    this.reachable = new Uint8Array(capacity);
  }

  /**
   * Grow to at least `needed`, powers of two, preserving nothing.
   *
   * The roster is eleven and fixed for the life of a galaxy — but `deserializeGalaxy` APPENDS any
   * `ODYSSEY_WORLDS` entry a save predates (the roster trap P4-T09 documents), so a loaded galaxy
   * really can arrive with more worlds than the one it replaced.
   */
  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 16;
    while (next < needed) next *= 2;
    const grown = new WorldTable(next);
    this.capacity = next;
    this.x = grown.x;
    this.status = grown.status;
    this.stance = grown.stance;
    this.stanceKnown = grown.stanceKnown;
    this.income = grown.income;
    this.industry = grown.industry;
    this.tech = grown.tech;
    this.faction = grown.faction;
    this.claim = grown.claim;
    this.pacified = grown.pacified;
    this.jumpCost = grown.jumpCost;
    this.reachable = grown.reachable;
  }
}

/** No world is hosting the tracked Rival Gate. */
export const NO_WORLD = -1;

/** Everything the starmap may read. */
export interface GalaxySnapshot {
  /** Bumped on every extraction, so a view can cache derived work without diffing. */
  version: number;
  worlds: WorldTable;
  /** Stable index → engine faction id. Grows only when a faction is first seen. */
  factionNames: string[];
  /** Row index of `galaxy.activeId` — the seat. Never -1 in a well-formed galaxy. */
  activeIndex: number;
  credits: number;
  /** Worlds reached, of the whole roster. The engine's own count, not a re-count of the table. */
  visited: number;
  total: number;
  /** Conquest progress: worlds pacified, and the target the milestone fires at. */
  pacifiedCount: number;
  dominationTarget: number;
  /**
   * The tracked Rival Gate (`rivalGateStatus`) — the one alert the ENGINE itself raises for the
   * starmap. `NO_WORLD` when nobody is charging one.
   */
  rivalGateIndex: number;
  /** Its live charge, 0..1, read off the building every extraction rather than latched. */
  rivalGateCharge: number;
  /**
   * Status strings this bridge could not map, by name. Empty in the steady state.
   *
   * Kept as evidence rather than as diagnostics: a starmap drawing `WORLD_UNKNOWN` looks like a
   * rendering bug, and this is the field that says it is not one.
   */
  unknownStatuses: string[];
}

/** Every planet's `x`, built once. `PLANETS` is static data and this is a lookup, not a rule. */
const PLANET_X = new Map<string, number>(PLANETS.map((p) => [p.id, p.x]));

/**
 * A world's coordinate — **the one engine rule this module re-implements, deliberately.**
 *
 * `galaxy.js`'s own accessor is `const planetX = id => PLANETS.find(p => p.id === id)?.x ?? 0;` and
 * it is module-private, so there is no way to ask the engine for it. Two lines and a fallback are
 * copied instead, INCLUDING the `?? 0`: `jumpCost` charges an off-roster destination as if it sat
 * at the origin, and a starmap that placed the same world somewhere else would disagree with the
 * price it shows. `test/engine/galaxy-coordinates.test.ts` pins the engine's accessor by its exact
 * text, so this copy cannot drift silently — which is the only thing that makes copying it safe.
 */
function planetXOf(id: string): number {
  return PLANET_X.get(id) ?? 0;
}

/**
 * Extract the galaxy's own snapshot, reusing the previous one's buffers.
 *
 * **Runs on a simulation tick, never on a frame** — the same contract `SnapshotExtractor` has, for
 * the same reason: `galaxyStatus` allocates its own result object and array (it is upstream's
 * function and we do not fork it), so the allocation this design cannot avoid is spent at 20 Hz on
 * eleven worlds rather than at 60 Hz. Everything the VIEW touches is a reused typed array.
 */
export class GalaxySnapshotExtractor {
  readonly snapshot: GalaxySnapshot;

  private readonly factionIndexById = new Map<string, number>();

  constructor(initialCapacity = 16) {
    this.snapshot = {
      version: 0,
      worlds: new WorldTable(initialCapacity),
      factionNames: [],
      activeIndex: NO_WORLD,
      credits: 0,
      visited: 0,
      total: 0,
      pacifiedCount: 0,
      dominationTarget: 0,
      rivalGateIndex: NO_WORLD,
      rivalGateCharge: 0,
      unknownStatuses: [],
    };
  }

  extract(galaxy: Galaxy): GalaxySnapshot {
    const status = galaxyStatus(galaxy) as EngineGalaxyStatus;
    const snap = this.snapshot;
    const w = snap.worlds;
    const rows = status.worlds.length;
    w.ensure(rows);

    // The id list is rebuilt only when the roster actually changes — a comparison, not a rebuild,
    // in the steady state. It MUST be checked on every extraction rather than once at construction,
    // because a load can swap the roster underneath a live extractor (P4-T09's append-on-load).
    let sameRoster = w.ids.length === rows;
    if (sameRoster) {
      for (let i = 0; i < rows; i++) {
        if (w.ids[i] !== status.worlds[i]!.id) { sameRoster = false; break; }
      }
    }
    if (!sameRoster) w.ids = status.worlds.map((entry) => entry.id);

    if (snap.unknownStatuses.length > 0) snap.unknownStatuses.length = 0;
    snap.activeIndex = NO_WORLD;
    snap.rivalGateIndex = NO_WORLD;

    for (let i = 0; i < rows; i++) {
      const entry = status.worlds[i]!;
      const id = entry.id;

      const code = statusCodeOf(entry.status);
      w.status[i] = code;
      if (code === WORLD_UNKNOWN && !snap.unknownStatuses.includes(entry.status)) {
        snap.unknownStatuses.push(entry.status);
      }

      w.x[i] = planetXOf(id);
      // `stance` is copied RAW and is never banded here. The engine's own `stanceLabel` owns the
      // five bands (Hostile … Allied) and their thresholds move with `PEACE_THRESHOLD`; neither it
      // nor those constants is exported, so a band invented above the bridge would be a second,
      // divergent answer to a question the simulation already answers — ADR-0012 §5's exact case.
      const stance = entry.stance;
      w.stanceKnown[i] = stance === null || stance === undefined ? 0 : 1;
      w.stance[i] = w.stanceKnown[i] === 1 ? stance! : 0;

      w.income[i] = entry.income;
      w.industry[i] = entry.industry;
      w.tech[i] = entry.tech;
      w.faction[i] = this.factionIdx(entry.faction);
      w.claim[i] = this.factionIdx(entry.controlledBy);
      w.pacified[i] = entry.pacified ? 1 : 0;

      // Both are engine queries, asked per world per tick. `jumpCost` is free for a world already
      // reached and distance-scaled otherwise; `canJumpTo` is false for the seat itself, because
      // the seat is not a destination — the view has to know that rather than dim its own world.
      w.jumpCost[i] = jumpCost(galaxy, id);
      w.reachable[i] = canJumpTo(galaxy, id) ? 1 : 0;

      if (id === status.activeId) snap.activeIndex = i;
      if (status.rivalGate && status.rivalGate.worldId === id) snap.rivalGateIndex = i;
    }

    w.count = rows;
    snap.credits = status.credits;
    snap.visited = status.visited;
    snap.total = status.total;
    snap.pacifiedCount = status.pacified;
    snap.dominationTarget = status.dominationTarget;
    snap.rivalGateCharge = status.rivalGate ? status.rivalGate.charge : 0;
    snap.version++;
    return snap;
  }

  private factionIdx(name: string | null): number {
    if (!name) return NO_FACTION;
    let i = this.factionIndexById.get(name);
    if (i === undefined) {
      i = this.snapshot.factionNames.length;
      this.snapshot.factionNames.push(name);
      this.factionIndexById.set(name, i);
    }
    return i;
  }
}
