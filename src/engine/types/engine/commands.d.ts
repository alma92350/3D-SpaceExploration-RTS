export declare function issueMove(units: Unit[], x: number, y: number, queue?: boolean, formation?: unknown): void;
export declare function issueAttackMove(units: Unit[], x: number, y: number, queue?: boolean, formation?: unknown): void;
export declare function issueAttack(units: Unit[], targetId: string, queue?: boolean): void;
export declare function issueGather(units: Unit[], nodeId: string, queue?: boolean): void;
export declare function issueStop(units: Unit[]): void;
export declare function issueHold(units: Unit[]): void;
export declare function issuePatrol(units: Unit[], points: Array<{ x: number; y: number }>): void;
export declare function issueBuild(state: State, workerId: string, buildingType: string, x: number, y: number): boolean;
export declare function issueSetRally(building: Building, x: number, y: number, nodeId?: string | null): void;
