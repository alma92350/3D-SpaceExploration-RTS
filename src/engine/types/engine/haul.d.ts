/** Logistics dispatch priorities, in the engine's own order. */
export declare const LOGI_PRIORITIES: ReadonlyArray<"high" | "normal" | "low">;
export declare function countLogistics(state: State): Record<string, number>;
export declare function aiUpkeepRate(unit: Unit): number;

/** The upgrade id `issueSetAILogistics` gates on. A freighter cannot be automated without it. */
export declare const FREIGHTER_AI_TECH: string;

/** Assign a ferry run. The automatic counterpart to `issueFerryFreighter`. */
export declare function assignFerry(state: State, unit: Unit, freighterId: string): boolean;
