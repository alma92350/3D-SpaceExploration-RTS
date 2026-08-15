// The bridge: the only module that knows both the simulation and the view (ADR-0008).
//
// It owns the galaxy, steps it on the fixed clock, extracts snapshots, and turns player intent
// into calls to the engine's own command functions. Nothing above it may touch engine state, and
// its public surface is deliberately asynchronous-tolerant — commands are queued, snapshots are
// pulled — so the sim can move into a Worker later without the renderer noticing (ADR-0008 §4).
//
// **Phase 1 stubs the galaxy layer to "one world, already there"** (PRD §5). `createGalaxy` builds
// the whole eleven-world roster because that is what upstream does and we do not fork the rules;
// what the MVP omits is the *presentation* of anything beyond the seat. `stepWorld` deliberately
// calls `stepGalaxy`, not `tick`, so the background worlds keep simulating exactly as upstream
// intends — a Phase 4 that switched from `tick` to `stepGalaxy` would produce a different universe
// from the same seed, and every determinism fixture recorded here would be worthless.

import {
  activeState, createGalaxy, deserializeGalaxy, serializeGalaxy, stepGalaxy, supplyCap, supplyUsed,
  sweepColonies,
} from "../engine/index.js";
import { STEP_SECONDS } from "../app/loop.js";
import { type Snapshot, SnapshotExtractor } from "./snapshot.js";
import { type Intent, applyIntent } from "./commands.js";

/**
 * Q-02, answered in ADR-0010: the MVP always lands on the SAME world, so playtest reports compare.
 *
 * Helix Belt rather than the PRD's illustrative `ferros`, for one measurable reason: Ferros Prime's
 * terrain grid is uniformly open — no rough, no high ground — so a Phase 1 built on it would render
 * a perfectly flat plane and demonstrate none of the relief ADR-0004 calls "one of the few things
 * 3D genuinely adds to this game". Helix carries high-ground stamps AND the roster's richest mixed
 * deposits (ore 1.6, crystals 1.4, radioactives 1.0), so the opening economy is not the bottleneck
 * while someone is judging how the world reads. The recommendation Q-02 actually made was
 * "fixed" — that still holds; only the world named in passing has changed.
 */
export const MVP_WORLD = "helix";

export interface WorldOptions {
  seed?: number;
  worldId?: string;
  difficulty?: string;
  playerFaction?: string;
}

/**
 * One thing `sweepColonies` wants said out loud: a colony lost, a neighbour turning hostile, or a
 * raid in progress on a world the player is not standing on.
 *
 * `type` is the engine's own string (`lost` | `hostile` | `attacked`) and is not narrowed here, for
 * `galaxy-snapshot.ts`'s reason about status codes: a fourth kind added upstream must arrive as
 * itself rather than being folded into one of these three by a mapping nobody would think to check.
 */
export interface ColonyNote {
  readonly type: string;
  readonly planetId: string;
}

/**
 * How many undrained colony notes are kept.
 *
 * `lost` and `hostile` are latched by the engine and fire once per transition, but `attacked` fires
 * on every sweep that finds a fresh player death on a colony — so a siege the player never looks at
 * would grow this list for the rest of the session. The newest are kept, because that is what a
 * transient notice is for; a reader that drains every frame never reaches the cap.
 */
const COLONY_NOTE_LIMIT = 16;

const NO_NOTES: readonly ColonyNote[] = [];

export class WorldBridge {
  #galaxy: Galaxy;
  /**
   * Rebuilt when the seat changes — see `refresh`. Not `readonly` any more, and that is the whole
   * of the fix: it is sized from ONE map (fog dimensions, width, height, the base's position).
   */
  private extractor: SnapshotExtractor;
  /** The map the extractor was built for, so a seat change is noticed rather than assumed. */
  private extractorMap: GameMap;
  /** Intents accumulate here and are applied at the top of the next step, never mid-tick. */
  private readonly pending: Intent[] = [];
  private lastCommandError: string | null = null;
  /** Why the last `load` returned false. Drained like `lastCommandError`, and for the same reason. */
  private lastLoadError: string | null = null;
  /** Colony notifications since the last drain — see `takeColonyNotes`. */
  private readonly notes: ColonyNote[] = [];

  constructor(opts: WorldOptions = {}) {
    this.#galaxy = createGalaxy({
      seed: opts.seed ?? 1,
      startId: opts.worldId ?? MVP_WORLD,
      difficulty: opts.difficulty ?? "medium",
      playerFaction: opts.playerFaction ?? "frontier",
    });
    this.extractorMap = activeState(this.#galaxy).map;
    this.extractor = new SnapshotExtractor(this.extractorMap);
    this.refresh();
  }

  /** The seat's engine state. Only the bridge and its own tests may hold this. */
  get state(): State {
    return activeState(this.#galaxy);
  }

  /**
   * The galaxy the seat sits in (P4-T13).
   *
   * Beside `get state()` and under the same rule — this is the meta-layer, so the app may look at
   * it and nothing above the bridge may write it. It exists because Phase 4's screens are ALL about
   * the galaxy rather than about the seat: the starmap draws the roster, the jump/colony/lane panels
   * take a `Galaxy` argument, and `approachBrief` previews a world that is not the seat. Until now
   * the only way to reach any of that was a guarded cast at the private field, which
   * `test/determinism/replay.ts` had been carrying since P4-T11 with a comment naming this accessor
   * as the real fix.
   */
  get galaxy(): Galaxy {
    return this.#galaxy;
  }

  get worldId(): string {
    return this.#galaxy.activeId;
  }

  get seed(): number {
    return this.#galaxy.seed;
  }

  get snapshot(): Snapshot {
    return this.extractor.snapshot;
  }

  /** Galaxy credits. They live above the world, which is why trade needs the galaxy (P2-T03). */
  get galaxyCredits(): number {
    return this.#galaxy.credits;
  }

  /** Queue player intent. Never applied immediately — see the class comment. */
  enqueue(intent: Intent): void {
    this.pending.push(intent);
  }

  /**
   * Apply one intent right now and return the engine's refusal, if any.
   *
   * The game never calls this — it enqueues, so that an order lands on a tick boundary and a
   * recorded intent stream replays. It exists because a *test* of "does the engine refuse this?"
   * should not have to step the clock to find out, and because it is the same code path `drain`
   * uses rather than a second one that could drift from it.
   */
  apply(intent: Intent): string | null {
    return applyIntent(this.state, intent, this.#galaxy);
  }

  /** Why the last command was rejected (not enough ore, blocked ground), for the HUD. */
  takeCommandError(): string | null {
    const e = this.lastCommandError;
    this.lastCommandError = null;
    return e;
  }

  /**
   * What the colonies had to say since the last call, newest last. Drained like `takeCommandError`.
   *
   * These are the only news in this client that is about a world the player cannot see, which is
   * exactly why they are handed over as data rather than pushed anywhere: the shell decides where
   * they land. They are NOT alerts in `view/alerts.ts`' sense and do not fit that pool — an alert
   * carries the world position "focus last alert" jumps the camera to, and a colony note has no
   * position on the seat's map to jump to (see P4-T13's notes).
   */
  takeColonyNotes(): readonly ColonyNote[] {
    if (this.notes.length === 0) return NO_NOTES;      // the common case allocates nothing
    const out = this.notes.slice();
    this.notes.length = 0;
    return out;
  }

  /**
   * Advance one fixed step: drain intent, step the galaxy, re-extract.
   *
   * The order is load-bearing. Draining first means an order issued during frame N is simulated on
   * tick N rather than N+1, which is the difference between an RTS that feels responsive and one
   * that feels like it is on a delay.
   */
  step(dt: number = STEP_SECONDS): void {
    this.drain();
    stepGalaxy(this.#galaxy, dt);
    // THE COLONY SWEEP (P4-T13), which nothing in this client drove until now.
    //
    // `stepGalaxy` does not call it — verified in the source above this line's own dependency:
    // `stepGalaxy` runs the worlds, the lanes and the ~1 Hz galaxy scans, and colony income is not
    // among them. So `COLONY_INCOME_PER_BUILDING` was a rate nobody banked, `PACIFIED_INCOME` was
    // an occupation dividend nobody was paid, and P4-T06's panel was correctly reporting money that
    // never arrived. It belongs here rather than in the app for the reason the whole bridge exists:
    // it moves `galaxy.credits`, which is simulation state.
    //
    // After `stepGalaxy` rather than before, so a colony's news is reported by the step that
    // produced it: the sweep reads each colony's `state.events` for the tick that has just run and
    // then drains them, being their only consumer (exactly as the seat's are drained below).
    // **It is a one-tick shift and nothing in the suite distinguishes the two orders** — no event is
    // lost either way, because the drain and the read are the same pass. Said plainly rather than
    // dressed up as a correctness rule, so the next reader does not assume a test is holding it.
    //
    // It does not touch the seat — `sweepColonies` skips every world that is not `background` — and
    // it moves nothing `hashState`/`hashGalaxy` hash, so the determinism fixture is unaffected by
    // its arrival. That is a fact about the digest rather than a coincidence: credits were left out
    // of it deliberately (see `test/determinism/replay.ts`).
    for (const note of sweepColonies(this.#galaxy, dt)) {
      this.notes.push(note);
      if (this.notes.length > COLONY_NOTE_LIMIT) this.notes.shift();
    }
    // The engine queues per-tick events for the UI to drain, and an undrained array grows without
    // bound for the whole session — so the bridge drains it, exactly as upstream's own client does.
    //
    // **The order matters and used to be wrong (P3-T07).** This cleared the list BEFORE extracting,
    // so the snapshot never saw a single event and `entityKilled` — the one combat cue the engine
    // hands over ready-made — was thrown away every tick with nothing to show for it. Extract
    // first, then drain, and the drain still happens exactly once per step.
    this.refresh();
    this.state.events.length = 0;
  }

  private drain(): void {
    if (this.pending.length === 0) return;
    for (const intent of this.pending) {
      // The seat is read PER INTENT rather than once, because one of them changes it: a `jump`
      // moves `galaxy.activeId`, and every later intent in the same batch belongs to the world the
      // player has just arrived on. Hoisting this out of the loop — which is what it used to do —
      // would apply them to the world they left.
      const err = applyIntent(this.state, intent, this.#galaxy);
      if (err) this.lastCommandError = err;
    }
    this.pending.length = 0;
  }

  /**
   * Re-extract, rebuilding the extractor first if the seat has moved under it.
   *
   * `SnapshotExtractor` is built from ONE map: its fog buffer is sized from that map's dimensions
   * and `snap.map` — width, height, and the player's base anchor — is written in its constructor and
   * never again. A jump swaps the seat, and `load()` can swap it too.
   *
   * **Nothing visible changes today and this is a guard, not a fix.** Every world in the current
   * roster generates at 1600 × 1000 with the same player anchor, so a stale extractor happens to
   * describe the new world correctly. What it is a guard on is that coincidence: `data.js`'s
   * settings carry a `sizeMult` per scenario, and one world sized differently would leave
   * `extractFog` filling a buffer cut for another map — a fog that is wrong at the edges, from a
   * line nobody would think to look at. Four lines, and the assumption stops being load-bearing.
   */
  private refresh(): void {
    const state = this.state;
    if (state.map !== this.extractorMap) {
      this.extractorMap = state.map;
      this.extractor = new SnapshotExtractor(state.map);
    }
    this.extractor.extract(state, {
      viewer: "player",
      credits: this.#galaxy.credits,
      supplyUsed: supplyUsed(state, "player"),
      supplyCap: supplyCap(state, "player"),
    });
  }

  /** Save the whole galaxy in upstream's own format (PRD F-08). */
  save(): Record<string, unknown> {
    return serializeGalaxy(this.#galaxy);
  }

  /**
   * Load a save produced by this client or by the 2D one.
   *
   * Upstream sanitises and version-gates on the way in (N-08) and returns null on anything it does
   * not recognise, so a bad file is a rejected load rather than a corrupted session. We keep the
   * old galaxy on failure for the same reason.
   */
  load(raw: unknown): boolean {
    // Upstream signals "not a save" two different ways depending on how wrong the input is: a
    // recognisable-but-rejected payload returns null, while garbage throws out of `sanitizeSave`.
    // A load is a player action on an untrusted file (N-08), so both have to land as `false` here
    // rather than as an exception through the boot path.
    let restored: Galaxy | null = null;
    try {
      restored = deserializeGalaxy(raw);
    } catch (err) {
      // **This used to be a bare `catch { return false }`, and that was the defect** (P6-T05).
      // Upstream writes a specific, quotable reason for every refusal — "unsupported galaxy save
      // version 2", "galaxy save has no active planet", "save contains a forbidden key: __proto__"
      // — and eight distinguishable causes collapsed to one bit while `console` never saw any of
      // them. A caught exception that logs nothing is worse than a crash: the crash at least has a
      // stack. The player gets the sentence; the console gets the error object.
      this.lastLoadError = err instanceof Error ? err.message : String(err);
      console.error("[odyssey] a save was refused", err);
      return false;
    }
    if (!restored) {
      this.lastLoadError = "the file is not a save this build recognises";
      return false;
    }
    // `refresh()` used to sit outside the try and AFTER the assignment, so a payload that satisfied
    // upstream and then broke extraction left the bridge holding it — contradicting this method's
    // own header promise to keep the old galaxy on failure. No payload reaches it today (22
    // corruptions measured, every one refused earlier), which is exactly why it was worth fixing
    // while somebody was looking at it.
    const previous = this.#galaxy;
    this.#galaxy = restored;
    try {
      this.refresh();
    } catch (err) {
      this.#galaxy = previous;
      this.refresh();
      this.lastLoadError = err instanceof Error ? err.message : String(err);
      console.error("[odyssey] a save loaded and then failed to extract", err);
      return false;
    }
    this.lastLoadError = null;
    return true;
  }

  /** Why the last `load` returned false, drained on read — `takeCommandError`'s shape (P6-T05). */
  takeLoadError(): string | null {
    const problem = this.lastLoadError;
    this.lastLoadError = null;
    return problem;
  }
}
