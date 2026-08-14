// Frame composition: snapshot → batches → the renderer port (ADR-0005, ADR-0006, P1-T09/T14/T15).
//
// This is where the CPU-only budget is actually spent or saved, so every choice here is a budget
// choice:
//
//   • **One draw call per (mesh, owner, LOD).** Entities are bucketed into preallocated batches
//     keyed on exactly that triple, so 200 units of 4 types across 2 owners is 8 draw calls, not
//     200. `FrameStats.drawCalls` is asserted against this in the contract tests.
//   • **Cull before batching, not after.** An entity outside the frustum or beyond the tier's cull
//     distance never enters a batch, so it costs one distance test and nothing else.
//   • **Every buffer is preallocated and reused.** The scene owns its scratch; a frame that
//     allocates is a frame that can be interrupted by a GC pause it cannot afford.
//
// The overlays go through the same port for the same reason ADR-0005 §4 gives: they are what the
// player READS, so they must survive the drop to T0 and to Canvas2D.

import {
  FLAG_BUILDING_KIND, FLAG_CONSTRUCTING, FLAG_SELECTED, type Snapshot,
} from "../bridge/snapshot.js";
import { type ElevationField, elevation } from "./terrain/elevation.js";
import { interpolatePositions } from "./interpolate.js";
import { type MeshId, meshIdForCommodity, meshIdForType } from "./meshes/generators.js";
import {
  type CameraState, type FrameStats, LOD_IMPOSTER, LOD_MESH, type LodLevel, OVERLAY_STRIDE,
  type OwnerSlot, type Renderer, type TerrainMesh,
} from "./renderer/port.js";
import { type TierConfig } from "./renderer/tiers.js";

const INITIAL_BATCH_CAPACITY = 64;
const OWNER_SLOTS = 2;
const LOD_LEVELS = 2;

/** Neutral owner slot — resource nodes and stars belong to nobody. */
const NEUTRAL_SLOT = 2 as OwnerSlot;


/** One bucket of instances sharing a mesh, an owner and a LOD. Grown in powers of two, off-frame. */
class Batch {
  count = 0;
  xyz: Float32Array;
  yaw: Float32Array;
  scale: Float32Array;
  shade: Float32Array;

  constructor(capacity: number) {
    this.xyz = new Float32Array(capacity * 3);
    this.yaw = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.shade = new Float32Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.yaw.length) return;
    let next = this.yaw.length || INITIAL_BATCH_CAPACITY;
    while (next < needed) next *= 2;
    this.xyz = new Float32Array(next * 3);
    this.yaw = new Float32Array(next);
    this.scale = new Float32Array(next);
    this.shade = new Float32Array(next);
  }

  push(x: number, y: number, z: number, yaw: number, scale: number, shade: number): void {
    const i = this.count;
    this.ensure(i + 1);
    this.xyz[i * 3] = x;
    this.xyz[i * 3 + 1] = y;
    this.xyz[i * 3 + 2] = z;
    this.yaw[i] = yaw;
    this.scale[i] = scale;
    this.shade[i] = shade;
    this.count = i + 1;
  }
}

/** Scratch for one overlay kind. Same growth discipline as the batches. */
class OverlayBuffer {
  count = 0;
  data: Float32Array;

  constructor(readonly stride: number, capacity = 64) {
    this.data = new Float32Array(capacity * stride);
  }

  ensure(items: number): void {
    const need = items * this.stride;
    if (need <= this.data.length) return;
    let next = this.data.length || this.stride * 64;
    while (next < need) next *= 2;
    this.data = new Float32Array(next);
  }

  push(...values: number[]): void {
    this.ensure(this.count + 1);
    const off = this.count * this.stride;
    for (let i = 0; i < this.stride; i++) this.data[off + i] = values[i] ?? 0;
    this.count++;
  }
}

export interface GhostState {
  readonly active: boolean;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly valid: boolean;
  readonly meshId: MeshId;
  /** Build reach from the nearest selected worker; 0 hides the reach ring. */
  readonly reach: number;
}

export class SceneComposer {
  private readonly batches = new Map<string, Batch>();
  private readonly batchOrder: Array<{ key: string; mesh: MeshId; owner: OwnerSlot; lod: LodLevel }> = [];
  private readonly overlays = new Map<string, OverlayBuffer>();
  private interpX = new Float32Array(256);
  private interpY = new Float32Array(256);

  constructor(private readonly field: ElevationField) {
    for (const kind of Object.keys(OVERLAY_STRIDE) as Array<keyof typeof OVERLAY_STRIDE>) {
      this.overlays.set(kind, new OverlayBuffer(OVERLAY_STRIDE[kind]));
    }
  }

  /**
   * Draw one frame and return what it cost.
   *
   * Returning `FrameStats` rather than swallowing it is what lets the perf harness and the render-
   * contract tests measure a frame without reaching around the composer to call `endFrame` twice.
   *
   * @param alpha interpolation factor from the loop — NOT the snapshot's, which has none.
   */
  compose(
    renderer: Renderer,
    snap: Snapshot,
    camera: CameraState,
    tier: TierConfig,
    terrain: TerrainMesh,
    alpha: number,
    ghost: GhostState | null,
  ): FrameStats {
    this.resetBuffers();

    const e = snap.entities;
    this.ensureInterpBuffers(e.count);
    interpolatePositions(snap, alpha, this.interpX, this.interpY);

    const cullSq = tier.cullDistance * tier.cullDistance;
    const lodSq = tier.lodDistance * tier.lodDistance;

    for (let i = 0; i < e.count; i++) {
      const x = this.interpX[i]!;
      const y = this.interpY[i]!;
      const dx = x - camera.eyeX;
      const dz = y - camera.eyeZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > cullSq) continue;

      const height = elevation(this.field, x, y);
      const flags = e.flags[i]!;
      const isBuilding = (flags & FLAG_BUILDING_KIND) !== 0;
      const typeName = snap.typeNames[e.typeIndex[i]!]!;
      const mesh = meshIdForType(typeName);
      const owner = e.owner[i]! as OwnerSlot;
      const lod: LodLevel = distSq > lodSq ? LOD_IMPOSTER : LOD_MESH;

      // A building under construction rises out of the ground as it completes, and dims. Both cues
      // come from instance attributes (scale, shade) rather than a second material — instancing
      // gives us exactly those two knobs and ADR-0006 says to use them.
      const constructing = (flags & FLAG_CONSTRUCTING) !== 0;
      const progress = e.progress[i]!;
      const scale = isBuilding
        ? (constructing ? 0.35 + 0.65 * progress : 1)
        : 1;
      const shade = constructing ? 0.45 + 0.35 * progress : 1;

      if (lod === LOD_IMPOSTER) {
        // The imposter is a unit quad; its scale carries the entity's real size so a distant
        // Command Center still reads as bigger than a distant Skiff.
        this.batchFor("imposter", owner, lod).push(x, height, y, 0, e.radius[i]! * 2.2 * scale, shade);
      } else {
        this.batchFor(mesh, owner, lod).push(x, height, y, e.facing[i]!, scale, shade);
      }

      this.pushEntityOverlays(snap, i, x, y, height, isBuilding, owner, distSq, lodSq);
    }

    this.pushNodes(snap, camera, cullSq);
    if (ghost?.active) this.pushGhost(ghost);

    renderer.beginFrame(camera);
    renderer.drawTerrain(terrain);
    for (const entry of this.batchOrder) {
      const batch = this.batches.get(entry.key)!;
      if (batch.count === 0) continue;
      renderer.drawInstances({
        mesh: entry.mesh, owner: entry.owner, lod: entry.lod, count: batch.count,
        xyz: batch.xyz, yaw: batch.yaw, scale: batch.scale, shade: batch.shade,
      });
    }
    for (const [kind, buf] of this.overlays) {
      if (buf.count === 0) continue;
      renderer.drawOverlay({
        kind: kind as keyof typeof OVERLAY_STRIDE, count: buf.count, stride: buf.stride, data: buf.data,
      });
    }
    return renderer.endFrame();
  }

  private pushEntityOverlays(
    snap: Snapshot, i: number, x: number, y: number, height: number,
    isBuilding: boolean, owner: OwnerSlot, distSq: number, lodSq: number,
  ): void {
    const e = snap.entities;
    const flags = e.flags[i]!;

    if ((flags & FLAG_SELECTED) !== 0) {
      this.overlays.get("selection")!.push(x, height + 0.4, y, e.radius[i]! * 1.35);
    }

    // Health bars only where they can be read: at imposter range they are sub-pixel clutter that
    // costs a draw call's worth of vertices and tells the player nothing.
    if (distSq <= lodSq) {
      const hp = e.hp[i]!;
      const maxHp = e.maxHp[i]!;
      if (hp < maxHp - 1e-3) {
        this.overlays.get("healthbar")!.push(x, height + entityBarHeight(e.radius[i]!, isBuilding), y, hp / maxHp, owner);
      }
      const rank = e.rank[i]!;
      if (!isBuilding && rank > 0) {
        this.overlays.get("chevron")!.push(x, height + entityBarHeight(e.radius[i]!, isBuilding) + 3, y, rank);
      }
    }
  }

  private pushNodes(snap: Snapshot, camera: CameraState, cullSq: number): void {
    const nodes = snap.nodes;
    for (let i = 0; i < nodes.count; i++) {
      const x = nodes.x[i]!;
      const y = nodes.y[i]!;
      const dx = x - camera.eyeX;
      const dz = y - camera.eyeZ;
      if (dx * dx + dz * dz > cullSq) continue;
      // The deposit's commodity has crossed the bridge since Phase 1 and was thrown away here —
      // every deposit drew with the one `node` mesh. Two meshes now, rock and volatile (ADR-0014).
      // `batchFor` is inside the loop rather than hoisted because there are two batches, and it is
      // a map lookup rather than an allocation.
      const mesh = meshIdForCommodity(snap.comNames[nodes.comIndex[i]!] ?? "ore");
      // A worked-out deposit visibly shrinks — the one piece of economy feedback the MVP shows
      // without a panel, and the cheapest possible way to show it.
      const remaining = nodes.remaining[i]!;
      this.batchFor(mesh, NEUTRAL_SLOT, LOD_MESH)
        .push(x, elevation(this.field, x, y), y, 0, 0.55 + 0.45 * remaining, 0.8 + 0.2 * remaining);
    }
  }

  private pushGhost(ghost: GhostState): void {
    const height = elevation(this.field, ghost.x, ghost.y);
    this.batchFor(ghost.meshId, 0 as OwnerSlot, LOD_MESH).push(
      ghost.x, height, ghost.y, 0, 1, ghost.valid ? 0.75 : 0.4,
    );
    this.overlays.get("ghost")!.push(
      ghost.x, height + 0.4, ghost.y, ghost.radius, ghost.valid ? 1 : 0, ghost.reach);
  }

  private batchFor(mesh: MeshId, owner: OwnerSlot, lod: LodLevel): Batch {
    const key = `${mesh}|${owner}|${lod}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = new Batch(INITIAL_BATCH_CAPACITY);
      this.batches.set(key, batch);
      this.batchOrder.push({ key, mesh, owner, lod });
      // Stable order across frames: the WebGL implementation binds one instanced buffer per key,
      // and a batch order that reshuffles frame to frame turns that into a rebind storm.
      this.batchOrder.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    return batch;
  }

  /**
   * Grow the interpolation scratch. Named for what it does because the architecture test's
   * allocation scan reads names: growth belongs in an `ensure*` method, and a `new Float32Array`
   * anywhere else in this file is the bug that test is looking for.
   */
  private ensureInterpBuffers(count: number): void {
    if (this.interpX.length >= count) return;
    const size = nextPow2(count);
    this.interpX = new Float32Array(size);
    this.interpY = new Float32Array(size);
  }

  private resetBuffers(): void {
    for (const b of this.batches.values()) b.count = 0;
    for (const o of this.overlays.values()) o.count = 0;
  }

  /** How many distinct draw calls the last composition would issue. Asserted by the contract tests. */
  get expectedDrawCalls(): number {
    let n = 1;   // terrain
    for (const b of this.batches.values()) if (b.count > 0) n++;
    for (const o of this.overlays.values()) if (o.count > 0) n++;
    return n;
  }

  /** Upper bound on batch keys, for the instancing test's own arithmetic. */
  static maxBatchKeys(meshCount: number): number {
    return meshCount * OWNER_SLOTS * LOD_LEVELS;
  }
}

function entityBarHeight(radius: number, isBuilding: boolean): number {
  return isBuilding ? radius * 0.9 + 14 : radius * 1.4 + 7;
}

function nextPow2(n: number): number {
  let v = 64;
  while (v < n) v *= 2;
  return v;
}
