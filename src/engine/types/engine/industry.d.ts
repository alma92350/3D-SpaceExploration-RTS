/** One band of the grid-efficiency field: the further from a source, the more capacity a job draws. */
export interface PowerTier {
  name: "linked" | "near" | "far" | "isolated";
  /** Outer edge of the band, in range-scaled distance. `Infinity` for the outermost. */
  max: number;
  mult: number;
  label: string;
}

/** A factory recipe. `in` is per batch; `energy` in it is a power *flow*, not a consumed good. */
export interface Recipe {
  id: string;
  out: string;
  qty: number;
  in: Resources;
  req?: string;
  kind: "refine" | "make";
}

/** Why a producer is not producing. `code` is absent when `level` is "paused". */
export interface BuildingConcern {
  level: "paused" | "bad" | "warn";
  code?: "noPower" | "noFuel" | "starved" | "bufferFull" | "throttled";
}

export declare const POWER_TIERS: PowerTier[];
export declare const ELECTRIFY_POWER: number;

export declare function recipeOf(building: { type: string }): Recipe | null | undefined;
export declare function powerEfficiency(state: State, owner: OwnerId, x: number, y: number): PowerTier;
export declare function onPowerGrid(state: State, owner: OwnerId, x: number, y: number): boolean;
export declare function powerCap(state: State, owner: OwnerId): number;
export declare function powerDraw(state: State, owner: OwnerId): number;
export declare function powerThrottle(state: State, owner: OwnerId): number;

/**
 * The engine's own "is this building doing its job?" read, priority-ordered to match
 * `updateProduction`'s gating exactly. The bridge uses it rather than deriving a stop reason, so
 * the badge can never disagree with the simulation (ADR-0012 §5).
 */
export declare function buildingConcern(state: State, b: Building): BuildingConcern | null;
