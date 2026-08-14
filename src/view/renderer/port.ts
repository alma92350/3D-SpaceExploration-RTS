// The `Renderer` port (ADR-0005). `view/` draws through this and never through three.js.
//
// Three implementations ship: `WebGLRenderer` (three.js, tiers T0–T3), `Canvas2DRenderer` (the
// no-WebGL product path), and `RecordingRenderer` (the test oracle). All three pass the same
// conformance suite, which is the only thing that keeps them honest about each other.
//
// Everything here is designed around one rule from ADR-0006: **no allocation in a steady-state
// frame**. That is why the types below are flat views over preallocated typed arrays with an
// explicit `count`, rather than arrays of objects. A batch is a window onto scratch memory the
// caller owns and reuses; an implementation must read it during the call and never retain it.

/** Quality/perf preset. The table of record is PRD §6.2. */
export type Tier = "T0" | "T1" | "T2" | "T3";

/**
 * Owner colour slot. Numeric rather than `"player" | "ai"` because it indexes the instance
 * palette and the batch key — a string here would mean a hash lookup per entity per frame.
 */
export const OWNER_PLAYER = 0;
export const OWNER_AI = 1;
export const OWNER_NEUTRAL = 2;
export type OwnerSlot = typeof OWNER_PLAYER | typeof OWNER_AI | typeof OWNER_NEUTRAL;

/** Level of detail. Beyond the tier's LOD distance a mesh collapses to a camera-facing quad. */
export const LOD_MESH = 0;
export const LOD_IMPOSTER = 1;
export type LodLevel = typeof LOD_MESH | typeof LOD_IMPOSTER;

/**
 * The camera, as both renderers see it.
 *
 * `viewProj` is the authority: the Canvas2D implementation projects through the very same matrix
 * the WebGL implementation uploads, so the two views agree about where a unit is on screen, and
 * picking (which inverts this matrix) agrees with both. Sharing the matrix rather than the camera
 * *parameters* is what makes PRD F-03's ±0.5-unit promise testable across implementations.
 */
export interface CameraState {
  /** Column-major 4×4, world → clip. */
  readonly viewProj: Float32Array;
  readonly eyeX: number;
  readonly eyeY: number;
  readonly eyeZ: number;
  /** Look-at point on the ground plane, in sim coordinates. */
  readonly targetX: number;
  readonly targetY: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** A procedural low-poly mesh (ADR-0005): flat-shaded, vertex-coloured, no textures. */
export interface MeshData {
  readonly id: string;
  /** xyz triples, model space, origin at the ground contact point. */
  readonly positions: Float32Array;
  /** rgb triples, one per vertex. Owner colour is applied per instance, not baked here. */
  readonly colors: Float32Array;
  readonly indices: Uint16Array;
  /** How much of the vertex colour is replaced by the owner's colour, per vertex (0..1). */
  readonly ownerMix: Float32Array;
  readonly triangles: number;
  /** Bounding radius in world units — culling and the imposter quad both need it. */
  readonly radius: number;
  readonly height: number;
}

/** The terrain, uploaded once and redrawn from a handle (ADR-0006: rebuilt only on change). */
export interface TerrainMesh {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  readonly triangles: number;
  /** Bumped whenever the geometry changes. An implementation re-uploads only when this moves. */
  readonly version: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One instanced draw: a single mesh, a single owner colour, N transforms.
 *
 * ADR-0006 requires one draw call per (mesh, owner) — so the batch key is exactly
 * `(mesh, owner, lod)`, and `FrameStats.drawCalls` counts these. The arrays are the caller's
 * scratch and are valid only for the duration of `drawInstances`.
 */
export interface InstanceBatch {
  readonly mesh: string;
  readonly owner: OwnerSlot;
  readonly lod: LodLevel;
  readonly count: number;
  /** count × 3 — scene space (x, elevation, z). See ADR-0004: y is presentation only. */
  readonly xyz: Float32Array;
  /** count — facing, radians. */
  readonly yaw: Float32Array;
  /** count — uniform scale. */
  readonly scale: Float32Array;
  /**
   * count — brightness 0..1. Carries construction progress and damage dimming without a second
   * material, which instancing would otherwise force (ADR-0006's "uniqueness comes from instance
   * attributes, not per-entity materials").
   */
  readonly shade: Float32Array;
}

/**
 * Overlay kinds. These are the elements a player must be able to READ, so ADR-0005 §4 puts them
 * behind the port: every implementation, down to Canvas2D at T0, has to draw all of them.
 */
// Every kind packs scene-space (x, y, z) first — y being elevation, not a sim value (ADR-0004).
// Uniform positioning is what lets a selection ring sit on a mesa instead of on the zero plane.
export type OverlayKind =
  | "selection"    // x, y, z, radius
  | "healthbar"    // x, y, z, fraction, ownerSlot
  | "chevron"      // x, y, z, rank
  | "rally"        // x0, y0, z0, x1, y1, z1
  | "ghost"        // x, y, z, radius, valid(0|1), reach
  | "waypoint";    // x, y, z, kind

export interface OverlayLayer {
  readonly kind: OverlayKind;
  readonly count: number;
  readonly stride: number;
  /** count × stride, packed. Caller-owned scratch; valid for the duration of the call. */
  readonly data: Float32Array;
}

/**
 * The fog of war, as one low-resolution lookup (ADR-0006) rather than per-entity branching.
 * 0 = unexplored, 1 = explored but not visible, 2 = visible. Uploaded per sim tick, not per frame.
 */
export interface FogField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly state: Uint8Array;
  /** Bumped once per tick that changed the field; implementations re-upload only when it moves. */
  readonly version: number;
}

/**
 * The power grid as a band per cell, at fog resolution (ADR-0012 §2).
 *
 * Deliberately the same shape as `FogField`, because it is the same kind of thing: a low-res
 * scalar field over the map, uploaded once per tick that changed it, sampled once by the terrain
 * material. 0 is "no grid reaches here"; 1–4 are the engine's `POWER_TIERS` bands.
 */
export interface PowerField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly state: Uint8Array;
  readonly version: number;
}

/** What the frame actually cost. Asserted by the render-contract tests and the perf gate. */
export interface FrameStats {
  drawCalls: number;
  instances: number;
  triangles: number;
  overlayItems: number;
  /** How many times the terrain geometry was uploaded since the renderer was created. */
  terrainUploads: number;
  /** How many times the fog field was uploaded since the renderer was created. */
  fogUploads: number;
  /** How many times the power field was uploaded. Same version-gated contract as `fogUploads`. */
  powerUploads: number;
  cpuMs: number;
}

/**
 * The drawing surface (ADR-0005).
 *
 * Call order per frame is fixed and asserted by the conformance suite:
 * `beginFrame` → `drawTerrain`? → `drawInstances`* → `drawOverlay`* → `endFrame`.
 */
export interface Renderer {
  /** Human-readable, for the settings panel and the no-WebGL notice. */
  readonly name: string;
  /** Meshes are registered once at boot. Registering mid-frame is a bug, not a feature. */
  registerMeshes(meshes: readonly MeshData[]): void;
  resize(width: number, height: number, dpr: number): void;
  setTier(tier: Tier): void;
  /** Off-frame: uploads only when `fog.version` has moved since the last call. */
  setFog(fog: FogField): void;
  /**
   * Show the power grid, or pass `null` to hide it.
   *
   * Off-frame, version-gated, exactly like `setFog`. It is `null` most of the time: painting power
   * bands over the whole map at all times fights with the fog and the terrain for the same pixels,
   * so this follows upstream and treats the grid as a **placement cue** — visible while a ghost is
   * up, and on a deliberate toggle. Hiding does not discard the texture, so toggling it back on
   * costs nothing.
   */
  setPower(power: PowerField | null): void;
  beginFrame(camera: CameraState): void;
  /** Off-frame upload, on-frame draw: re-uploads only when `terrain.version` has moved. */
  drawTerrain(terrain: TerrainMesh): void;
  drawInstances(batch: InstanceBatch): void;
  drawOverlay(layer: OverlayLayer): void;
  endFrame(): FrameStats;
  /**
   * Block until the frame has actually been drawn. **Measurement only.**
   *
   * WebGL submission is asynchronous: `endFrame` returns as soon as the commands are queued, long
   * before a software rasteriser has shaded a single fragment. Timing around `endFrame` therefore
   * measures how fast we can *describe* a frame, which on the CPU-only target is the cheap half and
   * not the half the budget is about — an early version of the perf gate reported 0.2 ms frames at
   * T0 and would have declared any amount of overdraw free.
   *
   * The game never calls this: a synchronous stall every frame is exactly the thing that turns a
   * pipelined 60 fps into a serialised 30. Only the perf harness does.
   */
  flush?(): void;
  dispose(): void;
}

/** Per-overlay-kind packing width. One table, so producers and consumers cannot disagree. */
export const OVERLAY_STRIDE: Readonly<Record<OverlayKind, number>> = {
  selection: 4,
  healthbar: 5,
  chevron: 4,
  rally: 6,
  ghost: 6,
  waypoint: 4,
};
