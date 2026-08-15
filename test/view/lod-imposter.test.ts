// P6-T07 — the LOD fallback has to be VISIBLE, or the threshold that switches to it means nothing.
//
// `generators.ts` describes the imposter as "one camera-facing quad. The renderer billboards it",
// `mesh-winding.test.ts` skips it saying "the renderer faces it", and `render-contract.test.ts`
// calls it "a billboard the renderer orients". Three files, one claim, and no renderer did it: both
// implementations apply the batch's own `yaw` about Y and nothing else, and `SceneComposer` pushed
// a constant 0.
//
// What that cost, measured on the eight yaw snaps the rig actually allows (ADR-0010 snapped it to
// eight so a player keeps their sense of north):
//
//   • The quad's geometry is a unit square in the model XY plane, so its outward normal — outward in
//     the sense `mesh-winding.test.ts` defines and the instance material culls on — is +Z. At a
//     fixed yaw of 0 that normal faced the camera at three snaps out of eight and away at five, and
//     the instance material is `FrontSide`, so at five of eight the fallback was culled outright.
//   • At snaps 2 and 6 the quad is exactly edge-on and projects to 0.00 px wide. That is nothing in
//     BOTH renderers, culling or no culling.
//   • `yawIndex` 0 — the boot default — was one of the five. Past T0's LOD distance a median 57% of
//     the entities on screen are imposters, so the game's opening camera was dropping over half of
//     what it drew.
//
// No test could see it. The batch count is identical either way, the triangle count is identical
// either way, and the perf gate's camera path held one yaw for six seconds against a ten-second run,
// so no gated frame ever looked from snaps 2 through 7 at all.
//
// These assertions are stated in the renderers' own terms rather than in three.js's: the rotation
// formula below is the one `canvas2d.ts` inlines and `WebGLRenderer` gets from `rotation.set`, and
// "front-facing" is `dot(normal, eye − centroid) > 0`, which is `mesh-winding.test.ts`'s definition
// of outward plus the fact that the material culls back faces.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { LOD_IMPOSTER } from "../../src/view/renderer/port.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig, YAW_SNAP_COUNT } from "../../src/input/camera.js";
import { projectToScreen } from "../../src/input/picking.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { activeState, createGalaxy, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;
const TIER = TIERS.T0;

/** How far the crowd sits from the eye's ground projection: past `lodDistance`, inside `cullDistance`. */
const CROWD_RANGE = 500;

/**
 * The imposter batch as one frame at the given yaw snap saw it, plus the camera that drew it.
 *
 * **The crowd is placed relative to the camera, not the camera relative to the crowd**, and that is
 * not a convenience. The eye sits at `target − (sin yaw, cos yaw) × cos(pitch) × distance`, so
 * rotating the rig around a fixed crowd changes how far the crowd is from the eye — by up to 570
 * units here, which straddles T0's 340 threshold. Two of the eight snaps would then draw no
 * imposter at all and the assertions would have nothing to look at. Placing the crowd along the
 * view direction from the eye holds that distance at exactly `CROWD_RANGE` for every snap, so the
 * only thing that varies between the eight frames is the one thing under test.
 */
function imposterFrame(yawIndex: number) {
  const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  const composer = new SceneComposer(field);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  const terrain = buildTerrainMesh(field, { relief: false, apron: TIER.apron });

  rig.yawIndex = yawIndex;
  rig.distance = 500;
  rig.focusOn(field.width / 2, field.height / 2);
  const camera = rig.update(1280, 720);

  const cx = camera.eyeX + Math.sin(rig.yaw) * CROWD_RANGE;
  const cy = camera.eyeZ + Math.cos(rig.yaw) * CROWD_RANGE;
  for (let i = 0; i < 40; i++) {
    const u = makeUnit("skiff", "player", cx + (i % 8) * 9 - 36, cy + Math.floor(i / 8) * 9 - 18);
    state.units.set(u.id, u);
  }
  // Reveal the map, as `perf/scene.ts` does: a fogged unit never reaches the composer, and a test
  // that lost its crowd to fog would report an absent batch rather than a facing bug.
  state.fogs.player.explored.fill(1);
  state.fogs.player.visible.fill(1);

  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  composer.compose(renderer, snap, camera, TIER, terrain, 0, null);

  const batch = renderer.lastFrame.batches.find((b) => b.mesh === "imposter" && b.lod === LOD_IMPOSTER);
  // The instance nearest the crowd's centre, not instance 0. `compose` culls on distance alone —
  // there is no frustum test — so an imposter batch also carries entities BEHIND the camera, and
  // reading whichever one the loop reached first would compare a different unit at each snap.
  let pick = -1;
  let best = Infinity;
  for (let i = 0; batch && i < batch.count; i++) {
    const d = Math.hypot(batch.xyz[i * 3]! - cx, batch.xyz[i * 3 + 2]! - cy);
    if (d < best) { best = d; pick = i; }
  }
  const instance = pick < 0 ? null : {
    yaw: batch!.yaw[pick]!, scale: batch!.scale[pick]!,
    x: batch!.xyz[pick * 3]!, y: batch!.xyz[pick * 3 + 1]!, z: batch!.xyz[pick * 3 + 2]!,
  };
  const eye = { x: camera.eyeX, y: camera.eyeY, z: camera.eyeZ };
  return { batch, instance, camera, eye, quad: buildMeshes().find((m) => m.id === "imposter")! };
}

/**
 * A model-space point placed into the world, rotated about Y exactly as both renderers do it.
 *
 * `WebGLRenderer` goes through `Object3D.rotation.set(0, yaw, 0)`; `Canvas2DRenderer` writes the
 * same matrix out by hand. They agree, and this is the shared form: x' = x·cos + z·sin,
 * z' = −x·sin + z·cos.
 */
function place(px: number, py: number, pz: number, yaw: number, scale: number, ox: number, oy: number, oz: number) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const x = px * scale;
  const y = py * scale;
  const z = pz * scale;
  return { x: ox + x * c + z * s, y: oy + y, z: oz - x * s + z * c };
}

describe("the LOD imposter faces the camera at every yaw snap (P6-T07)", () => {
  it("is front-facing at all eight snaps, so the instance material never culls it away", () => {
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      const { instance, eye, quad } = imposterFrame(yawIndex);
      expect(instance, `yaw snap ${yawIndex} drew no imposter batch; the test is measuring nothing`)
        .not.toBeNull();
      const { yaw, scale, x: ox, y: oy, z: oz } = instance!;

      // The quad's first triangle, wound the way `mesh-winding.test.ts` calls outward.
      const p = [0, 1, 2].map((k) => {
        const v = quad.indices[k]!;
        return place(quad.positions[v * 3]!, quad.positions[v * 3 + 1]!, quad.positions[v * 3 + 2]!,
          yaw, scale, ox, oy, oz);
      });
      const u = { x: p[1]!.x - p[0]!.x, y: p[1]!.y - p[0]!.y, z: p[1]!.z - p[0]!.z };
      const w = { x: p[2]!.x - p[0]!.x, y: p[2]!.y - p[0]!.y, z: p[2]!.z - p[0]!.z };
      const n = {
        x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x,
      };
      const c = {
        x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
        y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
        z: (p[0]!.z + p[1]!.z + p[2]!.z) / 3,
      };
      const facing = n.x * (eye.x - c.x) + n.y * (eye.y - c.y) + n.z * (eye.z - c.z);
      expect(
        facing,
        `at yaw snap ${yawIndex} the imposter quad's outward normal points AWAY from the eye. The `
        + `instance material is FrontSide, so every distant entity on this frame is culled and the `
        + `LOD fallback draws nothing at all.`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps its full width at every snap, instead of going edge-on at two of them", () => {
    // The half that does not depend on back-face culling: at a fixed yaw the quad was exactly
    // side-on at snaps 2 and 6, projecting to 0.00 px in the Canvas2D renderer too, which does no
    // culling at all. Widths are compared to each other rather than to a constant — the rig's
    // pitch and the eye's terrain clearance both move between snaps, so an absolute pixel figure
    // would be pinning the map rather than the billboard.
    const widths: number[] = [];
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      const { instance, camera, quad } = imposterFrame(yawIndex);
      const { yaw, scale, x: ox, y: oy, z: oz } = instance!;
      const out = { x: 0, y: 0, behind: false };
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < quad.positions.length; i += 3) {
        const q = place(quad.positions[i]!, quad.positions[i + 1]!, quad.positions[i + 2]!,
          yaw, scale, ox, oy, oz);
        projectToScreen(camera, q.x, q.y, q.z, out);
        lo = Math.min(lo, out.x);
        hi = Math.max(hi, out.x);
      }
      widths.push(hi - lo);
    }
    const widest = Math.max(...widths);
    expect(widest, "no imposter had any width at all; the test is measuring nothing").toBeGreaterThan(4);
    for (let i = 0; i < widths.length; i++) {
      expect(
        widths[i]! / widest,
        `yaw snap ${i} draws the imposter at ${(widths[i]! / widest * 100).toFixed(0)}% of its widest `
        + `projection. A quad that is not turned toward the camera is foreshortened at the diagonal `
        + `snaps and vanishes entirely at two of them.`,
      ).toBeGreaterThan(0.9);
    }
  });

  it("turns with the camera rather than sitting at a constant", () => {
    // The mutation this file is really about: `push(..., 0, ...)` restores the bug and the two
    // assertions above go red, but a reader skimming the batch would see a plausible number either
    // way. This states the intent directly — the imposter's yaw is a function of the camera.
    const yaws = new Set<number>();
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      yaws.add(imposterFrame(yawIndex).instance!.yaw);
    }
    expect(yaws.size, `the imposter took ${yaws.size} distinct yaws across ${YAW_SNAP_COUNT} camera `
      + `rotations; a billboard takes one per rotation`).toBe(YAW_SNAP_COUNT);
  });
});
