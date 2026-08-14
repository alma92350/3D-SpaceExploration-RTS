// P1-T23 / PRD S2 — the perf gate, on the hardware the budget is about.
//
// Headless Chromium here runs with `--use-gl=swiftshader`, forced rather than assumed: a gate that
// happens to find a GPU on some runners is not a CPU-only gate. That software rasteriser IS
// persona P2's machine, so **T0's budget is gated here and this is the honest place to gate it**.
//
// **T2's budget is not gated here, and that is deliberate.** PRD §6.2 defines T2 as "integrated GPU
// ≥ 2019" at 1600×900. CI has no GPU at all, so measuring the T2 scene under SwiftShader measures
// the wrong machine — it would fail at ~44 ms and tell us nothing about the hardware S3 is written
// about. What the T2 run DOES prove here is everything that is hardware-independent: the instancing
// contract, the terrain-upload rule, and the simulation's share of the frame. Its frame time is
// printed for the record, not asserted.
//
// So S3 (60 fps at 1600×900, 400 units, integrated GPU) is **not covered by CI** and has to be
// measured on real hardware before the Phase 1 gate can be called green. That gap is recorded in
// docs/planning/TASKS.md rather than papered over with a green tick here.
//
// The CPU-side gate (`npm run perf`) is the companion to this one: it covers the batching path
// against a committed baseline, in seconds, on any machine. Neither substitutes for the other.

import { expect, test } from "@playwright/test";
import type { PerfResult } from "../perf/harness.js";

interface HarnessPerf {
  perf(scene: string, seconds: number): { result: PerfResult; problems: string[] };
}

// A 20-second run rather than the PRD's 60: a scripted scene at fixed entity counts converges on
// its p95 long before 60 s, and three minutes of CI per PR is how a required check turns into a
// check people learn to ignore (ADR-0006's own warning). Lengthen it if the numbers look noisy.
const RUN_SECONDS = 20;

async function measure(page: import("@playwright/test").Page, scene: string) {
  await page.goto("/harness.html");
  await page.waitForSelector("body[data-harness-ready='1']", { state: "attached", timeout: 60_000 });
  const measured = await page.evaluate(
    ([name, seconds]) => (window as unknown as { __harness: HarnessPerf }).__harness.perf(name as string, seconds as number),
    [scene, RUN_SECONDS] as const,
  );
  // Print whatever happens: a green gate that says nothing teaches nobody what the headroom is,
  // and headroom is what decides whether the next effect can ship.
  const r = measured.result;
  console.log(
    `\n${scene}: p50 ${r.p50} ms · p95 ${r.p95} ms (budget ${r.budgetMs} ms) · ${r.maxDrawCalls} draw calls · `
    + `${r.maxInstances} instances · ${r.maxTriangles} triangles · sim ${r.simMsPerFrame} ms/frame`,
  );
  return measured;
}

test.describe("CPU-only perf gate", () => {
  test.slow();

  test("T0 holds its 33 ms budget under software rendering (S2)", async ({ page }) => {
    const { result, problems } = await measure(page, "T0");

    expect(problems, `T0 missed its budget:\n${problems.map((p) => `  • ${p}`).join("\n")}`).toEqual([]);

    // ADR-0006 allots the simulation at most 6 ms of a T0 frame. Blowing that is a different
    // problem from a slow renderer and deserves its own named failure.
    expect(result.simMsPerFrame, "the simulation is over its 6 ms share of a T0 frame (ADR-0006)")
      .toBeLessThanOrEqual(6);

    // The instancing contract, restated where a human will read it: 200 units of four types across
    // two owners plus terrain, nodes and overlays is a couple of dozen calls, not 200.
    expect(result.maxDrawCalls, "one draw call per (mesh, owner, LOD) — instancing regressed")
      .toBeLessThanOrEqual(40);
  });

  test("T2 holds the hardware-independent contracts (frame time recorded, not gated)", async ({ page }) => {
    const { result } = await measure(page, "T2");

    // 400 units and 200 buildings across four mesh types and two owners. If this creeps, a batch
    // key split somewhere — and that IS a regression on every tier, GPU or not.
    expect(result.maxDrawCalls, "one draw call per (mesh, owner, LOD) — instancing regressed")
      .toBeLessThanOrEqual(40);
    expect(result.terrainUploads, "the terrain never changes mid-match").toBe(1);

    // Double T0's entity count, so double its sim allowance. This is CPU work and is measured
    // honestly here even though the frame time is not.
    expect(result.simMsPerFrame, "the simulation is over its share of a T2 frame").toBeLessThanOrEqual(12);

    if (result.p95 > result.budgetMs) {
      console.log(
        `  note: T2 p95 ${result.p95} ms is over its ${result.budgetMs} ms budget, as expected on a `
        + `machine with no GPU. S3 needs a 2019-or-later integrated GPU and is not covered by CI.`,
      );
    }
  });
});
