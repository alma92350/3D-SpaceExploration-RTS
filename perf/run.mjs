#!/usr/bin/env node
// `npm run perf` — the CPU-side perf gate (ADR-0006 §4, P0-T06, P1-T23).
//
// Runs the scripted scene against the recording renderer and checks the result against
// `perf/baseline.json`. This measures the half of the frame that is ours: snapshot extraction,
// interpolation, culling, LOD selection and batching. It cannot see fill rate, so it is NOT the
// whole gate — the browser half lives in `e2e/perf.spec.ts`, under a software-rendering Chromium,
// which is the actual T0 target hardware. Both run in CI.
//
// Loading TypeScript through Vite's own SSR pipeline rather than a separate loader keeps ADR-0007's
// "one transform pipeline" promise: the perf run compiles the code exactly the way the build and
// the tests do, so it cannot accidentally measure a differently-compiled program.
//
//   npm run perf                 -- measure and gate
//   npm run perf -- --record     -- rewrite the baseline (do this in its own commit, with a reason)
//   npm run perf -- --seconds=20 -- longer run, for a less noisy number locally

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "perf", "baseline.json");

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));

// The gate's run length is FIXED, not a knob. The camera path is a function of frame number, so a
// longer run visits more of it and legitimately reaches a higher draw-call peak — comparing a
// 20-second run against a 10-second baseline would report that as an instancing regression. A
// `--seconds` override is still useful locally for a less noisy number, and it switches the gate
// off rather than comparing incomparable runs.
const GATE_SECONDS = 10;
const targetFps = 60;
const seconds = Number(args.get("seconds") ?? GATE_SECONDS);
const record = args.get("record") === true;
const comparable = seconds === GATE_SECONDS;

if (record && !comparable) {
  console.error(`perf — refusing to record a baseline from a ${seconds}s run; the gate runs ${GATE_SECONDS}s`);
  process.exit(1);
}

const server = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "warn" });
try {
  const { SCENES } = await server.ssrLoadModule("/perf/scene.ts");
  const { runScene, judge } = await server.ssrLoadModule("/perf/harness.ts");
  const { RecordingRenderer } = await server.ssrLoadModule("/src/view/renderer/recording.ts");

  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
  const results = [];
  const problems = [];

  for (const [name, spec] of Object.entries(SCENES)) {
    const renderer = new RecordingRenderer();
    // The fake retains frames for inspection; a 600-frame run would otherwise hold 600 copies of
    // every batch and measure the garbage collector instead of the renderer.
    renderer.keepFrames = 1;
    const result = runScene(name, spec, renderer, { seconds, targetFps, now: () => performance.now() });
    results.push(result);

    print(result);
    if (!record) {
      // Budgets always apply — they are absolute. Only the baseline COMPARISON needs a comparable
      // run length, so `judge` gets the baseline only when the run is the gate's own shape.
      const verdict = judge(result, comparable ? baseline[name] : undefined);
      problems.push(...verdict.problems);
    }
  }

  if (record) {
    const updated = Object.fromEntries(results.map((r) => [r.scene, {
      p95: r.p95,
      maxDrawCalls: r.maxDrawCalls,
      recorded: new Date().toISOString().slice(0, 10),
      reason: String(args.get("reason") ?? "baseline re-recorded without a stated reason"),
    }]));
    writeFileSync(BASELINE_PATH, JSON.stringify(updated, null, 2) + "\n");
    console.log(`\nperf — baseline written to perf/baseline.json`);
    process.exit(0);
  }

  if (!comparable && !record) {
    console.log(`\nperf — ${seconds}s run: budgets checked, baseline comparison skipped (gate runs ${GATE_SECONDS}s)`);
  }

  if (problems.length) {
    console.error("\nperf — FAILED:");
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log("\nperf — within budget");
} finally {
  await server.close();
}

function print(r) {
  console.log([
    ``,
    `scene ${r.scene} (tier ${r.tier}, ${r.frames} frames)`,
    `  frame p50      ${r.p50.toFixed(2)} ms`,
    `  frame p95      ${r.p95.toFixed(2)} ms   budget ${r.budgetMs} ms`,
    `  sim per frame  ${r.simMsPerFrame.toFixed(2)} ms`,
    `  draw calls     ${r.maxDrawCalls}`,
    `  instances      ${r.maxInstances}`,
    `  triangles      ${r.maxTriangles}`,
    `  terrain uploads ${r.terrainUploads}   fog uploads ${r.fogUploads}   power uploads ${r.powerUploads}`,
  ].join("\n"));
  if (r.background) printBackground(r.background, r.budgetMs);
}

// P4-T10. Printed whether or not the scene is anywhere near its budget: the row asks for a NUMBER
// the next phase can plan against ("N settled worlds cost X ms/frame"), and a gate that only speaks
// up when it fails never produces one.
function printBackground(b, budgetMs) {
  const ms = (v) => (v === null ? "n/a" : `${v.toFixed(2)} ms`);
  console.log([
    `  background galaxy (P4-T10)`,
    `    settled worlds ${b.worlds}   entities ${b.entitiesAtStart} -> ${b.entitiesAtEnd}`,
    `    round-robin    period ${b.period} galaxy ticks (measured), ${b.galaxyTicks} ticks sampled`,
    // The distribution, not the mean. `stepGalaxy` spreads the roster round-robin, so this is the
    // line that shows frame N and frame N+1 doing different amounts of work — the thing an average
    // would have flattened into a load no frame ever carries.
    ...b.phases.map((p) =>
      `      phase ${p.phase}: ${p.worlds} world(s)  p50 ${p.p50.toFixed(2)} ms  p95 ${p.p95.toFixed(2)} ms  (${p.ticks} ticks)`),
    `    per world      ${ms(b.perWorldStepMs)} / step, ${ms(b.perWorldFrameMs)} / frame amortised`,
    `    all ${String(b.worlds).padStart(2)} worlds  ${ms(b.allWorldsFrameMs)} / frame amortised, `
      + `${ms(b.peakFrameMs)} on the frame the busiest phase lands (budget ${budgetMs} ms)`,
  ].join("\n"));
}
