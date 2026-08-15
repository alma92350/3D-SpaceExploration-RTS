// S5 — cold load to interactive ≤ 5 s on a 10 Mbit connection, MEASURED.
//
// This criterion was previously called a pass by inference: the payload is 192 kB gzipped, 192 kB
// at 10 Mbit is 0.15 s, therefore S5 passes. That reasoning ignores everything between the last
// byte and a playable frame — parse, compile, WebGL context creation, mesh generation, the terrain
// build, the first draw — which on a machine with no GPU is where the time actually goes. §4.2
// says S5 is measured by `performance` marks, so it is measured here.
//
// **The second test is the one that matters.** A throttling harness that silently fails open is
// worth less than no harness: it reports a comfortable number forever while measuring an
// unthrottled localhost load. So the emulation is proven to bite before its number is trusted.
//
// **This file is Chromium-only, and the reason is a hard boundary rather than a preference**
// (P7-T01). Both measurements are built on `Network.emulateNetworkConditions`, which arrives
// through `context.newCDPSession` — the Chrome DevTools Protocol. Playwright exposes CDP on
// Chromium and on nothing else; `newCDPSession` throws on Firefox and WebKit. There is no
// equivalent, and the obvious substitute is worse than nothing: throttling with `page.route` and a
// timer would measure a delay this test file wrote itself, so the "the throttling actually bites"
// check above would be asserting that our own `setTimeout` works. That is exactly the harness that
// reports a comfortable number forever.
//
// So S5's 5-second budget is measured on one engine, that is stated here and in `RELEASE.md`'s N-04
// row rather than implied by an absent file, and the skip is a `test.skip` with its reason attached
// so it is COUNTED in the report on Firefox and WebKit instead of quietly not existing. What those
// two engines do still prove about cold load is that the app reaches a playable frame at all, which
// is `e2e/smoke.spec.ts` and `e2e/capability.spec.ts`, and both run everywhere.

import { expect, test } from "@playwright/test";

const CDP_ONLY =
  "cold-load throttling needs CDP's Network.emulateNetworkConditions, which Playwright exposes on "
  + "Chromium only. S5's budget is therefore measured on chromium-software; boot on this engine is "
  + "covered by smoke.spec.ts and capability.spec.ts, which do not skip.";

test.skip(({ browserName }) => browserName !== "chromium", CDP_ONLY);

/** S5's connection. 10 Mbit ⇒ 1.25 MB/s, plus an RTT a real link would have. */
const MBIT = 10;
const BYTES_PER_SEC = (MBIT * 1_000_000) / 8;
const RTT_MS = 40;

/** S5's budget. */
const BUDGET_MS = 5_000;

interface LoadResult {
  /** Navigation start → the first drawn frame, from the page's own clock. */
  interactiveMs: number;
  /** First contentful paint, for context. Not asserted — the canvas is the content that matters. */
  fcpMs: number | null;
  /** Bytes actually transferred, so the throughput floor can be computed rather than assumed. */
  transferredBytes: number;
}

async function measureLoad(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  throttle: boolean,
): Promise<LoadResult> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // "Cold" is load-bearing: with a warm HTTP cache this measures parse time and nothing else.
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: throttle ? RTT_MS : 0,
    downloadThroughput: throttle ? BYTES_PER_SEC : -1,
    uploadThroughput: throttle ? BYTES_PER_SEC : -1,
  });

  await page.goto("/");
  await page.waitForFunction(
    () => performance.getEntriesByName("odyssey:interactive").length > 0,
    null,
    { timeout: 60_000 },
  );

  return await page.evaluate(() => {
    const mark = performance.getEntriesByName("odyssey:interactive")[0]!;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const transferred = performance
      .getEntriesByType("resource")
      .reduce((sum, e) => sum + ((e as PerformanceResourceTiming).transferSize || 0), 0);
    return { interactiveMs: mark.startTime, fcpMs: fcp ? fcp.startTime : null, transferredBytes: transferred };
  });
}

test("cold load reaches a playable frame within S5's budget on a 10 Mbit link", async ({ page, context }) => {
  const result = await measureLoad(page, context, true);

  console.log(
    `S5: interactive at ${result.interactiveMs.toFixed(0)} ms ` +
      `(FCP ${result.fcpMs === null ? "n/a" : result.fcpMs.toFixed(0) + " ms"}, ` +
      `${(result.transferredBytes / 1024).toFixed(0)} kB transferred) — budget ${BUDGET_MS} ms`,
  );

  // The transfer alone cannot be faster than physics allows; if the measurement came in under that
  // floor, the throttling was not applied and the number is meaningless.
  const floorMs = (result.transferredBytes / BYTES_PER_SEC) * 1000;
  expect(
    result.interactiveMs,
    `interactive at ${result.interactiveMs.toFixed(0)} ms is below the ${floorMs.toFixed(0)} ms ` +
      `it must take to transfer ${result.transferredBytes} bytes at ${MBIT} Mbit — throttling is not applied`,
  ).toBeGreaterThan(floorMs);

  expect(result.interactiveMs, `S5: cold load to interactive must be ≤ ${BUDGET_MS} ms`).toBeLessThan(BUDGET_MS);
});

test("the throttling actually bites, so the budget above is not measuring localhost", async ({ page, context }) => {
  // Belt to the floor check's braces, and the reason this file can be trusted a year from now.
  // Same page, same build, same machine, one variable: the emulated link. If these two numbers are
  // the same, the harness is broken however green it looks.
  const fast = await measureLoad(page, context, false);
  const slow = await measureLoad(page, context, true);

  console.log(
    `throttle check: unthrottled ${fast.interactiveMs.toFixed(0)} ms vs ` +
      `${MBIT} Mbit ${slow.interactiveMs.toFixed(0)} ms`,
  );

  // The payload cannot arrive in less than payload/throughput, and each of the handful of requests
  // pays an RTT on top. Demanding the throttled run be at least that much slower is a claim about
  // the emulation, not about the machine's speed, so it does not get flaky on a loaded runner.
  const expectedDelayMs = (slow.transferredBytes / BYTES_PER_SEC) * 1000;
  expect(
    slow.interactiveMs - fast.interactiveMs,
    `throttling ${MBIT} Mbit should cost at least ~${expectedDelayMs.toFixed(0)} ms against an ` +
      `unthrottled load; it cost ${(slow.interactiveMs - fast.interactiveMs).toFixed(0)} ms`,
  ).toBeGreaterThan(expectedDelayMs * 0.5);
});
