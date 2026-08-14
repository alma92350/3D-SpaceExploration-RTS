# Task board

**This file is the project's memory.** It is updated in the same commit as the work it describes.
How to pick up a task: [`WORKING-AGREEMENT.md`](WORKING-AGREEMENT.md). What the phases mean:
[`../PRD.md`](../PRD.md) §5.

**Status values:** `READY` (dependencies met, take it) · `IN-PROGRESS` (claimed — see Notes) ·
`BLOCKED` (say why in Notes) · `DONE` · `PARKED` (deliberately deferred).

**Claiming:** set `IN-PROGRESS` + your identifier and date in Notes, in a commit, before writing
code.

---

## Phase 0 — Foundation

Goal: an empty but trustworthy repo. Exit criteria: PRD §5, Phase 0.

| ID | Task | Status | Deps | Definition of done |
|---|---|---|---|---|
| P0-T01 | Repo scaffolding: Vite + TypeScript strict + Vitest, `src/{app,ui,view,input,bridge,engine}`, `npm run dev` serves a page | READY | — | `npm run dev` opens a page; `npm run build` produces a bundle; `npm run typecheck` passes on an empty strict project |
| P0-T02 | CI workflow: typecheck, `test`, `test:sim`, `build`, `perf`, bundle-size — on push and PR | READY | P0-T01 | A deliberately broken commit fails CI in each job independently; job names documented in the README |
| P0-T03 | `scripts/sync-engine.mjs`: pull a pinned upstream ref, copy `engine/**` + `data.js` into `src/engine/`, write `VENDOR.json` | READY | P0-T01 | Running it on a clean tree is a no-op; on a stale tree it updates and records the upstream commit |
| P0-T04 | Vendor drift check in CI: a local edit to `src/engine/**` fails the build | READY | P0-T03 | Test proves it: modify a vendored file in a fixture, assert non-zero exit |
| P0-T05 | `src/engine/engine.d.ts` declarations + a compile-time conformance test | READY | P0-T03 | `createGalaxy`, `stepGalaxy`, `activeState`, command functions and the `State`/`Unit`/`Building` shapes are typed; a type test instantiates the real engine and fails to compile on a wrong field |
| P0-T06 | Perf harness: scripted 60 s scene, `FrameStats` collection, `perf/baseline.json`, 10 % regression gate, runs under software rendering | READY | P0-T01 | `npm run perf` prints p50/p95/draw calls/allocation and exits non-zero on a seeded regression |
| P0-T07 | Bundle-size budget check (≤ 3 MB gzipped) + a guard against non-tree-shakeable `three` imports | READY | P0-T01 | CI fails on a fixture commit that imports `three/examples/**` |
| P0-T08 | `RecordingRenderer` + the `Renderer` port interface (ADR-0005), with the first conformance tests | READY | P0-T01 | Port compiles; the fake records `beginFrame`/`drawInstances`/`endFrame`; conformance suite runs against it |
| P0-T09 | ADR index check in CI; ADRs 0001–0009 merged | DONE | — | Every `docs/adr/[0-9]*.md` appears in the index with a status — *shipped with the initial PRD commit; the CI check itself is still open, see P0-T09b* |
| P0-T09b | CI check for the ADR index | READY | P0-T02 | A new ADR file that is missing from the index fails CI |
| P0-T10 | Fixed-timestep loop (20 Hz) + interpolation alpha + a clear-colour frame; frame-time HUD | READY | P0-T01, P0-T08 | Loop test: with a stubbed clock, N ms of wall time produce exactly the expected tick count and alpha, and never more than 5 catch-up steps |
| P0-T11 | Playwright browser smoke: app boots, no console error, canvas present | READY | P0-T01, P0-T02 | Smoke fails on a fixture commit that throws at boot |
| P0-T12 | README: what this is, how to run, how to pick up work, CI job names | READY | P0-T01 | A stranger can clone, install, test and run from the README alone |

---

## Phase 1 — MVP: one world, in 3D  ⭐

Goal and scope: PRD §5, Phase 1. **This is the milestone that decides whether the idea feels
right.** Everything here is scoped to a single pre-settled world; no galaxy layer.

| ID | Task | Status | Deps | Definition of done |
|---|---|---|---|---|
| P1-T01 | Bridge: create a single Odyssey world from the vendored engine and step it from the loop | BLOCKED | P0-T05, P0-T10 | Test: 100 steps of the bridge equal 100 direct `stepGalaxy` calls, state hash identical |
| P1-T02 | Snapshot extraction into preallocated typed arrays (units, buildings, nodes) + version counters | BLOCKED | P1-T01 | Test: snapshot matches engine state for a hand-built world; 600 frames allocate nothing; growth is power-of-two and off-frame |
| P1-T03 | Interpolation: prev/current tick blending, spawn and death at tick boundaries | BLOCKED | P1-T02 | Test: a unit moving at constant speed interpolates linearly; a unit spawned this tick does not appear at the origin; a dead unit does not linger |
| P1-T04 | `elevation(x, y)` from the terrain grid, with cell-boundary smoothing (ADR-0004) | BLOCKED | P1-T02 | Test: all three terrain values, cell boundaries, map edges, determinism (same input → same output) |
| P1-T05 | Terrain mesh: one merged static mesh from the elevation field, rebuilt only on change | BLOCKED | P1-T04, P0-T08 | Test: rebuild count is 1 across 600 frames; vertex count within budget; T0 collapses to the flat variant |
| P1-T06 | Procedural low-poly meshes for the MVP roster (worker, skiff, bastion, lancer, command, barracks, habitat, turret, refinery) | BLOCKED | P0-T08 | Each generator is deterministic, budgeted (tri-count assertion per mesh), and readable at MVP camera distance (playtest) |
| P1-T07 | Tier configuration (T0–T3) as data + auto-detection + measured correction + settings override | BLOCKED | P0-T06 | Test: SwiftShader/llvmpipe renderer strings select T0; a stubbed 3-second budget miss drops a tier once and notifies; override persists |
| P1-T08 | Renderer conformance suite; WebGL implementation passing it | BLOCKED | P0-T08 | Same suite green against `RecordingRenderer` and `WebGLRenderer` |
| P1-T09 | Instanced entity rendering: one draw call per (mesh, owner) | BLOCKED | P1-T06, P1-T08 | Test: 200 units of 4 types across 2 owners ⇒ ≤ 8 instanced draw calls; `FrameStats` proves it |
| P1-T10 | RTS camera rig: pan, zoom-with-pitch, yaw (Q-01), bounds clamping, focus-base | BLOCKED | P0-T10 | Test: camera never leaves bounds at any zoom/yaw; focus centres the target; pure math, no DOM |
| P1-T11 | Input → intent translation: click, box select, double-click type-select, move/attack-move/stop/hold, hotkeys | BLOCKED | P1-T10 | Test: each gesture produces exactly one intent with the right payload; no intent writes sim state directly |
| P1-T12 | Ray → ground picking against the elevation field, and entity picking | BLOCKED | P1-T04, P1-T10 | Test: picked `(x, y)` within ±0.5 world units of truth across a matrix of yaw × pitch × zoom × terrain type (PRD F-03) |
| P1-T13 | Architecture tests: no `view/**` → `engine/**` import; no `z`/elevation field crossing the bridge | BLOCKED | P1-T02 | A fixture violating either rule fails the test |
| P1-T14 | Fog of war rendering: three states, single low-res lookup, no per-entity branching | BLOCKED | P1-T05, P1-T09 | Test: hidden entities are absent from the snapshot, not merely undrawn; fog texture updates once per tick, not per frame |
| P1-T15 | Selection, health bars, veterancy chevrons and rally lines as overlays | BLOCKED | P1-T09 | Conformance test: overlays render in both WebGL and Canvas2D implementations; legible at min zoom (playtest) |
| P1-T16 | HUD: resource bar, selection panel, production buttons, supply, alerts (plain DOM) | BLOCKED | P1-T02 | Test: panel content is a pure function of a snapshot; every number matches the engine's own value |
| P1-T17 | Minimap with terrain, fog, entities and click-to-move-camera | BLOCKED | P1-T05, P1-T14 | Test: minimap→world coordinate conversion round-trips; redraw cost inside budget |
| P1-T18 | Build placement: 3D ghost, validity shading (terrain, collision, build reach), commit | BLOCKED | P1-T12, P1-T16 | Test: validity matches the engine's own placement rules exactly, on every terrain type |
| P1-T19 | Canvas2D fallback renderer, feature-reduced but playable | BLOCKED | P1-T08 | Conformance suite green; the no-WebGL boot test reaches a playable frame |
| P1-T20 | Save/load of the single world (upstream `GALAXY_SAVE_VERSION` parity) | BLOCKED | P1-T01 | Test: a save written here loads in the 2D client's format checker and round-trips to an identical state hash |
| P1-T21 | Determinism fixtures: recorded seed + command stream → committed end-state hash | BLOCKED | P1-T11 | Replay is bit-identical in CI and on two developer machines; a deliberate engine tweak fails it |
| P1-T22 | No-WebGL boot path test (context creation stubbed to fail) | BLOCKED | P1-T19 | App starts, selects Canvas2D, reaches a playable frame, no uncaught error |
| P1-T23 | Perf gate at MVP content: T0 200 units @ 33 ms, T2 400 units @ 16.6 ms | BLOCKED | P1-T09, P1-T14 | `npm run perf` green at both tiers on the committed scene; baseline recorded |
| P1-T24 | Playtest script `docs/playtests/mvp.md` + one recorded playtest against S1/S6 | BLOCKED | P1-T18 | Script exists; 3 of 5 testers find the build menu unaided, or a follow-up task is filed |

---

## Phase 2 — The economy

Not yet decomposed. Decompose at the Phase 1 gate — the MVP will teach us what is actually hard.
Known headings: gathering/hauling visuals and cargo, the industrial chain and its buffers, power
zones, the market panel, doctrines and research UI, supply/Habitats, repair and recycling, the
remaining buildings.

## Phase 3 — Combat and the opponent

Not yet decomposed. Headings: full unit roster, combat feedback, wreckage and craters, turret tiers,
AI live under its own fog, formations, escorts, control groups, alerts.

## Phase 4 — The galaxy

Not yet decomposed. Headings: 3D starmap (see Q-03), jumps and staging, the landing picker as an
approach view, background worlds, colonies and income, credits, freight lanes, standing orders.

## Phase 5 — The long game

Not yet decomposed. Headings: diplomacy, the Antimatter Gate, the rival Gate, milestones and
fireworks, relief, Observer Mode, full save/load UI, settings, onboarding, audio, the parity
checklist.

## Phase 6 — Polish and release

Not yet decomposed. Headings: LOD and effect budgets, accessibility, tutorial, error handling,
release build, versioning.

---

## Open questions

Answer before the phase in brackets. Discussion belongs in the PRD §10 entry; the answer belongs
here and in the ADR it produces.

| ID | Question | Needed by | Status |
|---|---|---|---|
| Q-01 | Camera yaw: free orbit or snapped? | Phase 1 (P1-T10) | OPEN — recommendation: snapped for MVP |
| Q-02 | MVP starts on a fixed world or the seed's draw? | Phase 1 (P1-T01) | OPEN — recommendation: fixed (`ferros`) |
| Q-03 | Starmap: true 3D scene or 2.5D diagram? | Phase 4 | OPEN |
| Q-04 | Ship Observer Mode, or is a free camera enough? | Phase 5 | OPEN |
| Q-05 | Ever bridge the 3D view back into the 2D repo? | any | OPEN — recommendation: no |
| Q-06 | Audio: reuse upstream procedural WebAudio, or none? | Phase 6 | OPEN |
