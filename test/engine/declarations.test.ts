// P0-T05 — the declarations in src/engine/types/ describe the engine that is actually there.
//
// These declarations are hand-written (ADR-0003: we cannot generate them, the engine is JS we do
// not edit), which makes them the one place in the project where the types can be confidently,
// silently wrong. So this test does the only thing that helps: it builds a REAL world through the
// façade and asserts each declared name exists and each declared field is present on a real
// object. A rename upstream turns into a red test here instead of a black screen later.

import { describe, expect, it } from "vitest";
import * as engine from "../../src/engine/index.js";

const FIXED_SEED = 20260814;

describe("engine declarations", () => {
  it("exports every function the bridge calls", () => {
    const required = [
      "createGalaxy", "stepGalaxy", "activeState", "addPlanet",
      "createGameState", "makeUnit", "makeBuilding", "getEntity", "playerUnits", "playerBuildings",
      "tick", "sampleTerrain", "generateMap",
      "isVisibleAt", "isExploredAt", "isNodeDiscovered",
      "canAfford", "prereqsMet", "hasCompletedBuilding", "canBuildType",
      "issueMove", "issueAttackMove", "issueAttack", "issueGather", "issueStop", "issueHold",
      "issuePatrol", "issueBuild", "issueSetRally",
      "queueProduction", "cancelProduction",
      "canPlaceBuilding", "findPlacement", "radiusOf",
      "supplyUsed", "supplyCap",
      "serializeGalaxy", "serializeGalaxyString", "deserializeGalaxy",
    ] as const;
    const missing = required.filter((n) => typeof (engine as Record<string, unknown>)[n] !== "function");
    expect(missing, `declared but not exported by the vendored engine: ${missing.join(", ")}`).toEqual([]);
  });

  it("exports every constant the view reads", () => {
    expect(engine.MAP_WIDTH).toBe(1600);
    expect(engine.MAP_HEIGHT).toBe(1000);
    // ADR-0004 derives elevation from this grid, and ADR-0006 sizes the fog texture from it. If
    // these two ever stop being equal, the terrain mesh and the fog lookup silently disagree.
    expect(engine.TERRAIN_CELL_SIZE).toBe(engine.FOG_CELL_SIZE);
    expect(Object.keys(engine.TERRAIN)).toEqual(["0", "1", "2"]);
    expect(engine.ODYSSEY_WORLDS).toHaveLength(11);
    expect(engine.GALAXY_SAVE_VERSION).toBe(1);
    expect(engine.BUILD_REACH).toBeGreaterThan(0);
    expect(engine.NODE_RADIUS).toBeGreaterThan(0);
  });

  it("a real galaxy has the State shape the snapshot extractor reads", () => {
    const galaxy = engine.createGalaxy({ seed: FIXED_SEED, startId: "ferros" });
    const state = engine.activeState(galaxy);

    for (const field of ["time", "tick", "map", "owners", "players", "units", "buildings", "fogs", "events"]) {
      expect(state, `State.${field} is declared but absent`).toHaveProperty(field);
    }
    expect(state.units).toBeInstanceOf(Map);
    expect(state.buildings).toBeInstanceOf(Map);
    expect(state.owners).toEqual(["player", "ai"]);
    expect(state.fogs.player).toBe(state.fog);
    expect(state.fogs.ai).toBe(state.fogAI);

    const { map } = state;
    for (const field of ["width", "height", "nodes", "terrain", "bases"]) {
      expect(map, `GameMap.${field} is declared but absent`).toHaveProperty(field);
    }
    expect(map.terrain.type).toBeInstanceOf(Uint8Array);
    expect(map.terrain.type.length).toBe(map.terrain.cols * map.terrain.rows);
    expect(map.nodes.length).toBeGreaterThan(0);
    expect(map.nodes[0]).toMatchObject({ id: expect.any(String), com: expect.any(String), x: expect.any(Number), y: expect.any(Number) });

    const fog = state.fogs.player;
    expect(fog.explored).toBeInstanceOf(Uint8Array);
    expect(fog.visible).toBeInstanceOf(Uint8Array);
    expect(fog.explored.length).toBe(fog.cols * fog.rows);
  });

  it("a real unit and building carry every declared field", () => {
    const galaxy = engine.createGalaxy({ seed: FIXED_SEED, startId: "ferros" });
    const state = engine.activeState(galaxy);

    const unit = engine.makeUnit("skiff", "player", 100, 100);
    for (const field of ["kind", "id", "type", "owner", "x", "y", "hp", "maxHp", "order", "orderQueue"]) {
      expect(unit, `Unit.${field} is declared but absent`).toHaveProperty(field);
    }

    const building = engine.makeBuilding("barracks", "player", 200, 200);
    for (const field of ["kind", "id", "type", "owner", "x", "y", "radius", "hp", "maxHp",
      "constructing", "buildProgress", "queue", "targetId", "rally"]) {
      expect(building, `Building.${field} is declared but absent`).toHaveProperty(field);
    }

    state.units.set(unit.id, unit);
    expect(engine.getEntity(state, unit.id)).toBe(unit);
    expect(engine.radiusOf(unit)).toBeGreaterThan(0);
  });

  it("exports every Phase 2 economy name the panels call", () => {
    // Added alongside the declarations they cover, per this file's own rule. Each of these was
    // declared by hand against JS that is never edited here, so a rename upstream is silent until
    // something like this looks.
    const required = [
      "nearestGatherDrop", "nearestCommandCenter",
      "researchUpgrade", "committedDoctrine", "upgradeMult",
      "pickRepairTarget", "countRepairJobs",
      "rigSurvey", "rigInfo", "locationRichness",
    ] as const;
    const missing = required.filter((n) => typeof (engine as Record<string, unknown>)[n] !== "function");
    expect(missing, `declared but not exported by the vendored engine: ${missing.join(", ")}`).toEqual([]);

    // The doctrine table's shape is load-bearing twice over: `.doctrine` is what separates a real
    // path from `hardEdge` (the AI's, which must never read as a commitment), and the tier fields
    // are what the panel orders by.
    const doctrines = new Set(Object.values(engine.UPGRADES).filter((u) => u.doctrine).map((u) => u.doctrine));
    expect(doctrines, "the three Refinery doctrines").toEqual(new Set(["assault", "bulwark", "logistics"]));
    expect(engine.UPGRADES.hardEdge?.doctrine, "hardEdge must carry no doctrine").toBeUndefined();
    expect(engine.YIELD_TIERS.map((t) => t.name)).toEqual(["low", "medium", "good", "overwhelming"]);
    expect(engine.SURVEY_RADIUS).toBeGreaterThan(0);
    expect(engine.NEEDS_REPAIR).toBeLessThan(engine.HEALED);
  });

  it("a gather order really carries the `phase` the view reads", () => {
    // `UnitOrder.phase` is declared because P2-T07 reads which leg of a round trip a worker is on.
    // The engine sets it inside `updateGather` rather than at issue time, so this drives a real
    // order rather than inspecting a freshly issued one.
    const galaxy = engine.createGalaxy({ seed: FIXED_SEED, startId: "helix" });
    const state = engine.activeState(galaxy);
    const worker = engine.makeUnit("worker", "player", 100, 100);
    state.units.set(worker.id, worker);
    const node = state.map.nodes.find((n) => n.amount > 0)!;
    worker.x = node.x;
    worker.y = node.y;
    engine.issueGather([worker], node.id, false);

    for (let i = 0; i < 40 && !worker.order?.phase; i++) engine.stepGalaxy(galaxy, 0.05);
    expect(worker.order?.phase, "UnitOrder.phase is declared but the engine never sets it").toBeDefined();
    expect(["toNode", "mining", "toDrop"]).toContain(worker.order!.phase);
  });

  it("a Plasma Rig really carries the dig fields `rigInfo` reports", () => {
    // `digProgress`, `digCount`, `lastTier` and `lastYield` are written by `updatePlasmaRig`, not by
    // `makeBuilding`, so a rig has to actually dig before any of them exists. That is the whole
    // reason this is a test and not a glance at the constructor.
    const galaxy = engine.createGalaxy({ seed: FIXED_SEED, startId: "helix" });
    const state = engine.activeState(galaxy);
    const base = state.map.bases.player;

    const reactor = engine.makeBuilding("reactor", "player", base.x + 40, base.y);
    reactor.input = { radioactives: 5000 };
    state.buildings.set(reactor.id, reactor);
    const rig = engine.makeBuilding("plasmarig", "player", base.x + 90, base.y);
    state.buildings.set(rig.id, rig);
    state.players.player.resources.radioactives = 100000;

    for (let i = 0; i < 4000 && !rig.lastTier; i++) engine.stepGalaxy(galaxy, 0.05);

    expect(rig.digProgress, "Building.digProgress is declared but never written").toBeDefined();
    expect(rig.lastTier, "the rig never completed a dig, so the declaration is unverified").toBeTruthy();
    expect(engine.YIELD_TIERS.map((t) => t.name)).toContain(rig.lastTier);
    expect(rig.lastYield).toBeGreaterThan(0);
    expect(rig.digCount).toBeGreaterThan(0);
  });

  it("a guard aura is really on both the unit and the building that project one", () => {
    // Declared for P3-T04, which draws the radius. Both defs carry the field and the two ranges
    // deliberately differ, so a view that hardcoded either would be wrong about the other.
    expect(engine.UNITS.aegis?.guardAura?.range, "UNITS.aegis.guardAura is declared but absent").toBe(96);
    expect(engine.BUILDINGS.aegisbastion?.guardAura?.range, "the Bastion's aura is declared but absent").toBe(130);
    expect(engine.BUILDINGS.aegisbastion?.attack, "the Aegis Bastion must have NO attack").toBeUndefined();
    for (const g of [engine.UNITS.aegis?.guardAura, engine.BUILDINGS.aegisbastion?.guardAura]) {
      expect(g?.damageTakenMult, "a multiplier that is not below 1 is not a protective aura").toBeLessThan(1);
    }
  });

  it("a real tick fills `state.anvils`, which the aura overlay reads", () => {
    // Transient and rebuilt every tick by `collectAnvils`, so it does not exist until the sim runs.
    const galaxy = engine.createGalaxy({ seed: FIXED_SEED, startId: "helix" });
    const state = engine.activeState(galaxy);
    const base = state.map.bases.player;
    const bastion = engine.makeBuilding("aegisbastion", "player", base.x + 60, base.y);
    state.buildings.set(bastion.id, bastion);
    engine.stepGalaxy(galaxy, 0.05);

    const mine = (state.anvils ?? []).find((a) => a.id === bastion.id);
    expect(mine, "State.anvils is declared but the engine never filled it").toBeDefined();
    for (const field of ["id", "owner", "x", "y", "range", "mult"]) {
      expect(mine, `anvil.${field} is declared but absent`).toHaveProperty(field);
    }
    expect(mine!.range).toBe(130);
  });

  it("the MVP roster exists in the engine's own definitions", () => {
    // The nine types Phase 1 draws (PRD §5, Phase 1). A typo here would surface as a missing mesh
    // at runtime; here it is a named failure.
    for (const t of ["worker", "skiff", "bastion", "lancer"]) {
      expect(engine.UNITS[t], `UNITS.${t} is in the MVP roster but not in the engine`).toBeDefined();
      expect(engine.UNITS[t]!.radius).toBeGreaterThan(0);
    }
    for (const t of ["command", "barracks", "habitat", "turret", "refinery"]) {
      expect(engine.BUILDINGS[t], `BUILDINGS.${t} is in the MVP roster but not in the engine`).toBeDefined();
      expect(engine.BUILDINGS[t]!.radius).toBeGreaterThan(0);
    }
  });
});
