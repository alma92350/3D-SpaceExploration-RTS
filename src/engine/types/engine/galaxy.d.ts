export declare const ODYSSEY_WORLDS: string[];
export declare const BACKGROUND_WORLDS: number;
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
