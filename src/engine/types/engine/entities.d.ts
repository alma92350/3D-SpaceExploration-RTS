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

/**
 * Refinery doctrine upgrades (P2-T12). Three paths — assault, bulwark, logistics — of three tiers
 * each, plus `hardEdge`, which is `aiOnly` and carries NO `doctrine`. That absence is load-bearing:
 * `committedDoctrine` guards on `.doctrine` rather than on membership precisely so a Hard-difficulty
 * AI's seeded edge cannot read as a doctrine commitment, and anything iterating this table has to
 * make the same distinction.
 *
 * The effect fields are the engine's own numbers, applied through `upgradeMult`. A panel states
 * them; it never recomputes them.
 */
export interface UpgradeDef {
  id: string;
  name: string;
  doctrine?: "assault" | "bulwark" | "logistics";
  tier?: number;
  ico?: string;
  cost?: Resources;
  time?: number;
  requires?: string[];
  desc?: string;
  aiOnly?: boolean;
  damageDealtMult?: number;
  damageTakenMult?: number;
  attackCooldownMult?: number;
  chaseSpeedMult?: number;
  gatherYieldMult?: number;
  produceTimeMult?: number;
  regenRate?: number;
  regenDelay?: number;
  [field: string]: unknown;
}

export declare const UPGRADES: Record<string, UpgradeDef>;

/** The multiplier an owner's researched upgrades apply to `field`, 1 when none do. */
export declare function upgradeMult(upgrades: Record<string, unknown>, field: string): number;

/**
 * The doctrine an owner has committed to — researched OR merely queued at a Refinery — or undefined.
 * Committing is irreversible and locks out the other two, which is the trade-off a panel must state
 * BEFORE the click, not after it.
 */
export declare function committedDoctrine(state: State, owner: OwnerId): string | undefined;

// --- The order predicates (P5-T13) --------------------------------------------------------------
//
// `canLogisticsType` is `!!UNITS[t]?.canLogistics` and `canBuildType` is
// `canBuildCategory(t, BUILDINGS[b]?.category)`. Both are one line upstream and both are quoted
// rather than copied, because a filter re-derived above the bridge is a second answer to a question
// the engine already answers — and these are the filters that decide whether an order does anything
// at all, since every one of the orders they gate returns `void` whatever happens.

/** Can this unit type take a logistics job — repair, service, ferry? */
export declare function canLogisticsType(unitType: string): boolean;

/** Can this unit type gather? */
export declare function canGatherType(unitType: string): boolean;

/** Can this unit type build things in `category`? What `canBuildType` is built from. */
export declare function canBuildCategory(unitType: string, category: string | undefined): boolean;
