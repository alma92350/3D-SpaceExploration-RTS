import { defineConfig, devices } from "@playwright/test";

// Headless Chromium in CI runs with software rendering by default — and that IS the T0 target
// hardware (ADR-0006 §4). So the browser suite is not just a smoke test: it is the only place the
// CPU-only budget is measured honestly, because it is the only place a real rasteriser is involved.

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
