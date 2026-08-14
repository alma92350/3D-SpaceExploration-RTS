/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// One config, no custom plugins (ADR-0007). The vendored engine ships as plain ES modules and is
// not transpiled; Vite serves and bundles it as-is.
export default defineConfig({
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
