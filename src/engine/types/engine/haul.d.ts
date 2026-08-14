/** Logistics dispatch priorities, in the engine's own order. */
export declare const LOGI_PRIORITIES: ReadonlyArray<"high" | "normal" | "low">;
export declare function countLogistics(state: State): Record<string, number>;
export declare function aiUpkeepRate(unit: Unit): number;
