# ADR-0009: Test strategy — TDD, three layers, and what may be faked

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §8.1; ADR-0003, ADR-0005, ADR-0006, ADR-0008

## Context

TDD is a project requirement (PRD §8.1), and "write tests for rendering" is the point where TDD
projects usually quietly stop. Rendering tests have a bad reputation for good reasons: pixel
comparisons are flaky across drivers, GPU tests need a GPU, and "did it look right" resists
assertion.

We also have an unusual asset: ~41,000 lines of upstream tests that already cover the rules, and a
constraint (ADR-0006) that must itself be tested continuously.

The strategy therefore has to answer: what do we test at which layer, what may be faked, and what
does a failing test have to mean.

## Decision

**Three layers, with a strict rule about what each may touch.**

### Layer 1 — Simulation (inherited)
The vendored upstream suite, run **unmodified** as `npm run test:sim` (`node --test`). It proves the
rules. We do not add to it here; a missing rule test is an upstream PR.

Additionally, **determinism fixtures**: a recorded seed + command stream replayed to a state hash,
committed, and compared on every run and on every machine (PRD S4).

### Layer 2 — Logic (the bulk of new tests)
Everything in `src/bridge/`, `src/view/` and `src/ui/` that is a pure function of data: snapshot
extraction, interpolation, elevation, camera math, ray→ground picking, culling and LOD selection,
batching decisions, tier selection, HUD formatting, input→intent translation.

- Runs in Vitest, in Node, **with no canvas, no WebGL, no DOM beyond what jsdom gives the UI tests**.
- May fake: the renderer (the `RecordingRenderer`, ADR-0005), the clock, the input device.
- May **not** fake: the engine (use the real vendored one — it is fast and pure) or the snapshot
  format (use the real extractor).

### Layer 3 — Render contract and browser smoke
What the renderer *did*, not what it looked like:

- **Conformance suite**: every `Renderer` implementation (WebGL, Canvas2D, recording fake) passes
  the same behavioural suite — same calls in, same `FrameStats` invariants out.
- **Contract assertions**: draw-call counts against entity counts (instancing), instance-batch
  composition, culling, LOD switchover, terrain rebuild counts, and **zero allocation** across 600
  steady-state frames.
- **Browser smoke** (Playwright, software rendering): the app boots, a match starts, orders can be
  issued, no uncaught error, the console is clean. This is also the CPU-only target, so the perf
  gate (ADR-0006) rides here.
- **Visual snapshots are explicitly not part of the gate.** A small set of reference renders may be
  produced for human review in a PR, but no test fails on pixel diffs.

**The TDD loop is mandatory and specific** (see `docs/planning/WORKING-AGREEMENT.md`): write the
test from the requirement, watch it fail for the right reason, make it pass minimally, refactor
green, run everything before pushing. Production behaviour without a test that would have failed
before it does not merge. The exception list is short and closed: pure renames, comment/doc-only
changes, vendored syncs, and generated files.

**A failing test must mean something specific.** Every test asserts one behaviour and its message
says what the player-visible consequence is. "expected 3 to be 1" is a bad test failure; "one draw
call per unit type — instancing regressed, 3 calls for 1 type" is a good one.

## Consequences

**This makes easy:**
- Testing a renderer without a GPU, which is what makes CI on ordinary runners possible.
- Fast feedback: layers 1 and 2 run in seconds and cover most of the code.
- Refactoring the WebGL implementation freely — the conformance suite pins behaviour, not pixels.

**This makes hard / gives up:**
- **Nothing catches "it looks wrong"** — a mesh at the wrong scale, an inverted normal, a colour
  that reads as the enemy's. That gap is covered by human review and the playtest scripts, and it
  is a real, accepted hole.
- The conformance suite is work to build before it pays off, and it is the least glamorous code in
  the project.
- Allocation and perf tests are the flakiest thing we own; they need generous bands and
  re-run-before-failing discipline.

**Obligations it creates:**
- `RecordingRenderer` and the conformance suite exist in Phase 0/1 (`P0-T08`, `P1-T08`).
- Playtest scripts live in `docs/playtests/` and are updated per phase — they are how the visual
  hole gets covered.
- CI runs all three layers plus typecheck plus perf on every PR.

## Alternatives considered

### Pixel-diff (golden image) testing
Catches exactly the gap we are leaving open — and is notoriously driver-, font- and
antialiasing-sensitive, doubly so across a software rasteriser and real GPUs. It would spend our CI
reliability budget on the least deterministic signal available. Reconsider narrowly (one tiny fixed
scene, T0 only, generous threshold) if visual regressions actually start happening.

### Test only through the browser (E2E-heavy)
Slow, flaky, and hostile to the red-green-refactor loop TDD needs. The pyramid is deliberate.

### Skip renderer tests; rely on playtesting
Would make the instancing and allocation rules (ADR-0006) unenforceable, which is the same as not
having them.
