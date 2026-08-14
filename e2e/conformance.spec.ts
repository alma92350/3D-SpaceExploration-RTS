// P1-T08 — the same conformance suite, green against every renderer implementation.
//
// The suite itself lives in `src/view/renderer/conformance.ts` and also runs in Node (see
// `test/view/conformance.test.ts`). It runs HERE too because the WebGL implementation needs a real
// GL context, and "the fake passes" is worth very little on its own — the whole reason ADR-0005
// puts a port in the middle is so the three implementations stay interchangeable, and only running
// one suite against all three proves that.

import { expect, test } from "@playwright/test";
import type { ConformanceCase } from "../src/view/renderer/conformance.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness.html");
  await page.waitForSelector("body[data-harness-ready='1']", { state: "attached", timeout: 30_000 });
});

for (const implementation of ["recording", "canvas2d", "webgl2"]) {
  test(`${implementation} passes the renderer conformance suite`, async ({ page }) => {
    const cases = await page.evaluate(
      (name) => (window as unknown as { __harness: { conformance(n: string): ConformanceCase[] } }).__harness.conformance(name),
      implementation,
    );

    expect(cases.length, "the suite ran no cases").toBeGreaterThan(8);
    const failures = cases.filter((c) => !c.ok);
    expect(
      failures,
      `${implementation} failed conformance:\n${failures.map((f) => `  • ${f.name}: ${f.detail}`).join("\n")}`,
    ).toEqual([]);
  });
}

test("every implementation runs the same set of cases", async ({ page }) => {
  // If one implementation quietly ran a shorter suite, "all green" would mean nothing.
  const names = await page.evaluate(() => {
    const h = (window as unknown as { __harness: { implementations(): string[]; conformance(n: string): ConformanceCase[] } }).__harness;
    return h.implementations().map((impl) => ({ impl, cases: h.conformance(impl).map((c) => c.name) }));
  });
  const reference = names[0]!.cases;
  for (const entry of names) expect(entry.cases, `${entry.impl} ran a different suite`).toEqual(reference);
});
