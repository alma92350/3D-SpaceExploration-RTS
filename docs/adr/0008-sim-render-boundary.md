# ADR-0008: The sim/render boundary — fixed step, snapshots, worker-ready

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §7, §6.2; ADR-0003, ADR-0004, ADR-0006

## Context

The vendored simulation runs at a **fixed 20 Hz** timestep — that fixed step is what makes it
deterministic — while rendering happens at whatever rate the display and the machine allow (30 fps
at T0, 60+ elsewhere). Something must reconcile the two, and the reconciliation has consequences
well beyond smoothness:

- The simulation's state is **mutable object graphs** (`Map`s of entities that are updated in
  place). A renderer that reads them directly is one careless line away from writing to them, and
  a renderer that keeps references to entity objects will happily render a half-updated tick.
- On the CPU-only target, sim work happens **on the render thread** and comes straight out of a
  33 ms budget (ADR-0006 allots it ≤ 6 ms).
- Moving the sim to a Web Worker later is the single biggest lever we have for that budget — but
  only if the boundary between sim and view is already a serialisable message rather than a pile of
  shared object references.

The upstream 2D client already solves the smoothness half: it snapshots positions each tick and
renders with an interpolation `alpha`. We keep that and formalise the rest.

## Decision

**1. A fixed-step loop with an accumulator, capped.** Up to 5 catch-up sim steps per animation
frame (as upstream); past that the game runs in slow motion rather than spiralling. Render
interpolates between the previous and current tick with `alpha ∈ [0, 1)`.

**2. `view/` never imports `engine/`.** It consumes a **snapshot**: a read-only, flat,
typed-array-backed description of exactly what can be drawn this frame.

- Entities become parallel typed arrays (`ids`, `types`, `owners`, `x`, `y`, `prevX`, `prevY`,
  `hp`, `flags`), sized once and reused — no per-frame objects, no per-entity garbage (ADR-0006).
- Slow-changing data (terrain, map, node positions) is snapshotted once and invalidated by version
  counters, not rebuilt per frame.
- The snapshot is **structurally serialisable**: everything in it could cross a `postMessage`
  today, even though today it does not.

**3. Player intent flows the other way as commands, never as mutations.** Input produces intent
objects; the bridge translates them into calls to the engine's own command functions
(`engine/commands.js`) — the same entry points the 2D client uses. Nothing above the bridge may
write a sim field. This is what keeps determinism testable: a recorded command stream plus a seed
reproduces a run exactly.

**4. The seam is worker-ready from day one, and in-thread until it must not be.** MVP runs the sim
in-thread (simplest, debuggable, and it meets the budget at MVP entity counts). The bridge's public
API is asynchronous-tolerant — commands are queued, snapshots are pulled — so moving the sim into a
Worker is a change to one module, not to the renderer. The flip happens when the perf gate says so;
double-buffered snapshots over `postMessage` (or `SharedArrayBuffer` where the headers allow).

**5. The renderer is stateless with respect to game state.** Everything it keeps is derived cache
keyed by snapshot version. Given the same snapshot it draws the same frame — which is what makes
the recording fake (ADR-0005) a usable oracle.

## Consequences

**This makes easy:**
- Testing the view with hand-built snapshots — no engine, no canvas, no GPU.
- Proving the renderer cannot corrupt the simulation: it holds no references to it.
- The eventual worker move, which would otherwise be a rewrite.
- Smooth motion at any frame rate, including 30 fps at T0.

**This makes hard / gives up:**
- A snapshot layer is real work and real code, and it duplicates shape information that already
  exists in the engine's types.
- Snapshot extraction costs time per tick (a copy). Bounded by using preallocated typed arrays and
  copying only what is drawable — visible entities, not the whole galaxy.
- Debugging gains one hop: "the renderer drew the wrong thing" now splits into "the snapshot was
  wrong" and "the renderer misread it". Mitigated by asserting snapshots directly in tests.

**Obligations it creates:**
- Snapshot buffers are preallocated and grow only in powers of two, never per frame (`P1-T05`).
- An architecture test asserting no import from `src/view/**` to `src/engine/**` (`P1-T13`).
- A determinism test replaying a recorded command stream to a fixed end-state hash (`P1-T21`).
- The interpolation path is covered at tick boundaries, including entity spawn and death mid-tick.

## Alternatives considered

### Render directly from engine state
Simplest, fastest to write, and the upstream 2D client does exactly this (successfully — it passes
`state` to pure draw functions). Rejected here because the CPU-only budget makes the Worker move
likely, and because a 3D renderer keeps far more derived per-entity state than a canvas painter,
making accidental references and stale reads much easier to write.

### Immutable snapshots as plain objects
Ergonomic and allocation-heavy — exactly the GC pressure ADR-0006 forbids at 33 ms frames.

### Put the sim in a Worker immediately
The right endpoint, the wrong start. It complicates every early debugging session and every test
for a budget that is not yet under pressure at MVP entity counts. Deferring it costs nothing
*provided* the seam exists, which is why the seam is mandatory now.

### Variable timestep, render-driven simulation
Would destroy determinism and with it the entire reuse argument (ADR-0003). Not an option.
