// The test oracle (ADR-0005, ADR-0009): a `Renderer` that draws nothing and remembers everything.
//
// Render-layer tests assert against this — draw-call counts, batch composition, culling, LOD
// switchover, terrain rebuild counts — which is what makes "test the renderer" possible on a CI
// runner with no GPU at all. It is also the reference implementation of the port's call-order
// contract: it throws on a misuse rather than quietly producing a plausible frame, because a fake
// that is more forgiving than the real thing teaches the wrong lesson.
//
// It copies the batches it records. That costs allocation — deliberately, and only here: the whole
// point is to inspect what a frame contained AFTER the frame, and the caller's scratch buffers
// have been overwritten by then. Allocation tests measure the production renderers, not this one.

import {
  type CameraState, type FogField, type FrameStats, type InstanceBatch, type MeshData,
  type OverlayKind, type OverlayLayer, type OwnerSlot, type Renderer, type TerrainMesh, type Tier,
  type LodLevel, OVERLAY_STRIDE,
} from "./port.js";

export interface RecordedBatch {
  mesh: string;
  owner: OwnerSlot;
  lod: LodLevel;
  count: number;
  xyz: Float32Array;
  yaw: Float32Array;
  scale: Float32Array;
  shade: Float32Array;
}

export interface RecordedOverlay {
  kind: OverlayKind;
  count: number;
  stride: number;
  data: Float32Array;
}

export interface RecordedFrame {
  camera: CameraState;
  terrainVersion: number | null;
  batches: RecordedBatch[];
  overlays: RecordedOverlay[];
  stats: FrameStats;
}

export class RecordingRenderer implements Renderer {
  readonly name = "recording";

  readonly frames: RecordedFrame[] = [];
  meshes: readonly MeshData[] = [];
  tier: Tier = "T2";
  width = 1280;
  height = 720;
  dpr = 1;
  fogVersion = -1;

  /** Cap on retained frames. A 600-frame allocation test would otherwise keep 600 frames alive. */
  keepFrames = 4;

  private open: RecordedFrame | null = null;
  private terrainUploads = 0;
  private fogUploads = 0;
  private lastTerrainVersion = -1;
  private meshTriangles = new Map<string, number>();

  registerMeshes(meshes: readonly MeshData[]): void {
    if (this.open) throw new Error("registerMeshes during a frame — meshes are registered once at boot (ADR-0005)");
    this.meshes = meshes;
    this.meshTriangles.clear();
    for (const m of meshes) this.meshTriangles.set(m.id, m.triangles);
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  setTier(tier: Tier): void {
    this.tier = tier;
  }

  setFog(fog: FogField): void {
    if (this.open) throw new Error("setFog during a frame — the fog uploads once per tick, not per frame (ADR-0006)");
    if (fog.version === this.fogVersion) return;
    this.fogVersion = fog.version;
    this.fogUploads++;
  }

  beginFrame(camera: CameraState): void {
    if (this.open) throw new Error("beginFrame without endFrame — the port's call order is fixed");
    this.open = {
      camera,
      terrainVersion: null,
      batches: [],
      overlays: [],
      stats: { drawCalls: 0, instances: 0, triangles: 0, overlayItems: 0, terrainUploads: 0, fogUploads: 0, cpuMs: 0 },
    };
  }

  drawTerrain(terrain: TerrainMesh): void {
    const frame = this.requireFrame("drawTerrain");
    if (terrain.version !== this.lastTerrainVersion) {
      this.lastTerrainVersion = terrain.version;
      this.terrainUploads++;
    }
    frame.terrainVersion = terrain.version;
    frame.stats.drawCalls++;
    frame.stats.triangles += terrain.triangles;
  }

  drawInstances(batch: InstanceBatch): void {
    const frame = this.requireFrame("drawInstances");
    if (batch.count === 0) throw new Error(`empty batch for ${batch.mesh} — an empty draw call is still a draw call (ADR-0006)`);
    if (!this.meshTriangles.has(batch.mesh)) throw new Error(`unregistered mesh "${batch.mesh}"`);
    frame.batches.push({
      mesh: batch.mesh,
      owner: batch.owner,
      lod: batch.lod,
      count: batch.count,
      xyz: batch.xyz.slice(0, batch.count * 3),
      yaw: batch.yaw.slice(0, batch.count),
      scale: batch.scale.slice(0, batch.count),
      shade: batch.shade.slice(0, batch.count),
    });
    frame.stats.drawCalls++;
    frame.stats.instances += batch.count;
    frame.stats.triangles += batch.count * (this.meshTriangles.get(batch.mesh) ?? 0);
  }

  drawOverlay(layer: OverlayLayer): void {
    const frame = this.requireFrame("drawOverlay");
    const expected = OVERLAY_STRIDE[layer.kind];
    if (layer.stride !== expected)
      throw new Error(`overlay "${layer.kind}" packed at stride ${layer.stride}, contract says ${expected}`);
    if (layer.count === 0) return;   // an empty overlay costs nothing and is not a draw call
    frame.overlays.push({
      kind: layer.kind,
      count: layer.count,
      stride: layer.stride,
      data: layer.data.slice(0, layer.count * layer.stride),
    });
    frame.stats.drawCalls++;
    frame.stats.overlayItems += layer.count;
  }

  endFrame(): FrameStats {
    const frame = this.requireFrame("endFrame");
    frame.stats.terrainUploads = this.terrainUploads;
    frame.stats.fogUploads = this.fogUploads;
    this.open = null;
    this.frames.push(frame);
    if (this.frames.length > this.keepFrames) this.frames.shift();
    return frame.stats;
  }

  dispose(): void {
    this.open = null;
    this.frames.length = 0;
  }

  /** The most recent completed frame — what tests assert against. */
  get lastFrame(): RecordedFrame {
    const f = this.frames[this.frames.length - 1];
    if (!f) throw new Error("no frame has been completed yet");
    return f;
  }

  private requireFrame(call: string): RecordedFrame {
    if (!this.open) throw new Error(`${call} outside a frame — call beginFrame first`);
    return this.open;
  }
}
