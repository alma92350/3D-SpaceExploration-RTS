// What each engine in the browser matrix can actually do — and the rule that stops a cross-browser
// run from passing by doing nothing (P7-T01, N-04).
//
// PRD N-04 promises Chrome, Edge, Firefox and Safari, with WebGL2 for the 3D tiers and the Canvas2D
// fallback for everything else. Until P7-T01 that promise was executed on Chromium alone; the other
// two engines were covered by the renderer port's conformance suite and by there being no
// browser-specific code, which is an argument rather than a run.
//
// **The failure this file exists to prevent is the one that looks like success.** Three engines
// green is worthless if one of them quietly fell back to Canvas2D, or quietly skipped every test
// that needs a GL context, and nobody could tell from the report. So two mechanisms, and they are
// deliberately different in kind:
//
//   1. **A total function over the two renderer paths.** `e2e/capability.spec.ts` makes every
//      project prove one of them end to end and NAME which. An engine cannot be green while
//      contributing no evidence: it either drives WebGL2, or it drives Canvas2D and shows the
//      player the notice explaining why. There is no third branch.
//
//   2. **A pin per engine, recorded below.** Once an engine's WebGL2 answer has actually been
//      OBSERVED, it is written down here, and a run where the engine disagrees with its pin fails —
//      in both directions. Losing WebGL2 is a regression; gaining it is a signal that this table is
//      now under-claiming and the coverage should widen.
//
// The pins say `"unverified"` where nobody has run the engine yet, and that is the honest state
// rather than a guess: this row's author executed Chromium and could not execute Firefox or WebKit
// (no browser binaries in the authoring sandbox, `npx playwright install` disallowed there). An
// `"unverified"` engine still runs the full subset and still cannot be silently empty — it simply
// does not yet have a fact to defend. See `pinInstruction()` for the one-line edit that closes it.

import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * Whether this engine is known to give the app a WebGL2 context in CI.
 *
 * `true`/`false` are OBSERVED facts and are enforced. `"unverified"` means no run has reported one
 * yet; the observed value is annotated and logged instead of asserted.
 */
export type Webgl2Pin = boolean | "unverified";

export interface EngineExpectation {
  /** Playwright project name — the thing `--project=` takes and the report prints. */
  readonly project: string;
  /** The Playwright browser to install for it, i.e. `npx playwright install <this>`. */
  readonly install: "chromium" | "firefox" | "webkit";
  readonly webgl2: Webgl2Pin;
  /** Why this project's launch configuration differs from Chromium's, in one sentence. */
  readonly why: string;
}

/**
 * The matrix, as data. `playwright.config.ts` names the same three projects and
 * `.github/workflows/ci.yml` runs one job per row.
 */
export const ENGINES: readonly EngineExpectation[] = [
  {
    project: "chromium-software",
    install: "chromium",
    webgl2: true,
    why: "SwiftShader is forced by flag, so the T0 budget is measured on a real software rasteriser "
       + "rather than on whatever the runner happens to have. Observed: WebGL2 present.",
  },
  {
    project: "firefox-software",
    install: "firefox",
    webgl2: "unverified",
    why: "Firefox blocklists its GPU path on a headless runner and would otherwise report no WebGL "
       + "at all, so `webgl.force-enabled` overrides the blocklist and `layers.acceleration.disabled` "
       + "pins it to the software backend — the same deliberate choice Chromium's `--use-gl=swiftshader` "
       + "makes, spelled in Firefox's vocabulary.",
  },
  {
    project: "webkit",
    install: "webkit",
    webgl2: "unverified",
    // Named `webkit`, NOT `webkit-software`, and the missing suffix is the point: Playwright's Linux
    // WebKit exposes no pref or flag that forces a software rasteriser, so calling it `-software`
    // would be a claim about the rasteriser this project cannot make. What it runs on is whatever
    // the runner provides, and `capability.spec.ts` prints that string every run rather than
    // asserting one.
    why: "Playwright's Linux WebKit takes no launch flags for GL, so it runs on whatever the runner "
       + "gives it and reports what that was.",
  },
];

export function expectationFor(project: string): EngineExpectation {
  const found = ENGINES.find((e) => e.project === project);
  if (!found) {
    throw new Error(
      `project "${project}" is not in e2e/capabilities.ts. A project that runs without an entry `
      + `here is a browser nobody declared, which is exactly the silent coverage this file exists `
      + `to prevent — add it to ENGINES.`,
    );
  }
  return found;
}

/** What an engine actually reported, once. Printed every run; asserted where a pin exists. */
export interface EngineReport {
  readonly hasWebGL2: boolean;
  /** `WEBGL_debug_renderer_info`'s unmasked string, or `RENDERER` where the browser masks it. */
  readonly rendererString: string | null;
  readonly glVersion: string | null;
  readonly maxTextureSize: number | null;
  readonly devicePixelRatio: number;
  /** P6-T04 had to guard this for jsdom; the matrix is where it gets checked against real engines. */
  readonly hasMatchMedia: boolean;
  /** Chromium-only. Its absence changes which tier `detectTier` picks — see test/view/tiers.test.ts. */
  readonly hasDeviceMemory: boolean;
  readonly hardwareConcurrency: number;
}

/**
 * Ask the page what it can do, from a throwaway context.
 *
 * The context is explicitly lost afterwards, exactly as `src/app/renderer-factory.ts` does with its
 * own probe, because WebKit and Firefox both cap live WebGL contexts per page and a probe that
 * holds one hostage can make the very next `getContext` fail — turning the measurement into the
 * cause of the thing it measures.
 */
export async function probeEngine(page: Page): Promise<EngineReport> {
  return await page.evaluate(() => {
    let hasWebGL2 = false;
    let rendererString: string | null = null;
    let glVersion: string | null = null;
    let maxTextureSize: number | null = null;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (gl) {
        hasWebGL2 = true;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) rendererString = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        if (!rendererString) rendererString = String(gl.getParameter(gl.RENDERER));
        glVersion = String(gl.getParameter(gl.VERSION));
        maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    } catch {
      hasWebGL2 = false;
    }
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      hasWebGL2,
      rendererString,
      glVersion,
      maxTextureSize,
      devicePixelRatio: globalThis.devicePixelRatio,
      hasMatchMedia: typeof globalThis.matchMedia === "function",
      hasDeviceMemory: typeof nav.deviceMemory === "number",
      hardwareConcurrency: nav.hardwareConcurrency ?? 0,
    };
  });
}

/** One greppable line per engine per run, so a CI log answers "what did WebKit actually have?". */
export function formatReport(project: string, report: EngineReport): string {
  return [
    `N-04 CAPABILITY ${project}:`,
    `webgl2=${report.hasWebGL2}`,
    `renderer=${report.rendererString ?? "n/a"}`,
    `version=${report.glVersion ?? "n/a"}`,
    `maxTexture=${report.maxTextureSize ?? "n/a"}`,
    `dpr=${report.devicePixelRatio}`,
    `matchMedia=${report.hasMatchMedia}`,
    `deviceMemory=${report.hasDeviceMemory}`,
    `cores=${report.hardwareConcurrency}`,
  ].join(" ");
}

/** The exact edit that turns an observation into an enforced pin. Printed, not guessed at. */
export function pinInstruction(project: string, observed: boolean): string {
  return `N-04 CAPABILITY ${project}: webgl2 is unpinned. This run observed ${observed}. `
    + `Set \`webgl2: ${observed}\` for "${project}" in e2e/capabilities.ts to make a future change red.`;
}

/**
 * Compare an engine against its pin, or record the observation where there is none.
 *
 * Split out from the spec so the same rule applies wherever a capability decision is made, and so
 * the "unverified" branch is one place rather than a habit.
 */
export function enforcePin(info: TestInfo, expectation: EngineExpectation, report: EngineReport): void {
  if (expectation.webgl2 === "unverified") {
    info.annotations.push({
      type: "webgl2-unpinned",
      description: pinInstruction(expectation.project, report.hasWebGL2),
    });
    console.log(pinInstruction(expectation.project, report.hasWebGL2));
    return;
  }
  expect(
    report.hasWebGL2,
    `${expectation.project} is pinned to webgl2=${expectation.webgl2} in e2e/capabilities.ts and `
    + `reported ${report.hasWebGL2}. If the engine genuinely changed, change the pin AND say so in `
    + `the board — a WebGL2 loss silently demotes every player on this engine to the compatibility `
    + `renderer, and a WebGL2 gain means this matrix is testing less than it could.`,
  ).toBe(expectation.webgl2);
}

/**
 * Skip the calling test, visibly and with a named reason, when this engine has no WebGL2.
 *
 * `test.skip(condition, description)` rather than a project-level `testIgnore`, and the difference
 * is the whole point: an ignored file is a test that does not appear in the report, which reads
 * exactly like a pass. A skip appears in the report, carries its reason, and is counted.
 *
 * Returns the probe so a caller that survives the skip does not pay for a second one — a probe
 * costs a real GL context, and on WebKit those are a limited resource.
 */
export async function skipWithoutWebGL2(page: Page, project: string): Promise<EngineReport> {
  const report = await probeEngine(page);
  test.skip(
    !report.hasWebGL2,
    `${project} gave no WebGL2 context (${report.rendererString ?? "no renderer string"}), so the `
    + `3D implementation cannot be exercised on it. The Canvas2D path this engine DOES take is `
    + `proven by e2e/capability.spec.ts, which fails if THAT is silent too.`,
  );
  return report;
}
