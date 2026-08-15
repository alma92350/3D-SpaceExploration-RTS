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
  FLAG_BUILDING_KIND, FLAG_CARRYING, FLAG_CONSTRUCTING, FLAG_SELECTED, type Snapshot,
} from "../bridge/snapshot.js";
import { type ElevationField, elevation } from "./terrain/elevation.js";
import { interpolatePositions } from "./interpolate.js";
import { IMPOSTER_SIZE, type MeshId, meshIdForNode, meshIdForType } from "./meshes/generators.js";
import {
  type CameraState, type FrameStats, LOD_IMPOSTER, LOD_MESH, type LodLevel, OVERLAY_STRIDE,
  type OwnerSlot, type Renderer, type TerrainMesh,
} from "./renderer/port.js";
import { type TierConfig } from "./renderer/tiers.js";
import { hasStatusGlyph } from "./renderer/glyphs.js";
import { CombatEffects } from "./effects.js";

const INITIAL_BATCH_CAPACITY = 64;
const OWNER_SLOTS = 2;
const LOD_LEVELS = 2;

/** Neutral owner slot — resource nodes and stars belong to nobody. */
const NEUTRAL_SLOT = 2 as OwnerSlot;

/**
 * How far a drawn LINE is lifted off the terrain, in world units.
 *
 * Both ends of a tracer and both ends of a rally line get the same lift, and it is the same number
 * `view/landing.ts` uses for its own line: a line that followed the ground would sink into every
 * slope it crosses, and two lines lifted differently would cross each other in mid-air.
 */
const LINE_LIFT = 2.2;

/** The impact mark's lift. A ground ring, so it sits where a selection ring or an aura sits. */
const IMPACT_LIFT = 0.5;


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
  /**
   * Live combat effects (P3-T06). Owned by the composer rather than the snapshot because an effect
   * outlives the tick that made it: the sim reports a shot once at 20 Hz and it stays on screen for
   * the three frames until the next one.
   */
  readonly effects = new CombatEffects();

  constructor(private readonly field: ElevationField) {
    for (const kind of Object.keys(OVERLAY_STRIDE) as Array<keyof typeof OVERLAY_STRIDE>) {
      this.overlays.set(kind, new OverlayBuffer(OVERLAY_STRIDE[kind]));
    }
  }

  /**
   * Take one tick's shots and deaths into the effect pool.
   *
   * **Once per simulation step, never per frame.** Calling it twice for one tick draws every tracer
   * twice and doubles the apparent rate of fire — and because the snapshot is the same object
   * across the frames between ticks, a `compose`-side ingest would do exactly that.
   */
  ingestTick(snap: Snapshot): void {
    this.effects.ingestTick(snap);
  }

  /** Advance the effect pool by a frame. Retires expired effects; allocates nothing. */
  ageEffects(seconds: number): void {
    this.effects.age(seconds);
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
    // The imposter quad's facing, computed ONCE for the frame (P6-T07).
    //
    // The quad's geometry is a unit square in the model's XY plane, so its outward normal is +Z
    // (`generators.ts`: "one camera-facing quad. The renderer billboards it"). No renderer
    // billboards it: both apply the batch's own `yaw` about Y and nothing else, and this pushed 0.
    // Measured consequence, on the 8 yaw snaps the rig actually allows — the quad was BACK-FACING
    // at five of them (0, 1, 2, 6, 7), which the instance material's front-face culling drops
    // entirely, and at two of those (2 and 6) it projected to 0.00 px wide, which is nothing in
    // either renderer. `yawIndex` 0 is the boot default, so the game's opening camera drew no
    // imposter at all — and past T0's LOD distance that is a median 57% of the entities on screen.
    //
    // A rotation of θ about Y sends the normal to (sin θ, cos θ), and the eye sits at
    // −(sin yaw, cos yaw) × horizontal from the look-at point, so θ = yaw + π points the quad at
    // the camera. VIEW-PLANE aligned rather than eye-facing: one addition for the whole frame
    // instead of an `atan2` per instance, and imposters that never rotate against each other.
    // Measured after: front-facing and 21.10 px wide at all eight snaps, where the widest the old
    // code ever managed was 21.10 at two of them and 0.00 at two more.
    //
    // It cannot fix PITCH. `drawInstances` applies a Y rotation only, so a vertical quad under a
    // camera pitched 74° down stays foreshortened; a full billboard needs a renderer change.
    const imposterYaw = camera.yaw + Math.PI;

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
      // Shade carries construction for buildings and CARGO for units, and the two never collide
      // because a building is never carrying and a unit is never constructing (P2-T05).
      //
      // A laden hauler brightens with how full its hold is, not merely with whether it is carrying:
      // the snapshot already computes a 0..1 fullness, and collapsing that to a boolean would lose
      // the difference between a hauler on its way home and one that has barely started. It is a
      // per-instance attribute rather than a second "laden" mesh, which would have cost a draw call
      // per owner to say one number (ADR-0006: uniqueness comes from instance attributes).
      const shade = constructing
        ? 0.45 + 0.35 * progress
        : !isBuilding && (flags & FLAG_CARRYING) !== 0
          // Downward, not upward. Brightening past 1 was the first instinct and it would have put
          // 1.35 into a channel the port documents as 0..1 — a contract three implementations read,
          // where WebGL would have brightened and Canvas2D might well have clamped, so the two
          // renderers would disagree about the same frame. A laden hull sitting darker and heavier
          // reads just as well and needs no contract change.
          ? 1 - 0.38 * progress
          : 1;

      if (lod === LOD_IMPOSTER) {
        // The imposter is one quad, and its scale is the size of THE MESH IT REPLACES (P7-T02).
        //
        // This used to be `e.radius[i] * 2.2` — the engine's collision circle, times a constant that
        // arrived in the Phase 1 MVP commit with no working — used for the quad's HEIGHT as well as
        // its width. P6-T07 measured what that cost by projecting every mesh vertex and every quad
        // corner through the same camera: the quad covered **0.73× to 10.35×** the mesh's screen
        // area, and binary-searching the distance at which the two bounding boxes agree within one
        // rasterised pixel gave 7 151 to 43 858 world units against a cull distance of 1 100. There
        // is no threshold that fixes a size, which is why `tiers.ts` refused to move `lodDistance`
        // and named the quad instead.
        //
        // Two changes, and the measurement says the first one is the big half:
        //   • The size comes from `IMPOSTER_SIZE`, the mean width of the mesh's own footprint over
        //     every facing, rather than from the entity's radius. An imposter replaces a mesh, so
        //     the only size that cannot pop is that mesh's — and where ADR-0014's families put four
        //     freighters of different collision radii on one hull, the entity's radius is not even
        //     one number.
        //   • The quad itself leans back by the camera rig's mid-pitch (`IMPOSTER_LEAN`), which is
        //     what turns a Y-rotation-only renderer into a billboard to within ±19.5° at every zoom.
        //
        // Measured after, over the whole roster × every zoom the rig allows × all eight yaw snaps,
        // against the mesh's own screen box (`perf/imposter-probe.mjs`): screen WIDTH 0.88–2.99× →
        // **0.95–1.13×**, screen HEIGHT 0.34–5.60× → **0.48–2.20×**, screen AREA 0.30–14.68× →
        // **0.49–2.23×**. What is left is not a size error: it is the roster's own aspect spread —
        // a Skiff 2.4 units high and a Plasma Rig 26 cannot both be a square — and closing that
        // needs a non-uniform per-instance scale, which is a `Renderer` port change and is argued
        // in ADR-0024 rather than hidden here.
        this.batchFor("imposter", owner, lod)
          .push(x, height, y, imposterYaw, IMPOSTER_SIZE[mesh] * scale, shade);
      } else {
        this.batchFor(mesh, owner, lod).push(x, height, y, e.facing[i]!, scale, shade);
      }

      this.pushEntityOverlays(snap, i, x, y, height, isBuilding, owner, distSq, lodSq);
    }

    this.pushNodes(snap, camera, cullSq);
    this.pushAuras(snap, camera, cullSq);
    this.pushBombs(snap, camera, cullSq);
    this.pushRally(snap, camera, cullSq);
    this.pushEffects(camera, cullSq);
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

    // Health bars, chevrons and status badges only where they can be read.
    //
    // This used to say they are "sub-pixel clutter that costs a draw call's worth of vertices" past
    // imposter range, and P6-T07 measured both halves of that and found both wrong. They are drawn
    // by `drawOverlayLayer`, which both renderers share, as CONSTANT-pixel 2D shapes projected onto
    // the overlay canvas — a health bar is a 22×5 px `fillRect` at 200 units and at 2 000 — so they
    // are never sub-pixel at any distance, and they have no vertices at all.
    //
    // The gate is still right, for the reason it did not give: at imposter range the entities are a
    // few pixels apart on screen while their bars stay 22 px wide, so the bars stop reading as
    // belonging to anything and become a solid band. It is CROWDING, not shrinking — which matters,
    // because the two have different fixes and only one of them is a distance.
    //
    // Sharing `lodSq` with the mesh/imposter switch is convenient rather than derived: "is the mesh
    // worth drawing?" and "can the player read a bar?" are different questions, and `tiers.ts` now
    // records that neither has a measured answer behind it.
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

      // The building-state badge (P2-T08). Same LOD gate as the health bar and for the same reason:
      // a nine-pixel glyph at imposter range is noise, and a player reading their base's state is
      // looking at their base.
      //
      // Both codes are passed through untouched and the *view* decides what to draw from them, so
      // the bridge stays a reporter (ADR-0012 §5). A healthy working building has no badge, which
      // is the only reason a 300-building base is readable at all — and it is filtered HERE, like
      // the health bar above it, so the frame does not pack 1 500 floats to draw nothing.
      //
      // Constructing buildings are excluded: their state is already the scale ramp, and a badge on
      // a half-risen shell reads as a fault rather than as progress.
      const p = snap.production;
      if (isBuilding && (flags & FLAG_CONSTRUCTING) === 0
          && hasStatusGlyph(p.concern[i]!, p.activity[i]!)) {
        this.overlays.get("status")!.push(
          x, height + entityBarHeight(e.radius[i]!, isBuilding) + 5, y, p.concern[i]!, p.activity[i]!,
        );
      }
    }
  }

  /**
   * Combat feedback — tracers and death marks (P3-T06).
   *
   * The pool is the composer's, not the snapshot's, because an effect outlives the tick that
   * created it: the sim reports a shot once at 20 Hz and it has to stay on screen across the three
   * frames before the next tick. `ingestTick` fills it, `ageEffects` retires from it, and this only
   * reads — so the frame path allocates nothing.
   */
  private pushEffects(camera: CameraState, cullSq: number): void {
    const fx = this.effects;
    const tracers = this.overlays.get("tracer")!;
    for (let i = 0; i < fx.tracerCount; i++) {
      const x0 = fx.tx0[i]!;
      const y0 = fx.ty0[i]!;
      const dx = x0 - camera.eyeX;
      const dz = y0 - camera.eyeZ;
      if (dx * dx + dz * dz > cullSq) continue;
      const x1 = fx.tx1[i]!;
      const y1 = fx.ty1[i]!;
      // Both ends are lifted off the ground by the same small amount: a tracer that followed the
      // terrain would disappear into a slope it crosses.
      tracers.push(
        x0, elevation(this.field, x0, y0) + LINE_LIFT, y0,
        x1, elevation(this.field, x1, y1) + LINE_LIFT, y1,
        fx.tracerFade(i), fx.tOwner[i]!,
      );
    }

    const blasts = this.overlays.get("blast")!;
    for (let i = 0; i < fx.blastCount; i++) {
      const x = fx.bx[i]!;
      const y = fx.by[i]!;
      const dx = x - camera.eyeX;
      const dz = y - camera.eyeZ;
      if (dx * dx + dz * dz > cullSq) continue;
      blasts.push(x, elevation(this.field, x, y) + 1.0, y, fx.blastProgress(i), fx.bBig[i]!, fx.bOwner[i]!);
    }

    // Landed hits that had something to say (P5-T15). The pool is already filtered — `ingestTick`
    // drops a plain hit — so everything here draws.
    const impacts = this.overlays.get("impact")!;
    const cull = Math.sqrt(cullSq);
    for (let i = 0; i < fx.impactCount; i++) {
      const x = fx.ix[i]!;
      const y = fx.iy[i]!;
      const splash = fx.iSplash[i]!;
      const dx = x - camera.eyeX;
      const dz = y - camera.eyeZ;
      // Widened by the splash radius, on the same rule as the aura and the bomb: a Colossus shell
      // landing just off the screen edge still rattles units the player IS looking at, and clipping
      // the impact point would hide the reason half an army lost health at once.
      const reach = cull + splash;
      if (dx * dx + dz * dz > reach * reach) continue;
      impacts.push(
        x, elevation(this.field, x, y) + IMPACT_LIFT, y,
        fx.impactProgress(i), fx.iHeavy[i]!, fx.iBonus[i]!, splash, fx.iOwner[i]!,
      );
    }
  }

  /**
   * Rally lines (P5-T15, PARITY row 8) — where the selected producers send what they build.
   *
   * The `rally` overlay kind and both renderers' drawing of it have existed since Phase 1; this is
   * the line of code that was missing. Everything about *which* buildings get one is decided at the
   * bridge (`RallyTable`), because the filters are ownership and an engine table — neither of which
   * `view/` may look at (ADR-0008).
   *
   * Culled on the BUILDING's end rather than the rally point's, exactly as a tracer is culled on the
   * shooter's: the line belongs to the thing the player selected, and a rally point set across the
   * map should not make its own line disappear when the camera looks at the building.
   */
  private pushRally(snap: Snapshot, camera: CameraState, cullSq: number): void {
    const rally = snap.rally;
    const buf = this.overlays.get("rally")!;
    for (let i = 0; i < rally.count; i++) {
      const x0 = rally.fromX[i]!;
      const y0 = rally.fromY[i]!;
      const dx = x0 - camera.eyeX;
      const dz = y0 - camera.eyeZ;
      if (dx * dx + dz * dz > cullSq) continue;
      const x1 = rally.toX[i]!;
      const y1 = rally.toY[i]!;
      buf.push(
        x0, elevation(this.field, x0, y0) + LINE_LIFT, y0,
        x1, elevation(this.field, x1, y1) + LINE_LIFT, y1,
      );
    }
  }

  /**
   * Guard-aura rings (P3-T04). One overlay layer for every aura on the field, so the cue that makes
   * the Aegis Bastion distinguishable from the two things it shares a mesh with costs one draw call
   * for the whole frame rather than a mesh and two batches.
   *
   * The cull radius is widened by the aura's own radius: a bastion just off-screen still projects
   * over ground the player is looking at, and clipping the projector would blink the ring away at
   * the screen edge — exactly where a player is watching for an attack.
   */
  private pushAuras(snap: Snapshot, camera: CameraState, cullSq: number): void {
    const auras = snap.auras;
    const buf = this.overlays.get("aura")!;
    for (let i = 0; i < auras.count; i++) {
      const x = auras.x[i]!;
      const y = auras.y[i]!;
      const r = auras.radius[i]!;
      const dx = x - camera.eyeX;
      const dz = y - camera.eyeZ;
      const reach = Math.sqrt(cullSq) + r;
      if (dx * dx + dz * dz > reach * reach) continue;
      buf.push(x, elevation(this.field, x, y) + 0.3, y, r, auras.owner[i]!);
    }
  }

  /**
   * The Helium Bomb's reach and its fuse (P3-T10).
   *
   * Same widened cull as the aura, and for a sharper version of the same reason: a bomb just off the
   * left edge of the screen reaches ground the player is looking at, and blinking its ring away at
   * the frame edge would hide the one thing on the map that can erase an army in four seconds.
   *
   * `fuse01` runs 0 → 1 as the fuse burns. It is computed from the **sim's** remaining seconds and
   * the sim's own delay — `view/` may not import the engine, so the delay rides on the table — never
   * from a wall clock. A paused game therefore holds the arc still instead of detonating it on
   * screen while the sim has not moved.
   */
  private pushBombs(snap: Snapshot, camera: CameraState, cullSq: number): void {
    const bombs = snap.bombs;
    const buf = this.overlays.get("bomb")!;
    for (let i = 0; i < bombs.count; i++) {
      const x = bombs.x[i]!;
      const y = bombs.y[i]!;
      const blast = bombs.blast[i]!;
      const dx = x - camera.eyeX;
      const dz = y - camera.eyeZ;
      const reach = Math.sqrt(cullSq) + blast;
      if (dx * dx + dz * dz > reach * reach) continue;
      const fuse = bombs.fuse[i]!;
      const lit = fuse >= 0 ? 1 : 0;
      const delay = bombs.fuseDelay > 0 ? bombs.fuseDelay : 1;
      const fuse01 = lit ? 1 - Math.max(0, Math.min(1, fuse / delay)) : 0;
      buf.push(x, elevation(this.field, x, y) + 0.35, y, bombs.core[i]!, blast, lit, fuse01, bombs.owner[i]!);
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
      // Origin beats contents (ADR-0018): salvage and craters draw as what happened to them, not as
      // what they hold. `comIndex` still decides a natural deposit, exactly as P2-T17 left it.
      const mesh = meshIdForNode(snap.comNames[nodes.comIndex[i]!] ?? "ore", nodes.kind[i]!);
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
