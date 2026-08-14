// The typed façade onto the vendored simulation (ADR-0003).
//
// This is the ONLY module in the project that imports vendored JavaScript. Everything above it —
// including `bridge/`, which is the only layer allowed to import *this* — sees a normal typed
// module. Two things fall out of that, both deliberate:
//
//   • The JS/TS boundary is one file wide. When upstream changes shape, exactly one place breaks.
//   • The `@engine/*` specifier is what makes the declarations in `types/` bind to the vendored
//     JS at all: tsconfig maps it to `src/engine/types/*` (declarations) and Vite maps it to
//     `src/engine/*` (the real code). Neither half works alone, and neither may point elsewhere.
//
// `view/` may not import this, or anything under it (ADR-0008, enforced by
// `test/architecture/layering.test.ts`).

export {
  ODYSSEY_WORLDS, BACKGROUND_WORLDS, createGalaxy, stepGalaxy, activeState, addPlanet,
} from "@engine/engine/galaxy.js";

export {
  createGameState, makeUnit, makeBuilding, getEntity, playerUnits, playerBuildings,
} from "@engine/engine/state.js";

export { tick } from "@engine/engine/sim.js";

export {
  MAP_WIDTH, MAP_HEIGHT, TERRAIN_CELL_SIZE, TERRAIN, NODE_RADIUS, sampleTerrain, generateMap,
} from "@engine/engine/map.js";

export { FOG_CELL_SIZE, isVisibleAt, isExploredAt, isNodeDiscovered } from "@engine/engine/fog.js";

export {
  UNITS, BUILDINGS, VETERANCY_RANKS, canAfford, prereqsMet, hasCompletedBuilding, canBuildType,
} from "@engine/engine/entities.js";

export {
  issueMove, issueAttackMove, issueAttack, issueGather, issueStop, issueHold, issuePatrol,
  issueBuild, issueSetRally, issueRecycle, issueCancelRecycle, issueSetLogiPriority,
  issueServiceBuilding, issueRepair,
} from "@engine/engine/commands.js";

export { BUILD_REACH, queueProduction, cancelProduction } from "@engine/engine/production.js";

export { canPlaceBuilding, findPlacement, radiusOf } from "@engine/engine/colliders.js";

// The Odyssey opening: both sides land with a colony ship rather than a placed Command Center, so
// "deploy" is the first order a player ever gives. Phase 1 needs it even though the PRD's MVP
// roster does not name it — without it there is no base, and S1's demo cannot start.
export { COLONY_SHIP_WORKERS, deployColonyShip, hasColonyShip } from "@engine/engine/colony.js";

export { supplyUsed, supplyCap } from "@engine/engine/supply.js";

export {
  SAVE_VERSION, GALAXY_SAVE_VERSION, serializeGalaxy, serializeGalaxyString, deserializeGalaxy,
} from "@engine/engine/persist.js";

// ---------------------------------------------------------------------------------------------
// Phase 2 — the economy (ADR-0012).
//
// Every one of these is a *query* or a *command the engine validates*. None of them is a rule this
// project reimplements: a market price recomputed above the bridge disagrees with the engine
// within one trade, and a stop reason derived from buffer levels disagrees with it the first time
// `updateProduction`'s gating order changes. `buildingConcern` in particular exists upstream for
// exactly the job the view wants it for.
// ---------------------------------------------------------------------------------------------

export {
  POWER_TIERS, ELECTRIFY_POWER, recipeOf, powerEfficiency, onPowerGrid, powerCap, powerDraw,
  powerThrottle, buildingConcern,
} from "@engine/engine/industry.js";
export type { PowerTier, Recipe, BuildingConcern } from "@engine/engine/industry.js";

export {
  storeCapOf, storeTotal, storeRoom, inputTotal, inputCapOf, isElectrifiable,
} from "@engine/engine/entities.js";

export {
  TRADE_LOT, PRESSURE_FLOOR, PRESSURE_CEIL, GLUT_CEIL, createMarket, unitPrice, quoteSell, buy,
  sell, tradeables, commodityAvailable,
} from "@engine/engine/market.js";

export { TECHS, researchTech, cancelResearch, techMult } from "@engine/engine/techtree.js";
export type { TechDef } from "@engine/engine/techtree.js";

export { canRecycle, beginRecycle, cancelRecycle, recycleValue } from "@engine/engine/recycle.js";

export { NEEDS_REPAIR, HEALED, pickRepairTarget, countRepairJobs } from "@engine/engine/repair.js";

export { LOGI_PRIORITIES, countLogistics, aiUpkeepRate } from "@engine/engine/haul.js";

export { PLASMA_VEINS, SURVEY_RADIUS, YIELD_TIERS, locationRichness, rigInfo } from "@engine/engine/rig.js";

export { PLANETS, COM } from "@engine/data.js";
