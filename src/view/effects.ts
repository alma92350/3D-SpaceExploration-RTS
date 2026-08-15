// Combat feedback's memory (P3-T06, ADR-0017).
//
// The sim ticks at 20 Hz and the display runs at 60+, so a shot the bridge reports once has to stay
// on screen for several frames or it is a one-frame flicker nobody sees. That means the view needs
// **state the snapshot does not have**: a set of live effects, each with its own clock.
//
// PRD §5 makes that hard on purpose — "no combat feedback allocates per frame". So this is a pool,
// not a list of objects:
//
//   • `ingestTick` runs on a simulation tick and is the ONLY method allowed to grow a buffer. It is
//     named for the `ensure*` convention the allocation scan enforces (layering.test.ts).
//   • `age` runs every frame and retires expired effects by swapping the last entry down over the
//     dead one. O(n), no allocation, no ordering guarantee — and none is needed, because a tracer
//     is a tracer.
//
// Nothing here is an object per shot at any layer: the bridge hands over parallel typed arrays and
// so does this.

import { type Snapshot } from "../bridge/snapshot.js";

/**
 * How long a tracer stays up, in seconds.
 *
 * Three sim ticks. Long enough to survive the 50 ms gap between ticks with margin — at 60 fps that
 * is nine frames — and short enough that a firefight reads as a firefight rather than as a cage of
 * permanent lines. Below one tick's worth (0.05) a tracer could vanish before it was ever drawn.
 */
export const TRACER_SECONDS = 0.15;

/** How long a death mark stays up. Longer than a tracer: a kill is worth looking back at. */
export const BLAST_SECONDS = 0.5;

export class CombatEffects {
  // --- tracers: a line from shooter to target, fading out ---
  tracerCount = 0;
  tx0: Float32Array;
  ty0: Float32Array;
  tx1: Float32Array;
  ty1: Float32Array;
  tOwner: Uint8Array;
  tAge: Float32Array;

  // --- blasts: a mark where something died, expanding and fading ---
  blastCount = 0;
  bx: Float32Array;
  by: Float32Array;
  bOwner: Uint8Array;
  /** 1 for a building. A base going down is worth a bigger mark than a skirmisher. */
  bBig: Uint8Array;
  bAge: Float32Array;

  constructor(capacity = 128) {
    this.tx0 = new Float32Array(capacity);
    this.ty0 = new Float32Array(capacity);
    this.tx1 = new Float32Array(capacity);
    this.ty1 = new Float32Array(capacity);
    this.tOwner = new Uint8Array(capacity);
    this.tAge = new Float32Array(capacity);

    this.bx = new Float32Array(capacity);
    this.by = new Float32Array(capacity);
    this.bOwner = new Uint8Array(capacity);
    this.bBig = new Uint8Array(capacity);
    this.bAge = new Float32Array(capacity);
  }

  /**
   * Take this tick's shots and deaths. **Call once per simulation step, never per frame** — calling
   * it twice for one tick draws every tracer twice and doubles the apparent rate of fire.
   */
  ingestTick(snap: Snapshot): void {
    const shots = snap.shots;
    this.ensureTracers(this.tracerCount + shots.count);
    for (let i = 0; i < shots.count; i++) {
      const n = this.tracerCount;
      this.tx0[n] = shots.fromX[i]!;
      this.ty0[n] = shots.fromY[i]!;
      this.tx1[n] = shots.toX[i]!;
      this.ty1[n] = shots.toY[i]!;
      this.tOwner[n] = shots.owner[i]!;
      this.tAge[n] = 0;
      this.tracerCount = n + 1;
    }

    const deaths = snap.deaths;
    this.ensureBlasts(this.blastCount + deaths.count);
    for (let i = 0; i < deaths.count; i++) {
      const n = this.blastCount;
      this.bx[n] = deaths.x[i]!;
      this.by[n] = deaths.y[i]!;
      this.bOwner[n] = deaths.owner[i]!;
      this.bBig[n] = deaths.isBuilding[i]!;
      this.bAge[n] = 0;
      this.blastCount = n + 1;
    }
  }

  /**
   * Advance every live effect and retire the expired ones. Runs per frame and allocates nothing.
   *
   * Swap-remove rather than splice: the last live entry is copied over the dead one and the count
   * drops. It reorders the pool, which is fine — nothing here is drawn in a meaningful order — and
   * it is the only way to compact a parallel-array pool without a second buffer.
   */
  age(seconds: number): void {
    for (let i = 0; i < this.tracerCount;) {
      const t = (this.tAge[i]! += seconds);
      if (t < TRACER_SECONDS) { i++; continue; }
      const last = --this.tracerCount;
      this.tx0[i] = this.tx0[last]!;
      this.ty0[i] = this.ty0[last]!;
      this.tx1[i] = this.tx1[last]!;
      this.ty1[i] = this.ty1[last]!;
      this.tOwner[i] = this.tOwner[last]!;
      this.tAge[i] = this.tAge[last]!;
    }

    for (let i = 0; i < this.blastCount;) {
      const t = (this.bAge[i]! += seconds);
      if (t < BLAST_SECONDS) { i++; continue; }
      const last = --this.blastCount;
      this.bx[i] = this.bx[last]!;
      this.by[i] = this.by[last]!;
      this.bOwner[i] = this.bOwner[last]!;
      this.bBig[i] = this.bBig[last]!;
      this.bAge[i] = this.bAge[last]!;
    }
  }

  /** 1 when just fired, 0 at expiry. What the view fades on. */
  tracerFade(i: number): number {
    return 1 - this.tAge[i]! / TRACER_SECONDS;
  }

  /** 0 at the moment of death, 1 at expiry — a blast EXPANDS as it fades. */
  blastProgress(i: number): number {
    return this.bAge[i]! / BLAST_SECONDS;
  }

  /** Drop everything. For a scene change, not for a frame. */
  clear(): void {
    this.tracerCount = 0;
    this.blastCount = 0;
  }

  private ensureTracers(needed: number): void {
    if (needed <= this.tx0.length) return;
    let next = this.tx0.length || 64;
    while (next < needed) next *= 2;
    this.tx0 = grow(this.tx0, next);
    this.ty0 = grow(this.ty0, next);
    this.tx1 = grow(this.tx1, next);
    this.ty1 = grow(this.ty1, next);
    this.tOwner = growU8(this.tOwner, next);
    this.tAge = grow(this.tAge, next);
  }

  private ensureBlasts(needed: number): void {
    if (needed <= this.bx.length) return;
    let next = this.bx.length || 64;
    while (next < needed) next *= 2;
    this.bx = grow(this.bx, next);
    this.by = grow(this.by, next);
    this.bOwner = growU8(this.bOwner, next);
    this.bBig = growU8(this.bBig, next);
    this.bAge = grow(this.bAge, next);
  }
}

/**
 * Grow preserving contents — unlike the snapshot's tables, which are refilled from scratch each
 * tick and so may discard. A pool holds effects mid-flight; dropping them on a resize would make
 * tracers vanish exactly when a fight got big enough to need them.
 */
function grow(src: Float32Array, size: number): Float32Array {
  const next = new Float32Array(size);
  next.set(src);
  return next;
}

function growU8(src: Uint8Array, size: number): Uint8Array {
  const next = new Uint8Array(size);
  next.set(src);
  return next;
}
