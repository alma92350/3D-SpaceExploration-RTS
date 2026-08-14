// The renderer conformance suite (ADR-0005, ADR-0009, P1-T08).
//
// Every `Renderer` implementation passes this same suite: `WebGLRenderer`, `Canvas2DRenderer` and
// the `RecordingRenderer` fake. That is the only thing keeping three implementations honest about
// each other — without it, the fake drifts into a convenient fiction and the Canvas2D path quietly
// stops supporting an overlay the WebGL path gained.
//
// It is written as plain functions rather than as a vitest file on purpose: the WebGL
// implementation needs a real GL context, so this suite has to be runnable *inside a browser* (via
// `e2e/conformance.spec.ts`) as well as in Node. A suite that can only run in one of those places
// is a suite that only ever tests one implementation.
//
// What it asserts is BEHAVIOUR, never pixels (ADR-0009): the call-order contract, the FrameStats
// arithmetic, the upload-once rules, and that every overlay kind is accepted.

import {
  type CameraState, type FogField, type InstanceBatch, type MeshData, type OverlayKind,
  type OverlayLayer, type Renderer, type TerrainMesh, OVERLAY_STRIDE,
} from "./port.js";

export interface ConformanceCase {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConformanceOptions {
  /** Build a fresh renderer. Called once per case so a failure cannot cascade. */
  readonly create: () => Renderer;
  readonly meshes: readonly MeshData[];
}

/** A minimal camera. The suite tests plumbing, not projection — camera math has its own tests. */
export function stubCamera(): CameraState {
  const viewProj = new Float32Array([
    0.9, 0, 0, 0,
    0, 1.6, 0, 0,
    0, 0, -1.0005, -1,
    -600, -400, 500, 620,
  ]);
  return {
    viewProj,
    eyeX: 600, eyeY: 300, eyeZ: 900,
    targetX: 600, targetY: 500,
    yaw: 0, pitch: 1.1, distance: 400,
    viewportWidth: 1280, viewportHeight: 720,
  };
}

export function stubTerrain(version = 1): TerrainMesh {
  // Two triangles is enough: the suite asserts upload accounting, not tessellation.
  return {
    positions: new Float32Array([0, 0, 0, 1600, 0, 0, 1600, 0, 1000, 0, 0, 1000]),
    colors: new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    triangles: 2,
    version,
    width: 1600,
    height: 1000,
  };
}

export function stubFog(version = 1): FogField {
  const cols = 8;
  const rows = 5;
  const state = new Uint8Array(cols * rows).fill(2);
  return { cols, rows, cell: 200, state, version };
}

function stubBatch(mesh: string, count: number): InstanceBatch {
  const xyz = new Float32Array(count * 3);
  const yaw = new Float32Array(count);
  const scale = new Float32Array(count).fill(1);
  const shade = new Float32Array(count).fill(1);
  for (let i = 0; i < count; i++) {
    xyz[i * 3] = 200 + i * 20;
    xyz[i * 3 + 1] = 0;
    xyz[i * 3 + 2] = 400 + (i % 5) * 20;
    yaw[i] = (i / count) * Math.PI;
  }
  return { mesh, owner: 0, lod: 0, count, xyz, yaw, scale, shade };
}

function stubOverlay(kind: OverlayKind, count = 2): OverlayLayer {
  const stride = OVERLAY_STRIDE[kind];
  const data = new Float32Array(count * stride);
  for (let i = 0; i < count * stride; i++) data[i] = 100 + i * 7;
  return { kind, count, stride, data };
}

/** Run the suite. Never throws: a failing implementation returns failing cases. */
export function runConformance(opts: ConformanceOptions): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const check = (name: string, fn: () => string | null): void => {
    let detail: string | null;
    try {
      detail = fn();
    } catch (err) {
      detail = `threw: ${(err as Error).message}`;
    }
    cases.push({ name, ok: detail === null, detail: detail ?? "ok" });
  };

  const fresh = (): Renderer => {
    const r = opts.create();
    r.registerMeshes(opts.meshes);
    r.resize(1280, 720, 1);
    r.setTier("T2");
    return r;
  };

  check("returns FrameStats from endFrame", () => {
    const r = fresh();
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain());
    const stats = r.endFrame();
    r.dispose();
    if (!stats) return "endFrame returned nothing";
    for (const field of ["drawCalls", "instances", "triangles", "overlayItems", "terrainUploads", "fogUploads", "cpuMs"]) {
      if (typeof (stats as unknown as Record<string, unknown>)[field] !== "number") return `FrameStats.${field} is not a number`;
    }
    return null;
  });

  check("counts one draw call per instanced batch", () => {
    const r = fresh();
    r.setFog(stubFog());
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain());
    r.drawInstances(stubBatch(opts.meshes[0]!.id, 12));
    r.drawInstances(stubBatch(opts.meshes[1]!.id, 7));
    const stats = r.endFrame();
    r.dispose();
    // Terrain + two batches. An implementation that splits a batch per entity fails here, which is
    // exactly the instancing contract ADR-0006 mandates.
    if (stats.drawCalls !== 3) return `expected 3 draw calls (terrain + 2 batches), got ${stats.drawCalls}`;
    if (stats.instances !== 19) return `expected 19 instances, got ${stats.instances}`;
    return null;
  });

  check("counts triangles as mesh triangles × instances", () => {
    const mesh = opts.meshes[0]!;
    const r = fresh();
    r.beginFrame(stubCamera());
    r.drawInstances(stubBatch(mesh.id, 10));
    const stats = r.endFrame();
    r.dispose();
    if (stats.triangles !== mesh.triangles * 10) {
      return `expected ${mesh.triangles * 10} triangles, got ${stats.triangles}`;
    }
    return null;
  });

  check("accepts every overlay kind at its contracted stride", () => {
    const kinds = Object.keys(OVERLAY_STRIDE) as OverlayKind[];
    const r = fresh();
    r.setFog(stubFog());
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain());
    for (const kind of kinds) r.drawOverlay(stubOverlay(kind));
    const stats = r.endFrame();
    r.dispose();
    // Every element here is one a player must READ. A tier or an implementation that skips one is
    // an implementation the game is not playable on (ADR-0005 §4).
    if (stats.overlayItems !== kinds.length * 2) {
      return `expected ${kinds.length * 2} overlay items, got ${stats.overlayItems}`;
    }
    return null;
  });

  check("ignores an overlay with no items", () => {
    const r = fresh();
    r.beginFrame(stubCamera());
    r.drawOverlay({ ...stubOverlay("selection"), count: 0 });
    const stats = r.endFrame();
    r.dispose();
    return stats.drawCalls === 0 ? null : `an empty overlay cost ${stats.drawCalls} draw calls`;
  });

  check("uploads the terrain once however many frames draw it", () => {
    const r = fresh();
    const terrain = stubTerrain(42);
    for (let f = 0; f < 30; f++) {
      r.beginFrame(stubCamera());
      r.drawTerrain(terrain);
      r.endFrame();
    }
    r.beginFrame(stubCamera());
    r.drawTerrain(terrain);
    const stats = r.endFrame();
    r.dispose();
    return stats.terrainUploads === 1 ? null : `terrain uploaded ${stats.terrainUploads} times across 31 frames`;
  });

  check("re-uploads the terrain when its version moves", () => {
    const r = fresh();
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain(1));
    r.endFrame();
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain(2));
    const stats = r.endFrame();
    r.dispose();
    return stats.terrainUploads === 2 ? null : `expected 2 terrain uploads, got ${stats.terrainUploads}`;
  });

  check("uploads the fog only when its version moves", () => {
    const r = fresh();
    const fog = stubFog(7);
    for (let i = 0; i < 10; i++) r.setFog(fog);
    r.setFog(stubFog(8));
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain());
    const stats = r.endFrame();
    r.dispose();
    return stats.fogUploads === 2 ? null : `expected 2 fog uploads across 11 calls, got ${stats.fogUploads}`;
  });

  check("resets per-frame counters between frames", () => {
    const r = fresh();
    r.beginFrame(stubCamera());
    r.drawInstances(stubBatch(opts.meshes[0]!.id, 5));
    r.endFrame();
    r.beginFrame(stubCamera());
    const stats = r.endFrame();
    r.dispose();
    // A renderer that accumulates makes every perf number a lie by the second minute.
    if (stats.drawCalls !== 0 || stats.instances !== 0) {
      return `counters carried over: ${stats.drawCalls} calls, ${stats.instances} instances`;
    }
    return null;
  });

  check("survives a tier switch mid-session without losing its meshes", () => {
    // PRD F-09: the player switches tier at runtime and keeps their session.
    const r = fresh();
    r.beginFrame(stubCamera());
    r.drawInstances(stubBatch(opts.meshes[0]!.id, 4));
    r.endFrame();
    r.setTier("T0");
    r.resize(1280, 720, 1);
    r.beginFrame(stubCamera());
    r.drawInstances(stubBatch(opts.meshes[0]!.id, 4));
    const stats = r.endFrame();
    r.dispose();
    return stats.instances === 4 ? null : `after a tier switch the renderer drew ${stats.instances} of 4 instances`;
  });

  check("tolerates a resize between frames", () => {
    const r = fresh();
    r.beginFrame(stubCamera());
    r.endFrame();
    r.resize(1600, 900, 2);
    r.beginFrame(stubCamera());
    r.drawTerrain(stubTerrain());
    const stats = r.endFrame();
    r.dispose();
    return stats.drawCalls >= 1 ? null : "drew nothing after a resize";
  });

  check("dispose is safe and idempotent", () => {
    const r = fresh();
    r.beginFrame(stubCamera());
    r.endFrame();
    r.dispose();
    r.dispose();
    return null;
  });

  return cases;
}
