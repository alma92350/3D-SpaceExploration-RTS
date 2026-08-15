/** Logistics dispatch priorities, in the engine's own order. */
export declare const LOGI_PRIORITIES: ReadonlyArray<"high" | "normal" | "low">;
export declare function countLogistics(state: State): Record<string, number>;
export declare function aiUpkeepRate(unit: Unit): number;

/** The upgrade id `issueSetAILogistics` gates on. A freighter cannot be automated without it. */
export declare const FREIGHTER_AI_TECH: string;

/**
 * Assign a ferry run. The automatic counterpart to `issueFerryFreighter`.
 *
 * Takes no target and answers nothing: it SCANS for a collection-point freighter with room and
 * assigns the run itself. Declared `(state, unit, freighterId): boolean` when it was first written
 * here, which was wrong on both counts — a caller trusting that would have passed an id nothing
 * reads and branched on an `undefined` it read as a refusal.
 */
export declare function assignFerry(state: State, unit: Unit): void;
