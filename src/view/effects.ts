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
import { reducedMotion } from "./motion.js";

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

/**
 * How long a hit mark stays up (P5-T15).
 *
 * Between the two above, because a landed hit is more news than a shot and less than a death: six
 * sim ticks, about eighteen frames at 60 fps. The ceiling is the weapon cycle rather than taste —
 * the fastest cooldown in the roster is 0.85 s, so a mark this long can never still be up when the
 * same weapon fires again, and a player never sees two marks and reads them as two hits.
 */
export const IMPACT_SECONDS = 0.3;

/**
 * Does this hit say anything a plain one does not?
 *
 * **The filter, and the whole reason the impact pool is small.** Every landed hit crosses the
 * bridge — the bridge reports, it does not decide (ADR-0012 §5) — and the *view* decides what is
 * worth drawing. A mark on every hit is not a mark: it would be one more flash per tracer, in a
 * frame that already has tracers, teaching nothing. The three flags are what the engine bothered to
 * say about a hit, so they are what earns one.
 *
 * It also makes the two cues that carry meaning legible by contrast rather than by hue: the plain
 * hit draws nothing at all, so "this one was different" is the loudest thing the frame can say.
 */
export function impactReads(heavy: number, bonus: number, splashRadius: number): boolean {
  return heavy !== 0 || bonus !== 0 || splashRadius > 0;
}

/* -------------------------------------------------------------------------------------------
   Reduced motion (P6-T04, N-05).

   Three clocks leave this pool — a tracer's fade, a death mark's expansion, an impact's swell —
   and they are the whole of the animation in the effect layer. Everything else a cue carries is a
   FACT: where the shot came from, whose it was, that the hit was heavy, how far the splash reached.

   So reduced motion freezes the clocks and keeps the facts. Every effect is still ingested, still
   drawn, still expires on its own schedule; it simply holds one value for its whole life instead of
   sweeping through them. Nothing is deleted, because deleting a tracer would take away the only
   channel that says "you are being shot at from over there" — which is removing information rather
   than motion, and the opposite of what the setting was asked for.

   The frozen values are chosen for legibility in a STILL frame, which is what the player is now
   getting, and each is the value a single frame of the animation would have to be true at.
   ------------------------------------------------------------------------------------------- */

/**
 * A still tracer's fade: full strength for its whole life.
 *
 * The alternative — freezing part-way — would draw every tracer permanently dimmer than the
 * animated one ever starts, which is a legibility loss dressed up as restraint. At 20 Hz a fight is
 * already a stream of appearing and disappearing lines; holding each at full opacity is what stops
 * that reading as a flicker.
 */
export const STILL_TRACER_FADE = 1;

/**
 * A still death mark's progress: a third of the way through.
 *
 * The renderer derives BOTH the ring's size (`0.35 + progress`) and its opacity (`1 - progress`)
 * from this one number, and they pull in opposite directions — early is bright and small, late is
 * large and faint. A third is where their product peaks, so a frozen mark puts the most ink on
 * screen that any single frame of the animation ever does. The size STEP between a unit's mark and
 * a building's is a ratio, so it survives any choice here and stays legible.
 */
export const STILL_BLAST_PROGRESS = 1 / 3;

/**
 * A still impact mark's progress: zero.
 *
 * Its two glyphs swell as they fade (`1 + 0.35·progress` at `1 - progress` opacity), so zero is
 * fully opaque at the base size the glyph vocabulary was drawn for. The splash ring never animated
 * at all — its radius is a measurement (P5-T15) — so freezing at zero also leaves it at exactly
 * that radius, at full strength, which is the one frame of its life that was always true.
 */
export const STILL_IMPACT_PROGRESS = 0;

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

  // --- impacts: a hit that landed and had something to say about itself (P5-T15) ---
  impactCount = 0;
  ix: Float32Array;
  iy: Float32Array;
  iOwner: Uint8Array;
  /** The engine's `attackHit.heavy` — a siege weapon on a structure. */
  iHeavy: Uint8Array;
  /** The engine's `attackHit.bonus` — the counter triangle, landing. */
  iBonus: Uint8Array;
  /** The engine's `attackHit.splashRadius`, world units, 0 for a weapon without one. */
  iSplash: Float32Array;
  iAge: Float32Array;

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

    this.ix = new Float32Array(capacity);
    this.iy = new Float32Array(capacity);
    this.iOwner = new Uint8Array(capacity);
    this.iHeavy = new Uint8Array(capacity);
    this.iBonus = new Uint8Array(capacity);
    this.iSplash = new Float32Array(capacity);
    this.iAge = new Float32Array(capacity);
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

    // Impacts are filtered on the way IN rather than at pack time, so the pool never holds an
    // effect no frame will draw — and the filter runs once per tick instead of once per frame.
    const impacts = snap.impacts;
    this.ensureImpacts(this.impactCount + impacts.count);
    for (let i = 0; i < impacts.count; i++) {
      const heavy = impacts.heavy[i]!;
      const bonus = impacts.bonus[i]!;
      const splash = impacts.splashRadius[i]!;
      if (!impactReads(heavy, bonus, splash)) continue;
      const n = this.impactCount;
      this.ix[n] = impacts.x[i]!;
      this.iy[n] = impacts.y[i]!;
      this.iOwner[n] = impacts.owner[i]!;
      this.iHeavy[n] = heavy;
      this.iBonus[n] = bonus;
      this.iSplash[n] = splash;
      this.iAge[n] = 0;
      this.impactCount = n + 1;
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

    for (let i = 0; i < this.impactCount;) {
      const t = (this.iAge[i]! += seconds);
      if (t < IMPACT_SECONDS) { i++; continue; }
      const last = --this.impactCount;
      this.ix[i] = this.ix[last]!;
      this.iy[i] = this.iy[last]!;
      this.iOwner[i] = this.iOwner[last]!;
      this.iHeavy[i] = this.iHeavy[last]!;
      this.iBonus[i] = this.iBonus[last]!;
      this.iSplash[i] = this.iSplash[last]!;
      this.iAge[i] = this.iAge[last]!;
    }
  }

  /** 1 when just fired, 0 at expiry. What the view fades on — unless motion is reduced. */
  tracerFade(i: number): number {
    if (reducedMotion()) return STILL_TRACER_FADE;
    return 1 - this.tAge[i]! / TRACER_SECONDS;
  }

  /** 0 at the moment of death, 1 at expiry — a blast EXPANDS as it fades. */
  blastProgress(i: number): number {
    if (reducedMotion()) return STILL_BLAST_PROGRESS;
    return this.bAge[i]! / BLAST_SECONDS;
  }

  /**
   * 0 at the moment of the hit, 1 at expiry. The mark's glyphs swell and fade on it.
   *
   * The SPLASH ring does not: it is drawn at the weapon's own radius for the whole of its life, so
   * any single frame of it is the true reach. A ring that grew into its radius would be honest only
   * on its last frame, which is the one nobody is looking at.
   */
  impactProgress(i: number): number {
    if (reducedMotion()) return STILL_IMPACT_PROGRESS;
    return this.iAge[i]! / IMPACT_SECONDS;
  }

  /** Drop everything. For a scene change, not for a frame. */
  clear(): void {
    this.tracerCount = 0;
    this.blastCount = 0;
    this.impactCount = 0;
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

  private ensureImpacts(needed: number): void {
    if (needed <= this.ix.length) return;
    let next = this.ix.length || 64;
    while (next < needed) next *= 2;
    this.ix = grow(this.ix, next);
    this.iy = grow(this.iy, next);
    this.iOwner = growU8(this.iOwner, next);
    this.iHeavy = growU8(this.iHeavy, next);
    this.iBonus = growU8(this.iBonus, next);
    this.iSplash = grow(this.iSplash, next);
    this.iAge = grow(this.iAge, next);
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
