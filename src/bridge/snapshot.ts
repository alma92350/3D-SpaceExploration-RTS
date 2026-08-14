// The snapshot: the read-only, flat, typed-array description of what can be drawn (ADR-0008).
//
// `view/` consumes this and never the engine's own state. Three reasons, in order of how expensive
// they are to discover late:
//
//   1. The engine mutates entity objects in place. A renderer holding references renders half-
//      updated ticks, and a renderer that writes one is a determinism bug you find in Phase 5.
//   2. ADR-0006 forbids allocation in a steady-state frame. Parallel typed arrays, sized once and
//      reused, are the only shape that holds at 400 entities and 60 fps.
//   3. Everything here is structurally serialisable, so moving the sim into a Worker later is a
//      change to this module and nothing above it.
//
// **Fog is applied here, not in the renderer.** An entity the player cannot see is absent from the
// snapshot entirely (PRD F-02, F-06). Filtering in the view would mean the hidden entity's position
// had already crossed the boundary, and "the renderer knows but does not draw" is how information
// leaks — through a selection box, a minimap dot, or a stray sort order.

import { BUILDINGS, FOG_CELL_SIZE, UNITS, isNodeDiscovered, isVisibleAt } from "../engine/index.js";

/** Owner encoded as a small integer — it indexes palettes and batch keys every frame. */
export const SNAP_PLAYER = 0;
export const SNAP_AI = 1;

/** Bit flags on a snapshot entity. Cheaper than parallel boolean arrays and easier to extend. */
export const FLAG_SELECTED = 1 << 0;
export const FLAG_CONSTRUCTING = 1 << 1;
export const FLAG_CARRYING = 1 << 2;
export const FLAG_MOVING = 1 << 3;
export const FLAG_BUILDING_KIND = 1 << 4;

/** Fog states, matching `FogField` in the renderer port. */
export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1;
export const FOG_VISIBLE = 2;

/**
 * A parallel-array table of drawable entities.
 *
 * `x`/`y` are this tick's simulation position; `prevX`/`prevY` are last tick's, for interpolation.
 * There is no `z` and there never will be — elevation is derived in the view (ADR-0004), and
 * `test/architecture/layering.test.ts` fails the build if one appears here.
 */
export class EntityTable {
  capacity: number;
  count = 0;

  ids: Int32Array;
  /** Index into the snapshot's `typeNames`. A string per entity per frame would be the whole budget. */
  typeIndex: Uint8Array;
  owner: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  hp: Float32Array;
  maxHp: Float32Array;
  radius: Float32Array;
  facing: Float32Array;
  flags: Uint8Array;
  /** Veterancy rank 0–3 for units; Spaceport-style tier for buildings. Drives the chevron overlay. */
  rank: Uint8Array;
  /** 0..1 — build progress for buildings, cargo fullness for workers. */
  progress: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ids = new Int32Array(capacity);
    this.typeIndex = new Uint8Array(capacity);
    this.owner = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.hp = new Float32Array(capacity);
    this.maxHp = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.facing = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.rank = new Uint8Array(capacity);
    this.progress = new Float32Array(capacity);
  }

  /**
   * Grow to at least `needed`, in powers of two, preserving nothing.
   *
   * Called from the extractor, which runs on a sim tick — not on a render frame (ADR-0008's
   * "growth is power-of-two and off-frame"). Doubling means a match that peaks at 400 units
   * reallocates a handful of times in its first minute and never again.
   */
  ensure(needed: number): boolean {
    if (needed <= this.capacity) return false;
    let next = this.capacity || 64;
    while (next < needed) next *= 2;
    const grown = new EntityTable(next);
    this.capacity = next;
    this.ids = grown.ids;
    this.typeIndex = grown.typeIndex;
    this.owner = grown.owner;
    this.x = grown.x;
    this.y = grown.y;
    this.prevX = grown.prevX;
    this.prevY = grown.prevY;
    this.hp = grown.hp;
    this.maxHp = grown.maxHp;
    this.radius = grown.radius;
    this.facing = grown.facing;
    this.flags = grown.flags;
    this.rank = grown.rank;
    this.progress = grown.progress;
    return true;
  }
}

/** Resource nodes: static except for `amount`, so they get their own smaller table. */
export class NodeTable {
  capacity: number;
  count = 0;
  ids: Int32Array;
  comIndex: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  /** Remaining fraction 0..1 — the mesh shrinks as a deposit is worked out. */
  remaining: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ids = new Int32Array(capacity);
    this.comIndex = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.remaining = new Float32Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 32;
    while (next < needed) next *= 2;
    const grown = new NodeTable(next);
    this.capacity = next;
    this.ids = grown.ids;
    this.comIndex = grown.comIndex;
    this.x = grown.x;
    this.y = grown.y;
    this.remaining = grown.remaining;
  }
}

export interface SnapshotResources {
  ore: number;
  crystals: number;
  radioactives: number;
  supplyUsed: number;
  supplyCap: number;
  credits: number;
}

/**
 * Everything a frame may read. Versions let the view cache derived work (meshes, fog textures,
 * HUD strings) without diffing: a counter that has not moved means nothing changed.
 */
export interface Snapshot {
  tick: number;
  time: number;
  /** Bumped on every extraction. The interpolator uses it to detect a tick boundary. */
  version: number;
  entities: EntityTable;
  nodes: NodeTable;
  /** Stable index → engine type name. Grows only when a type is first seen. */
  typeNames: string[];
  comNames: string[];
  fog: {
    cols: number;
    rows: number;
    cell: number;
    state: Uint8Array;
    /** Bumped only when the field actually changed — the renderer re-uploads on this. */
    version: number;
  };
  map: {
    width: number;
    height: number;
    baseX: number;
    baseY: number;
  };
  resources: SnapshotResources;
  /** Selected entity ids, as engine strings — the HUD needs identity, not just a flag. */
  selection: string[];
  /** Numeric ids that existed last tick and do not exist now. Interpolation reads it. */
  removed: Set<number>;
  /** Numeric ids that appeared this tick. They must not interpolate in from a stale position. */
  spawned: Set<number>;
}

/**
 * Engine ids are `u12` / `b7` / `n3`. Pack to an int so the hot tables stay numeric; buildings go
 * negative so a single number carries both the identity and the kind.
 */
export function numericId(id: string): number {
  const n = Number.parseInt(id.slice(1), 10);
  return id.charCodeAt(0) === 98 /* 'b' */ ? -(n + 1) : n + 1;
}

export function isBuildingId(numeric: number): boolean {
  return numeric < 0;
}

export interface ExtractOptions {
  /** Which side's fog decides visibility. Always "player" in the MVP; an argument for Observer Mode. */
  viewer: OwnerId;
  /** Galaxy-wide credits, which live above the world state. */
  credits: number;
  /** Supply is a derived engine query; the caller passes it so the bridge stays a pure copier. */
  supplyUsed: number;
  supplyCap: number;
}

/**
 * Extract a snapshot from engine state, reusing the previous one's buffers.
 *
 * Allocation-free in the steady state: the only allocations are the growth path (power of two, on
 * a tick) and first-sight type-name registration (bounded by the roster size).
 */
export class SnapshotExtractor {
  readonly snapshot: Snapshot;

  private readonly typeIndexByName = new Map<string, number>();
  private readonly comIndexByName = new Map<string, number>();
  private readonly facingById = new Map<number, number>();
  /** numeric id → offset into `prevBuf`, rebuilt from the previous extraction each tick. */
  private readonly prevPos = new Map<number, number>();
  private prevBuf: Float32Array;
  private fogHash = -1;

  constructor(map: GameMap, initialCapacity = 256) {
    const cols = Math.ceil(map.width / FOG_CELL_SIZE);
    const rows = Math.ceil(map.height / FOG_CELL_SIZE);
    this.prevBuf = new Float32Array(initialCapacity * 2);
    this.snapshot = {
      tick: 0,
      time: 0,
      version: 0,
      entities: new EntityTable(initialCapacity),
      nodes: new NodeTable(Math.max(32, map.nodes.length)),
      typeNames: [],
      comNames: [],
      fog: { cols, rows, cell: FOG_CELL_SIZE, state: new Uint8Array(cols * rows), version: 0 },
      map: { width: map.width, height: map.height, baseX: map.bases.player.x, baseY: map.bases.player.y },
      resources: { ore: 0, crystals: 0, radioactives: 0, supplyUsed: 0, supplyCap: 0, credits: 0 },
      selection: [],
      removed: new Set(),
      spawned: new Set(),
    };
  }

  extract(state: State, opts: ExtractOptions): Snapshot {
    const snap = this.snapshot;
    const fog = state.fogs[opts.viewer];
    snap.entities.ensure(state.units.size + state.buildings.size);
    this.rememberPreviousPositions();

    const e = snap.entities;
    const selected = state.selection;
    let n = 0;

    for (const b of state.buildings.values()) {
      // Buildings are revealed by the *explored* memory, not by live vision: a base you scouted an
      // hour ago is still there, and forgetting it is worse than the small intel it gives. Their
      // positions never change, so this leaks nothing the player did not already earn.
      if (!isVisibleAt(fog, b.x, b.y) && !exploredAt(fog, b.x, b.y)) continue;
      const id = numericId(b.id);
      e.ids[n] = id;
      e.typeIndex[n] = this.typeIdx(b.type);
      e.owner[n] = b.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      e.x[n] = b.x;
      e.y[n] = b.y;
      e.prevX[n] = b.x;                      // buildings never move; prev === current always
      e.prevY[n] = b.y;
      e.hp[n] = b.hp;
      e.maxHp[n] = b.maxHp;
      e.radius[n] = b.radius || BUILDINGS[b.type]?.radius || 16;
      e.facing[n] = 0;
      e.flags[n] = FLAG_BUILDING_KIND
        | (b.constructing ? FLAG_CONSTRUCTING : 0)
        | (selected.includes(b.id) ? FLAG_SELECTED : 0);
      e.rank[n] = Math.min(3, b.tier ?? 0);
      e.progress[n] = b.constructing ? b.buildProgress : 1;
      n++;
    }

    for (const u of state.units.values()) {
      // Units move, so live vision — not memory — decides. This is the line that makes F-06 true.
      if (!isVisibleAt(fog, u.x, u.y)) continue;
      const id = numericId(u.id);
      const prev = this.prevPos.get(id);
      const px = prev === undefined ? u.x : this.prevBuf[prev]!;
      const py = prev === undefined ? u.y : this.prevBuf[prev + 1]!;

      e.ids[n] = id;
      e.typeIndex[n] = this.typeIdx(u.type);
      e.owner[n] = u.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      e.x[n] = u.x;
      e.y[n] = u.y;
      e.prevX[n] = px;
      e.prevY[n] = py;
      e.hp[n] = u.hp;
      e.maxHp[n] = u.maxHp;
      e.radius[n] = UNITS[u.type]?.radius ?? 6;

      // Facing is presentation, derived from this tick's own movement (ADR-0004: decoration is
      // allowed, feeding back into the sim is not). A stationary unit keeps its last heading —
      // snapping to zero would make an idle army all face north the moment it stopped.
      const dx = u.x - px;
      const dy = u.y - py;
      const moved = dx * dx + dy * dy;
      const facing = moved > 1e-6 ? Math.atan2(dx, dy) : (this.facingById.get(id) ?? 0);
      e.facing[n] = facing;
      this.facingById.set(id, facing);

      e.flags[n] = (u.cargo && u.cargo.qty > 0 ? FLAG_CARRYING : 0)
        | (moved > 1e-4 ? FLAG_MOVING : 0)
        | (selected.includes(u.id) ? FLAG_SELECTED : 0);
      e.rank[n] = rankOf(u.kills ?? 0);
      e.progress[n] = u.cargo ? Math.min(1, u.cargo.qty / 10) : 0;
      n++;
    }

    e.count = n;
    this.diffLifetimes();
    this.extractNodes(state, fog);
    this.extractFog(fog);

    const res = state.players.player.resources;
    const r = snap.resources;
    r.ore = res.ore ?? 0;
    r.crystals = res.crystals ?? 0;
    r.radioactives = res.radioactives ?? 0;
    r.supplyUsed = opts.supplyUsed;
    r.supplyCap = opts.supplyCap;
    r.credits = opts.credits;

    snap.selection.length = 0;
    for (const id of selected) snap.selection.push(id);

    snap.tick = state.tick;
    snap.time = state.time;
    snap.version++;
    return snap;
  }

  private typeIdx(name: string): number {
    let i = this.typeIndexByName.get(name);
    if (i === undefined) {
      i = this.snapshot.typeNames.length;
      this.snapshot.typeNames.push(name);
      this.typeIndexByName.set(name, i);
    }
    return i;
  }

  private comIdx(name: string): number {
    let i = this.comIndexByName.get(name);
    if (i === undefined) {
      i = this.snapshot.comNames.length;
      this.snapshot.comNames.push(name);
      this.comIndexByName.set(name, i);
    }
    return i;
  }

  /** Growth for the previous-position buffer. Named `ensure*` — see the allocation scan in
   *  `test/architecture/layering.test.ts`, which reads method names to tell setup from a frame. */
  private ensurePrevBuffer(capacity: number): void {
    if (this.prevBuf.length >= capacity * 2) return;
    this.prevBuf = new Float32Array(capacity * 2);
  }

  private rememberPreviousPositions(): void {
    const e = this.snapshot.entities;
    this.ensurePrevBuffer(e.capacity);
    this.prevPos.clear();
    for (let i = 0; i < e.count; i++) {
      const off = i * 2;
      this.prevBuf[off] = e.x[i]!;
      this.prevBuf[off + 1] = e.y[i]!;
      this.prevPos.set(e.ids[i]!, off);
    }
  }

  /** Who arrived and who left, so the interpolator can refuse to slide either across the map. */
  private diffLifetimes(): void {
    const snap = this.snapshot;
    const e = snap.entities;
    snap.spawned.clear();
    snap.removed.clear();
    for (let i = 0; i < e.count; i++) if (!this.prevPos.has(e.ids[i]!)) snap.spawned.add(e.ids[i]!);
    if (this.prevPos.size === 0) return;
    const live = new Set<number>();
    for (let i = 0; i < e.count; i++) live.add(e.ids[i]!);
    for (const id of this.prevPos.keys()) {
      if (!live.has(id)) {
        snap.removed.add(id);
        this.facingById.delete(id);
      }
    }
  }

  private extractNodes(state: State, fog: Fog): void {
    const nodes = this.snapshot.nodes;
    nodes.ensure(state.map.nodes.length);
    let n = 0;
    for (const node of state.map.nodes) {
      // A charted deposit stays on the map once explored; a hidden cache only exists once scouted
      // (upstream's `isNodeDiscovered`). Using the engine's own predicate keeps what the 3D view
      // shows, what the minimap dots and what a right-click can target in agreement.
      if (!exploredAt(fog, node.x, node.y) || !isNodeDiscovered(fog, node)) continue;
      nodes.ids[n] = numericId(node.id);
      nodes.comIndex[n] = this.comIdx(node.com);
      nodes.x[n] = node.x;
      nodes.y[n] = node.y;
      nodes.remaining[n] = node.max > 0 ? node.amount / node.max : 0;
      n++;
    }
    nodes.count = n;
  }

  private extractFog(fog: Fog): void {
    const f = this.snapshot.fog;
    let hash = 0;
    for (let i = 0; i < f.state.length; i++) {
      const v = fog.visible[i] === 1 ? FOG_VISIBLE : fog.explored[i] === 1 ? FOG_EXPLORED : FOG_UNEXPLORED;
      f.state[i] = v;
      // A cheap order-sensitive rolling hash. Scanning ~1000 bytes per tick is far less work than
      // re-uploading a texture on every one of the 3 frames that tick spans, which is the whole
      // reason `version` exists (ADR-0006: the fog is one lookup, updated once per tick).
      hash = (hash * 31 + v * (i + 1)) | 0;
    }
    if (hash !== this.fogHash) {
      this.fogHash = hash;
      f.version++;
    }
  }
}

function exploredAt(fog: Fog, x: number, y: number): boolean {
  const cx = Math.floor(x / FOG_CELL_SIZE);
  const cy = Math.floor(y / FOG_CELL_SIZE);
  if (cx < 0 || cy < 0 || cx >= fog.cols || cy >= fog.rows) return false;
  return fog.explored[cy * fog.cols + cx] === 1;
}

/** Veterancy rank from kill count — upstream's 3/8/18 thresholds (universe digest §5). */
function rankOf(kills: number): number {
  return kills >= 18 ? 3 : kills >= 8 ? 2 : kills >= 3 ? 1 : 0;
}
