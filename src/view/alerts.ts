// The alert system (P3-T14).
//
// The engine emits *facts*; a player needs *claims on their attention*, and the two are not the
// same thing. `entityKilled` fires once per casualty — `detonateBomb` pushes one for every entity
// it caught — so a Helium Bomb going off in a crowd puts eleven of them on a single tick, at eleven
// different positions, for one thing that happened. Eleven rows in a HUD is not eleven times the
// information: it is a wall that buries whatever happens next underneath it, which is the exact
// failure an alert exists to prevent. **Coalescing is not a polish pass on this module; it is the
// module**, and everything below is arranged around it.
//
// Two precedents meet here and both are load-bearing:
//
//   • Like `input/control-groups.ts`, this is client state that must never become simulation
//     state. Nothing in the engine knows it exists. An alert is one player's attention, not a fact
//     about the world, and a dismissal that reached `hashState` would desync a replay against a
//     player who happened to click a different thing.
//   • Like `view/effects.ts`, it holds what the snapshot cannot: **memory**. A snapshot describes
//     one tick. An alert outlives the tick that raised it, carries a clock, absorbs later events,
//     and can be dismissed — four things the bridge deliberately does not carry, because they are
//     per-viewer and per-session.
//
// **The snapshot is the only input, and that is the whole of the fog story.** `view/` may not
// import the engine (ADR-0008), so this module physically cannot ask the simulation who died; it
// can only read what the bridge already decided the player is entitled to. `extractDeaths` gates
// on *explored* ground and `extractBombs` gates an enemy device on a lit fuse in live vision, so an
// alert built on those tables inherits both gates by construction rather than by discipline. The
// constraint IS the task: there is no code path here that could leak, because there is no code path
// here that can see anything to leak. That argument is worth exactly as much as the gate it leans
// on, which is why `test/view/alerts.test.ts` asserts it end to end — and why the assertion was
// checked by breaking the bridge's gate and watching the test go red, rather than by re-reading
// this comment.

import { FUSE_UNLIT, SNAP_PLAYER, type Snapshot } from "../bridge/snapshot.js";

/**
 * Something of the **player's own** was destroyed. From `snap.deaths`.
 *
 * Owner-filtered, and that filter does more than tidy the list. `entityKilled` fires for the AI's
 * losses too, and the bridge lets an AI death cross whenever the ground has *ever* been explored —
 * deliberately, so the death flash still plays on a wreck the player walks up to later (P3-T07). A
 * flash on remembered ground is a small cue in the world; a HUD row reading "combat here" is a
 * live report from territory the player scouted once an hour ago and cannot currently see. The
 * first is decoration, the second is intel, and only one of them was earned.
 */
export const ALERT_ATTACK = 0;

/**
 * An enemy Helium Bomb is counting down where the player can see it. From `snap.bombs`.
 *
 * Sourced from the table rather than from the `bombFused` event for the reason P3-T10 settled at
 * length: the event fires on one tick in eighty, and a player looking elsewhere on that tick would
 * be told nothing at all, while `fuseUntil` persists for the whole four seconds. Reading the same
 * table the warning ring reads also means the alert and the ring can never disagree about whether a
 * device is a threat. The player's own armed bomb is excluded — they armed it, and an alert about
 * one's own deliberate act is noise.
 */
export const ALERT_BOMB = 1;

/**
 * How long one alert owns its patch of ground, in **sim** seconds.
 *
 * This single number is both the coalescing window and the on-screen lifetime, because they are the
 * same thing: an alert *is* "one attack, at one place, over one window", and it stops being useful
 * at exactly the moment it stops absorbing. Ten seconds — 200 ticks — is long enough that a
 * skirmish reads as one event rather than as a drum roll, and short enough that a base attacked
 * again a minute later gets told about it.
 *
 * Measured from the alert's FIRST event, never sliding forward on each new one. A sliding window
 * would give a twenty-minute siege exactly one alert, raised at the start and never repeated — so a
 * player who dismissed it would never hear about that base again while it was being taken apart.
 */
export const ALERT_WINDOW_SECONDS = 10;

/**
 * How far apart two events can be and still be the same alert, in world units.
 *
 * 190 is not a taste call: it is `BOMB_BLAST_RADIUS` (`POWER_TIERS[0].max`), the widest circle in
 * which the engine can kill an arbitrary number of things in a single tick. Anything smaller and
 * one detonation splits into several alerts at the rim — the precise failure the board row names.
 * The number is duplicated rather than imported because `view/` may not import the engine and the
 * bombs table carries its radii per row (so an out-of-vision blast would carry none); the test pins
 * it against the engine's own constant, which is the only place that can.
 *
 * Over-merging is the safe direction. Two skirmishes 150 units apart become one alert, and the
 * camera jump lands somewhere both are on screen; under-merging buries the next attack.
 */
export const ALERT_MERGE_RADIUS = 190;

/**
 * Live alerts, coalesced, positioned and dismissible.
 *
 * Parallel arrays rather than an object per alert, following `effects.ts`: alerts are far lower
 * volume than tracers and an object each would be affordable, but a pool that is uniform with the
 * rest of the view layer is one fewer shape for the next reader to hold. `ensureSlots` is the ONLY
 * method that allocates; it runs from `ingestTick`, which by contract runs on a simulation tick and
 * never on a frame.
 *
 * There is no per-frame `age()` here, and the difference from `effects.ts` is deliberate. A tracer
 * lives 0.15 s — three ticks — so its clock has to run at frame rate or it visibly stutters. An
 * alert lives ten seconds, so one tick is half a percent of its life, and a second clock above the
 * bridge would be a second answer to "is this still up" with no gain at all.
 */
export class AlertFeed {
  /**
   * Slots in use, **dismissed ones included**. A reader draws the entries where `dismissed[i]` is
   * 0; `liveCount()` is the same loop if only the number is wanted. Dismissed alerts stay in the
   * pool on purpose — see `dismiss`.
   */
  count = 0;

  /** Stable handle for `dismiss`. Never an index: slots are compacted by swap-remove. */
  id: Int32Array;
  /** `ALERT_ATTACK` or `ALERT_BOMB`. Two alerts of different kinds never merge. */
  kind: Uint8Array;
  /** The **event's** own world position, so "focus last alert" lands on the fight, not on a base. */
  x: Float32Array;
  y: Float32Array;
  /** Sim seconds of the event that opened this alert. The window is measured from here. */
  firstAt: Float32Array;
  /** Sim seconds of the most recent event folded in — "still happening", for a pulse or a sort. */
  lastAt: Float32Array;
  /** How many engine events this one alert stands for. The "×11" on a badge — see `raise`. */
  events: Uint16Array;
  /** 1 once the player has seen it. Kept, not deleted — see `dismiss`. */
  dismissed: Uint8Array;

  private nextId = 1;

  constructor(capacity = 16) {
    this.id = new Int32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.firstAt = new Float32Array(capacity);
    this.lastAt = new Float32Array(capacity);
    this.events = new Uint16Array(capacity);
    this.dismissed = new Uint8Array(capacity);
  }

  /**
   * Fold one tick's events into the feed. **Call once per simulation step, never per frame.**
   *
   * Both sources are already whatever the bridge decided the player may know; nothing here re-asks
   * a fog question, because nothing here can. What it does decide is *actionability*: a loss is the
   * player's to act on and an enemy's is not, and an enemy device counting down is, while the
   * player's own armed one is not.
   *
   * Calling it twice for one tick inflates `events[i]` but cannot produce a duplicate alert — the
   * coalescing rule catches the repeat the same way it catches a second casualty. That is a
   * consequence of the rule rather than a guarantee being offered; the contract is still once.
   */
  ingestTick(snap: Snapshot): void {
    this.retire(snap.time);

    // `snap.deaths` is an EVENT STREAM: one row is one `entityKilled`, the table is rebuilt every
    // tick, and a casualty appears in exactly one of them. So every row is news, and the tally is a
    // body count.
    const deaths = snap.deaths;
    for (let i = 0; i < deaths.count; i++) {
      if (deaths.owner[i] !== SNAP_PLAYER) continue;
      this.raise(ALERT_ATTACK, deaths.x[i]!, deaths.y[i]!, snap.time, true);
    }

    // `snap.bombs` is STATE: the same device is in the table on every one of the eighty ticks its
    // fuse burns, because P3-T10 chose `fuseUntil` over the `bombFused` event precisely so the
    // warning would survive the tick the event fired on. That makes the loop below a repeat, not
    // news — hence `tally: false`.
    const bombs = snap.bombs;
    for (let i = 0; i < bombs.count; i++) {
      // Two conditions, and only the first is doing work today: the bridge already refuses to put
      // an unlit enemy bomb in the table at all. The fuse check states what the alert *means*
      // rather than what the bridge currently happens to hand over — an armed enemy device the
      // player learned about some other way is a ring, not a countdown.
      if (bombs.owner[i] === SNAP_PLAYER || bombs.fuse[i] === FUSE_UNLIT) continue;
      this.raise(ALERT_BOMB, bombs.x[i]!, bombs.y[i]!, snap.time, false);
    }
  }

  /**
   * Put an alert away. Idempotent: returns whether an alert with this id is now dismissed, so
   * calling it twice is true twice and calling it on a stranger is false.
   *
   * **The slot is not freed, and that is the point.** A dismissed alert stays in the pool as a
   * tombstone until its window runs out, still absorbing events at its position. Free it instead,
   * and the next casualty of the same fight — a tick later, at the same spot — finds no slot to
   * fold into and opens a fresh alert, so a dismissal during a battle would last exactly 50 ms.
   * That is the "must not resurrect on the next tick from the same event" half of the board row,
   * and a pool that compacts eagerly fails it without ever looking wrong.
   */
  dismiss(id: number): boolean {
    for (let i = 0; i < this.count; i++) {
      if (this.id[i] !== id) continue;
      this.dismissed[i] = 1;
      return true;
    }
    return false;
  }

  /** Clear the board — the "dismiss all" key. Same tombstone rule, applied to everything. */
  dismissAll(): void {
    for (let i = 0; i < this.count; i++) this.dismissed[i] = 1;
  }

  /** How many alerts are actually asking for attention. Tombstones do not count. */
  liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.dismissed[i] === 0) n++;
    return n;
  }

  /**
   * The newest undismissed alert's index, or -1. What "focus last alert" (PRD §4) jumps to.
   *
   * Newest by `id`, not by `firstAt`. Two attacks on one tick share `firstAt` to the last bit, so a
   * timestamp comparison has no answer for them and silently falls back to whichever slot the loop
   * reached first — and `retire`'s swap-remove reorders slots. "Focus last alert" would then jump
   * to a *different* fight the moment some unrelated alert elsewhere expired. Ids are minted in
   * order and are the only thing in this class that means "later".
   */
  latest(): number {
    let best = -1;
    for (let i = 0; i < this.count; i++) {
      if (this.dismissed[i] !== 0) continue;
      if (best < 0 || this.id[i]! > this.id[best]!) best = i;
    }
    return best;
  }

  /** Index of the slot holding `id`, or -1. For a HUD that stored a handle across a tick. */
  indexOf(id: number): number {
    for (let i = 0; i < this.count; i++) if (this.id[i] === id) return i;
    return -1;
  }

  /**
   * Drop everything, tombstones included. For a scene change or a load, not for a frame.
   *
   * The id counter deliberately does NOT reset: a HUD holding a handle across the load would
   * otherwise dismiss whatever alert happened to be minted into that number next.
   */
  clear(): void {
    this.count = 0;
  }

  /**
   * Fold one event into an existing alert, or open a new one.
   *
   * The coalescing rule, in full: **same kind, within `ALERT_MERGE_RADIUS` of the alert's anchor,
   * within `ALERT_WINDOW_SECONDS` of its first event.** All three, or it is a separate alert.
   *
   * Kind is part of the key because "your units are dying here" and "a bomb goes off here in four
   * seconds" call for opposite actions, and merging them would produce one row that recommends
   * neither.
   *
   * **The anchor never moves.** A running centroid of a battle is a defensible camera target and
   * was the first draft, but an alert is a bookmark the player reads now and acts on a second
   * later: if the position drifts between those two moments, the camera lands somewhere other than
   * the marker that prompted the click. The merge radius bounds how far off the anchor can be, so
   * the fight is on screen either way, and a fixed anchor costs two fields fewer.
   *
   * `tally` says whether a folded row is a **new event or the same one seen again**, which is the
   * difference between the two sources and not a detail. Ten death rows are ten casualties. Eighty
   * bomb rows are one device on eighty consecutive ticks, and counting them would badge a
   * four-second fuse "×79" — a number that looks like a swarm and is really a stopwatch.
   */
  private raise(kind: number, x: number, y: number, now: number, tally: boolean): void {
    // No window check in this loop, deliberately. `retire` ran at the top of this tick with this
    // same `now` and dropped everything the window had closed on, so a second test here could never
    // be true — and an unreachable guard is a line the next reader trusts and reasons from.
    for (let i = 0; i < this.count; i++) {
      if (this.kind[i] !== kind) continue;
      const dx = this.x[i]! - x;
      const dy = this.y[i]! - y;
      if (dx * dx + dy * dy > ALERT_MERGE_RADIUS * ALERT_MERGE_RADIUS) continue;
      // Clamped rather than wrapped: a Uint16 rollover would report a massacre as "×3", and a
      // count that is occasionally absurd is worse than one that is occasionally saturated.
      if (tally) this.events[i] = Math.min(65535, this.events[i]! + 1);
      this.lastAt[i] = now;
      // Note what is NOT touched: `x`/`y`, `firstAt` and `dismissed`. The last one is the whole of
      // the no-resurrection rule.
      return;
    }

    const n = this.count;
    this.ensureSlots(n + 1);
    this.id[n] = this.nextId++;
    this.kind[n] = kind;
    this.x[n] = x;
    this.y[n] = y;
    this.firstAt[n] = now;
    this.lastAt[n] = now;
    this.events[n] = 1;
    this.dismissed[n] = 0;
    this.count = n + 1;
  }

  /**
   * Retire everything whose window has closed — **the one place the window is enforced**, which is
   * why `raise` carries no window test of its own. Swap-remove, as in `effects.ts`: the last live
   * slot is copied over the dead one and the count drops, which reorders the pool and allocates
   * nothing.
   *
   * Order is not a promise this class makes — `latest()` reads the id, not the position — so the
   * reordering costs nothing. A HUD that wants oldest-first sorts on `firstAt` when it draws.
   */
  private retire(now: number): void {
    for (let i = 0; i < this.count;) {
      if (now - this.firstAt[i]! < ALERT_WINDOW_SECONDS) { i++; continue; }
      const last = --this.count;
      this.id[i] = this.id[last]!;
      this.kind[i] = this.kind[last]!;
      this.x[i] = this.x[last]!;
      this.y[i] = this.y[last]!;
      this.firstAt[i] = this.firstAt[last]!;
      this.lastAt[i] = this.lastAt[last]!;
      this.events[i] = this.events[last]!;
      this.dismissed[i] = this.dismissed[last]!;
    }
  }

  /**
   * **The only growth path in this file.** Powers of two, contents preserved, and reachable only
   * from `ingestTick` — which runs on a simulation tick, never on a frame (ADR-0006). Named
   * `ensure*` for the allocation scan in `test/architecture/layering.test.ts`, which reads method
   * names to tell setup from a frame.
   *
   * Growth is close to theoretical here and that is the design working, not luck: the window is ten
   * seconds and the merge radius is a blast, so the number of live slots is bounded by how many
   * distinct places a match can be on fire at once, which is single digits. Sixteen is already
   * generous.
   */
  private ensureSlots(needed: number): void {
    if (needed <= this.id.length) return;
    let next = this.id.length || 16;
    while (next < needed) next *= 2;
    this.id = growI32(this.id, next);
    this.kind = growU8(this.kind, next);
    this.x = growF32(this.x, next);
    this.y = growF32(this.y, next);
    this.firstAt = growF32(this.firstAt, next);
    this.lastAt = growF32(this.lastAt, next);
    this.events = growU16(this.events, next);
    this.dismissed = growU8(this.dismissed, next);
  }
}

// Growth preserves contents, unlike the snapshot's tables which are refilled from scratch every
// tick. An alert mid-window is exactly the thing a resize must not drop: losing it would also lose
// its tombstone, and the fight that filled the pool would immediately re-raise what the player had
// just dismissed.
function growF32(src: Float32Array, size: number): Float32Array {
  const next = new Float32Array(size);
  next.set(src);
  return next;
}

function growI32(src: Int32Array, size: number): Int32Array {
  const next = new Int32Array(size);
  next.set(src);
  return next;
}

function growU16(src: Uint16Array, size: number): Uint16Array {
  const next = new Uint16Array(size);
  next.set(src);
  return next;
}

function growU8(src: Uint8Array, size: number): Uint8Array {
  const next = new Uint8Array(size);
  next.set(src);
  return next;
}
