export declare const BUILD_REACH: number;
export declare function queueProduction(state: State, buildingId: string, unitType: string, alt?: boolean): boolean;
export declare function cancelProduction(state: State, buildingId: string, queueIndex: number): boolean;

/**
 * Queue a doctrine upgrade at a Refinery. Gates on: a finished Refinery, not already researched,
 * the doctrine lock, `prereqsMet` against RESEARCHED upgrades only — unlike `researchTech`, a job
 * queued ahead does NOT satisfy its successor's prerequisite — no duplicate in the queue, and
 * affordability. Returns false without side effects when any of those fails.
 */
export declare function researchUpgrade(state: State, buildingId: string, upgradeId: string): boolean;
