export declare const ODYSSEY_WORLDS: string[];
export declare function createGalaxy(opts?: GalaxyOpts): Galaxy;
export declare function stepGalaxy(galaxy: Galaxy, dt: number): void;
export declare function activeState(galaxy: Galaxy): State;
export declare function addPlanet(galaxy: Galaxy, planetId: string, opts?: { unsettled?: boolean }): State;

// ---------------------------------------------------------------------------------------------
// Phase 4 — the galaxy layer above the seat (P4-T09).
//
// Declared because the save round-trip has to be able to BUILD a galaxy worth saving: settle a
// second world, run a lane, set a standing order. Everything below is either a scheduler constant
// the test asserts against or a mutator it drives; none of it is a rule reimplemented here.
// ---------------------------------------------------------------------------------------------

/**
 * Background worlds tick once every `BG_STEP` galaxy ticks, at `BG_STEP`x the step — spread
 * round-robin by each world's index in `galaxy.worlds`. That indexing is why a save that restored
 * the roster wrong would still round-trip its *data* and stop simulating (see P4-T09).
 */
export declare const BG_STEP: number;
/** Galaxy ticks between one lane delivery cycle and the next. An integer schedule, not a timer. */
export declare const LANE_PERIOD: number;
/** Base fuel for a jump to a world you have not reached. Scaled by distance and the pad's tier. */
export declare const JUMP_COST: number;

/** Credits a jump to `destId` costs right now. Zero for a world already in `galaxy.discovered`. */
export declare function jumpCost(galaxy: Galaxy, destId: string): number;

/**
 * Move the seat to `destId`: the staged expedition rides, the origin keeps its buildings and
 * becomes a background colony (`state.background = true`), and `galaxy.activeId` moves.
 * Returns null when the jump cannot run (no pad and no foothold, same world, or too poor).
 */
export declare function jumpCapital(
  galaxy: Galaxy,
  destId: string,
  opts?: { landingPoint?: { x: number; y: number } },
): { destId: string; riders: number; leftBehind: number; cargo: Resources } | null;

/** A standing freight route between two worlds the galaxy holds. Refused for a same-world pair. */
export declare function createLane(galaxy: Galaxy, from: string, to: string, commodities?: string[]): Lane | null;
/** Book a player freighter parked at one of the source world's own Spaceports onto `laneId`. */
export declare function assignShipToLane(galaxy: Galaxy, laneId: string, unitId: string): boolean;
/** Free a ship from a lane. Returns whether it was on it. */
export declare function unassignShipFromLane(galaxy: Galaxy, laneId: string, unitId: string): boolean;
/** Run every lane one delivery cycle. Called by `stepGalaxy` on the `LANE_PERIOD` schedule. */
export declare function runLanes(galaxy: Galaxy): void;

/**
 * Bank every background colony's passive income and drain its sim events, returning the
 * notifications a UI would raise. **Not** called by `stepGalaxy` — the app drives it, so a test
 * that wants colony income in `galaxy.credits` has to drive it too.
 */
export declare function sweepColonies(galaxy: Galaxy, dt?: number): Array<{ type: string; planetId: string }>;

declare global {
  /** A Freight Lane. Field order matters: `runLanes` walks `shipIds` in place and sums their holds. */
  interface Lane {
    id: string;
    from: string;
    to: string;
    /** Empty means "every CARGO_GOODS commodity, most-valuable-first". */
    commodities: string[];
    shipIds: string[];
  }

  interface Galaxy {
    /** Standing freight routes, in creation order — the order `runLanes` moves them in. */
    lanes: Lane[];
    /** Fresh lane-id counter. Restored past every id in use, so a load cannot mint a collision. */
    laneSeq: number;
    /** The separate `"g"`-id counter for entities that cross worlds (jump riders, relief ships). */
    entitySeq: number;
    /**
     * Colony standing orders, keyed by world id (`engine/colonyPolicy.js`).
     *
     * **Optional on purpose.** `createGalaxy` does not build this map; `setColonyPolicy` creates it
     * on first use, while `deserializeGalaxy` always builds one. So a loaded galaxy carries a field
     * a freshly-created one may not — harmless, because every reader treats absent and empty the
     * same (`getColonyPolicy` returns the off default either way), but not something to declare
     * away.
     */
    colonyPolicies?: Map<string, ColonyPolicy>;
    /** Worlds whose neighbour's Command Center you have razed and kept razed. */
    pacified: Set<string>;
    /** Faction spread: world id to the faction flying its flag (`checkExpansion`). */
    claims: Map<string, string>;
    /** Progress milestones already celebrated, so a reload does not replay their fireworks. */
    reached: Set<string>;
    /** Worlds whose rival Antimatter Gate has completed and latched its stance ceiling. Lazily created, like `colonyPolicies`. */
    rivalAscended?: Set<string>;
    wonBy: string | null;
    /** Galaxy-clock time of the last relief drop, or absent when none has been sent. */
    lastReliefTime?: number;
  }
}

// --- Phase 4 presentation surface (P4-T03 … P4-T08) -------------------------------------------

/** How many neighbour worlds `createGalaxy` brings up alongside the seat. */
export declare const BACKGROUND_WORLDS: number;
export declare const JUMP_LOAD_RADIUS: number;
export declare const COLONY_INCOME_PER_BUILDING: number;
/** Credits/sec ceiling per colony. The number that makes a fifth colony worth less than a fourth. */
export declare const COLONY_INCOME_CAP: number;
export declare const PACIFIED_INCOME: number;
export declare const SPACEPORT_MAX_TIER: number;
/** Supply carried per jump, indexed by tier. Index 0 is unused. */
export declare const SPACEPORT_CAPACITY: readonly number[];
export declare const SPACEPORT_UPGRADE_COST: Readonly<Record<number, Record<string, number>>>;
/** Fuel multiplier by tier. Why `jumpCost` must be asked and `JUMP_COST` never shown. */
export declare const FUEL_DISCOUNT_BY_TIER: readonly number[];
export declare const CARGO_GOODS: readonly string[];
/** The landing picker's own snap grid. A raw click disagrees with where the colony lands. */
export declare const LANDING_PICK_GRID: number;

export declare function canJump(state: State): boolean;
/**
 * Not "do I have a Spaceport". A stranded force can always fall back to a world where it still
 * holds a Command Center or an undeployed colony ship — the rule that stops a portless world
 * being a trap.
 */
export declare function canJumpTo(galaxy: Galaxy, destId: string): boolean;
export declare function jumpVessel(state: State): Unit | null;
/** Who is actually standing in the ring. Lane-booked ships are skipped. */
export declare function stagedRiders(state: State, spaceport: Building): Unit[];
/**
 * What would actually ride, and what would be left standing.
 *
 * **`staged` and `leftBehind` are COUNTS, and `stagedSupply` is supply, not hulls** — a manifest
 * that reported a head count where the engine caps on supply would be right for an army of Skiffs
 * and wrong for one Heavy Hauler. `used`/`capacity` are the supply the riders spend and the pad's
 * tier ceiling. (An earlier version of this declaration invented `supply` and `left`: both
 * type-checked and were `undefined` at runtime, which is precisely the fiction ADR-0003's façade
 * exists to prevent. Verified against `galaxy.js:1013` and `galaxy.js:1063`.)
 */
export declare function jumpManifest(state: State, spaceport: Building): {
  riders: Unit[]; capacity: number; used: number;
  stagedSupply: number; staged: number; leftBehind: number;
};
export declare function jumpManifestAll(state: State): {
  riders: Unit[]; capacity: number; used: number;
  stagedSupply: number; staged: number; leftBehind: number;
};
export declare function spaceportTier(b: Building): number;
export declare function jumpCapacity(b: Building): number;
export declare function upgradeSpaceport(state: State, building: Building): boolean;
export declare function playerSpaceports(state: State): Building[];
export declare function freightCapacity(riders: Unit[]): number;
export declare function cargoManifest(
  from: State, capacity?: number, goods?: readonly string[],
): Record<string, number>;
/** Returns the quantity actually moved — **not** a boolean. 0 means nothing moved. */
export declare function loadFreighter(state: State, unitId: string, com: string, qty: number): number;
export declare function unloadFreighter(state: State, unitId: string, com: string, qty: number): number;
export declare function deleteLane(galaxy: Galaxy, laneId: string): boolean;
/** The engine's own landing snap. A picker that used the raw click would disagree with it. */
export declare function snapLandingPoint(map: GameMap, x: number, y: number): { x: number; y: number };
export declare function previewPlanet(galaxy: Galaxy, planetId: string): unknown;
/** The engine's own per-world summary. Report it; never re-derive it. */
export declare function galaxyStatus(galaxy: Galaxy): unknown;
export declare function backgroundWorldIds(seed: number, startId: string, count?: number): string[];

/**
 * The landing sites a map actually offers, per axis (added upstream in 50ceb88, issue #94).
 *
 * The site list is the source of truth, not the bare grid: near a map edge the two disagree, and
 * "nearest multiple of LANDING_PICK_GRID" was wrong by up to 60 units there. `snapLandingPoint`
 * picks the nearest entry of these, which is what makes it a fixed point.
 */
export declare function landingSites(map: GameMap): { xs: number[]; ys: number[] };
