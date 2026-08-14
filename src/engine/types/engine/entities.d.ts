export declare const UNITS: Record<string, UnitDef>;
export declare const BUILDINGS: Record<string, BuildingDef>;
export declare const VETERANCY_RANKS: Array<{ kills: number; name: string; damage: number; taken: number }>;
export declare function canAfford(resources: Resources, cost: Resources): boolean;
/**
 * Are `def.requires`' prerequisites met for `owner`?
 *
 * Takes anything with a `requires` list, not only a full entity def — `researchTech` calls it with
 * a bare `{ requires }` to check a tech's prerequisites minus the ones already queued ahead. The
 * declaration said `BuildingDef | UnitDef`, which was narrower than the function, and the narrower
 * type made the engine's own idiom a type error above the bridge.
 */
export declare function prereqsMet(state: State, owner: OwnerId, def: { requires?: string[] }): boolean;
export declare function hasCompletedBuilding(state: State, owner: OwnerId, type: string): boolean;
export declare function canBuildType(unitType: string, buildingType: string): boolean;

/** Output-buffer accounting. A factory stalls when `storeRoom` reaches zero (industry.js). */
export declare function storeCapOf(type: string): number;
export declare function storeTotal(building: Building): number;
export declare function storeRoom(building: Building): number;
export declare function inputTotal(building: Building): number;
/** Per-commodity input capacity — the larder is split evenly across a recipe's real inputs. */
export declare function inputCapOf(type: string): number;
/** Whether a building type can take the +30% electrification upgrade. The engine's own list. */
export declare function isElectrifiable(type: string): boolean;
