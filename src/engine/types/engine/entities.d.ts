export declare const UNITS: Record<string, UnitDef>;
export declare const BUILDINGS: Record<string, BuildingDef>;
export declare const VETERANCY_RANKS: Array<{ kills: number; name: string; damage: number; taken: number }>;
export declare function canAfford(resources: Resources, cost: Resources): boolean;
export declare function prereqsMet(state: State, owner: OwnerId, def: BuildingDef | UnitDef): boolean;
export declare function hasCompletedBuilding(state: State, owner: OwnerId, type: string): boolean;
export declare function canBuildType(unitType: string, buildingType: string): boolean;
