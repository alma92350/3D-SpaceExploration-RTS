// P2-T08 — a building's state reads without colour: constructing, working, idle, throttled,
// unpowered, each distinguishable by SHAPE in a still frame.
//
// PRD N-05 is the whole reason this is hard. A red dot and an amber dot are the obvious badge, they
// are three lines of code, and they are the same shape — so a colour-blind player, or anyone at a
// glance, sees one badge with five meanings. The board named the specific failure: "unpowered" and
// "idle" being confusable is what makes a player think the game is broken, because one of them
// means "fix your grid" and the other means "you forgot to queue anything".
//
// The tests below therefore never look at a colour. They compare **geometry**: the glyph point
// sets, the instance scale, and which overlay slots exist. A change that kept the badges and made
// them differ only by colour would fail here, which is the point.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes, meshIdForType } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { OVERLAY_STRIDE } from "../../src/view/renderer/port.js";
import {
  GLYPHS, IDLE_GLYPH, hasStatusGlyph, statusGlyph,
} from "../../src/view/renderer/glyphs.js";
import {
  ACTIVITY_IDLE, ACTIVITY_NONE, ACTIVITY_WORKING, CONCERN_BUFFER_FULL, CONCERN_NONE,
  CONCERN_NO_FUEL, CONCERN_NO_POWER, CONCERN_PAUSED, CONCERN_STARVED, CONCERN_THROTTLED,
  SnapshotExtractor, numericId,
} from "../../src/bridge/snapshot.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { buildingConcern, makeBuilding } from "../../src/engine/index.js";

const SEED = 20260814;

/** Every concern the bridge can report, plus the one activity code that draws. */
const ALL_CONCERNS = [
  CONCERN_PAUSED, CONCERN_NO_POWER, CONCERN_NO_FUEL,
  CONCERN_STARVED, CONCERN_BUFFER_FULL, CONCERN_THROTTLED,
];

/** A glyph as comparable geometry — the only thing these tests are allowed to look at. */
function shapeOf(glyph: { strokes: readonly (readonly number[])[]; closed: boolean }): string {
  return `${glyph.closed ? "closed" : "open"}:${glyph.strokes.map((s) => s.join(",")).join("|")}`;
}

describe("the badge vocabulary", () => {
  it("gives every concern the bridge can report a glyph of its own", () => {
    // If upstream adds a seventh concern, `CONCERN_CODES` will map it and buildings will start
    // wearing no badge at all while the engine says they are stopped. This is the tripwire.
    for (const code of ALL_CONCERNS) {
      expect(statusGlyph(code, ACTIVITY_NONE), `concern ${code} has no glyph`).not.toBeNull();
    }
    expect(Object.keys(GLYPHS).length).toBe(ALL_CONCERNS.length);
  });

  it("makes every state distinguishable by shape alone", () => {
    const shapes = new Map<string, string>();
    for (const code of ALL_CONCERNS) shapes.set(String(code), shapeOf(statusGlyph(code, ACTIVITY_NONE)!));
    shapes.set("idle", shapeOf(IDLE_GLYPH));

    // Pairwise, so the failure message names the two states that collided rather than reporting a
    // set-size mismatch and leaving someone to find them.
    const entries = [...shapes.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        expect(
          entries[i]![1],
          `${entries[i]![0]} and ${entries[j]![0]} are the same shape — only a colour could tell them apart`,
        ).not.toBe(entries[j]![1]);
      }
    }
  });

  it("keeps idle and unpowered as far apart as two small figures get", () => {
    // The specific confusion the board called out. A ring and a bolt: one closed and round, one
    // open and jagged. Asserting the *properties* rather than the point lists, so a redesign that
    // keeps the intent passes and one that quietly makes both of them triangles does not.
    const idle = statusGlyph(CONCERN_NONE, ACTIVITY_IDLE)!;
    const unpowered = statusGlyph(CONCERN_NO_POWER, ACTIVITY_NONE)!;

    expect(idle.closed, "idle should be a closed figure").toBe(true);
    expect(unpowered.closed, "unpowered should not be a closed figure").toBe(false);
    expect(idle.strokes.length, "idle is one continuous ring").toBe(1);
    expect(unpowered.strokes.length, "unpowered is a BROKEN bolt — two strokes with a gap").toBe(2);
    expect(idle.strokes[0]!.length / 2, "a ring needs enough points to read as round").toBeGreaterThan(6);
  });

  it("says nothing at all about a healthy working building", () => {
    // The cue that makes the others readable. 300 badges is not a cue, it is a texture.
    expect(statusGlyph(CONCERN_NONE, ACTIVITY_WORKING)).toBeNull();
    expect(statusGlyph(CONCERN_NONE, ACTIVITY_NONE)).toBeNull();
    expect(hasStatusGlyph(CONCERN_NONE, ACTIVITY_WORKING)).toBe(false);
    expect(hasStatusGlyph(CONCERN_NONE, ACTIVITY_IDLE)).toBe(true);
  });

  it("lets the engine's reason win over ours, so a building never wears two badges", () => {
    // A Barracks cannot be both starved and idle in today's engine, but the precedence has to be
    // stated somewhere or the first building that can be will render whichever branch came first.
    expect(shapeOf(statusGlyph(CONCERN_STARVED, ACTIVITY_IDLE)!))
      .toBe(shapeOf(statusGlyph(CONCERN_STARVED, ACTIVITY_NONE)!));
  });
});

/* ------------------------------------------------------------------ the five states, end to end */

interface Placed {
  bridge: WorldBridge;
  target: Building;
}

function world(): { bridge: WorldBridge; base: { x: number; y: number } } {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  place(bridge, "command", base.x, base.y);
  return { bridge, base };
}

function place(bridge: WorldBridge, type: string, x: number, y: number, opts = {}): Building {
  const b = makeBuilding(type, "player", x, y, opts);
  bridge.state.buildings.set(b.id, b);
  return b;
}

/** A fuelled reactor. Unfuelled it grants nothing, and the base reads unpowered (economy.test.ts). */
function reactor(bridge: WorldBridge, x: number, y: number): Building {
  const r = place(bridge, "reactor", x, y);
  r.input = { radioactives: 400 };
  return r;
}

/**
 * Build one world per state, with the engine deciding — not the test.
 *
 * `throttled` needs EIGHT fed smelters against one Reactor, which is a measurement rather than a
 * guess: six draw less than the Reactor's 30 and report no concern at all, eight exceed it. A test
 * that set `concern` by hand would pass against a bridge that had stopped reading the engine.
 */
const STATES: Record<string, () => Placed> = {
  constructing: () => {
    const { bridge, base } = world();
    reactor(bridge, base.x + 40, base.y);
    const target = place(bridge, "smelter", base.x + 90, base.y, { constructing: true });
    bridge.step(STEP_SECONDS);
    return { bridge, target };
  },

  working: () => {
    const { bridge, base } = world();
    reactor(bridge, base.x + 40, base.y);
    const target = place(bridge, "smelter", base.x + 90, base.y);
    bridge.step(STEP_SECONDS);
    target.input = { ore: 999, crystals: 999, metals: 999 };
    bridge.step(STEP_SECONDS);
    return { bridge, target };
  },

  idle: () => {
    const { bridge, base } = world();
    reactor(bridge, base.x + 40, base.y);
    const target = place(bridge, "barracks", base.x + 90, base.y);
    bridge.step(STEP_SECONDS);
    return { bridge, target };
  },

  throttled: () => {
    const { bridge, base } = world();
    reactor(bridge, base.x + 40, base.y);
    const smelters: Building[] = [];
    for (let i = 0; i < 8; i++) smelters.push(place(bridge, "smelter", base.x + 90 + i * 22, base.y + 30));
    bridge.step(STEP_SECONDS);
    for (const s of smelters) s.input = { ore: 999, crystals: 999, metals: 999 };
    bridge.step(STEP_SECONDS);
    return { bridge, target: smelters[0]! };
  },

  unpowered: () => {
    const { bridge, base } = world();
    // No Reactor at all: `powerCap` is 0, so `powerThrottle` is 0 and the engine says "noPower".
    const target = place(bridge, "smelter", base.x + 90, base.y);
    bridge.step(STEP_SECONDS);
    target.input = { ore: 999, crystals: 999, metals: 999 };
    bridge.step(STEP_SECONDS);
    return { bridge, target };
  },
};

/** What a still frame says about one building, with no colour anywhere in it. */
interface Signature {
  scale: number;
  glyph: string;
}

function frameSignature({ bridge, target }: Placed): Signature {
  const state = bridge.state;
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);

  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  renderer.setFog(snap.fog);

  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(target.x, target.y);
  const terrain = buildTerrainMesh(field, { relief: true, apron: 0 });
  new SceneComposer(field).compose(renderer, snap, rig.update(1280, 720), TIERS.T2, terrain, 0, null);

  // The instance is found by POSITION rather than by index: batches pack in iteration order, and a
  // signature that read instance 0 would silently be about a different building in the throttled
  // world, which is the only one with more than one smelter.
  const mesh = meshIdForType(target.type);
  const batch = renderer.lastFrame.batches.find((b) => b.mesh === mesh && b.owner === 0);
  expect(batch, `no batch for ${target.type} (${mesh})`).toBeDefined();
  let scale = NaN;
  for (let i = 0; i < batch!.count; i++) {
    if (Math.abs(batch!.xyz[i * 3]! - target.x) < 0.01 && Math.abs(batch!.xyz[i * 3 + 2]! - target.y) < 0.01) {
      scale = batch!.scale[i]!;
      break;
    }
  }
  expect(Number.isFinite(scale), `${target.type} at ${target.x},${target.y} is not in its own batch`).toBe(true);

  const status = renderer.lastFrame.overlays.find((o) => o.kind === "status");
  let glyph = "none";
  if (status) {
    const stride = OVERLAY_STRIDE.status;
    for (let i = 0; i < status.count; i++) {
      const off = i * stride;
      if (Math.abs(status.data[off]! - target.x) > 0.01) continue;
      if (Math.abs(status.data[off + 2]! - target.y) > 0.01) continue;
      const g = statusGlyph(status.data[off + 3]! | 0, status.data[off + 4]! | 0);
      glyph = g ? shapeOf(g) : "none";
      break;
    }
  }
  return { scale, glyph };
}

describe("the five building states in a still frame", () => {
  it("are pairwise distinguishable without reading a single colour", () => {
    const signatures = new Map<string, Signature>();
    for (const [name, build] of Object.entries(STATES)) signatures.set(name, frameSignature(build()));

    const names = [...signatures.keys()];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = signatures.get(names[i]!)!;
        const b = signatures.get(names[j]!)!;
        const same = a.glyph === b.glyph && Math.abs(a.scale - b.scale) < 1e-4;
        expect(
          same,
          `"${names[i]}" and "${names[j]}" render identically: scale ${a.scale.toFixed(3)} vs ` +
          `${b.scale.toFixed(3)}, badge ${a.glyph === "none" ? "(none)" : "present"} vs ` +
          `${b.glyph === "none" ? "(none)" : "present"}. A player cannot tell them apart.`,
        ).toBe(false);
      }
    }
  });

  it("distinguishes constructing from working by shape, since neither wears a badge", () => {
    // Both are healthy, so both are badgeless; the difference is the construction scale ramp
    // (P1-T09), which is a shape cue and not a colour one.
    const constructing = frameSignature(STATES.constructing!());
    const working = frameSignature(STATES.working!());
    expect(constructing.glyph).toBe("none");
    expect(working.glyph).toBe("none");
    expect(constructing.scale, "a rising shell should be smaller than a finished building").toBeLessThan(working.scale);
    expect(working.scale).toBeCloseTo(1, 5);
  });

  it("is driven by what the engine actually says, not by the test's own idea of the state", () => {
    // The half that stops all of the above from being self-fulfilling. Each world is asserted
    // against `buildingConcern` directly — if a world stops producing the state it is named for,
    // this fails here rather than silently making the distinctness test compare two identical
    // frames and pass.
    const expected: Record<string, string | null> = {
      working: null, idle: null, throttled: "throttled", unpowered: "noPower",
    };
    for (const [name, code] of Object.entries(expected)) {
      const { bridge, target } = STATES[name]!();
      expect(buildingConcern(bridge.state, target)?.code ?? null, `world "${name}"`).toBe(code);
    }
    const { bridge, target } = STATES.constructing!();
    expect(target.constructing, "the constructing world should hold a building under construction").toBe(true);
    expect(buildingConcern(bridge.state, target), "a shell has no concern — it is not stopped").toBeNull();
  });

  it("tells idle from working through the bridge, which the engine alone cannot", () => {
    // `buildingConcern` returns null for BOTH an idle Barracks and a working smelter — a Barracks
    // has no recipe, so the engine has nothing to complain about. That is exactly why the activity
    // byte exists, and this is the assertion that says so.
    const idle = STATES.idle!();
    const working = STATES.working!();
    expect(buildingConcern(idle.bridge.state, idle.target)).toBeNull();
    expect(buildingConcern(working.bridge.state, working.target)).toBeNull();

    expect(activityIn(idle)).toBe(ACTIVITY_IDLE);
    expect(activityIn(working)).toBe(ACTIVITY_WORKING);
  });

  it("stops calling a Barracks idle the moment something is queued", () => {
    const { bridge, target } = STATES.idle!();
    expect(activityIn({ bridge, target })).toBe(ACTIVITY_IDLE);
    target.queue.push({ unitType: "ranger", progress: 0 });
    expect(activityIn({ bridge, target })).toBe(ACTIVITY_WORKING);
  });

  it("puts no badge on a building under construction", () => {
    // A badge on a half-risen shell reads as a fault rather than as progress, and every new base
    // starts as a field of shells.
    const { bridge, target } = STATES.constructing!();
    const snap = new SnapshotExtractor(bridge.state.map)
      .extract(bridge.state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
    const i = rowOf(snap, target.id);
    expect(hasStatusGlyph(snap.production.concern[i]!, snap.production.activity[i]!)).toBe(false);
  });
});

function activityIn({ bridge, target }: Placed): number {
  const snap = new SnapshotExtractor(bridge.state.map)
    .extract(bridge.state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  return snap.production.activity[rowOf(snap, target.id)]!;
}

function rowOf(snap: { entities: { count: number; ids: Int32Array } }, id: string): number {
  const numeric = numericId(id);
  for (let i = 0; i < snap.entities.count; i++) if (snap.entities.ids[i] === numeric) return i;
  throw new Error(`${id} is not in the snapshot`);
}
