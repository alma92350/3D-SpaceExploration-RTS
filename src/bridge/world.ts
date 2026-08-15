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

export class WorldBridge {
  private galaxy: Galaxy;
  private readonly extractor: SnapshotExtractor;
  /** Intents accumulate here and are applied at the top of the next step, never mid-tick. */
  private readonly pending: Intent[] = [];
  private lastCommandError: string | null = null;

  constructor(opts: WorldOptions = {}) {
    this.galaxy = createGalaxy({
      seed: opts.seed ?? 1,
      startId: opts.worldId ?? MVP_WORLD,
      difficulty: opts.difficulty ?? "medium",
      playerFaction: opts.playerFaction ?? "frontier",
    });
    this.extractor = new SnapshotExtractor(activeState(this.galaxy).map);
    this.refresh();
  }

  /** The seat's engine state. Only the bridge and its own tests may hold this. */
  get state(): State {
    return activeState(this.galaxy);
  }

  get worldId(): string {
    return this.galaxy.activeId;
  }

  get seed(): number {
    return this.galaxy.seed;
  }

  get snapshot(): Snapshot {
    return this.extractor.snapshot;
  }

  /** Galaxy credits. They live above the world, which is why trade needs the galaxy (P2-T03). */
  get galaxyCredits(): number {
    return this.galaxy.credits;
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
    return applyIntent(this.state, intent, this.galaxy);
  }

  /** Why the last command was rejected (not enough ore, blocked ground), for the HUD. */
  takeCommandError(): string | null {
    const e = this.lastCommandError;
    this.lastCommandError = null;
    return e;
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
    stepGalaxy(this.galaxy, dt);
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
    const state = this.state;
    for (const intent of this.pending) {
      const err = applyIntent(state, intent, this.galaxy);
      if (err) this.lastCommandError = err;
    }
    this.pending.length = 0;
  }

  private refresh(): void {
    const state = this.state;
    this.extractor.extract(state, {
      viewer: "player",
      credits: this.galaxy.credits,
      supplyUsed: supplyUsed(state, "player"),
      supplyCap: supplyCap(state, "player"),
    });
  }

  /** Save the whole galaxy in upstream's own format (PRD F-08). */
  save(): Record<string, unknown> {
    return serializeGalaxy(this.galaxy);
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
    } catch {
      return false;
    }
    if (!restored) return false;
    this.galaxy = restored;
    this.refresh();
    return true;
  }
}
