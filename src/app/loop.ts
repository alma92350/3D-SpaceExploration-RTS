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

/** The simulation's fixed rate. Upstream's `PLAY_HZ`; not ours to change (ADR-0003). */
export const PLAY_HZ = 20;
export const STEP_SECONDS = 1 / PLAY_HZ;

/** Catch-up substeps per animation frame before the loop gives up and runs slow (upstream's cap). */
export const MAX_CATCHUP_STEPS = 5;

export interface LoopCallbacks {
  /** One fixed simulation step. Always called with exactly `STEP_SECONDS`. */
  step(dt: number): void;
  /**
   * Draw one frame.
   * @param alpha  interpolation factor in [0, 1) between the previous and current tick.
   * @param frameMs wall-clock time since the previous rendered frame.
   */
  render(alpha: number, frameMs: number): void;
}

export interface LoopStats {
  readonly ticks: number;
  readonly frames: number;
  /** Steps discarded by the catch-up cap. Non-zero means the machine is behind (ADR-0006). */
  readonly droppedSteps: number;
  readonly alpha: number;
}

export class FixedStepLoop {
  private accumulator = 0;
  private lastNow: number | null = null;
  private ticks = 0;
  private frames = 0;
  private droppedSteps = 0;
  private alpha = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  /**
   * Advance by wall-clock. Call once per animation frame with the frame's timestamp.
   * @param now milliseconds, monotonic. The first call only establishes the baseline.
   */
  advance(now: number): void {
    if (this.lastNow === null) {
      this.lastNow = now;
      // Render the very first frame so the player sees the world before any tick has run.
      // Without this a slow first sim step shows a blank canvas, which reads as a hang.
      this.frames++;
      this.cb.render(0, 0);
      return;
    }

    const frameMs = Math.max(0, now - this.lastNow);
    this.lastNow = now;
    this.accumulator += frameMs / 1000;

    let steps = 0;
    while (this.accumulator >= STEP_SECONDS && steps < MAX_CATCHUP_STEPS) {
      this.cb.step(STEP_SECONDS);
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
    this.cb.render(this.alpha, frameMs);
  }

  /** Forget the wall-clock baseline — call after a pause, so the gap is not simulated. */
  resume(): void {
    this.lastNow = null;
    this.accumulator = 0;
  }

  get stats(): LoopStats {
    return { ticks: this.ticks, frames: this.frames, droppedSteps: this.droppedSteps, alpha: this.alpha };
  }
}
