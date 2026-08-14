# ADR-0007: Toolchain and dependency policy

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §6.3; ADR-0003, ADR-0005, ADR-0009

## Context

The source project is proudly **zero-dependency, no-build**: the files in the repo are exactly what
the browser loads, and a guard test enforces it. That constraint bought real things — no toolchain
rot, no "works in dev, breaks in prod", instant onboarding.

This project cannot keep it. We take a real dependency on a 3D library (ADR-0005), and 3D code is
dense vector/matrix math where a type system pays for itself many times over. We also vendor a
JavaScript engine that must keep running unmodified (ADR-0003).

So the question is not whether to have a toolchain, but how to keep it small enough that it never
becomes the thing we maintain instead of the game.

## Decision

**Language.** New code is **TypeScript** (strict). Vendored engine code stays **JavaScript**,
untouched, and is consumed through hand-written declarations in `src/engine/engine.d.ts` covered by
a compile-time test.

**Build.** **Vite** for dev server and production build. One config, no custom plugins without an
ADR. The dev server must start in under 2 seconds and hot-reload the view layer.

**Tests.** **Vitest** for the new code (same transform pipeline as the build, fast watch mode),
plus **`node --test`** for the vendored upstream suite, run unmodified (ADR-0003). **Playwright**
for browser-level smoke and the perf gate, driven against a software-rendering Chromium (ADR-0006).

**Runtime dependencies** are pinned exactly, listed here, and adding one needs an ADR:

| Package | Pinned | Why | Budget impact |
|---|---|---|---|
| `three` | exact minor, tree-shaken named imports only | ADR-0005 | ~150 kB gzipped, inside the 3 MB payload budget |

That table is the whole list. Everything else — UI, state, math helpers, ECS — is either written
here or not needed. The HUD is plain DOM, as upstream: no UI framework.

**Dev dependencies** are unconstrained in kind but reviewed in number; each must be justified by a
script in `package.json` that someone actually runs.

**Budgets enforced in CI:** initial payload ≤ 3 MB gzipped; `three` import surface checked so a
stray `import * from 'three/examples/...'` cannot quietly double the bundle.

**No transpiling the vendored engine.** It ships as ES modules, which is what it already is.

## Consequences

**This makes easy:**
- Types across the renderer, bridge and UI — the layers where a wrong unit or a swapped axis is a
  silent, hours-long bug.
- Fast tests and a fast dev loop, which is what makes TDD (ADR-0009) sustainable rather than
  aspirational.
- Reviewing dependency growth: the table above is one file and one ADR away from being a surprise.

**This makes hard / gives up:**
- The parent's "what you see is what runs" property. A build step means a build can break, and
  source maps become part of the debugging story.
- Two test runners. Accepted deliberately: the alternative is modifying the vendored suite, which
  ADR-0003 forbids.
- The JS/TS boundary needs hand-maintained declarations that can drift from the engine.

**Obligations it creates:**
- `npm run typecheck`, `npm test`, `npm run test:sim`, `npm run perf`, `npm run build`,
  `npm run sync:engine` all exist and run in CI from Phase 0.
- A bundle-size check in CI (`P0-T07`).
- A declaration-conformance test that instantiates the real engine through `engine.d.ts`
  (`P0-T05`).

## Alternatives considered

### Stay no-build, use an import map and vanilla JS
Preserves the parent's best property, and was seriously considered. Rejected: three.js via import
map means shipping the un-tree-shaken build (bigger, and the size budget matters on a 10 Mbit
connection), and giving up types in exactly the code most prone to silent geometry bugs. The cost
lands on the constraint personas.

### TypeScript everywhere, including a ported engine
See ADR-0003: porting the engine throws away the tests that make it trustworthy.

### webpack / Rollup / esbuild directly
All workable. Vite is Rollup underneath with a dev server we would otherwise write, and it is the
lowest-configuration option that covers dev, build and test transform with one pipeline.

### Jest instead of Vitest
Slower on ESM+TS and needs its own transform config. Vitest shares Vite's, which is the whole point.
