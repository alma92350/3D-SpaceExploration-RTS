/**
 * What the AI knows about its enemy, and how stale it is (P3-T15).
 *
 * The whole module reads `state.fogs[owner]` — `state.fogAI` for the AI — and never the player's
 * fog. That is the fairness guarantee, and P3-T15 exists to prove it holds rather than to build it:
 * "the AI cheats" is unfalsifiable without a test and is the first thing a playtester assumes.
 */

/** Sim seconds an unrefreshed belief takes to fade to nothing. Four minutes. */
export declare const INTEL_FADE: number;
/** Ore-value of seen enemy assets at which the AI considers itself fully informed. */
export declare const INTEL_FULL: number;

/** What `owner` can see of its enemy RIGHT NOW, through `owner`'s own fog. Split by role. */
export declare function sightEnemy(state: State, owner?: string): { mil: number; eco: number };

/** Fold this cycle's sighting into `owner`'s persistent belief. Only a sighting raises it. */
export declare function updateIntel(state: State, owner?: string): void;

/**
 * `owner`'s current read of its enemy. `posture` is null when nothing has ever been seen — which
 * the caller must handle separately from "they are peaceful".
 */
export declare function readEnemy(state: State, owner?: string): {
  posture: number | null;
  confidence: number;
  mil: number;
  eco: number;
  age: number | null;
};
