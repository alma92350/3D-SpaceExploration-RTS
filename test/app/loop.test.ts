// P0-T10 — the fixed-timestep clock. Written from ADR-0008's numbers, not from the implementation.

import { describe, expect, it } from "vitest";
import { FixedStepLoop, MAX_CATCHUP_STEPS, PLAY_HZ, STEP_SECONDS } from "../../src/app/loop.js";

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
