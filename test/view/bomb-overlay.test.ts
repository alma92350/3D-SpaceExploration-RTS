// P3-T10 in the frame.
//
// `test/bridge/bomb.test.ts` proves the bridge reports the right thing; this proves it survives to
// the renderer, which is a separate claim — the aura's plumbing was correct for a while before
// anything drew it. Two rings and an arc, one overlay layer, and no instance batch: a ring is
// geometry a naive implementation pushes as a mesh, and this unit already costs a mesh of its own.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { OVERLAY_STRIDE } from "../../src/view/renderer/port.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import {
  BOMB_BLAST_RADIUS, BOMB_CORE_RADIUS, BOMB_FUSE_DELAY, activeState, createGalaxy, makeBuilding,
  makeUnit,
} from "../../src/engine/index.js";

const SEED = 20260814;

/** A base, one armed player bomb beside it, rendered once. `fuse` in seconds, or null for unlit. */
function bombScene(fuse: number | null) {
  const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const base = state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  state.buildings.set(cc.id, cc);

  const bomb = makeUnit("heliumbomb", "player", base.x + 90, base.y + 40);
  bomb.armed = true;
  if (fuse !== null) bomb.fuseUntil = state.time + fuse;
  state.units.set(bomb.id, bomb);

  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);
  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  renderer.setFog(snap.fog);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(bomb.x, bomb.y);
  new SceneComposer(field).compose(
    renderer, snap, rig.update(1280, 720), TIERS.T2,
    buildTerrainMesh(field, { relief: true, apron: 0 }), 0, null,
  );
  return { renderer, bomb };
}

function bombRow(renderer: RecordingRenderer) {
  const layer = renderer.lastFrame.overlays.find((o) => o.kind === "bomb");
  if (!layer || layer.count === 0) return null;
  const d = layer.data;
  return {
    core: d[3]!, blast: d[4]!, lit: d[5]!, fuse01: d[6]!, owner: d[7]!,
    stride: layer.stride, count: layer.count,
  };
}

describe("the Helium Bomb's reach in a composed frame (P3-T10)", () => {
  it("reaches the renderer with both of the engine's radii", () => {
    const row = bombRow(bombScene(null).renderer)!;
    expect(row, "an armed bomb produced no overlay at all").not.toBeNull();
    expect(row.stride).toBe(OVERLAY_STRIDE.bomb);
    expect(row.core).toBe(BOMB_CORE_RADIUS);
    expect(row.blast).toBe(BOMB_BLAST_RADIUS);
  });

  it("marks an unlit fuse as unlit, and a lit one as lit", () => {
    expect(bombRow(bombScene(null).renderer)!.lit, "an armed bomb read as counting down").toBe(0);
    expect(bombRow(bombScene(BOMB_FUSE_DELAY).renderer)!.lit, "a burning fuse read as idle").toBe(1);
  });

  it("turns the countdown into a fraction that fills as the fuse burns", () => {
    // The view gets `fuse01` rising 0 → 1 rather than raw seconds, because `view/` may not import
    // the engine and so cannot know what a second is worth. The composer divides by the delay the
    // TABLE carries — assert against the ends and the middle, since a fraction that is merely
    // monotonic could still be the wrong shape.
    const full = bombRow(bombScene(BOMB_FUSE_DELAY).renderer)!;
    const half = bombRow(bombScene(BOMB_FUSE_DELAY / 2).renderer)!;
    const gone = bombRow(bombScene(0).renderer)!;

    expect(full.fuse01, "a fresh fuse was already drawn as spent").toBeCloseTo(0, 5);
    expect(half.fuse01, "the arc is not proportional to the time left").toBeCloseTo(0.5, 5);
    expect(gone.fuse01, "a fuse at zero was not drawn as full").toBeCloseTo(1, 5);
  });

  it("costs one overlay layer and no instance batch", () => {
    // The same argument the guard aura made, and it matters more here: this unit already spent one
    // of ADR-0016's nine new meshes, so drawing its radius as geometry would charge it twice.
    const { renderer } = bombScene(BOMB_FUSE_DELAY);
    const layers = renderer.lastFrame.overlays.filter((o) => o.kind === "bomb");
    expect(layers.length).toBe(1);
    expect(layers[0]!.count).toBe(1);
    expect(
      renderer.lastFrame.batches.filter((b) => b.mesh === "heliumbomb").length,
      "the bomb's own mesh is the only batch it may add",
    ).toBeLessThanOrEqual(1);
  });

  it("draws nothing for an unarmed bomb", () => {
    // Guards the whole path, not just the bridge: a composer that pushed a row for every bomb it
    // found would put a permanent ring on a unit the player drives across the map.
    const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
    const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
    const base = state.map.bases.player;
    const cc = makeBuilding("command", "player", base.x, base.y);
    state.buildings.set(cc.id, cc);
    const bomb = makeUnit("heliumbomb", "player", base.x + 90, base.y + 40);
    state.units.set(bomb.id, bomb);

    const renderer = new RecordingRenderer();
    renderer.registerMeshes(buildMeshes());
    renderer.setTier("T2");
    renderer.resize(1280, 720, 1);
    const snap = new SnapshotExtractor(state.map)
      .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
    renderer.setFog(snap.fog);
    const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
    rig.focusOn(bomb.x, bomb.y);
    new SceneComposer(field).compose(
      renderer, snap, rig.update(1280, 720), TIERS.T2,
      buildTerrainMesh(field, { relief: true, apron: 0 }), 0, null,
    );
    expect(bombRow(renderer), "an inert bomb was drawn as a threat").toBeNull();
  });
});
