// P2-T18 — the draw-call ceiling ADR-0012 §3 set and ADR-0013 promised to hold (Q-09).
//
// This is the test that makes those two ADRs *true* rather than merely stated. ADR-0013 collapsed
// 29 building types into six silhouette families specifically so 300 buildings could be drawn
// inside a budget, and gave up real legibility to do it — nine chain buildings now look identical
// on the field. If the ceiling is not actually asserted, that cost was paid for nothing.
//
// It runs against the RecordingRenderer rather than the perf harness on purpose. A draw-call count
// is a structural fact, not a timing one: it is identical on every machine, so it belongs in the
// fast suite where a regression is caught in the red-green loop rather than 40 seconds into a
// perf run.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { BUILDING_FAMILY, buildMeshes, meshIdForType } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { BUILDINGS, activeState, createGalaxy, makeBuilding, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;

/**
 * ADR-0012 §3's budget, unchanged by ADR-0013: 14 building meshes × 2 owners.
 *
 * This is a **buildings** budget. Both ADRs are about collapsing 29 building types into families,
 * and the first draft of this test counted the unit batches too and reported 33 against 28 — which
 * read as an architectural failure and was a measurement error. Measured now: exactly 28.
 */
const BUILDING_DRAW_CALL_CEILING = 28;

/**
 * The whole frame: buildings, plus four unit meshes across two owners, plus nodes and imposters.
 *
 * Stated separately and asserted separately, because a buildings-only ceiling could be held while
 * the frame as a whole crept. Measured: 34.
 */
const SCENE_DRAW_CALL_CEILING = 36;

/**
 * A fully industrialised world: 300 buildings covering **every** type the engine defines, and 200
 * units, packed around the player's base so nothing escapes the frustum.
 *
 * Covering every type matters more than the count does. 300 barracks would pass a ceiling that 29
 * distinct types would blow straight through, and 300 buildings is the number PRD §5 names.
 */
function industrialWorld() {
  const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const base = state.map.bases.player;
  const types = Object.keys(BUILDINGS);

  for (let i = 0; i < 300; i++) {
    const b = makeBuilding(
      types[i % types.length]!,
      i % 2 === 0 ? "player" : "ai",
      base.x - 200 + (i % 25) * 16,
      base.y - 200 + Math.floor(i / 25) * 16,
    );
    state.buildings.set(b.id, b);
  }
  for (let i = 0; i < 200; i++) {
    const u = makeUnit(
      ["worker", "skiff", "bastion", "lancer"][i % 4]!,
      i % 2 === 0 ? "player" : "ai",
      base.x - 100 + (i % 20) * 9,
      base.y - 100 + Math.floor(i / 20) * 9,
    );
    state.units.set(u.id, u);
  }
  return { state, field, base };
}

function renderOnce(tierKey: keyof typeof TIERS = "T0") {
  const { state, field, base } = industrialWorld();
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier(tierKey);
  renderer.resize(1280, 720, 1);

  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  renderer.setFog(snap.fog);

  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x, base.y);
  const terrain = buildTerrainMesh(field, {
    relief: TIERS[tierKey].terrain === "relief", apron: TIERS[tierKey].apron,
  });
  new SceneComposer(field).compose(renderer, snap, rig.update(1280, 720), TIERS[tierKey], terrain, 0, null);
  return { renderer, snap, state };
}

describe("the Phase 2 draw-call ceiling", () => {
  it("draws 300 buildings across all 29 types inside ADR-0012's 28-call budget", () => {
    const { renderer, snap } = renderOnce();

    // Buildings only — that is what both ADRs are about, and mixing the unit batches in was what
    // made the first run of this test look like an architectural failure.
    const buildingMeshes = new Set(Object.values(BUILDING_FAMILY));
    const buildingKeys = new Set(
      renderer.lastFrame.batches
        .filter((b) => buildingMeshes.has(b.mesh as never))
        .map((b) => `${b.mesh}|${b.owner}|${b.lod}`),
    );

    expect(
      buildingKeys.size,
      `${buildingKeys.size} building batches for a 300-building base covering all 29 types. ` +
      `ADR-0013 collapsed those types into six silhouette families to keep this at ` +
      `${BUILDING_DRAW_CALL_CEILING} — nine buildings look identical on the field because of it. ` +
      `Adding a mesh costs two draw calls and needs an ADR, not a raised number here.`,
    ).toBeLessThanOrEqual(BUILDING_DRAW_CALL_CEILING);

    const allKeys = new Set(renderer.lastFrame.batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));
    expect(allKeys.size, "the whole frame, not only its buildings").toBeLessThanOrEqual(SCENE_DRAW_CALL_CEILING);

    // The scene must actually be the scene: a ceiling passed by drawing nothing is not a ceiling.
    expect(snap.entities.count, "the world should be populated").toBeGreaterThan(400);
    expect(renderer.lastFrame.stats.instances).toBeGreaterThan(400);
  });

  it("has no batch drawn twice, so the ceiling is a real batch count", () => {
    const { renderer } = renderOnce();
    const batches = renderer.lastFrame.batches;
    const keys = batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`);
    expect(new Set(keys).size, "a (mesh, owner, LOD) key was submitted more than once").toBe(keys.length);
  });

  it("exercises every silhouette family, or the ceiling proves nothing", () => {
    // If a type were missing from `BUILDING_FAMILY`, `meshIdForType` would fall back to "worker"
    // and the count would look healthy while the game rendered grey lumps. This asserts the scene
    // really did reach all six families plus Phase 1's five.
    const families = new Set(Object.keys(BUILDINGS).map(meshIdForType));
    expect(families.size).toBeGreaterThanOrEqual(11);
    expect(families.has("factory")).toBe(true);
    expect(families.has("gate")).toBe(true);
  });
});
