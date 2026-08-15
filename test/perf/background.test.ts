// P4-T10 — the premises under the background-cost measurement, pinned.
//
// PRD §5's third Phase 4 exit criterion is a MEASUREMENT, not a build: `WorldBridge.step` has
// called `stepGalaxy` rather than `tick` since Phase 1, deliberately, so the background simulation
// already runs. What this row adds is a number for it — and a number is only worth having if
// something fails when it stops being true.
//
// That is not a hypothetical worry here. `perf/scene.ts` carries a running list of times this
// harness silently was not measuring what a phase had shipped: an owner assignment that counted
// every unit mesh for one side only; a second extractor that ran after `state.events` had been
// drained, so no death ever reached a perf run; a Helium Bomb that was on the field but unarmed, so
// the overlay never drew. Every one of them was a green gate that proved nothing, and every one was
// found late. The background measurement has a fourth version of the same hole waiting for it: ten
// worlds that are in the galaxy but empty, or populated but never stepped, cost nothing — and a
// gate reporting "10 settled worlds, within budget" against them reads exactly like a pass.
//
// So this file asserts the PREMISES, not the timings. `PerfScene` throws on the two that can be
// checked mid-run; these are the same claims stated where CI will notice if someone disarms them,
// plus the ones only the finished report can answer. One assertion is a timing and is marked.

import { describe, expect, it } from "vitest";
import { SCENES, type SceneSpec } from "../../perf/scene.js";
import { runScene, type PerfResult } from "../../perf/harness.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { ODYSSEY_WORLDS } from "../../src/engine/index.js";

// Shorter than the gate's ten seconds — this is a test of the measurement's shape, not a
// re-measurement. Four seconds still leaves ~72 galaxy ticks after the warm-up, which is ~18 per
// round-robin phase: comfortably past `MIN_GROUP_SAMPLES`, so the marginal cost is real rather than
// a median of three numbers.
const SECONDS = 4;

function run(spec: SceneSpec, name = "P4"): PerfResult {
  const renderer = new RecordingRenderer();
  renderer.keepFrames = 1;
  return runScene(name, spec, renderer, { seconds: SECONDS, targetFps: 60, now: () => performance.now() });
}

describe("the settled background galaxy (P4-T10)", () => {
  const settled = run(SCENES.P4!);
  const background = settled.background;

  it("settles the whole roster, not the handful `createGalaxy` brings up on its own", () => {
    // The row says "the FULL roster settled". `createGalaxy` brings up `BACKGROUND_WORLDS` (3)
    // neighbours by itself, so a scene that measured only those would be measuring a third of the
    // criterion while its name said otherwise.
    expect(background).not.toBeNull();
    expect(background!.worlds).toBe(ODYSSEY_WORLDS.length - 1);
  });

  it("gives every settled world an economy rather than upstream's empty opening", () => {
    // THE premise. `addPlanet(..., { unsettled: true })` yields a world holding one colony ship and
    // zero buildings; ten of those tick in ~nothing, and the measured cost of ten empty worlds is
    // indistinguishable from a bug that forgot to settle them at all. Measured directly: with the
    // populate call removed the whole background cost falls to 0.00 ms/frame and the gate still
    // says "within budget".
    //
    // The bound is per-world and generous, because the point is "an economy, not a colony ship" —
    // pinning the exact entity count would just be re-asserting the spec.
    expect(background!.entitiesAtStart / background!.worlds).toBeGreaterThan(100);
  });

  it("still has that economy at the end of the run", () => {
    // The two sides on a background world fight, so the roster erodes as the run goes on and the
    // tail of the run is a cheaper scene than its head. `maxDrawCalls` had the identical hole and
    // got the identical treatment (see `armedBombs` in perf/scene.ts): a scene that erased itself
    // halfway would still report the peak it reached first, and come out green.
    expect(background!.entitiesAtEnd).toBeGreaterThan(background!.entitiesAtStart * 0.4);
  });

  it("proves the round-robin exists, which is why a per-frame average would be a lie", () => {
    // `stepGalaxy` spreads the background roster across `BG_STEP` galaxy ticks by fixed roster
    // index, so frame N and frame N+1 do different amounts of background work. That is the whole
    // reason this report is a distribution and not a mean. The period is MEASURED, off the gaps
    // between the ticks on which each world actually advanced — a harness that imported `BG_STEP`
    // would keep reporting a tidy four-phase cycle after upstream changed it.
    expect(background!.period).toBeGreaterThan(1);

    const counts = new Set(background!.phases.map((p) => p.worlds));
    expect(counts.size, "phases that all step the same number of worlds are not a round-robin")
      .toBeGreaterThan(1);
    // Every phase steps at least one world, and none steps them all: that is the ~ceil(N/BG_STEP)
    // shape `stepGalaxy`'s own header promises.
    for (const phase of background!.phases) {
      expect(phase.worlds).toBeGreaterThan(0);
      expect(phase.worlds).toBeLessThan(background!.worlds);
    }
    expect(background!.maxWorldsPerStep).toBe(Math.max(...background!.phases.map((p) => p.worlds)));
  });

  it("amortises the per-world cost over frames by arithmetic anyone can check", () => {
    // `perWorldFrameMs` is the number a later phase will plan capacity against, so its derivation is
    // pinned rather than trusted: one world steps once every `period` galaxy ticks, and a frame runs
    // `PLAY_HZ / targetFps` of them.
    const ticksPerFrame = 20 / 60;
    expect(background!.perWorldStepMs).toBeGreaterThan(0);
    expect(background!.perWorldFrameMs).toBeCloseTo(
      background!.perWorldStepMs! * ticksPerFrame / background!.period, 1,
    );
    expect(background!.allWorldsFrameMs).toBeCloseTo(
      background!.perWorldFrameMs! * background!.worlds, 1,
    );
    // The lump the round-robin actually delivers, which the amortised figure hides. This is the
    // number that has to fit under the budget alongside the render, and it is `maxWorldsPerStep`
    // times bigger than the per-world one — the exact gap a mean would have closed by pretending.
    expect(background!.peakFrameMs).toBeCloseTo(
      background!.perWorldStepMs! * background!.maxWorldsPerStep, 1,
    );
    expect(background!.peakFrameMs).toBeGreaterThan(background!.allWorldsFrameMs!);
  });

  it("holds the T0 budget while the active world renders", () => {
    // The criterion itself, and it is a COMBINED one — `runScene` interleaves the galaxy step and
    // the render in the same measured frame, so this p95 is the whole frame, not the sim alone.
    expect(settled.p95).toBeLessThan(settled.budgetMs);
    // …and the render is genuinely still happening: the same scene minus the settled roster is T0,
    // and T0's batch count is a structural number identical on every machine.
    expect(settled.maxDrawCalls).toBe(22);
  });

  it("costs materially more sim time than the same scene with the roster unsettled", () => {
    // The only machine-DEPENDENT assertion in this file, and it is a ratio rather than a threshold
    // for that reason: a loaded runner slows both halves together, so the ratio survives what an
    // absolute millisecond count would not.
    //
    // It is here because it is the one claim nothing structural can make. Everything above would
    // still pass if the ten worlds were settled, populated, stepped — and free. The measured ratio
    // is around 4x; 1.5 is the loosest bound that still means "the background is being paid for".
    const control = run({ ...SCENES.P4!, settledRoster: false }, "P4-control");
    expect(control.background, "the control settles nothing, and must say so with null").toBeNull();
    expect(settled.simMsPerFrame).toBeGreaterThan(control.simMsPerFrame * 1.5);
  });
});
