// P0-T10 — the fixed-timestep clock. Written from ADR-0008's numbers, not from the implementation.
//
// P6-T05 adds the second half: what the clock does when the work it drives throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FrameFailure, FixedStepLoop, MAX_CATCHUP_STEPS, MAX_CONSECUTIVE_FAILURES, PLAY_HZ,
  STEP_SECONDS, reportFrameFailuresTo,
} from "../../src/app/loop.js";

function harness() {
  const steps: number[] = [];
  const renders: Array<{ alpha: number; frameMs: number }> = [];
  const loop = new FixedStepLoop({
    step: (dt) => steps.push(dt),
    render: (alpha, frameMs) => renders.push({ alpha, frameMs }),
  });
  return { loop, steps, renders };
}

describe("FixedStepLoop", () => {
  it("runs the sim at exactly 20 Hz regardless of frame rate", () => {
    const { loop, steps } = harness();
    // One second of wall time, delivered as 60 fps frames.
    for (let f = 0; f <= 60; f++) loop.advance(f * (1000 / 60));
    expect(steps).toHaveLength(PLAY_HZ);
    expect(new Set(steps)).toEqual(new Set([STEP_SECONDS]));
  });

  it("runs the same number of ticks at 30 fps as at 60 fps", () => {
    const fast = harness();
    for (let f = 0; f <= 120; f++) fast.loop.advance(f * (1000 / 60));
    const slow = harness();
    for (let f = 0; f <= 60; f++) slow.loop.advance(f * (1000 / 30));
    expect(slow.steps.length).toBe(fast.steps.length);
  });

  it("reports alpha as the fraction of a step still unsimulated", () => {
    const { loop, renders } = harness();
    loop.advance(0);
    loop.advance(25);            // half a 50 ms step, nothing simulated yet
    expect(renders.at(-1)!.alpha).toBeCloseTo(0.5, 6);
    loop.advance(50);            // exactly one step consumed: nothing left over
    expect(renders.at(-1)!.alpha).toBeCloseTo(0, 6);
    loop.advance(90);            // 40 ms into the next step
    expect(renders.at(-1)!.alpha).toBeCloseTo(0.8, 6);
  });

  it("keeps alpha inside [0, 1) on every frame", () => {
    const { loop, renders } = harness();
    let t = 0;
    for (let f = 0; f < 200; f++) { t += 7.3 * ((f % 5) + 1); loop.advance(t); }
    for (const r of renders) {
      expect(r.alpha).toBeGreaterThanOrEqual(0);
      expect(r.alpha).toBeLessThan(1);
    }
  });

  it("never runs more than the catch-up cap of steps in one frame", () => {
    const { loop, steps } = harness();
    loop.advance(0);
    loop.advance(10_000);        // ten seconds of backlog — a tab-switch
    expect(steps).toHaveLength(MAX_CATCHUP_STEPS);
  });

  it("drops the backlog past the cap instead of carrying it into the next frame", () => {
    // Carrying it is the spiral of death: every subsequent frame arrives already over budget.
    const { loop, steps } = harness();
    loop.advance(0);
    loop.advance(10_000);
    const afterStall = steps.length;
    loop.advance(10_050);        // one ordinary 50 ms frame after the stall
    expect(steps.length - afterStall).toBe(1);
    expect(loop.stats.droppedSteps).toBeGreaterThan(0);
  });

  it("renders once per advance, including the first", () => {
    const { loop, renders, steps } = harness();
    loop.advance(1000);
    expect(renders).toHaveLength(1);
    expect(steps).toHaveLength(0);   // the first call only establishes the clock baseline
    loop.advance(1050);
    expect(renders).toHaveLength(2);
  });

  it("does not simulate the gap across a resume", () => {
    const { loop, steps } = harness();
    loop.advance(0);
    loop.advance(50);
    loop.resume();
    loop.advance(60_000);        // a minute paused
    expect(steps).toHaveLength(1);
  });

  it("ignores a clock that goes backwards", () => {
    const { loop, steps, renders } = harness();
    loop.advance(1000);
    loop.advance(900);
    expect(steps).toHaveLength(0);
    expect(renders.at(-1)!.frameMs).toBe(0);
  });
});

/* =================================================================================================
   P6-T05 — a throw inside a frame

   There was no `try` anywhere in `app/loop.ts` or the render path before this row. Every test here
   FIRES a throw rather than checking that a handler is installed: the callbacks passed to the loop
   are the real seam the game uses, so a `throw` in one of them is the real failure, not a stand-in.
   ================================================================================================= */

/** A loop whose two phases throw on demand. `explode.step = err` makes the next step throw it. */
function faulty() {
  const explode: { step: unknown; render: unknown } = { step: null, render: null };
  const done = { steps: 0, renders: 0 };
  const seen: FrameFailure[] = [];
  const loop = new FixedStepLoop({
    step: () => {
      if (explode.step) throw explode.step;
      done.steps++;
    },
    render: () => {
      if (explode.render) throw explode.render;
      done.renders++;
    },
  });
  return { loop, explode, done, seen };
}

describe("a frame that throws (P6-T05)", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  let reported: FrameFailure[];
  let previous: ((f: FrameFailure) => void) | null;

  beforeEach(() => {
    // Silenced, but captured: every assertion about "it did not swallow this" reads the spy.
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    reported = [];
    previous = reportFrameFailuresTo((f) => reported.push(f));
  });

  afterEach(() => {
    reportFrameFailuresTo(previous);
    errors.mockRestore();
  });

  it("keeps rendering after a frame throws, instead of ending the session", () => {
    // The defect, exactly: `Game.start`'s rAF chain re-arms itself INSIDE the callback, so a throw
    // out of `advance` meant `requestAnimationFrame` was never called again. One bad frame and the
    // game was over, with a still picture and no message.
    const { loop, explode, done } = faulty();
    loop.advance(0);
    explode.render = new TypeError("cannot read properties of undefined (reading 'x')");
    loop.advance(50);
    explode.render = null;
    loop.advance(100);
    loop.advance(150);

    expect(done.renders, "the loop stopped rendering after one bad frame").toBeGreaterThanOrEqual(2);
    expect(loop.stats.failedFrames).toBe(1);
    expect(loop.stats.halted).toBe(false);
  });

  it("keeps ticking after a step throws, and does not re-run the backlog that threw", () => {
    const { loop, explode, done } = faulty();
    loop.advance(0);
    explode.step = new Error("corrupt snapshot");
    loop.advance(1000);              // 20 steps of backlog, the first of which throws
    expect(loop.stats.failedSteps).toBe(1);
    // The backlog is dropped, not carried: carrying it guarantees the next frame throws too, on
    // work that has already failed once. This is the catch-up cap's rule, applied to a fault.
    expect(loop.stats.ticks).toBe(0);
    // …and it is dropped by the FAULT, not by the cap. Letting the over-cap branch collect the
    // abandoned backlog would file nineteen steps under "this machine is behind" (ADR-0006), which
    // is the one number a reader consults to decide whether a report is a bug or a slow laptop.
    expect(loop.stats.droppedSteps, "a broken tick was recorded as a slow machine").toBe(0);

    explode.step = null;
    loop.advance(1050);
    expect(done.steps, "the simulation never restarted after one bad tick").toBe(1);
    expect(loop.stats.ticks).toBe(1);
  });

  it("never swallows: the thrown value itself reaches console.error", () => {
    // A caught exception that logs nothing is worse than a crash — the crash at least has a stack.
    const boom = new RangeError("index out of bounds");
    const { loop, explode } = faulty();
    loop.advance(0);
    explode.render = boom;
    loop.advance(50);

    expect(errors).toHaveBeenCalled();
    const args = errors.mock.calls.flat();
    expect(args, "the error object was not passed through, so the stack is gone").toContain(boom);
    expect(String(args[0]), "the log does not say which half of the frame threw").toMatch(/render/);
  });

  it("reports once per episode, not once per frame", () => {
    // 60 Hz × the same fault buries the one stack taken while the state was fresh under six hundred
    // copies of itself. Reporting is keyed on the failure signature, cleared by a clean frame.
    const { loop, explode } = faulty();
    loop.advance(0);
    explode.render = new TypeError("same fault");
    for (let f = 1; f <= 30; f++) loop.advance(f * 50);
    expect(reported).toHaveLength(1);
    expect(loop.stats.failedFrames).toBe(30);

    // Recovered, then broken again: a fault that comes back is news again.
    explode.render = null;
    loop.advance(31 * 50);
    explode.render = new TypeError("same fault");
    loop.advance(32 * 50);
    expect(reported).toHaveLength(2);
  });

  it("reports a different fault immediately, without waiting for a clean frame", () => {
    const { loop, explode } = faulty();
    loop.advance(0);
    explode.render = new TypeError("first fault");
    loop.advance(50);
    explode.render = new RangeError("second fault");
    loop.advance(100);
    expect(reported.map((f) => (f.error as Error).name)).toEqual(["TypeError", "RangeError"]);
  });

  it("tells two faults of the same class apart by their message", () => {
    // The common case by a distance: `TypeError: a is not a function` and
    // `TypeError: b is not a function` are two different bugs, and a signature that stopped at the
    // constructor name would report the first and hide the second for the rest of the session.
    const { loop, explode } = faulty();
    loop.advance(0);
    explode.render = new TypeError("snap.units is not iterable");
    loop.advance(50);
    explode.render = new TypeError("snap.fog is not iterable");
    loop.advance(100);
    expect(reported.map((f) => (f.error as Error).message))
      .toEqual(["snap.units is not iterable", "snap.fog is not iterable"]);
  });

  it("tells the same fault in the two halves of the frame apart", () => {
    // A `TypeError: x` thrown while stepping and the same one thrown while drawing are different
    // bugs in different code, and the message a player is shown names which.
    const { loop, explode } = faulty();
    loop.advance(0);
    explode.step = new TypeError("shared message");
    loop.advance(50);
    explode.step = null;
    explode.render = new TypeError("shared message");
    loop.advance(100);
    expect(reported.map((f) => f.phase)).toEqual(["step", "render"]);
  });

  it("gives up inside a few seconds at the slowest frame rate this loop advertises", () => {
    // The threshold has to be pinned to something, and restating the number would only assert that
    // 60 is 60. It is bounded by its own purpose instead: the header promises 30 fps at T0 and 60+
    // elsewhere, so the halt must not fire inside half a second of fast frames (a resize race that
    // clears itself is not a dead game) and must arrive within three seconds of slow ones (a player
    // staring at a frozen picture is owed a sentence).
    expect(MAX_CONSECUTIVE_FAILURES / 60, "the loop gives up on a transient").toBeGreaterThanOrEqual(0.5);
    expect(MAX_CONSECUTIVE_FAILURES / 30, "a frozen game says nothing for too long").toBeLessThanOrEqual(3);
  });

  it("names the phase and the tick, which is what a bug report needs", () => {
    const { loop, explode } = faulty();
    loop.advance(0);
    loop.advance(1000);                       // five ticks in (the catch-up cap)
    explode.step = new Error("boom");
    loop.advance(1050);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.phase).toBe("step");
    expect(reported[0]!.ticks).toBe(MAX_CATCHUP_STEPS);
    expect(reported[0]!.halted).toBe(false);
  });

  it("gives up after a solid second of failures, and says that it has", () => {
    const { loop, explode, done } = faulty();
    loop.advance(0);
    explode.render = new Error("permanent");
    for (let f = 1; f <= MAX_CONSECUTIVE_FAILURES; f++) loop.advance(f * 16);

    expect(loop.stats.halted, "the loop is still burning a core on work that cannot succeed").toBe(true);
    const halt = reported.find((f) => f.halted);
    expect(halt, "the loop gave up without telling anyone").toBeDefined();
    expect(halt!.consecutive).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(halt!.error).toBe(explode.render);

    // And it really stops: the callbacks are not called again.
    explode.render = null;
    const before = done.renders;
    loop.advance(10_000);
    expect(done.renders).toBe(before);
  });

  it("does not give up on a fault that keeps clearing", () => {
    // Every other frame throws — unpleasant, but the game is running and halting it would be wrong.
    const { loop, explode } = faulty();
    loop.advance(0);
    for (let f = 1; f <= MAX_CONSECUTIVE_FAILURES * 3; f++) {
      explode.render = f % 2 === 0 ? new Error("intermittent") : null;
      loop.advance(f * 16);
    }
    expect(loop.stats.halted).toBe(false);
    expect(loop.stats.failedFrames).toBeGreaterThan(MAX_CONSECUTIVE_FAILURES);
  });

  it("comes back after a halt when the session is resumed", () => {
    // The recovery this project has is "put a working renderer back and start again"
    // (`Game.setRenderer`). A halt that only a reload could clear would throw the session away.
    const { loop, explode, done } = faulty();
    loop.advance(0);
    explode.render = new Error("permanent");
    for (let f = 1; f <= MAX_CONSECUTIVE_FAILURES; f++) loop.advance(f * 16);
    expect(loop.stats.halted).toBe(true);

    explode.render = null;
    loop.resume();
    const before = done.renders;
    loop.advance(20_000);
    expect(loop.stats.halted).toBe(false);
    expect(done.renders).toBe(before + 1);
  });

  it("prefers the owner's own handler to the module reporter", () => {
    const mine: FrameFailure[] = [];
    const loop = new FixedStepLoop({
      step: () => {},
      render: () => { throw new Error("mine"); },
      onError: (f) => mine.push(f),
    });
    loop.advance(0);
    expect(mine).toHaveLength(1);
    expect(reported, "both sinks fired, so the player would be told twice").toHaveLength(0);
  });

  it("survives a reporter that throws, and says that it did", () => {
    reportFrameFailuresTo(() => { throw new Error("the banner is broken too"); });
    const { loop, explode, done } = faulty();
    loop.advance(0);
    explode.render = new Error("original");
    loop.advance(50);
    explode.render = null;
    loop.advance(100);

    // The first frame and the recovered one; the middle frame is the one that threw.
    expect(done.renders, "a broken reporter took the loop down with it").toBe(2);
    const logged = errors.mock.calls.flat().map(String).join(" | ");
    expect(logged, "the original fault was lost").toMatch(/original/);
    expect(logged, "the reporter's own failure was swallowed").toMatch(/reporter threw/);
  });

  it("counts a failed step separately from a step dropped by the catch-up cap", () => {
    // They mean opposite things — one is a bug, the other is a slow machine (ADR-0006) — and a
    // single counter would let a fault hide inside a stall.
    const { loop, explode } = faulty();
    loop.advance(0);
    loop.advance(10_000);                     // a stall: the cap drops the remainder
    expect(loop.stats.droppedSteps).toBeGreaterThan(0);
    expect(loop.stats.failedSteps).toBe(0);

    explode.step = new Error("boom");
    loop.advance(10_100);
    expect(loop.stats.failedSteps).toBe(1);
  });
});
