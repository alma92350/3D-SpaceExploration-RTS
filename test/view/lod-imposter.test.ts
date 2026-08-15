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
import { type CameraState, LOD_IMPOSTER } from "../../src/view/renderer/port.js";
import {
  IMPOSTER_LEAN, IMPOSTER_SIZE, type MeshId, buildMeshes, meshIdForType,
} from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import {
  CameraRig, MAX_DISTANCE, MIN_DISTANCE, PITCH_FAR, PITCH_NEAR, YAW_SNAP_COUNT,
} from "../../src/input/camera.js";
import { projectToScreen } from "../../src/input/picking.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { BUILDINGS, UNITS, activeState, createGalaxy, makeUnit } from "../../src/engine/index.js";

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

/* ================================================================================================
   P7-T02 — the imposter is the SIZE AND SHAPE of the mesh it replaces (ADR-0024).

   P6-T07 fixed the quad's facing and measured its proportions, and left the proportions alone with
   a number: the quad covered 0.73×–10.35× the mesh's screen area, and no LOD distance fixes a size.
   These are the assertions that keep the fix from sliding back, and they are stated in the same
   units the measurement was: screen-space bounding boxes on the raster the tier rasterises.

   `perf/imposter-probe.mjs` is the full sweep — 896 on-screen camera samples × 47 engine types ×
   8 facings. What is below is a coarser grid of the same measurement, sized to run in a test.
   ================================================================================================ */

/** The roster as `snapshot.ts` puts it on the wire: every engine type, its radius, and its mesh. */
const ROSTER: Array<{ type: string; radius: number; mesh: MeshId }> = [
  ...Object.entries(UNITS).map(([type, def]) => ({
    type, radius: (def as { radius?: number }).radius ?? 6, mesh: meshIdForType(type),
  })),
  ...Object.entries(BUILDINGS).map(([type, def]) => ({
    type, radius: (def as { radius?: number }).radius ?? 16, mesh: meshIdForType(type),
  })),
];

/** Flat ground: this measures geometry, and a hill under the sample lifts mesh and quad alike. */
const FLAT = {
  width: 12000, height: 12000, cols: 300, rows: 300, cell: 40, type: new Uint8Array(300 * 300),
};

const SCREEN = { x: 0, y: 0, behind: false };

function screenBox(positions: Float32Array, yaw: number, scale: number, ox: number, oz: number, camera: CameraState) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const p = place(positions[i]!, positions[i + 1]!, positions[i + 2]!, yaw, scale, ox, 0, oz);
    projectToScreen(camera, p.x, p.y, p.z, SCREEN);
    x0 = Math.min(x0, SCREEN.x); x1 = Math.max(x1, SCREEN.x);
    y0 = Math.min(y0, SCREEN.y); y1 = Math.max(y1, SCREEN.y);
  }
  return { w: x1 - x0, h: y1 - y0 };
}

/**
 * Every (zoom, yaw, range) at which an imposter is both PAST the LOD distance and on screen.
 *
 * The filter is the point. Pitch is a pure function of zoom, so at the closest zooms the LOD
 * distance is off the top of the viewport and nothing there is ever an imposter — a sweep that did
 * not project the sample point first would report worst cases from frames the game cannot draw.
 */
function imposterSamples(tier: typeof TIER) {
  const samples: Array<{ camera: CameraState; ox: number; oz: number; zoom: number; range: number }> = [];
  const raster = { w: Math.round(1280 * tier.renderScale), h: Math.round(720 * tier.renderScale) };
  for (let zoom = MIN_DISTANCE; zoom <= MAX_DISTANCE; zoom += 135) {
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      const rig = new CameraRig({ mapWidth: FLAT.width, mapHeight: FLAT.height }, FLAT);
      rig.yawIndex = yawIndex;
      rig.distance = zoom;
      rig.focusOn(FLAT.width / 2, FLAT.height / 2);
      const camera = rig.update(raster.w, raster.h);
      for (const range of [tier.lodDistance, (tier.lodDistance + tier.cullDistance) / 2]) {
        const ox = camera.eyeX + Math.sin(rig.yaw) * range;
        const oz = camera.eyeZ + Math.cos(rig.yaw) * range;
        projectToScreen(camera, ox, 0, oz, SCREEN);
        if (SCREEN.behind || SCREEN.x < 0 || SCREEN.x > raster.w || SCREEN.y < 0 || SCREEN.y > raster.h) continue;
        samples.push({ camera, ox, oz, zoom, range });
      }
    }
  }
  return samples;
}

describe("the imposter is the size of the mesh it replaces (P7-T02, ADR-0024)", () => {
  const quad = buildMeshes().find((m) => m.id === "imposter")!;
  const meshes = new Map(buildMeshes().map((m) => [m.id, m]));

  it("covers what the mesh covered, in both screen dimensions, at every zoom the rig allows", () => {
    // The measurement P6-T07 left as a comment, run against every type. Before this row: screen
    // width 0.88–2.99×, height 0.34–5.60×, area 0.30–14.68×. After: 0.95–1.13, 0.48–2.20, 0.49–2.23.
    // The bounds below are those numbers with headroom, and they are BOUNDS ON BOTH SIDES — a quad
    // that shrank to nothing would satisfy any "not too big" test ever written.
    // Eight facings, not four. Four samples only the axes, and a mesh modelled long in z — a Lancer
    // is 4 units across and 9.4 deep — has its widest projections on the DIAGONALS, so a four-way
    // mean understates what the player sees by up to 25% and would charge the imposter for it.
    const facings = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);
    let worstW = { v: 1, at: "" };
    let worstH = { v: 1, at: "" };
    let worstArea = { v: 1, at: "" };
    for (const s of imposterSamples(TIER)) {
      for (const entry of ROSTER) {
        const mesh = meshes.get(entry.mesh)!;
        // The imposter deliberately does not turn with the entity, so it is judged against what the
        // mesh is worth on AVERAGE over its facings — charging it for the difference it is designed
        // to have would be measuring the design rather than the defect.
        let logW = 0;
        let logH = 0;
        for (const f of facings) {
          const b = screenBox(mesh.positions, f, 1, s.ox, s.oz, s.camera);
          logW += Math.log(b.w);
          logH += Math.log(b.h);
        }
        const meshW = Math.exp(logW / facings.length);
        const meshH = Math.exp(logH / facings.length);
        const q = screenBox(quad.positions, s.camera.yaw + Math.PI, IMPOSTER_SIZE[entry.mesh], s.ox, s.oz, s.camera);

        const where = `${entry.type} (${entry.mesh}) at zoom ${s.zoom}, ${s.range} out`;
        for (const [ratio, worst] of [
          [q.w / meshW, worstW], [q.h / meshH, worstH], [(q.w * q.h) / (meshW * meshH), worstArea],
        ] as const) {
          const err = Math.max(ratio, 1 / ratio);
          if (err > worst.v) { worst.v = err; worst.at = `${where}: ${ratio.toFixed(2)}x`; }
        }
      }
    }
    expect(worstW.v, `the imposter's screen WIDTH is off by ${worstW.at}. Width is the dimension the `
      + `mesh's own footprint fixes, so this is the one that should be nearly exact.`).toBeLessThan(1.25);
    expect(worstH.v, `the imposter's screen HEIGHT is off by ${worstH.at}. Past this the fallback `
      + `stops being the same object: a flat ship reads as a wall, which is what P6-T07 measured.`)
      .toBeLessThan(2.6);
    expect(worstArea.v, `the imposter's screen AREA is off by ${worstArea.at}, against 14.68x before `
      + `P7-T02 and a 2.23x measurement after it.`).toBeLessThan(2.6);
  });

  it("takes its size from the mesh, so four freighters on one hull get one imposter", () => {
    // The single worst case P6-T07 found, and its cause: `entityRadius * 2.2` asked the engine's
    // COLLISION circle how big to draw something the view had already decided to draw at one size.
    // ADR-0014 put `hauler`, `heavyhauler`, `bulkfreighter` and `freighter` on one hull — four
    // radii, 9 to 15, against a hull whose own diameter is 15.4 — so the imposter disagreed with
    // the mesh by up to 2x and covered 10.35x its screen area.
    const family = ["hauler", "heavyhauler", "bulkfreighter", "freighter"];
    const sizes = new Set(family.map((t) => IMPOSTER_SIZE[meshIdForType(t)]));
    expect(sizes.size, `the four logistics units draw ONE hull (ADR-0014) and got ${sizes.size} `
      + `different imposters; the imposter is not being taken from the mesh`).toBe(1);

    for (const entry of ROSTER) {
      const mesh = meshes.get(entry.mesh)!;
      expect(
        IMPOSTER_SIZE[entry.mesh],
        `${entry.type}'s imposter is ${IMPOSTER_SIZE[entry.mesh].toFixed(1)} wide for a mesh whose `
        + `widest diameter is ${(mesh.radius * 2).toFixed(1)} — an imposter may never be wider than `
        + `the widest the thing it replaces has ever looked`,
      ).toBeLessThanOrEqual(mesh.radius * 2 + 1e-6);
      expect(IMPOSTER_SIZE[entry.mesh], `${entry.type}'s imposter has no size at all`).toBeGreaterThan(0);
    }
  });

  it("leans by the camera rig's own mid-pitch, which is where that number comes from", () => {
    // `generators.ts` writes 0.96 rather than importing it, because `input/` already imports `view/`
    // and the arrow must not turn around. So the derivation is asserted here instead of remembered:
    // a rig whose pitch ramp moved would make this red on the commit that moved it, which is the
    // only thing standing between "derived" and "a number someone liked".
    expect(IMPOSTER_LEAN, `the imposter's lean is no longer the middle of the rig's pitch ramp `
      + `(${PITCH_NEAR}–${PITCH_FAR}); it is a fitted constant again`)
      .toBeCloseTo((PITCH_NEAR + PITCH_FAR) / 2, 10);
  });

  it("holds a near-billboard's height across the whole zoom ramp, where upright collapses", () => {
    // What the lean actually buys, in the renderers' own terms. `drawInstances` applies a Y rotation
    // and a uniform scale and nothing else, so an upright quad is foreshortened by the pitch; a quad
    // built already leaning by θ is not, until the pitch has moved θ away from it. Measured against
    // a quad turned to face the eye squarely at each zoom — the billboard neither renderer can draw:
    //
    //   pitch   37.7°  42.0°  46.3°  52.8°  61.5°  70.2°  74.5°
    //   leaning   80%    88%    94%    99%   100%    99%    99%
    //   upright  113%   102%    90%    73%    55%    42%    38%
    //
    // So the claim is NOT "leaning is closer at every zoom" — at the shallowest zooms, where the LOD
    // distance is a sliver at the top of the screen, upright is nearer and slightly over. It is that
    // leaning is STEADY: a fallback whose height depends on how far the player has zoomed is a
    // fallback that changes size when nothing in the world did.
    const upright = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]);
    // Only the zooms AN IMPOSTER CAN REACH. Below about 135 the LOD distance is off the top of the
    // viewport, so a bound measured there would be a bound on a frame the game never draws.
    const zooms = [...new Set(imposterSamples(TIER).map((s) => s.zoom))].sort((a, b) => a - b);
    const leaning: number[] = [];
    const flat: number[] = [];
    for (const zoom of zooms) {
      const rig = new CameraRig({ mapWidth: FLAT.width, mapHeight: FLAT.height }, FLAT);
      rig.distance = zoom;
      rig.focusOn(FLAT.width / 2, FLAT.height / 2);
      const camera = rig.update(960, 540);
      const pitch = rig.pitch;
      const ox = camera.eyeX + Math.sin(rig.yaw) * TIER.lodDistance;
      const oz = camera.eyeZ + Math.cos(rig.yaw) * TIER.lodDistance;
      const face = [[-0.5, 0, 0], [0.5, 0, 0], [0.5, Math.cos(pitch), -Math.sin(pitch)],
        [-0.5, 0, 0], [0.5, Math.cos(pitch), -Math.sin(pitch)], [-0.5, Math.cos(pitch), -Math.sin(pitch)]];
      const yaw = camera.yaw + Math.PI;
      const ideal = screenBox(new Float32Array(face.flat()), yaw, 30, ox, oz, camera).h;
      leaning.push(screenBox(quad.positions, yaw, 30, ox, oz, camera).h / ideal);
      flat.push(screenBox(upright, yaw, 30, ox, oz, camera).h / ideal);
    }
    const spread = (a: number[]) => Math.max(...a) / Math.min(...a);
    expect(spread(leaning), `the imposter's height ran ${Math.min(...leaning).toFixed(2)}–`
      + `${Math.max(...leaning).toFixed(2)} of a billboard's across the zoom ramp. The lean is what `
      + `keeps that flat, and it is the half of P6-T07's measurement its own comment called "cannot `
      + `fix PITCH — a full billboard needs a renderer change".`).toBeLessThan(1.4);
    expect(spread(flat), `an UPRIGHT quad now varies by only ${spread(flat).toFixed(2)}x across the `
      + `ramp, so this test is not measuring anything`).toBeGreaterThan(2.5);
    expect(leaning[leaning.length - 1]!, `zoomed all the way out — which is where imposters actually `
      + `live, since that is when most of the field is past the LOD distance — the quad projects `
      + `${(leaning[leaning.length - 1]! * 100).toFixed(0)}% of a billboard's height`).toBeGreaterThan(0.9);
    expect(flat[flat.length - 1]!, "an upright quad no longer collapses at the far zoom; re-derive the lean")
      .toBeLessThan(0.5);
  });

  it("still faces the camera once it leans — the normal must not tip past the eye", () => {
    // The lean rotates the quad's outward normal up with it, to (0, sin θ, cos θ). The instance
    // material is FrontSide, so a lean past the eye's own elevation at some zoom would cull the
    // whole fallback there — the exact failure P6-T07 found at five yaw snaps out of eight, arriving
    // by a different route. Checked across the ramp, not at one zoom.
    for (let zoom = MIN_DISTANCE; zoom <= MAX_DISTANCE; zoom += 90) {
      const rig = new CameraRig({ mapWidth: FLAT.width, mapHeight: FLAT.height }, FLAT);
      rig.distance = zoom;
      rig.focusOn(FLAT.width / 2, FLAT.height / 2);
      const camera = rig.update(960, 540);
      const ox = camera.eyeX + Math.sin(rig.yaw) * TIER.lodDistance;
      const oz = camera.eyeZ + Math.cos(rig.yaw) * TIER.lodDistance;
      const yaw = camera.yaw + Math.PI;
      const p = [0, 1, 2].map((k) => {
        const v = quad.indices[k]!;
        return place(quad.positions[v * 3]!, quad.positions[v * 3 + 1]!, quad.positions[v * 3 + 2]!,
          yaw, 30, ox, 0, oz);
      });
      const u = { x: p[1]!.x - p[0]!.x, y: p[1]!.y - p[0]!.y, z: p[1]!.z - p[0]!.z };
      const w = { x: p[2]!.x - p[0]!.x, y: p[2]!.y - p[0]!.y, z: p[2]!.z - p[0]!.z };
      const n = { x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x };
      const c = {
        x: (p[0]!.x + p[1]!.x + p[2]!.x) / 3,
        y: (p[0]!.y + p[1]!.y + p[2]!.y) / 3,
        z: (p[0]!.z + p[1]!.z + p[2]!.z) / 3,
      };
      const facing = n.x * (camera.eyeX - c.x) + n.y * (camera.eyeY - c.y) + n.z * (camera.eyeZ - c.z);
      expect(facing, `at zoom ${zoom} the leaning imposter's normal points away from the eye; `
        + `FrontSide culling drops every distant entity on that frame`).toBeGreaterThan(0);
    }
  });

  it("stands on the ground, so it does not float where the mesh it replaced stood", () => {
    // `render-contract.test.ts` skips the imposter in its ground-contact sweep — "it has no ground
    // contact point" — which was true of a billboard the renderer was believed to orient freely and
    // is not true of this one. Its bottom edge is its anchor.
    let minY = Infinity;
    for (let i = 1; i < quad.positions.length; i += 3) minY = Math.min(minY, quad.positions[i]!);
    expect(minY, "the imposter's lowest vertex left the ground plane").toBeCloseTo(0, 10);
  });

  it("is still ONE mesh for the whole roster, so the fix cost no draw calls (ADR-0006)", () => {
    // The obvious alternative was an imposter per silhouette, and it is the one ADR-0006 forbids:
    // the batch key is (mesh, owner, LOD), so a second imposter mesh is a second draw call every
    // frame both are on screen. The size rides the per-instance `scale` channel that already exists
    // — which is ADR-0014 §2's rule, arrived at again.
    const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
    const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
    const renderer = new RecordingRenderer();
    renderer.registerMeshes(buildMeshes());
    const composer = new SceneComposer(field);
    const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
    const terrain = buildTerrainMesh(field, { relief: false, apron: TIER.apron });
    rig.distance = 500;
    rig.focusOn(field.width / 2, field.height / 2);
    const camera = rig.update(1280, 720);

    // Every unit type the engine has, both owners, all of them past the LOD distance.
    const cx = camera.eyeX + Math.sin(rig.yaw) * CROWD_RANGE;
    const cy = camera.eyeZ + Math.cos(rig.yaw) * CROWD_RANGE;
    const types = Object.keys(UNITS);
    types.forEach((type, i) => {
      const u = makeUnit(type, i % 2 === 0 ? "player" : "ai", cx + (i % 8) * 9 - 36, cy + Math.floor(i / 8) * 9 - 18);
      state.units.set(u.id, u);
    });
    state.fogs.player.explored.fill(1);
    state.fogs.player.visible.fill(1);
    const snap = new SnapshotExtractor(state.map)
      .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
    composer.compose(renderer, snap, camera, TIER, terrain, 0, null);

    const imposters = renderer.lastFrame.batches.filter((b) => b.lod === LOD_IMPOSTER);
    expect(imposters.length, `${types.length} unit types past the LOD distance drew `
      + `${imposters.length} imposter batches; ADR-0006 allows one per owner, and this is where a `
      + `per-silhouette imposter would show up as draw calls`).toBeLessThanOrEqual(2);
    expect(imposters.every((b) => b.mesh === "imposter")).toBe(true);

    // And the scale each instance carries is the MESH's, not `radius * 2.2`. Read back off the
    // batch, because that is the number the renderer actually receives.
    const seen = new Map<number, number>();
    for (const batch of imposters) {
      for (let i = 0; i < batch.count; i++) seen.set(batch.scale[i]!, (seen.get(batch.scale[i]!) ?? 0) + 1);
    }
    // `Math.fround` because the batch is a Float32Array: the composer writes a double and the
    // renderer reads back the nearest float, and comparing the two directly would fail on a value
    // that arrived perfectly intact.
    const expected = new Set(types.map((t) => Math.fround(IMPOSTER_SIZE[meshIdForType(t)])));
    for (const scale of seen.keys()) {
      expect(expected.has(scale), `an imposter went out at scale ${scale.toFixed(2)}, which is not any `
        + `mesh's size. \`scene.ts\` is deriving the imposter's size again instead of reading it.`).toBe(true);
    }
    expect(seen.size, "every imposter came out the same size; the per-mesh size is not reaching the batch")
      .toBeGreaterThan(1);
  });
});
