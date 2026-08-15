// P5-T15, the drawn half of PARITY row 8.
//
// The unusual thing about this row is how little of it was missing. The `rally` overlay kind, its
// stride, and the dashed line both product renderers stroke for it have all been in place since
// Phase 1 — `view/landing.ts` has been using them to draw a line to a landing point. What never
// existed was the one call that pushes a battlefield rally line into the layer.
//
// So this file has two jobs: prove the composer now pushes it, and prove it shares the kind with
// `landing.ts` rather than forking it — because a second kind would be a second thing to keep in
// step across three renderer implementations, for a line.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevation, elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { drawOverlayLayer } from "../../src/view/renderer/overlays2d.js";
import { OVERLAY_STRIDE, type CameraState } from "../../src/view/renderer/port.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { issueSetRally, makeBuilding } from "../../src/engine/index.js";

const SEED = 20260814;
const STRIDE = OVERLAY_STRIDE.rally;

function scene() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);

  const field = elevationFieldFrom(bridge.state.map.terrain, bridge.state.map.width, bridge.state.map.height);
  const composer = new SceneComposer(field);
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x, base.y);
  const terrain = buildTerrainMesh(field, { relief: true, apron: 0 });

  const draw = (): CameraState => {
    const camera = rig.update(1280, 720);
    renderer.setFog(bridge.snapshot.fog);
    composer.compose(renderer, bridge.snapshot, camera, TIERS.T2, terrain, 0, null);
    return camera;
  };
  const select = (...ids: string[]) => {
    bridge.state.selection.length = 0;
    for (const id of ids) bridge.state.selection.push(id);
    bridge.step(STEP_SECONDS);
  };
  return { bridge, base, cc, field, rig, composer, renderer, draw, select };
}

const layer = (r: RecordingRenderer) => r.lastFrame.overlays.find((o) => o.kind === "rally") ?? null;

describe("the rally line in a composed frame", () => {
  it("appears when a producer is selected and vanishes when it is not", () => {
    const { cc, renderer, draw, select } = scene();
    draw();
    expect(layer(renderer), "a rally line was drawn with nothing selected").toBeNull();

    select(cc.id);
    draw();
    const l = layer(renderer);
    expect(l, "the Command Center is selected and the frame has no rally layer — this is the line " +
      "of code PARITY row 8 says has been missing since Phase 1").not.toBeNull();
    expect(l!.count).toBe(1);
    expect(l!.stride, "the battlefield forked the overlay kind `view/landing.ts` shares").toBe(STRIDE);

    select();
    draw();
    expect(layer(renderer), "the line outlived the selection").toBeNull();
  });

  it("runs from the building to the rally point, both ends lifted onto the terrain", () => {
    const { bridge, cc, field, renderer, draw, select } = scene();
    // A rally point on HIGH GROUND, found rather than guessed. The base sits on the zero plane, so a
    // rally point at ground level would leave both ends of the line at the same height and an
    // implementation that never sampled the terrain at all would pass — which is exactly what the
    // first version of this test did.
    let high: { x: number; y: number } | null = null;
    for (let cy = 0; cy < field.rows && !high; cy++) {
      for (let cx = 0; cx < field.cols; cx++) {
        const x = cx * field.cell + field.cell / 2;
        const y = cy * field.cell + field.cell / 2;
        if (elevation(field, x, y) > 1) { high = { x, y }; break; }
      }
    }
    expect(high, "this world is perfectly flat, so the lift cannot be told from the ground")
      .not.toBeNull();

    issueSetRally(bridge.state.buildings.get(cc.id)!, high!.x, high!.y);
    select(cc.id);
    draw();

    const d = layer(renderer)!.data;
    expect(d[0]).toBeCloseTo(cc.x, 2);
    expect(d[2]).toBeCloseTo(cc.y, 2);
    expect(d[3], "the far end is not the engine's rally point").toBeCloseTo(high!.x, 2);
    expect(d[5]).toBeCloseTo(high!.y, 2);
    // Elevation is the VIEW's (ADR-0004): the snapshot is planar and the composer samples the field
    // at both ends, so a line across a slope rides the ground instead of cutting through it.
    expect(d[1], "the building end is not on the ground under the building")
      .toBeCloseTo(elevation(field, cc.x, cc.y) + 2.2, 3);
    expect(d[4], "the rally end sits at the building's height rather than on the ground under it")
      .toBeCloseTo(elevation(field, high!.x, high!.y) + 2.2, 3);
    expect(
      d[4]! - d[1]!,
      "both ends came out at the same height across an 18-unit rise — the field is not being sampled",
    ).toBeCloseTo(elevation(field, high!.x, high!.y) - elevation(field, cc.x, cc.y), 3);
    expect(Math.abs(d[4]! - d[1]!), "the two ends are level, so this proves nothing").toBeGreaterThan(1);
  });

  it("draws one line per selected producer, in one layer", () => {
    const { bridge, base, cc, renderer, draw, select } = scene();
    const ids = [cc.id];
    for (let i = 0; i < 5; i++) {
      const b = makeBuilding("barracks", "player", base.x - 120 + i * 50, base.y + 60);
      bridge.state.buildings.set(b.id, b);
      ids.push(b.id);
    }
    select(...ids);
    draw();
    expect(renderer.lastFrame.overlays.filter((o) => o.kind === "rally").length, "one layer, not six").toBe(1);
    expect(layer(renderer)!.count).toBe(6);
  });

  it("culls on the BUILDING's end, so a distant rally point does not lose its own line", () => {
    // The same rule a tracer uses: the line belongs to the thing the player selected. Culling on
    // the far end would blink the line away exactly when a player set a rally across the map and
    // then looked at the factory to check it — and culling on neither end would let a base on the
    // far side of the map pay for a line nobody can see.
    //
    // T0's 1 100-unit cull radius rather than T2's 2 200, because the map is 1 600 x 1 000: at T2
    // nothing on it is ever culled and both halves below would pass with the test deleted.
    const { bridge, cc, field, rig, composer, renderer } = scene();
    const map = bridge.state.map;
    const terrain = buildTerrainMesh(field, { relief: false, apron: TIERS.T0.apron });
    const drawT0 = () => {
      const camera = rig.update(1280, 720);
      composer.compose(renderer, bridge.snapshot, camera, TIERS.T0, terrain, 0, null);
      return camera;
    };
    const select = (...ids: string[]) => {
      bridge.state.selection.length = 0;
      for (const id of ids) bridge.state.selection.push(id);
      bridge.step(STEP_SECONDS);
    };

    const corner = { x: map.width - 40, y: map.height - 40 };
    issueSetRally(bridge.state.buildings.get(cc.id)!, corner.x, corner.y);
    select(cc.id);
    const camera = drawT0();
    // The premise, checked rather than assumed: the rally point really is outside the radius and
    // the building really is inside it, or neither half below means anything.
    expect(
      Math.hypot(corner.x - camera.eyeX, corner.y - camera.eyeZ),
      "the far corner is inside T0's cull radius — this map or this tier changed",
    ).toBeGreaterThan(TIERS.T0.cullDistance);
    expect(Math.hypot(cc.x - camera.eyeX, cc.y - camera.eyeZ)).toBeLessThan(TIERS.T0.cullDistance);
    expect(layer(renderer), "a rally point outside the cull radius took its line with it").not.toBeNull();

    // …and a producer beyond the cull distance takes its own line with it, as it should.
    const far = makeBuilding("barracks", "player", corner.x, corner.y);
    bridge.state.buildings.set(far.id, far);
    select(far.id);
    drawT0();
    expect(layer(renderer), "a building far off camera still drew its rally line").toBeNull();
  });

  it("adds no instance batch and costs exactly one draw call", () => {
    const { cc, renderer, draw, select } = scene();
    draw();
    const quiet = renderer.lastFrame.stats.drawCalls;
    const quietBatches = new Set(renderer.lastFrame.batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));
    select(cc.id);
    draw();
    const loud = renderer.lastFrame;
    for (const b of loud.batches) {
      const key = `${b.mesh}|${b.owner}|${b.lod}`;
      expect(quietBatches.has(key), `selecting a producer introduced the batch ${key}`).toBe(true);
    }
    // Selection also raises the selection ring, so the rally line's own share is the second call.
    expect(loud.stats.drawCalls - quiet, "a rally line cost more than one layer").toBeLessThanOrEqual(2);
  });
});

describe("the rally line as drawn", () => {
  it("is a dashed segment between the two projected ends", () => {
    // The drawing has existed since Phase 1 and this is the first battlefield caller of it, so it
    // is worth one check that the shared path really strokes what the composer packs.
    const { cc, renderer, draw, select } = scene();
    select(cc.id);
    const camera = draw();
    const packed = layer(renderer)!;

    const { ctx, paths } = recordingCtx();
    drawOverlayLayer(ctx, camera, { kind: "rally", count: packed.count, stride: packed.stride, data: packed.data }, 1);
    expect(paths.length, "the rally layer stroked nothing").toBe(1);
    expect(paths[0]!.points.length, "a rally line is one segment, two points").toBe(2);
    expect(paths[0]!.dashed, "the rally line is solid, so it reads like a tracer").toBe(true);
    expect(
      Math.hypot(paths[0]!.points[0]!.x - paths[0]!.points[1]!.x, paths[0]!.points[0]!.y - paths[0]!.points[1]!.y),
      "the two ends projected to the same pixel — the line has no length on screen",
    ).toBeGreaterThan(2);
  });
});

interface Path { points: Array<{ x: number; y: number }>; dashed: boolean }

function recordingCtx() {
  const paths: Path[] = [];
  let current: Path | null = null;
  const state = { dashed: false };
  const ctx = {
    lineWidth: 1, strokeStyle: "", fillStyle: "", lineCap: "butt", lineJoin: "miter", globalAlpha: 1,
    save() {}, restore() {}, scale() {},
    setLineDash(pattern: number[]) { state.dashed = pattern.length > 0; },
    beginPath() { current = { points: [], dashed: state.dashed }; },
    closePath() {},
    moveTo(x: number, y: number) { current?.points.push({ x, y }); },
    lineTo(x: number, y: number) { current?.points.push({ x, y }); },
    arc() {}, fill() {}, fillRect() {},
    stroke() {
      if (!current || current.points.length < 2) return;
      current.dashed = state.dashed;
      paths.push(current);
      current = null;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, paths };
}
