// The perf gate's own rules (`perf/harness.ts`'s `judge`), which had no tests.
//
// This is the function that decides whether ADR-0006's budget still holds, and it was trusted on
// inspection. Two of the cases below are ordinary coverage. The last one is the reason the file
// exists: the regression message tells the reader what to do next, and what it used to tell them
// was a way to permanently disable the gate.

import { describe, expect, it } from "vitest";
import { judge, REGRESSION_SLACK_MS, type Baseline, type PerfResult } from "../../perf/harness.js";

/** A passing T0 result; override the one field a case is about. */
function result(over: Partial<PerfResult> = {}): PerfResult {
  return {
    scene: "T0",
    tier: "T0",
    frames: 300,
    p50: 2.4,
    p95: 2.8,
    budgetMs: 33,
    maxDrawCalls: 15,
    maxInstances: 313,
    maxTriangles: 13_016,
    terrainUploads: 1,
    fogUploads: 30,
    // Zero, because a scene with no build ghost never brings the grid up at all — see
    // `PerfResult.powerUploads`. The check is "not once per frame", so 0 must pass.
    powerUploads: 0,
    simMsPerFrame: 0.7,
    // Explicitly null, not omitted: T0 settles no roster, and `PerfResult.background` says so out
    // loud for the same reason `Baseline.p95` does (P4-T10).
    background: null,
    ...over,
  };
}

const baseline: Baseline[string] = {
  p95: 2.77,
  maxDrawCalls: 15,
  recorded: "2026-08-14",
  reason: "Phase 1 MVP baseline",
};

describe("the perf gate's judgement", () => {
  it("passes a run inside both the budget and the baseline band", () => {
    expect(judge(result(), baseline)).toEqual({ ok: true, problems: [] });
  });

  it("fails an over-budget run even with no baseline to compare against", () => {
    // The budget is absolute (PRD §6.2). A first run on a new scene has no baseline, and that must
    // not make it unjudgeable.
    const verdict = judge(result({ p95: 40 }), undefined);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/exceeds the 33 ms budget/);
  });

  it("tolerates noise up to the slack but not beyond it", () => {
    // The band is `max(baseline × 1.1, baseline + slack)`; at these small numbers the slack is what
    // binds. This pins the intent — "something got materially slower", not "the runner was busy".
    const justInside = judge(result({ p95: baseline.p95! + REGRESSION_SLACK_MS - 0.01 }), baseline);
    expect(justInside.ok, "a run inside the slack is noise, not a regression").toBe(true);

    const justOutside = judge(result({ p95: baseline.p95! + REGRESSION_SLACK_MS + 0.5 }), baseline);
    expect(justOutside.ok).toBe(false);
  });

  it("still gates draw calls when no p95 has been recorded", () => {
    // A scene can be added before anyone has run it on a machine worth trusting. `p95: null` says
    // so explicitly instead of leaving the field absent, which used to make the ceiling NaN and
    // silently delete the check. The structural half — batch count, identical on every machine —
    // must keep working regardless.
    const unrecorded = { p95: null, maxDrawCalls: 40, recorded: "2026-08-15", reason: "new scene" };
    const slow = judge(result({ p95: 30, maxDrawCalls: 40 }), unrecorded);
    expect(slow.ok, "a slow but in-budget run must not fail on an unrecorded p95").toBe(true);

    const extra = judge(result({ p95: 1, maxDrawCalls: 41 }), unrecorded);
    expect(extra.ok, "the draw-call check must survive a null p95").toBe(false);
    expect(extra.problems.join(" ")).toMatch(/instancing regressed/);

    // And the PRD's own budget still applies, because that number is not machine-dependent.
    const overBudget = judge(result({ p95: 40, maxDrawCalls: 40 }), unrecorded);
    expect(overBudget.ok).toBe(false);
    expect(overBudget.problems.join(" ")).toMatch(/exceeds the 33 ms budget/);
  });

  it("fails a power field that re-uploads every frame, and passes one that is version-gated", () => {
    // The grid is a whole `cols × rows` byte field. `setPower` re-uploads only when `version` moves
    // (ADR-0012 §2), and until P6-T07 gave a perf scene a build ghost nothing had ever called it in
    // a gated run — so the one of the three version-gated uploads with no test was also the one with
    // no coverage. Judged against the FRAME count rather than a constant: the field legitimately
    // moves whenever a power source is built or destroyed, and no fixed number separates a busy
    // base from a broken gate.
    expect(judge(result({ powerUploads: 12 }), baseline).ok, "a dozen changes in 300 frames is a base being built")
      .toBe(true);
    const perFrame = judge(result({ powerUploads: 300 }), baseline);
    expect(perFrame.ok).toBe(false);
    expect(perFrame.problems.join(" ")).toMatch(/version gate is not holding/);
  });

  it("has no tolerance at all for a draw call appearing", () => {
    // Frame time is noisy; batching is not. One extra call is a batch key that split.
    const verdict = judge(result({ maxDrawCalls: 16 }), baseline);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/instancing regressed/);
  });

  it("tells a slow run to re-measure before it tells it to re-record the baseline", () => {
    // The message is the product here, so it is asserted like one.
    //
    // A perf baseline is a number from one machine on one day. Any host slow or loaded enough will
    // fail this check with no code change at all — it happened on this project's own container,
    // which measured 39% over a baseline it had recorded itself hours earlier while CI stayed
    // green. The old message's only advice was "if this is deliberate, re-record the baseline",
    // and a contributor who follows it writes their loaded machine's number into the repo. The
    // gate then passes forever and detects nothing, which is worse than it failing loudly.
    //
    // So the message must offer the diagnostic step first. Substrings, because pinning whole
    // sentences makes a test that fails on rewording rather than on meaning.
    const verdict = judge(result({ p95: 9 }), baseline);
    expect(verdict.ok).toBe(false);

    const message = verdict.problems.join(" ");
    expect(message, "must still name the regression it found").toMatch(/regressed/);
    expect(
      message,
      "must send the reader to check an unmodified checkout before touching the baseline",
    ).toMatch(/unmodified checkout/i);
    expect(
      message,
      "re-recording must read as the last resort, after the measurement is confirmed",
    ).toMatch(/only.*re-record|re-record.*only/is);
  });
});
