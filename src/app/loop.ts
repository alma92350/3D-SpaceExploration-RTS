// The fixed-timestep clock (ADR-0008, P0-T10).
//
// The simulation is deterministic *because* it steps at a fixed 20 Hz; the display runs at whatever
// the machine gives us (30 fps at T0, 60+ elsewhere). This reconciles the two, and it is the one
// piece of the app whose bugs look like "the game feels wrong" rather than like an exception.
//
// Two properties matter more than they look:
//
//   • **The catch-up cap.** After a tab-switch or a GC pause the accumulator can hold seconds of
//     unsimulated time. Running it all back is the classic spiral of death: each catch-up batch
//     takes longer than the time it recovers. Upstream's loop caps at 5 substeps and then drops
//     the remainder, so the game runs briefly in slow motion instead of freezing. We keep that
//     number, because determinism fixtures recorded against upstream must replay here.
//   • **The dropped remainder is dropped, not carried.** Keeping it would make the next frame do
//     the same work again, which is the spiral with extra steps.
//
// No DOM, no `performance.now()`: the clock is injected. That is what lets the test drive N
// milliseconds of wall time and assert the exact tick count and alpha.
//
// ---------------------------------------------------------------------------------------------
// P6-T05: a throw inside a frame used to kill the loop in silence.
//
// There was no `try` anywhere in this file or the render path. `main.ts`'s `bootOrExplain` covers
// the boot and nothing covered the next ten thousand frames, so one bad snapshot — a corrupt save
// that detonates on a later tick is upstream's own named example (`engine/persist.js:88–92`:
// "they slip in and detonate on the FIRST tick, inside the rAF loop, AFTER load's try/catch has
// already returned success") — threw out of the rAF callback, `Game.start`'s `frame` never
// re-armed `requestAnimationFrame`, and the game stopped. From the outside: a still picture, no
// message, and the only evidence in a console nobody has open.
//
// Three rules, and each one is a rule because its opposite is a worse failure:
//
//   • **Nothing is swallowed.** Every caught error reaches `console.error` with its stack, always,
//     before any reporter runs. A caught exception that logs nothing is strictly worse than a
//     crash, because the crash at least leaves a stack.
//   • **It is reported once per episode, not once per frame.** A render that throws at 60 Hz would
//     bury the first stack — the only one taken while the state that caused it was fresh — under
//     six hundred copies of itself in ten seconds. The report fires when the failure SIGNATURE
//     changes, and the signature is cleared by one clean frame, so a fault that comes back after
//     recovering is reported again.
//   • **It gives up eventually, and says so.** `MAX_CONSECUTIVE_FAILURES` frames in a row that all
//     throw is not a transient; it is a game that is not running. Continuing to burn a core at
//     60 Hz on work that cannot succeed is the same failure the catch-up cap exists to prevent, so
//     the loop halts and the halt is itself reported.
//
// The reporter is module-level and defaults to `console.error` because it is the console's role,
// not the loop's state: there is one loop per page, and the object is constructed inside `Game`,
// which `main.ts` — the module that owns the player-facing surface — cannot reach. `LoopCallbacks`
// also accepts a per-instance `onError`, which takes precedence when the owner has one.

/** The simulation's fixed rate. Upstream's `PLAY_HZ`; not ours to change (ADR-0003). */
export const PLAY_HZ = 20;
export const STEP_SECONDS = 1 / PLAY_HZ;

/** Catch-up substeps per animation frame before the loop gives up and runs slow (upstream's cap). */
export const MAX_CATCHUP_STEPS = 5;

/**
 * Frames that must fail back-to-back before the loop stops trying.
 *
 * 60 — about a second at T2, two at T0. Long enough that a single bad tick, or a resize race that
 * clears itself, never trips it; short enough that a player staring at a frozen picture is told
 * why within a breath rather than never.
 */
export const MAX_CONSECUTIVE_FAILURES = 60;

/** Which half of the frame threw. The two are different faults and the message says which. */
export type FramePhase = "step" | "render";

export interface FrameFailure {
  readonly phase: FramePhase;
  readonly error: unknown;
  /** Frames in the current unbroken run of failures, this one included. */
  readonly consecutive: number;
  /** True on the report that accompanies the loop giving up. */
  readonly halted: boolean;
  /** Simulation ticks completed before the failure — the "when" a bug report needs. */
  readonly ticks: number;
  readonly frames: number;
}

export type FrameFailureReporter = (failure: FrameFailure) => void;

let reporter: FrameFailureReporter | null = null;

/**
 * Install the player-facing sink for frame failures. Returns the previous one, so a test can put
 * it back.
 *
 * This is **in addition to** `console.error`, never instead of it: the stack goes to the console
 * whether or not anyone is listening.
 */
export function reportFrameFailuresTo(sink: FrameFailureReporter | null): FrameFailureReporter | null {
  const previous = reporter;
  reporter = sink;
  return previous;
}

export interface LoopCallbacks {
  /** One fixed simulation step. Always called with exactly `STEP_SECONDS`. */
  step(dt: number): void;
  /**
   * Draw one frame.
   * @param alpha  interpolation factor in [0, 1) between the previous and current tick.
   * @param frameMs wall-clock time since the previous rendered frame.
   */
  render(alpha: number, frameMs: number): void;
  /**
   * Told about a frame that threw, if the owner wants to know. Takes precedence over the
   * module-level reporter; `console.error` happens either way.
   */
  onError?(failure: FrameFailure): void;
}

export interface LoopStats {
  readonly ticks: number;
  readonly frames: number;
  /** Steps discarded by the catch-up cap. Non-zero means the machine is behind (ADR-0006). */
  readonly droppedSteps: number;
  readonly alpha: number;
  /** Simulation steps abandoned because `step` threw. Distinct from `droppedSteps`, which is load. */
  readonly failedSteps: number;
  /** Frames abandoned because `render` threw. */
  readonly failedFrames: number;
  /** True once the loop has given up — see `MAX_CONSECUTIVE_FAILURES`. `resume()` clears it. */
  readonly halted: boolean;
}

export class FixedStepLoop {
  private accumulator = 0;
  private lastNow: number | null = null;
  private ticks = 0;
  private frames = 0;
  private droppedSteps = 0;
  private alpha = 0;

  private failedSteps = 0;
  private failedFrames = 0;
  /** Frames in the current unbroken run of failures. One clean frame resets it. */
  private consecutive = 0;
  /** Set by the first failure of a frame, so a frame that throws twice counts once. */
  private failedThisFrame = false;
  /** `phase` + the error's name and message. Reporting is keyed on this changing. */
  private signature: string | null = null;
  private halted = false;
  /** The fault currently being reported, so the halt can name it rather than say "something". */
  private lastPhase: FramePhase = "render";
  private lastError: unknown = null;

  constructor(private readonly cb: LoopCallbacks) {}

  /**
   * Advance by wall-clock. Call once per animation frame with the frame's timestamp.
   * @param now milliseconds, monotonic. The first call only establishes the baseline.
   */
  advance(now: number): void {
    // Halted means every remaining frame would throw too. The rAF chain above keeps calling —
    // `Game.stop()` is not ours to call — so this is what stops the work.
    if (this.halted) return;
    this.failedThisFrame = false;

    if (this.lastNow === null) {
      this.lastNow = now;
      // Render the very first frame so the player sees the world before any tick has run.
      // Without this a slow first sim step shows a blank canvas, which reads as a hang.
      this.frames++;
      try {
        this.cb.render(0, 0);
      } catch (error) {
        this.failedFrames++;
        this.failed("render", error);
      }
      this.settle();
      return;
    }

    const frameMs = Math.max(0, now - this.lastNow);
    this.lastNow = now;
    this.accumulator += frameMs / 1000;

    let steps = 0;
    while (this.accumulator >= STEP_SECONDS && steps < MAX_CATCHUP_STEPS) {
      try {
        this.cb.step(STEP_SECONDS);
      } catch (error) {
        this.failedSteps++;
        this.failed("step", error);
        // Abandon the batch and the backlog with it, for exactly the reason the catch-up cap drops
        // its remainder: re-running work that has just thrown, on the next frame, with more of it
        // queued, is the spiral of death with an exception in it. The tick is NOT counted — the
        // simulation did not advance, and a stats line that says it did would send the next reader
        // looking in the wrong place.
        this.accumulator = 0;
        break;
      }
      this.accumulator -= STEP_SECONDS;
      this.ticks++;
      steps++;
    }

    if (this.accumulator >= STEP_SECONDS) {
      // Over the cap. Drop the backlog rather than carrying it: carrying it guarantees the next
      // frame is over the cap too, and the game never recovers.
      const dropped = Math.floor(this.accumulator / STEP_SECONDS);
      this.droppedSteps += dropped;
      this.accumulator -= dropped * STEP_SECONDS;
    }

    this.alpha = this.accumulator / STEP_SECONDS;
    this.frames++;
    try {
      this.cb.render(this.alpha, frameMs);
    } catch (error) {
      this.failedFrames++;
      this.failed("render", error);
    }
    this.settle();
  }

  /** Forget the wall-clock baseline — call after a pause, so the gap is not simulated. */
  resume(): void {
    this.lastNow = null;
    this.accumulator = 0;
    // A halted loop is resumable on purpose: the recovery this project has is "put a working
    // renderer back and start again" (`Game.setRenderer`), and a halt that could only be cleared
    // by reloading would throw the session away to fix the picture.
    this.halted = false;
    this.consecutive = 0;
    this.signature = null;
  }

  get stats(): LoopStats {
    return {
      ticks: this.ticks, frames: this.frames, droppedSteps: this.droppedSteps, alpha: this.alpha,
      failedSteps: this.failedSteps, failedFrames: this.failedFrames, halted: this.halted,
    };
  }

  /** Record a throw and report it if it is not the one already being reported. */
  private failed(phase: FramePhase, error: unknown): void {
    if (!this.failedThisFrame) {
      this.failedThisFrame = true;
      this.consecutive++;
    }
    const signature = `${phase} ${signatureOf(error)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.report(phase, error, false);
  }

  /** End-of-frame bookkeeping: clear the streak on a clean frame, or give up on a long one. */
  private settle(): void {
    if (!this.failedThisFrame) {
      this.consecutive = 0;
      this.signature = null;
      return;
    }
    if (this.consecutive >= MAX_CONSECUTIVE_FAILURES) {
      this.halted = true;
      this.report(this.lastPhase, this.lastError, true);
    }
  }

  private report(phase: FramePhase, error: unknown, halted: boolean): void {
    this.lastPhase = phase;
    this.lastError = error;
    // Unconditional, and first. Whatever else happens, the stack is in the console.
    console.error(`[odyssey] the ${phase} phase of the frame threw${halted ? " — the loop has stopped" : ""}`, error);
    const failure: FrameFailure = {
      phase, error, consecutive: this.consecutive, halted, ticks: this.ticks, frames: this.frames,
    };
    try {
      if (this.cb.onError) this.cb.onError(failure);
      else if (reporter) reporter(failure);
    } catch (sinkError) {
      // The thing that reports failures failed. Say so rather than losing both.
      console.error("[odyssey] the frame-failure reporter threw", sinkError);
    }
  }
}

/**
 * A stable key for "the same failure again".
 *
 * Name and message only — never the stack, whose line numbers are identical anyway and whose
 * frames differ between an inlined and a non-inlined call of the same fault.
 */
function signatureOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
