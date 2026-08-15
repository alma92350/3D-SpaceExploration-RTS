/**
 * How a match ends, and what it was worth (P5-T08).
 *
 * `scoreBreakdown` is broken out rather than collapsed into a total, and upstream's own comment
 * says why: "so a HUD can show WHY". A score recomputed above the bridge disagrees with the engine
 * the first time a weight moves.
 */
export declare const DEFAULT_MATCH_TIME_LIMIT: number;
export declare function checkWinCondition(state: State): unknown;
export declare function checkEndlessLoss(state: State): unknown;
export declare function checkEndlessWin(state: State): unknown;
export declare function scoreBreakdown(state: State, owner: string): Record<string, number>;
export declare function playerScore(state: State, owner: string): number;
