export declare function issueMove(units: Unit[], x: number, y: number, queue?: boolean, formation?: unknown): void;
export declare function issueAttackMove(units: Unit[], x: number, y: number, queue?: boolean, formation?: unknown): void;
export declare function issueAttack(units: Unit[], targetId: string, queue?: boolean): void;
export declare function issueGather(units: Unit[], nodeId: string, queue?: boolean): void;
export declare function issueStop(units: Unit[]): void;
export declare function issueHold(units: Unit[]): void;
export declare function issuePatrol(units: Unit[], points: Array<{ x: number; y: number }>): void;
export declare function issueBuild(state: State, workerId: string, buildingType: string, x: number, y: number): boolean;
export declare function issueSetRally(building: Building, x: number, y: number, nodeId?: string | null): void;

// --- Phase 2 (P2-T03). Upstream's own orders for the economy; the bridge calls these, never
// a field. Pause and electrify have no order upstream — the 2D HUD flips those flags directly.
export declare function issueRecycle(entities: Entity[]): void;
export declare function issueCancelRecycle(entities: Entity[]): void;
export declare function issueSetLogiPriority(state: State, buildingId: string, priority: string): void;
export declare function issueServiceBuilding(units: Unit[], buildingId: string, queue?: boolean): void;
export declare function issueRepair(units: Unit[], targetId: string, queue?: boolean): void;
