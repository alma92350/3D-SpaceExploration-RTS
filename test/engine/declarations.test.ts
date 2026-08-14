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
