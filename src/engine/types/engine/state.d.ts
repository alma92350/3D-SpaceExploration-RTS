export declare function createGameState(opts?: GameStateOpts): State;
export declare function makeUnit(type: string, owner: OwnerId, x: number, y: number): Unit;
export declare function makeBuilding(type: string, owner: OwnerId, x: number, y: number, opts?: { hp?: number; constructing?: boolean }): Building;
export declare function getEntity(state: State, id: string): Entity | undefined;
export declare function playerUnits(state: State, owner: OwnerId): Unit[];
export declare function playerBuildings(state: State, owner: OwnerId): Building[];
