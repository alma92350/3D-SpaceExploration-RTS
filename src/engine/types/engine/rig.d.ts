/** One row of `YIELD_TIERS`: what a dig of that tier multiplies the rig's base yield by. */
export interface YieldTier { name: string; mult: number; p: number }

/**
 * A placement-time READING of the ground, from a caller-supplied node list.
 *
 * The node list is the whole point of the signature. The sim surveys ALL nodes, deterministically;
 * a UI must pass only the ones the player has actually discovered, so a hidden cache stays a
 * surprise. That makes the placement reading an honest guess rather than a preview of the answer —
 * hence `confidence`, which is the winning vein's share of the total nearby weight.
 */
export interface RigSurvey {
  /** The most likely vein below, or null when no discovered deposit is in range — a blind spot. */
  likelyVein: string | null;
  /** 0..1. The winner's share of nearby weight, NOT a probability that the guess is right. */
  confidence: number;
  richness: number;
  richLabel: string;
}

/** A read-only snapshot of a built rig, for the HUD. `lastTier` is the ROLLED tier — never re-derive it. */
export interface RigInfo {
  vein: string;
  richness: number;
  richLabel: string;
  /** 0..1 through the current dig cycle. */
  progress: number;
  /** The name of the `YIELD_TIERS` row the last dig struck, or null before the first dig. */
  lastTier: string | null;
  lastYield: number;
  nuclearOk: boolean;
  throttle: number;
  stored: number;
  storeCap: number;
  storeFull: boolean;
}

export declare const PLASMA_VEINS: string[];
/** How far out a rig reads the surface. A deposit beyond this contributes nothing at all. */
export declare const SURVEY_RADIUS: number;
export declare const YIELD_TIERS: YieldTier[];

export declare function locationRichness(state: State, x: number, y: number): number;
export declare function rigSurvey(
  nodes: ResourceNode[], planetId: string, x: number, y: number,
): RigSurvey;
export declare function rigInfo(state: State, building: Building): RigInfo | null;
