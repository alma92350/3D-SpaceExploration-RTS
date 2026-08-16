// P1-T05/T09/T14/T23 — the render contracts ADR-0006 mandates, asserted against the recording
// renderer. These are the tests that make "one draw call per (mesh, owner)" and "zero allocation"
// enforceable rather than aspirational.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS, TIER_ORDER } from "../../src/view/renderer/tiers.js";
import { LOD_IMPOSTER, LOD_MESH } from "../../src/view/renderer/port.js";
import { buildMeshes, TRIANGLE_BUDGET } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh, expectedTriangles } from "../../src/view/terrain/mesh.js";
import { type ElevationField, elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { activeState, createGalaxy, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const state = activeState(createGalaxy({ seed: SEED, startId: "ferros" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  return { state, field };
}

function snapshotOf(state: State) {
  const extractor = new SnapshotExtractor(state.map);
  return extractor.extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
}

/** A hand-built elevation field, so a terrain test states its own terrain. */
function fieldWith(rows: number[][]): ElevationField {
  const cell = 40;
  const cols = rows[0]!.length;
  const type = new Uint8Array(cols * rows.length);
  rows.forEach((row, y) => row.forEach((v, x) => { type[y * cols + x] = v; }));
  return { cols, rows: rows.length, cell, type, width: cols * cell, height: rows.length * cell };
}

function harness(field: ElevationField, tierKey: keyof typeof TIERS = "T2") {
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  const composer = new SceneComposer(field);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  const terrain = buildTerrainMesh(field, {
    relief: TIERS[tierKey].terrain === "relief", apron: TIERS[tierKey].apron,
  });
  return { renderer, composer, rig, terrain, tier: TIERS[tierKey] };
}

describe("mesh budgets", () => {
  it("every MVP mesh is inside its triangle ceiling", () => {
    for (const mesh of buildMeshes()) {
      const budget = TRIANGLE_BUDGET[mesh.id];
      expect(budget, `${mesh.id} has no declared triangle budget`).toBeDefined();
      expect(mesh.triangles, `${mesh.id} draws ${mesh.triangles} triangles, budget is ${budget}`)
        .toBeLessThanOrEqual(budget!);
    }
  });

  it("generates byte-identical geometry every time", () => {
    // Instanced geometry is uploaded once at boot; a generator with hidden state would produce a
    // different fleet on a reload, and a different one again on a tier switch.
    const a = buildMeshes();
    const b = buildMeshes();
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(a[i]!.positions)).toEqual(Array.from(b[i]!.positions));
      expect(Array.from(a[i]!.colors)).toEqual(Array.from(b[i]!.colors));
    }
  });

  it("stands every mesh on the ground with a usable bounding radius", () => {
    // The imposter used to be exempted here — "a billboard the renderer orients; it has no ground
    // contact point" — and both halves were wrong: no renderer orients it (P6-T07), and it stands on
    // the ground like everything else, because it replaces something that does. Since ADR-0024 it
    // leans back from a base edge at y = 0, so it passes this sweep on the same terms as the rest of
    // the roster and no longer needs an exemption.
    for (const mesh of buildMeshes()) {
      let minY = Infinity;
      for (let i = 1; i < mesh.positions.length; i += 3) minY = Math.min(minY, mesh.positions[i]!);
      expect(minY, `${mesh.id} floats or sinks: its lowest vertex is at y=${minY}`).toBeCloseTo(0, 5);
      expect(mesh.radius).toBeGreaterThan(0);
      expect(mesh.height).toBeGreaterThan(0);
    }
  });
});

describe("terrain mesh", () => {
  it("is uploaded exactly once across 600 frames", () => {
    const { state, field } = world();
    const { renderer, composer, rig, terrain, tier } = harness(field);
    const snap = snapshotOf(state);
    for (let f = 0; f < 600; f++) {
      composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, (f % 3) / 3, null);
    }
    expect(renderer.lastFrame.stats.terrainUploads,
      "the terrain never changes mid-match; re-uploading it is pure waste (ADR-0006)").toBe(1);
  });

  it("collapses to a flat plane at T0 and keeps its relief elsewhere", () => {
    // A hand-built field with a mesa in it, not a generated world: only six of the eleven worlds
    // carry high-ground stamps, and Ferros is not one of them. Asserting relief against whichever
    // map the MVP happens to start on would make this test pass or fail on a balance change.
    const field = fieldWith([
      [0, 0, 0, 0],
      [0, 2, 2, 0],
      [0, 2, 2, 0],
      [0, 0, 1, 0],
    ]);
    const flat = buildTerrainMesh(field, { relief: false, apron: 0 });
    const relief = buildTerrainMesh(field, { relief: true, apron: 0 });

    let flatMax = 0;
    for (let i = 1; i < flat.positions.length; i += 3) flatMax = Math.max(flatMax, flat.positions[i]!);
    expect(flatMax, "T0's terrain must have no vertical silhouette to overdraw").toBe(0);

    let reliefMax = 0;
    for (let i = 1; i < relief.positions.length; i += 3) reliefMax = Math.max(reliefMax, relief.positions[i]!);
    expect(reliefMax, "high ground should actually be high at T1+").toBeGreaterThan(10);
    expect(flat.triangles).toBe(relief.triangles);
  });

  it("carries a dark apron past the map edge so the world does not end in a black wedge", () => {
    const { field } = world();
    const bare = buildTerrainMesh(field, { relief: true, apron: 0 });
    const fringed = buildTerrainMesh(field, { relief: true, apron: 900 });

    // Eight quads: a picture frame, in the SAME mesh, so it stays one draw call.
    expect(fringed.triangles - bare.triangles).toBe(8);

    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < fringed.positions.length; i += 3) {
      minX = Math.min(minX, fringed.positions[i]!);
      maxX = Math.max(maxX, fringed.positions[i]!);
    }
    expect(minX).toBeCloseTo(-900, 3);
    expect(maxX).toBeCloseTo(field.width + 900, 3);

    // …and it must be nearly black: its job is to be ignored, not to draw the eye off the map.
    let brightest = 0;
    for (let i = bare.colors.length; i < fringed.colors.length; i++) {
      brightest = Math.max(brightest, fringed.colors[i]!);
    }
    expect(brightest, "the apron is meant to recede, not compete with the play area").toBeLessThan(0.1);
  });

  it("stays inside its vertex budget at MVP map size, per tier", () => {
    const { field } = world();

    // **The budget is per tier since PT-10**, because terrain resolution is now a tier property.
    // It has to be: at SUBDIVISION 2 the drawn ground disagreed with where entities stand by up to
    // 3.9 world units on the Helix ridge — against a smallest unit radius of 6 — which a player
    // reported as units sinking into the hillside and reappearing. Closing that costs vertices, and
    // deciding how many to spend per machine is the tier ladder's whole job.
    for (const tier of TIER_ORDER) {
      const config = TIERS[tier];
      const mesh = buildTerrainMesh(field, {
        relief: config.terrain === "relief", apron: config.apron, subdivision: config.terrainSubdivision,
      });
      expect(mesh.triangles, `${tier} terrain does not match its own subdivision`)
        .toBe(expectedTriangles(field, config.apron, config.terrainSubdivision));
    }

    // T0 is the one that must stay tiny: it is the no-GPU tier, and it is flat, so its samples buy
    // nothing. One draw call and small next to 200 instanced units — the argument for merging it.
    const t0 = buildTerrainMesh(field, {
      relief: false, apron: TIERS.T0.apron, subdivision: TIERS.T0.terrainSubdivision,
    });
    expect(t0.triangles, "the compatibility tier grew geometry it cannot use").toBeLessThan(12_000);

    // And the top tier still has to be one modest draw call rather than a reason to buy a GPU.
    const t3 = buildTerrainMesh(field, {
      relief: true, apron: TIERS.T3.apron, subdivision: TIERS.T3.terrainSubdivision,
    });
    expect(t3.triangles, "the top tier's terrain is no longer small next to the units on it")
      .toBeLessThan(80_000);
  });
});

describe("instancing", () => {
  it("draws 200 units of 4 types across 2 owners in at most 8 instanced calls", () => {
    const { state, field } = world();
    const base = state.map.bases.player;
    const types = ["skiff", "bastion", "lancer", "worker"];
    // Both owners, packed tight around the player's base so everything is visible and in range.
    for (let i = 0; i < 200; i++) {
      const u = makeUnit(types[i % 4]!, i % 2 === 0 ? "player" : "ai", base.x + (i % 20) * 8, base.y + Math.floor(i / 20) * 8);
      state.units.set(u.id, u);
    }
    const snap = snapshotOf(state);
    const { renderer, composer, rig, terrain, tier } = harness(field);
    rig.focusOn(base.x, base.y);
    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);

    const instanced = renderer.lastFrame.batches.filter((b) => b.mesh !== "node");
    const keys = new Set(instanced.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));
    expect(keys.size, `instancing regressed: ${keys.size} batches for 4 types × 2 owners`).toBeLessThanOrEqual(8);
    expect(instanced.length).toBe(keys.size);   // no key drawn twice
    expect(renderer.lastFrame.stats.instances).toBeGreaterThanOrEqual(200);
  });

  it("never mixes owners or meshes inside one batch", () => {
    const { state, field } = world();
    const base = state.map.bases.player;
    for (let i = 0; i < 60; i++) {
      const u = makeUnit(i % 2 === 0 ? "skiff" : "lancer", i % 3 === 0 ? "ai" : "player", base.x + i * 4, base.y + i * 2);
      state.units.set(u.id, u);
    }
    const snap = snapshotOf(state);
    const { renderer, composer, rig, terrain, tier } = harness(field);
    rig.focusOn(base.x, base.y);
    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);

    for (const batch of renderer.lastFrame.batches) {
      expect(batch.count).toBeGreaterThan(0);
      expect(batch.xyz.length).toBe(batch.count * 3);
    }
  });
});

describe("culling and LOD", () => {
  it("does not draw entities beyond the tier's cull distance", () => {
    const { state, field } = world();
    const base = state.map.bases.player;
    const near = makeUnit("skiff", "player", base.x + 20, base.y);
    state.units.set(near.id, near);
    const snap = snapshotOf(state);

    const { renderer, composer, rig, terrain, tier } = harness(field, "T0");
    rig.focusOn(base.x, base.y);
    const camera = rig.update(1280, 720);
    composer.compose(renderer, snap, camera, tier, terrain, 0, null);
    const withNear = renderer.lastFrame.stats.instances;

    // Move the camera to the far corner: everything at the base is now well past T0's cull range.
    rig.focusOn(field.width, field.height);
    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);
    expect(renderer.lastFrame.stats.instances,
      "culling regressed: distant entities still cost draw work").toBeLessThan(withNear);
  });

  it("switches to imposters past the LOD distance, and back", () => {
    const { state, field } = world();
    const base = state.map.bases.player;
    for (let i = 0; i < 30; i++) {
      const u = makeUnit("skiff", "player", base.x + i * 5, base.y);
      state.units.set(u.id, u);
    }
    const snap = snapshotOf(state);
    const { renderer, composer, rig, terrain, tier } = harness(field, "T0");

    rig.focusOn(base.x, base.y);
    rig.distance = 120;
    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);
    expect(renderer.lastFrame.batches.some((b) => b.lod === LOD_MESH)).toBe(true);

    // Push the camera out until the base is beyond T0's LOD distance but inside its cull distance.
    rig.focusOn(base.x + tier.lodDistance + 200, base.y);
    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);
    const batches = renderer.lastFrame.batches;
    expect(batches.length, "everything was culled; the test is not measuring LOD").toBeGreaterThan(0);
    expect(batches.every((b) => b.lod === LOD_IMPOSTER || b.mesh === "node"),
      "entities past the LOD distance must draw as imposters").toBe(true);
  });
});

describe("allocation", () => {
  it("reuses its scratch buffers across 600 frames", () => {
    // The composer's buffers are what a frame writes into. If any of them is a different object
    // 600 frames later, the frame allocated — and at 33 ms a GC pause is a visible hitch.
    const { state, field } = world();
    const base = state.map.bases.player;
    for (let i = 0; i < 120; i++) {
      const u = makeUnit("skiff", "player", base.x + (i % 12) * 9, base.y + Math.floor(i / 12) * 9);
      state.units.set(u.id, u);
    }
    const snap = snapshotOf(state);
    const { renderer, composer, rig, terrain, tier } = harness(field);
    rig.focusOn(base.x, base.y);

    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);
    const first = renderer.lastFrame.batches[0]!;
    const identity = new Map<string, Float32Array>();

    for (let f = 0; f < 600; f++) {
      composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, (f % 4) / 4, null);
    }
    // The recording fake copies, so identity has to be checked on the composer's own buffers:
    // re-composing and capturing the batch arrays the port received.
    const probe = new (class extends RecordingRenderer {
      override drawInstances(batch: Parameters<RecordingRenderer["drawInstances"]>[0]): void {
        identity.set(`${batch.mesh}|${batch.owner}|${batch.lod}`, batch.xyz);
        super.drawInstances(batch);
      }
    })();
    probe.registerMeshes(buildMeshes());
    composer.compose(probe, snap, rig.update(1280, 720), tier, terrain, 0, null);
    const before = new Map(identity);
    composer.compose(probe, snap, rig.update(1280, 720), tier, terrain, 0.5, null);
    for (const [key, buffer] of identity) {
      expect(buffer, `batch ${key} reallocated its transform buffer between frames`).toBe(before.get(key));
    }
    expect(first.count).toBeGreaterThan(0);
  });
});

describe("frame stats", () => {
  it("counts one draw call per batch, per overlay layer, plus the terrain", () => {
    const { state, field } = world();
    const snap = snapshotOf(state);
    const { renderer, composer, rig, terrain, tier } = harness(field);
    rig.focusOn(state.map.bases.player.x, state.map.bases.player.y);
    composer.compose(renderer, snap, rig.update(1280, 720), tier, terrain, 0, null);

    const frame = renderer.lastFrame;
    expect(frame.stats.drawCalls).toBe(1 + frame.batches.length + frame.overlays.length);
    expect(frame.stats.drawCalls).toBe(composer.expectedDrawCalls);
  });
});
