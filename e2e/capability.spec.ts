// P7-T01 / N-04 — what this engine can do, proven rather than assumed, once per engine per run.
//
// This is the spec that makes the browser matrix mean something. Every other spec in `e2e/` asks
// "does the app work here?"; this one asks "**did this engine actually do anything, and does the
// project still believe the right things about it?**" — because the way a cross-browser suite fails
// silently is not a red test, it is three green ticks over an engine that fell back to Canvas2D at
// boot and was never asked about it.
//
// It runs on every project, and it has no skips.

import { expect, test } from "@playwright/test";
import playwrightConfig from "../playwright.config.js";
import { ENGINES, enforcePin, expectationFor, formatReport, probeEngine } from "./capabilities.js";

test("the engine reports its capabilities, and proves the renderer path it actually took", async ({ page }, info) => {
  const expectation = expectationFor(info.project.name);

  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(`uncaught: ${err.message}`));

  await page.goto("/");
  // The same bar every other spec uses: not "a canvas exists" but "the loop is advancing".
  await page.waitForFunction(() => (window as any).__odyssey?.bridge?.snapshot?.tick > 5, null, { timeout: 30_000 });

  const report = await probeEngine(page);
  console.log(formatReport(expectation.project, report));
  info.annotations.push({ type: "engine-capabilities", description: formatReport(expectation.project, report) });
  enforcePin(info, expectation, report);

  // The total function. Exactly two renderer paths exist (ADR-0005), the app picks between them at
  // boot, and this engine has to have driven one of them all the way to a drawn frame. Neither
  // branch is allowed to be quiet: the 3D branch must NOT have shown the fallback notice, and the
  // fallback branch must have shown it AND put ink on the canvas.
  const notice = page.locator("#fallback-notice");
  if (report.hasWebGL2) {
    await expect(
      notice,
      "this engine has WebGL2 and the app still fell back to Canvas2D — a silent demotion is the "
      + "exact failure a green cross-browser run hides, so it is a failure here",
    ).toBeHidden();
  } else {
    await expect(
      notice,
      "this engine has no WebGL2, so the player must be told why the view looks plainer",
    ).toBeVisible();
    await expect(notice).toContainText(/WebGL/i);
    const lit = await page.evaluate(() => {
      const canvas = document.getElementById("overlay") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! > 60) n++;
      return n;
    });
    expect(lit, "the Canvas2D fallback is this engine's only path and it rendered nothing").toBeGreaterThan(1000);
  }

  expect(errors, `console errors while probing this engine:\n${errors.join("\n")}`).toEqual([]);
});

test("matchMedia answers the reduced-motion query on this engine (N-05, P6-T04)", async ({ page }) => {
  // P6-T04 guards `matchMedia` because jsdom does not have it, and that guard has never been run
  // against a second real engine. `false` when nothing can answer is the documented contract
  // (src/view/motion.ts); what must not happen is a throw, or a `matches` that is not a boolean.
  await page.goto("/");
  const answer = await page.evaluate(() => {
    if (typeof globalThis.matchMedia !== "function") return { present: false, matches: null as boolean | null };
    return { present: true, matches: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches };
  });
  expect(answer.present, "every engine in the matrix is expected to have matchMedia").toBe(true);
  expect(typeof answer.matches, "matchMedia answered with something that is not a boolean").toBe("boolean");
});

test("every project in playwright.config.ts is declared in e2e/capabilities.ts, and vice versa", () => {
  // A project with no entry runs with nothing expected of it; an entry with no project is coverage
  // this repo claims and does not execute. Both are the same lie in opposite directions, and both
  // are the kind of drift that only shows up when someone reads two files side by side.
  const configured = (playwrightConfig.projects ?? []).map((p) => p.name).sort();
  const declared = ENGINES.map((e) => e.project).sort();
  expect(configured, "playwright.config.ts and e2e/capabilities.ts disagree about the matrix").toEqual(declared);
});
