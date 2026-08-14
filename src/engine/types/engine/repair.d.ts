export declare const NEEDS_REPAIR: number;
export declare const HEALED: number;
export declare function pickRepairTarget(state: State, owner: OwnerId, x: number, y: number, opts?: Record<string, unknown>): Entity | null;
export declare function countRepairJobs(state: State): number;
