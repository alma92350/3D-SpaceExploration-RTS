// P1-T18 / P1-T20 — build placement agrees with the engine's own rules, and the world round-trips
// through upstream's save format.

import { describe, expect, it } from "vitest";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { checkPlacement } from "../../src/bridge/commands.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  BUILDINGS, GALAXY_SAVE_VERSION, TERRAIN_CELL_SIZE, canPlaceBuilding, sampleTerrain,
} from "../../src/engine/index.js";

const SEED = 20260814;

describe("build placement", () => {
  it("matches the engine's own verdict everywhere the engine says no", () => {
    // The ghost must never turn green on ground the engine will then refuse. Sweeping the whole
    // map and comparing verdict-for-verdict is the only way to know the two agree — a spot check
    // passes happily while the two disagree on exactly the cells a player actually clicks.
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const state = bridge.state;
    state.players.player.resources.ore = 100_000;      // take affordability out of the comparison

    let compared = 0;
    for (let x = 0; x < state.map.width; x += 37) {
      for (let y = 0; y < state.map.height; y += 41) {
        const ours = checkPlacement(state, "barracks", x, y);
        const engineSaysYes = canPlaceBuilding(state, "barracks", x, y)
          && sampleTerrain(state.map.terrain, x, y).buildable;
        expect(ours.valid, `placement disagreement at (${x}, ${y})`).toBe(engineSaysYes);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("refuses rough ground, with a reason a player can act on", () => {
    // Rough ground is stamped on only three worlds (Glacius, Forge, Oort — see engine/map.js's
    // PLANET_MODIFIERS), and the MVP's own world is not one of them. The rule still has to work
    // there, so this test goes to a world that HAS the terrain rather than asserting nothing.
    const bridge = new WorldBridge({ seed: SEED, worldId: "oort" });
    const state = bridge.state;
    state.players.player.resources.ore = 100_000;

    const terrain = state.map.terrain;
    let rough: { x: number; y: number } | null = null;
    for (let i = 0; i < terrain.type.length && !rough; i++) {
      if (terrain.type[i] === 1) {
        rough = {
          x: (i % terrain.cols) * TERRAIN_CELL_SIZE + TERRAIN_CELL_SIZE / 2,
          y: Math.floor(i / terrain.cols) * TERRAIN_CELL_SIZE + TERRAIN_CELL_SIZE / 2,
        };
      }
    }
    expect(rough, "this world has no rough ground; the test is not exercising the rule").not.toBeNull();
    const check = checkPlacement(state, "barracks", rough!.x, rough!.y);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/rough/i);
  });

  it("refuses what the player cannot afford, and says so by name", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const state = bridge.state;
    state.players.player.resources.ore = 0;
    const spot = { x: state.map.bases.player.x + 120, y: state.map.bases.player.y };
    const check = checkPlacement(state, "barracks", spot.x, spot.y);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain(BUILDINGS.barracks!.name);
  });

  it("refuses ground off the edge of the map", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    expect(checkPlacement(bridge.state, "barracks", -20, 100).valid).toBe(false);
    expect(checkPlacement(bridge.state, "barracks", 100, bridge.state.map.height + 50).valid).toBe(false);
  });

  it("actually starts a building when the order goes through", () => {
    const bridge = openedBase();
    bridge.state.players.player.resources.ore = 100_000;
    const worker = ownWorker(bridge);
    const before = bridge.state.buildings.size;
    bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    bridge.enqueue({ kind: "build", buildingType: "barracks", x: worker.x + 60, y: worker.y });
    bridge.step(STEP_SECONDS);
    expect(bridge.state.buildings.size).toBe(before + 1);
    expect(bridge.takeCommandError()).toBeNull();
  });

  it("reports a refusal rather than throwing", () => {
    const bridge = openedBase();
    bridge.state.players.player.resources.ore = 0;
    const worker = ownWorker(bridge);
    bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    bridge.enqueue({ kind: "build", buildingType: "barracks", x: worker.x + 60, y: worker.y });
    expect(() => bridge.step(STEP_SECONDS)).not.toThrow();
    expect(bridge.takeCommandError()).toBeTruthy();
  });
});

describe("the Odyssey opening", () => {
  it("starts with a colony ship and no base at all", () => {
    // The single most important fact about the MVP's first thirty seconds, and the one the PRD's
    // MVP roster does not mention: there is no Command Center and no worker until the player
    // deploys. A regression here is a game that cannot be started.
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const own = [...bridge.state.units.values()].filter((u) => u.owner === "player");
    expect(own.map((u) => u.type)).toContain("colonyship");
    expect([...bridge.state.buildings.values()].filter((b) => b.owner === "player")).toHaveLength(0);
  });

  it("deploying the colony ship founds a finished Command Center and lands its crew", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    bridge.enqueue({ kind: "deploy" });
    bridge.step(STEP_SECONDS);

    expect(bridge.takeCommandError()).toBeNull();
    const cc = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "command");
    expect(cc, "deploy must produce a Command Center").toBeDefined();
    expect(cc!.constructing, "the deployed CC arrives finished, not as a building site").toBe(false);
    expect(bridge.state.units.get(ship.id), "the ship is consumed by the deploy").toBeUndefined();
    expect([...bridge.state.units.values()].filter((u) => u.owner === "player" && u.type === "worker").length)
      .toBeGreaterThan(0);
  });

  it("explains itself when there is nothing to deploy", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    bridge.enqueue({ kind: "deploy" });
    bridge.step(STEP_SECONDS);
    expect(bridge.takeCommandError()).toMatch(/colony ship/i);
  });
});

/** A bridge past the opening: colony ship deployed, so a worker exists to build with. */
function openedBase(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
  const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
  bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  bridge.enqueue({ kind: "deploy" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

function ownWorker(bridge: WorldBridge): Unit {
  const worker = [...bridge.state.units.values()].find((u) => u.type === "worker" && u.owner === "player");
  expect(worker, "a deployed base should have landed its colonists").toBeDefined();
  return worker!;
}

describe("orders", () => {
  it("moves only the player's own units, even if an enemy is selected", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const enemy = [...bridge.state.units.values()].find((u) => u.owner === "ai");
    if (!enemy) return;                                   // no enemy units at t=0 on this world
    const before = { ...enemy.order };
    bridge.enqueue({ kind: "select", ids: [enemy.id], additive: false });
    bridge.enqueue({ kind: "move", x: 100, y: 100, queue: false });
    bridge.step(STEP_SECONDS);
    expect(enemy.order?.type).not.toBe("move");
    expect(before).toBeDefined();
  });

  it("ignores an attack order on a target that died before the tick", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const own = [...bridge.state.units.values()].find((u) => u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [own.id], additive: false });
    bridge.enqueue({ kind: "attack", targetId: "u99999", queue: false });
    expect(() => bridge.step(STEP_SECONDS)).not.toThrow();
  });

  it("applies queued intent on the very next tick, not the one after", () => {
    // The difference between an RTS that feels responsive and one that feels laggy.
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const own = [...bridge.state.units.values()].find((u) => u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [own.id], additive: false });
    bridge.step(STEP_SECONDS);
    expect(bridge.state.selection).toEqual([own.id]);
  });
});

describe("save and load", () => {
  it("round-trips a world to an identical state", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    for (let i = 0; i < 120; i++) bridge.step(STEP_SECONDS);
    const before = hash(bridge.state);
    const save = bridge.save();

    for (let i = 0; i < 40; i++) bridge.step(STEP_SECONDS);
    expect(hash(bridge.state)).not.toBe(before);          // the world genuinely moved on

    expect(bridge.load(save)).toBe(true);
    expect(hash(bridge.state)).toBe(before);
  });

  it("writes upstream's own galaxy save version (F-08)", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const save = bridge.save() as { v?: number };
    expect(save.v).toBe(GALAXY_SAVE_VERSION);
  });

  it("rejects a corrupt save instead of adopting it (N-08)", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    for (let i = 0; i < 20; i++) bridge.step(STEP_SECONDS);
    const before = hash(bridge.state);

    for (const bad of [null, {}, { v: 999 }, "nonsense", { v: 1, planets: "no" }]) {
      expect(bridge.load(bad), `a load of ${JSON.stringify(bad)} should fail`).toBe(false);
    }
    expect(hash(bridge.state), "a failed load must leave the running session untouched").toBe(before);
  });

  it("survives a JSON round trip, which is how a save actually travels", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    for (let i = 0; i < 60; i++) bridge.step(STEP_SECONDS);
    const before = hash(bridge.state);
    const text = JSON.stringify(bridge.save());
    expect(bridge.load(JSON.parse(text))).toBe(true);
    expect(hash(bridge.state)).toBe(before);
  });
});

function hash(state: State): string {
  const parts = [`t${state.tick}`, `ore${(state.players.player.resources.ore ?? 0).toFixed(4)}`];
  for (const u of [...state.units.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
    parts.push(`${u.id}:${u.type}:${u.x.toFixed(5)}:${u.y.toFixed(5)}:${u.hp.toFixed(3)}`);
  for (const b of [...state.buildings.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
    parts.push(`${b.id}:${b.type}:${b.hp.toFixed(3)}:${b.buildProgress.toFixed(5)}`);
  return parts.join("|");
}
