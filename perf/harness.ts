// The perf harness proper: run the scripted scene, collect FrameStats, decide pass or fail.
//
// Split from the runner so the SAME measurement code runs in two places (ADR-0006 §4):
//   • in a headless Chromium under software rendering, against the real WebGL renderer — that is
//     the T0 target hardware, and the only honest measurement of it;
//   • in Node against the recording renderer, which measures the CPU side of the frame (snapshot,
//     interpolation, culling, batching) with no GPU involved at all.
//
// The second is not a substitute for the first — it cannot see fill rate — but it is what makes a
// regression in the batching path fail fast, in seconds, on any machine.

import { PerfScene, type SceneSpec } from "./scene.js";
import { type FrameStats, type Renderer } from "../src/view/renderer/port.js";
import { TIERS } from "../src/view/renderer/tiers.js";
import { percentile } from "../src/view/renderer/tiers.js";
import { PLAY_HZ } from "../src/app/loop.js";

export interface PerfResult {
  scene: string;
  tier: string;
  frames: number;
  p50: number;
  p95: number;
  budgetMs: number;
  maxDrawCalls: number;
  maxInstances: number;
  maxTriangles: number;
  terrainUploads: number;
  fogUploads: number;
  /** Sim time per RENDERED frame, which is the number ADR-0006 caps at 6 ms for T0. */
  simMsPerFrame: number;
}

export interface RunOptions {
  readonly seconds: number;
  /** Frames per second to simulate; the scene ticks the sim at 20 Hz regardless. */
  readonly targetFps: number;
  readonly now: () => number;
}

export function runScene(
  name: string,
  spec: SceneSpec,
  renderer: Renderer,
  opts: RunOptions,
): PerfResult {
  const scene = new PerfScene(spec);
  scene.setup(renderer);

  const totalFrames = Math.max(1, Math.round(opts.seconds * opts.targetFps));
  const ticksPerFrame = PLAY_HZ / opts.targetFps;

  // Warm-up: the first frames pay for buffer growth, shader compilation and JIT. Measuring them
  // would make the p95 a report on startup rather than on steady state.
  const warmup = Math.min(60, Math.floor(totalFrames / 10));
  let tickDebt = 0;
  for (let f = 0; f < warmup; f++) {
    tickDebt += ticksPerFrame;
    while (tickDebt >= 1) { scene.tick(); tickDebt -= 1; }
    scene.render(renderer, 0);
    renderer.flush?.();
  }

  const frameTimes: number[] = [];
  let simTotal = 0;
  let maxDrawCalls = 0;
  let maxInstances = 0;
  let maxTriangles = 0;
  let last: FrameStats | null = null;

  for (let f = 0; f < totalFrames; f++) {
    const frameStart = opts.now();
    tickDebt += ticksPerFrame;
    const simStart = opts.now();
    while (tickDebt >= 1) { scene.tick(); tickDebt -= 1; }
    simTotal += opts.now() - simStart;

    const stats = scene.render(renderer, tickDebt);
    // Wait for the frame to actually exist before stopping the clock. Without this the WebGL path
    // reports submission time and the budget means nothing — see `Renderer.flush`.
    renderer.flush?.();
    frameTimes.push(opts.now() - frameStart);

    maxDrawCalls = Math.max(maxDrawCalls, stats.drawCalls);
    maxInstances = Math.max(maxInstances, stats.instances);
    maxTriangles = Math.max(maxTriangles, stats.triangles);
    last = stats;
  }

  return {
    scene: name,
    tier: spec.tier,
    frames: totalFrames,
    p50: round(percentile(frameTimes, 0.5)),
    p95: round(percentile(frameTimes, 0.95)),
    budgetMs: TIERS[spec.tier].frameBudgetMs,
    maxDrawCalls,
    maxInstances,
    maxTriangles,
    terrainUploads: last?.terrainUploads ?? 0,
    fogUploads: last?.fogUploads ?? 0,
    simMsPerFrame: round(simTotal / totalFrames),
  };
}

/** ADR-0006's regression band: 10% against the committed baseline. */
export const REGRESSION_BAND = 1.1;

/**
 * Absolute slack added to the regression ceiling, in milliseconds.
 *
 * ADR-0006 warns that perf numbers on shared CI runners are noisy, and a percentage band alone is
 * exactly the wrong shape of tolerance for the CPU-side gate: this measurement lands near 3 ms, so
 * 10% is 0.3 ms — comfortably inside the run-to-run scatter of a container that shares a host with
 * whatever else is building right now. A band that fires on noise gets muted, and a muted gate is
 * the four-days-of-red-builds failure ADR-0006 was written about. The slack makes the check mean
 * "something got materially slower" rather than "the runner was busy".
 */
export const REGRESSION_SLACK_MS = 1.5;

export interface Baseline {
  [scene: string]: { p95: number; maxDrawCalls: number; recorded: string; reason: string };
}

export interface Verdict {
  ok: boolean;
  problems: string[];
}

export function judge(result: PerfResult, baseline: Baseline[string] | undefined): Verdict {
  const problems: string[] = [];

  if (result.p95 > result.budgetMs) {
    problems.push(
      `${result.scene}: p95 ${result.p95} ms exceeds the ${result.budgetMs} ms budget `
      + `(PRD §6.2, tier ${result.tier})`,
    );
  }

  if (baseline) {
    const ceiling = round(Math.max(baseline.p95 * REGRESSION_BAND, baseline.p95 + REGRESSION_SLACK_MS));
    if (result.p95 > ceiling) {
      // The advice matters as much as the number. This check compares absolute milliseconds
      // against a baseline recorded on one machine on one day, so a loaded or simply slower host
      // fails it with no code change at all — and a reader told only to "re-record the baseline"
      // will write their slow machine's number into the repo, after which the gate passes forever
      // and detects nothing. Diagnostic step first, re-recording last. Pinned by
      // test/perf/judge.test.ts.
      problems.push(
        `${result.scene}: p95 ${result.p95} ms regressed more than 10% against the baseline `
        + `${baseline.p95} ms (ceiling ${ceiling} ms). Re-measure on an unmodified checkout before `
        + `changing anything: this compares absolute milliseconds, so a busy or slower host fails it `
        + `without any code having changed. You have regressed something only if the clean checkout `
        + `is fast and yours is not — and only a deliberate, understood slowdown justifies `
        + `re-recording the baseline, in its own commit, with a reason.`,
      );
    }
    // Draw calls are the instancing contract in numeric form. They should not creep at all, so this
    // has no band: one extra call per frame means a batch key split that nobody intended.
    if (result.maxDrawCalls > baseline.maxDrawCalls) {
      problems.push(
        `${result.scene}: ${result.maxDrawCalls} draw calls, baseline ${baseline.maxDrawCalls} — `
        + `instancing regressed (ADR-0006)`,
      );
    }
  }

  // The terrain is static for the whole match. More than one upload means the "rebuilt only on
  // change" contract broke, which costs far more than the frame time it shows up as.
  if (result.terrainUploads > 1) {
    problems.push(`${result.scene}: terrain uploaded ${result.terrainUploads} times; it never changes`);
  }

  return { ok: problems.length === 0, problems };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
