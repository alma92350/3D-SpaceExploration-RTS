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
  // Phase 3 (P3-T11, P3-T12). Both have existed upstream since before this project started and
  // neither was ever exposed: formations and escorts are wiring, not invention.
  issueEscort, issueHoldFormation, issueScout,
} from "@engine/engine/commands.js";

export {
  FORMATION_SHAPES, LEADER_POSITIONS, formationSlots, pickLeader,
} from "@engine/engine/formation.js";

// The Helium Bomb (P3-T10). Both radii cross, because the engine's own `bombDetonated` event
// carries both — and `bombDamageAt` crosses so nothing above the bridge ever re-derives the falloff.
export {
  BOMB_BLAST_RADIUS, BOMB_CORE_RADIUS, BOMB_DETECT_RANGE, BOMB_MAX_DAMAGE, BOMB_FUSE_DELAY,
  bombDamageAt, lightFuse,
} from "@engine/engine/bomb.js";

export { BUILD_REACH, queueProduction, cancelProduction, researchUpgrade } from "@engine/engine/production.js";

// Refinery doctrines (P2-T12). `committedDoctrine` is the irreversible half: once an owner has
// researched OR merely queued an upgrade on one path, the other two are closed for the match.
export { UPGRADES, upgradeMult, committedDoctrine } from "@engine/engine/entities.js";
export type { UpgradeDef } from "@engine/engine/entities.js";

export { canPlaceBuilding, findPlacement, radiusOf } from "@engine/engine/colliders.js";

// The Odyssey opening: both sides land with a colony ship rather than a placed Command Center, so
// "deploy" is the first order a player ever gives. Phase 1 needs it even though the PRD's MVP
// roster does not name it — without it there is no base, and S1's demo cannot start.
export { COLONY_SHIP_WORKERS, deployColonyShip, hasColonyShip } from "@engine/engine/colony.js";

export { supplyUsed, supplyCap } from "@engine/engine/supply.js";

// P2-T07 needs the drop-off the gather loop actually picks, not a re-derivation of it. `updateGather`
// calls `nearestGatherDrop` every "toDrop" tick, and it is NOT simply the nearest Command Center: a
// landed collection-point freighter can win, and buildings are scanned before units so an equidistant
// building takes the tie. A test that re-implemented "nearest CC" would agree with the engine on the
// one-base opening and diverge on exactly the cases the rule exists for.
export { nearestGatherDrop, nearestCommandCenter } from "@engine/engine/gather.js";

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

export {
  PLASMA_VEINS, SURVEY_RADIUS, YIELD_TIERS, locationRichness, rigInfo, rigSurvey,
} from "@engine/engine/rig.js";
export type { RigInfo, RigSurvey, YieldTier } from "@engine/engine/rig.js";

// The AI's own intel (P3-T15). Exported so a test can ask what the AI knows through the AI's own
// fog, rather than asserting fairness from the outside and hoping.
export {
  INTEL_FADE, INTEL_FULL, readEnemy, sightEnemy, updateIntel,
} from "@engine/engine/aiIntel.js";

export { PLANETS, COM } from "@engine/data.js";

// ---------------------------------------------------------------------------------------------
// Phase 4 — the galaxy above the seat (P4-T09).
//
// The save round-trip cannot be proved against a FRESH galaxy: a fresh one regenerates from its
// seed, so it would round-trip even if serialization dropped every field. Proving anything needs a
// galaxy that has diverged — a second world settled, a lane running, a standing order set — and
// that needs the mutators below. Each is upstream's own; nothing here is a rule reimplemented.
//
// `BG_STEP` and `LANE_PERIOD` cross as the two integer schedules the galaxy scheduler runs on. A
// test that guessed either would be asserting against its own arithmetic rather than the engine's.
// ---------------------------------------------------------------------------------------------

export {
  BG_STEP, LANE_PERIOD, JUMP_COST, jumpCost, jumpCapital,
  createLane, assignShipToLane, unassignShipFromLane, runLanes, sweepColonies,
} from "@engine/engine/galaxy.js";

// The rest of the galaxy surface Phase 4 presents (P4-T03 … P4-T08).
//
// Every one is a *query the engine already answers* or a *command the engine validates*. The
// pattern is the one Phase 3 established with formations: the client asks, it never decides.
// Two are worth naming because a plausible re-derivation is wrong:
//
//   • `jumpCost` is NOT `JUMP_COST` — `FUEL_DISCOUNT_BY_TIER` makes the price depend on the
//     Spaceport's tier, so a panel that showed the constant would be wrong for every upgraded port.
//   • `canJumpTo` is not "do I have a Spaceport". A stranded force can always FALL BACK to a world
//     where it still has a foothold, which is the rule that stops a portless world being a trap.
export {
  JUMP_LOAD_RADIUS, COLONY_INCOME_PER_BUILDING, COLONY_INCOME_CAP,
  PACIFIED_INCOME, SPACEPORT_MAX_TIER, SPACEPORT_CAPACITY, SPACEPORT_UPGRADE_COST,
  FUEL_DISCOUNT_BY_TIER, CARGO_GOODS, LANDING_PICK_GRID,
  canJump, canJumpTo, jumpVessel, stagedRiders, jumpManifest, jumpManifestAll,
  spaceportTier, jumpCapacity, upgradeSpaceport, playerSpaceports,
  freightCapacity, cargoManifest, loadFreighter, unloadFreighter, deleteLane,
  snapLandingPoint, landingSites, previewPlanet, galaxyStatus, backgroundWorldIds,
} from "@engine/engine/galaxy.js";

export { runColonyPolicies } from "@engine/engine/colonyPolicy.js";

export {
  MAX_WORKER_TARGET, sanitizePolicy, getColonyPolicy, setColonyPolicy,
} from "@engine/engine/colonyPolicy.js";

// ---------------------------------------------------------------------------------------------
// Phase 5 — the long game.
//
// Same shape as Phases 3 and 4: every one is a query the engine already answers or a command it
// validates. Two are worth naming because the client has already been caught wanting them:
//
//   • `stanceLabel` is the engine's own banding of the −1..1 stance. P4-T03 drew the starmap's
//     stance bar with NO bands precisely because this stopped at the engine, and inventing a
//     threshold above the bridge would be a second answer to a question the simulation answers
//     (ADR-0012 §5). Now it crosses, that bar can be labelled from the engine's own words.
//   • `scoreBreakdown` is broken out rather than collapsed into a total, and upstream's own comment
//     says why: "so a HUD can show WHY". A score recomputed above the bridge disagrees with it the
//     first time a weight moves.
// ---------------------------------------------------------------------------------------------

export {
  PEACE_THRESHOLD, APPEASE_TIME, TRIBUTE_BASE_COST, GOODWILL_CAP,
  FAVOR_INTERVAL, FAVOR_WINDOW, FAVOR_GOODWILL, GRACE_TIME,
  tributeCost, offerTribute, offerGift, fulfillRequest, atPeace, hostility, stanceLabel, provoked,
} from "@engine/engine/diplomacy.js";

export { updateWonder, chargingWonderOf, chargingPlayerWonder } from "@engine/engine/wonder.js";

export {
  DEFAULT_MATCH_TIME_LIMIT, checkWinCondition, checkEndlessLoss, checkEndlessWin,
  scoreBreakdown, playerScore,
} from "@engine/engine/victory.js";

export {
  RELIEF_COOLDOWN, MILESTONE_IDS, DOMINATION_TARGET, CLAIM_DEV, EXPAND_DEV,
  CAPITAL_UPGRADE_COST, CAPITAL_HP_MULT, upgradeToCapital,
  checkGalaxyRescue, surrenderGalaxy, checkGalaxyProgress, checkDomination, isMilestoneId,
  updateFactionWarmth, checkRivalGate,
} from "@engine/engine/galaxy.js";

export { FACTIONS, PLAYABLE_FACTIONS, factionTrait } from "@engine/engine/factions.js";

// ---------------------------------------------------------------------------------------------
// Phase 5's parity close-out (P5-T13 … P5-T16).
//
// `docs/planning/PARITY.md` §5.2 is the reason these are here: **ten of the engine's own twenty-eight
// orders had no gesture, no button and no intent**, a third of the verb list the 2D game gives a
// player, and five of the ten did not cross this façade at all. That is the number the checklist was
// written to make visible, and it is the one Phase 5's exit criterion turns on.
//
// Two of them are worth naming, because the client has already been caught reading their
// consequences while unable to set their causes:
//
//   • `issueSetCollectPoint` — P2-T07 documents that a landed collection-point freighter can win the
//     drop-off over a nearer Command Center, and `nearestGatherDrop` honours it. The client has read
//     that answer since Phase 2 and has never been able to make one.
//   • `issueSetRally` takes a `nodeId` as well as a point: rally-to-node, so a worker spawns already
//     mining. A rally intent carrying only x/y would be a rally point that is quietly worse than
//     upstream's for exactly the unit that needs it most.
export {
  issueAssistBuild, issueFerryFreighter, issueSetHomeBase, issueSetCollectPoint, issueSetAILogistics,
} from "@engine/engine/commands.js";

export { FREIGHTER_AI_TECH, assignFerry } from "@engine/engine/haul.js";

export { updateScoutMode } from "@engine/engine/scout.js";

// The new-game screen (row 104). `WorldOptions` has accepted `difficulty` and `playerFaction` since
// Phase 1 and `main.ts` has never passed either, so every session ever played has been medium /
// frontier. The roster and the tuning tables are the engine's own; nothing here picks a default.
export { DIFFICULTY_OPTIONS } from "@engine/engine/aiDifficulty.js";
