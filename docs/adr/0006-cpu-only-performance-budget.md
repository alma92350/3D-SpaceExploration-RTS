# ADR-0006: The CPU-only performance budget and how it is enforced

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §6.2; ADR-0005, ADR-0008

## Context

A named persona (PRD §4.1, P2) has **no usable GPU**: an office laptop, a VDI session, a browser
falling back to SwiftShader or llvmpipe. On such a machine the cost model inverts from the familiar
one:

- **Fill rate is the enemy.** Every fragment is shaded by the CPU. Overdraw, full-screen effects,
  transparency and high resolution are what kill the frame, far more than triangle count.
- **Draw calls are expensive** — each carries state-change and validation cost with no GPU-side
  parallelism to hide it.
- **The render thread is the only thread.** Anything else on it — the simulation, GC, layout —
  comes directly out of the frame.
- **GC pauses are fatal at 33 ms.** A single 20 ms collection is a visible hitch.

Performance requirements that are written down but not measured are decoration. The parent project
learned an analogous lesson the expensive way: a required CI check that nobody had to pass was
walked past for four days of red builds. A budget needs a gate.

## Decision

**1. Four tiers, with explicit budgets** (PRD §6.2 is the table of record):
T0 Compatibility (software raster, 1280×720, 200 units, 33 ms), T1 Low, T2 Standard, T3 High.

**2. Tier selection is detected, then corrected by measurement.** At boot: read
`WEBGL_debug_renderer_info` (SwiftShader / llvmpipe / "Software" / Mesa offscreen ⇒ T0),
`navigator.hardwareConcurrency` and `deviceMemory` for the initial guess. Then measure: if the
rolling 95th-percentile frame time misses the tier budget for 3 consecutive seconds, drop a tier and
say so in a dismissible notice. Never silently up-tier. The player's manual override always wins and
persists.

**3. Mandated techniques.** These are contracts, not suggestions; each has a test.

| Rule | Enforced by |
|---|---|
| One draw call per (mesh, material, owner) via instancing | `FrameStats.drawCalls` asserted against entity counts |
| Zero allocation in a steady-state frame | Allocation-probe test over 600 frames |
| No textures, no post-processing, no transparency-heavy effects at T0/T1 | Renderer conformance suite per tier |
| Blob shadows at T0–T1; shadow maps T3 only | Conformance suite |
| Frustum + distance culling always on | Culling test with entities off-camera |
| Billboard imposters beyond the LOD distance | LOD test asserting mesh-vs-imposter counts |
| Terrain as one static merged mesh, rebuilt only on change | Rebuild-count test across 600 frames |
| Fog of war as one low-res lookup, not per-entity branching | Conformance suite |
| Render resolution scale is a tier knob (T0 may render at 0.75× and upscale) | Tier config test |
| Simulation ≤ 6 ms per rendered frame at T0 | Perf gate, sim-time channel |

**4. The CI gate.** Headless Chromium in CI runs with software rendering — **that is the T0 target
hardware**. `npm run perf` plays a scripted 60-second scene (fixed seed, fixed camera path, fixed
entity spawns) and records p50/p95 frame time, draw calls, instance counts and allocation. CI fails
if any budget is exceeded or if p95 regresses more than 10 % against the committed baseline in
`perf/baseline.json`. Baselines are updated deliberately, in their own commit, with a reason.

**5. The budget outranks the feature.** If an effect cannot fit T0's budget, it is disabled at T0 —
not shipped "just a bit over". If a *gameplay-legible* element cannot fit, the element gets cheaper,
not the budget bigger.

## Consequences

**This makes easy:**
- Catching the regression on the PR that caused it, on the hardware profile that cares.
- Saying no to expensive ideas early, with a number instead of an opinion.

**This makes hard / gives up:**
- Visual ambition, permanently and by design.
- CI time: the perf run is minutes, not seconds. Accepted; it runs in parallel with the test job.
- Perf numbers on shared CI runners are noisy. Mitigated by using p95 over a long scene, a 10 %
  regression band, and re-running before failing a PR twice.
- Instancing constrains the art: per-entity uniqueness must come from instance attributes (colour,
  scale, a state index), not per-entity materials.

**Obligations it creates:**
- `perf/` harness, scene script and baseline exist in Phase 0 (`P0-T06`), before any content.
- Every renderer implementation returns honest `FrameStats` (ADR-0005).
- Tier configuration is data, in one file, covered by tests (`P1-T07`).

## Alternatives considered

### "Optimise later"
The default, and it fails here specifically: the CPU-only constraint is architectural (instancing,
allocation, threading), not a matter of tuning constants. Discovering it in Phase 5 means rewriting
the view layer.

### Support only GPU machines, show a warning otherwise
Rejects a named persona and, with it, the point of the constraint. Also the least honest option: on
software rendering the app would *start* and then be miserable.

### Ship a separate "low" build
Two artefacts, two test matrices, and the player has to know which one to fetch. Runtime tiers with
auto-detection give the same result with one build.

### Cap the entity count instead of the frame time
Changes the game to fit the renderer. The population cap is a balance number owned upstream; the
renderer must handle what the simulation legitimately produces (up to 200 supply per side per
world).
