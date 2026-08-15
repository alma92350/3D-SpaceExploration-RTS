/// <reference types="vitest/config" />
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// One config, no custom plugins (ADR-0007). The vendored engine ships as plain ES modules and is
// not transpiled; Vite serves and bundles it as-is.

/**
 * The version, from the one place it is written (P6-T06).
 *
 * `define`, not a plugin: ADR-0007 says "one config, no custom plugins without an ADR", and a
 * two-key string substitution is config. Read here rather than imported by `src/app/build.ts`
 * because `package.json` is outside `src/` — importing it would put the whole manifest into the
 * module graph, one bad tree-shake away from the payload N-03 budgets.
 */
const version: string = (() => {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    const v = (pkg as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : "dev";
  } catch {
    return "dev";
  }
})();

/**
 * The short commit, which is what actually identifies a build.
 *
 * `version` moves once a phase and the deploy moves every push, so two builds a week apart both
 * read `0.1.0` and only one of them has the bug. Absent in a source tarball or a shallow checkout
 * with no `.git`, and that is not an error — the game builds and reports `unknown`, which is a true
 * statement rather than a broken build. `execFileSync` without a shell, so nothing here is
 * interpolated into one.
 */
const commit: string = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  // Two strings, substituted at build time and read by `src/app/build.ts`. Deliberately NOT a
  // timestamp: a build that differs from the last one only in the second it was made would make
  // every artefact unique and every "is this the same bundle?" question unanswerable.
  define: {
    __BUILD_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
  // Relative asset URLs, so one build works from any path.
  //
  // GitHub Pages serves a project site from a SUBPATH (`/3D-SpaceExploration-RTS/`), and Vite's
  // default absolute `/assets/...` URLs 404 there. The obvious fix is `base: "/3D-Space…/"`, but
  // then the bundle CI tests at `http://127.0.0.1:4173/` is not the bundle that deploys — and a
  // deploy-only build path is one nobody ever runs until it breaks. Relative works at both, so
  // there is exactly one artefact.
  //
  // Safe here only because the app has no client-side routing: every page sits at the root of
  // whatever path it is served from. Add nested routes and this needs revisiting.
  base: "./",
  resolve: {
    // The runtime half of the JS/TS seam. tsconfig maps `@engine/*` to the declarations in
    // src/engine/types/; this maps it to the vendored JavaScript those declarations describe.
    // See src/engine/index.ts — both halves must name the same modules or the types are fiction.
    alias: { "@engine": fileURLToPath(new URL("./src/engine", import.meta.url)) },
  },
  build: {
    target: "es2022",
    // Source maps make a production stack trace readable without shipping the sources themselves —
    // the debugging story we traded away when we took a build step (ADR-0007).
    sourcemap: true,
    rollupOptions: {
      // Two entries: the game, and the in-browser renderer harness the Playwright suite drives
      // (see src/harness-entry.ts). The harness is built from the same sources as the game so the
      // conformance and perf runs measure what actually ships.
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        harness: fileURLToPath(new URL("./harness.html", import.meta.url)),
      },
      output: {
        // `three` is the one runtime dependency and it never changes between our own deploys.
        // Splitting it out keeps a code change from re-downloading 150 kB on a 10 Mbit line (N-03).
        manualChunks: (id: string) => (id.includes("node_modules/three") ? "three" : undefined),
      },
    },
  },
  test: {
    // Vitest owns `test/` only. `src/engine/test/` is upstream's suite and runs under
    // `node --test` (ADR-0003, ADR-0007) — running it here would transform vendored code.
    include: ["test/**/*.test.ts"],
    // Node by default; the handful of DOM tests opt in with `// @vitest-environment jsdom`.
    environment: "node",
    globals: true,
  },
});
