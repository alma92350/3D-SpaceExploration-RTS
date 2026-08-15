// P1-T08 — the same conformance suite, green against every renderer implementation.
//
// The suite itself lives in `src/view/renderer/conformance.ts` and also runs in Node (see
// `test/view/conformance.test.ts`). It runs HERE too because the WebGL implementation needs a real
// GL context, and "the fake passes" is worth very little on its own — the whole reason ADR-0005
// puts a port in the middle is so the three implementations stay interchangeable, and only running
// one suite against all three proves that.
//
// P7-T01 turned "a real GL context" into "a real GL context in THREE engines". That is the point of
// the browser matrix: three implementations × three rasterisers is where a `ShaderMaterial` default,
// an attribute divisor, an extension that Chromium has and Firefox does not, or a texture format
// nobody else accepts stops being an argument and becomes a run.
//
// The `webgl2` case is the one that can be impossible. It is skipped — visibly, with the engine
// named — only when that engine gave no WebGL2 context at all, and `e2e/capability.spec.ts` fails
// if such an engine also failed to prove the Canvas2D path. Neither branch can be quiet.

import { expect, test } from "@playwright/test";
import type { ConformanceCase } from "../src/view/renderer/conformance.js";
import { probeEngine, skipWithoutWebGL2 } from "./capabilities.js";

interface Harness {
  conformance(name: string): ConformanceCase[];
  implementations(): string[];
}

/** Implementations that need nothing from the GPU, so every engine must run them. */
const PORTABLE = ["recording", "canvas2d"];

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await page.waitForSelector("body[data-harness-ready='1']", { state: "attached", timeout: 30_000 });
});

for (const implementation of [...PORTABLE, "webgl2"]) {
  test(`${implementation} passes the renderer conformance suite`, async ({ page }, info) => {
    if (implementation === "webgl2") await skipWithoutWebGL2(page, info.project.name);

    const cases = await page.evaluate(
      (name) => (window as unknown as { __harness: Harness }).__harness.conformance(name),
      implementation,
    );

    expect(cases.length, "the suite ran no cases").toBeGreaterThan(8);
    const failures = cases.filter((c) => !c.ok);
    expect(
      failures,
      `${implementation} failed conformance on ${info.project.name}:\n`
      + failures.map((f) => `  • ${f.name}: ${f.detail}`).join("\n"),
    ).toEqual([]);
  });
}

test("every implementation runs the same set of cases", async ({ page }, info) => {
  // If one implementation quietly ran a shorter suite, "all green" would mean nothing.
  //
  // On an engine without WebGL2 this compares the two portable implementations rather than all
  // three, because constructing `WebGLRenderer` there throws `WebGLUnavailableError` by design. The
  // comparison is still worth making — a divergence between `recording` and `canvas2d` is a
  // divergence — so the test narrows and SAYS it narrowed instead of skipping wholesale.
  const report = await probeEngine(page);
  const wanted = report.hasWebGL2 ? [...PORTABLE, "webgl2"] : PORTABLE;
  if (!report.hasWebGL2) {
    info.annotations.push({
      type: "narrowed-suite",
      description: `${info.project.name} has no WebGL2, so this compared ${wanted.join(" and ")} only.`,
    });
  }

  const names = await page.evaluate((impls) => {
    const h = (window as unknown as { __harness: Harness }).__harness;
    return { available: h.implementations(), rows: impls.map((impl) => ({ impl, cases: h.conformance(impl).map((c) => c.name) })) };
  }, wanted);

  // The harness must still OFFER all three, whatever this engine can construct. An implementation
  // silently dropped from the harness would otherwise make this test pass by comparing fewer things.
  expect(names.available.sort(), "the harness stopped offering an implementation").toEqual(
    [...PORTABLE, "webgl2"].sort(),
  );
  expect(names.rows.length, "nothing was compared").toBeGreaterThan(1);
  const reference = names.rows[0]!.cases;
  for (const entry of names.rows) expect(entry.cases, `${entry.impl} ran a different suite`).toEqual(reference);
});
