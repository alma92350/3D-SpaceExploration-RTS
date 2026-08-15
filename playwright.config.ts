import { defineConfig, devices } from "@playwright/test";

// Three engines, three honest configurations (P7-T01, N-04).
//
// Headless Chromium in CI runs with software rendering by default — and that IS the T0 target
// hardware (ADR-0006 §4). So the browser suite is not just a smoke test: it is the only place the
// CPU-only budget is measured honestly, because it is the only place a real rasteriser is involved.
//
// PRD N-04 promises the last two versions of Chrome, Edge, Firefox and Safari. Until P7-T01 exactly
// one project was declared and `RELEASE.md` said so in those words: *"CI runs Chromium only […]
// that is a real gap and it is the one a release should close first."* This file closes it, and the
// shape of the fix matters more than the count of projects:
//
//   • **Every project runs the same specs.** No project-level `testIgnore`, no per-browser test
//     directory. Where an engine genuinely cannot do something, the individual test calls
//     `test.skip(condition, reason)` so the skip APPEARS IN THE REPORT with its reason. A filtered
//     file is a test that does not exist, which reads exactly like a pass.
//
//   • **Two specs are Chromium-only and each says why in its own header**: `coldload.spec.ts` needs
//     CDP network emulation, which Playwright exposes on Chromium alone, and `perf.spec.ts` gates a
//     budget calibrated against SwiftShader specifically. Both skip visibly rather than silently.
//
//   • **`e2e/capability.spec.ts` has no skips and runs everywhere.** It makes each engine prove one
//     of the two renderer paths end to end and name which, so no engine can be green while
//     contributing nothing. `e2e/capabilities.ts` holds the per-engine pins.
//
// The projects are named for what they actually are. `chromium-software` and `firefox-software`
// force a software rasteriser; `webkit` does not carry the suffix because Playwright's Linux WebKit
// takes no GL flags and a `-software` in its name would be a claim this project cannot make.

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,          // the perf spec needs the machine to itself
  workers: 1,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-software",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          // Chromium is preinstalled in this environment; PLAYWRIGHT_BROWSERS_PATH points at it.
          args: [
            // Force the software rasteriser explicitly rather than hoping the runner has no GPU.
            // A gate that quietly measures a GPU on some machines is not a CPU-only gate.
            "--use-gl=swiftshader",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--disable-gpu-sandbox",
          ],
        },
      },
    },
    {
      name: "firefox-software",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          // Firefox's equivalent of `--use-gl=swiftshader`, in Firefox's vocabulary. Each of these
          // is here for a reason, because a pref set "just in case" is a pref nobody can remove
          // later:
          firefoxUserPrefs: {
            // Firefox BLOCKLISTS its GPU path on a headless runner with no usable driver, and the
            // blocklist does not degrade to software — it turns WebGL off entirely, so the app
            // would take the Canvas2D fallback and every WebGL assertion would skip. That is the
            // exact silent subset this row exists to prevent, so the blocklist is overridden and
            // the software backend is asked for by name.
            "webgl.force-enabled": true,
            "webgl.disabled": false,
            // Software compositing, deliberately, so this project measures the same class of
            // machine `chromium-software` does rather than whatever the runner happens to expose.
            "layers.acceleration.disabled": true,
            "gfx.webrender.software": true,
            // Out-of-process WebGL adds a GPU-process handshake that buys nothing headless and has
            // its own failure modes in a container.
            "webgl.out-of-process": false,
            // Firefox has shipped WebGL2 since 51; naming it stops a future default flip from
            // demoting this project to the fallback path without anyone noticing.
            "webgl.enable-webgl2": true,
          },
        },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 720 },
        // `Desktop Safari` carries `deviceScaleFactor: 2`, and it is KEPT rather than normalised to
        // 1 to match the other two. Device-pixel-ratio handling is one of the surfaces N-04 is
        // actually about — `resize(w, h, dpr)` feeds `setPixelRatio(dpr × renderScale)`, sizes the
        // overlay canvas in device pixels and hands `dpr` to `drawOverlayLayer`'s `ctx.scale` — and
        // before this project existed the entire suite ran at dpr 1, so none of that arithmetic had
        // ever been executed with a value that changes the answer. The cost is real and stated: this
        // project rasterises four times the pixels of the other two.
        //
        // No launch options, and that is the honest configuration rather than an omission.
        // Playwright's Linux WebKit accepts no GL-related flags (see its `defaultArgs`:
        // `--disable-accelerated-compositing` is pushed on win32 only) and exposes no pref surface,
        // so there is nothing to force. What WebKit renders on is whatever the runner gives it, and
        // `e2e/capability.spec.ts` prints that string on every run instead of this file asserting
        // one it cannot control.
      },
    },
  ],
  webServer: {
    // The production build, not the dev server: N-03's payload budget and S5's cold-load target
    // are about what actually ships.
    //
    // The `preview` script binds **127.0.0.1 explicitly**, and that is load-bearing rather than
    // tidy. Vite's default is `localhost`, which on a dual-stack host resolves to `::1` first — so
    // on a GitHub runner the server listened on IPv6 while Playwright polled the IPv4 address here
    // and timed out after three minutes without ever running a test. It passed locally because
    // this machine resolves `localhost` to 127.0.0.1. Naming the interface removes the ambiguity
    // on both.
    command: "npm run build && npm run preview",
    url: `http://127.0.0.1:${PORT}`,
    // Never reuse: a preview server left over from an earlier run keeps serving the OLD dist/, so
    // the browser suite silently tests a build that no longer matches the source. It cost an hour
    // of "my change did nothing" once already. A rebuild is about a second; a lying test suite is
    // not worth saving it.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
