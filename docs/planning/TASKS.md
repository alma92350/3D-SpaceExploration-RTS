# Task board

**This file is the project's memory.** It is updated in the same commit as the work it describes.
How to pick up a task: [`WORKING-AGREEMENT.md`](WORKING-AGREEMENT.md). What the phases mean:
[`../PRD.md`](../PRD.md) §5.

**Status values:** `READY` (dependencies met, take it) · `IN-PROGRESS` (claimed — see Notes) ·
`BLOCKED` (say why in Notes) · `DONE` · `PARTIAL` (shipped, but one acceptance line cannot be met
here — say which, and why) · `PARKED` (deliberately deferred).

**Claiming:** set `IN-PROGRESS` + your identifier and date in Notes, in a commit, before writing
code.

---

## Phase 0 — Foundation

Goal: an empty but trustworthy repo. Exit criteria: PRD §5, Phase 0.

| ID | Task | Status | Deps | Definition of done | Notes |
|---|---|---|---|---|---|
| P1-T01 | Bridge: create a single Odyssey world from the vendored engine and step it from the loop | DONE | P0-T05, P0-T10 | Test: 100 steps of the bridge equal 100 direct `stepGalaxy` calls, state hash identical | The two runs must be **sequential, never interleaved**: the engine mints entity ids from a module-global counter that `createGameState` resets, so two galaxies alive in one process reset each other's id sequence and diverge in positions. A real constraint on Phase 4's background worlds |
| P1-T02 | Snapshot extraction into preallocated typed arrays (units, buildings, nodes) + version counters | DONE | P1-T01 | Test: snapshot matches engine state for a hand-built world; 600 frames allocate nothing; growth is power-of-two and off-frame | Fog is applied **here**, not in the renderer: an entity the player cannot see is absent from the snapshot entirely (F-02, F-06) |
| P1-T03 | Interpolation: prev/current tick blending, spawn and death at tick boundaries | DONE | P1-T02 | Test: a unit moving at constant speed interpolates linearly; a unit spawned this tick does not appear at the origin; a dead unit does not linger | Alpha is clamped, never extrapolated — extrapolation overshoots a unit through the wall it just stopped at, on exactly the frames that ran long |
| P1-T04 | `elevation(x, y)` from the terrain grid, with cell-boundary smoothing (ADR-0004) | DONE | P1-T02 | Test: all three terrain values, cell boundaries, map edges, determinism (same input → same output) | Bilinear across cell **centres** with a narrowed blend band, so a plateau top stays flat and a cliff still reads as a cliff |
| P1-T05 | Terrain mesh: one merged static mesh from the elevation field, rebuilt only on change | DONE | P1-T04, P0-T08 | Test: rebuild count is 1 across 600 frames; vertex count within budget; T0 collapses to the flat variant | ~8k triangles for the whole ground at MVP map size |
| P1-T06 | Procedural low-poly meshes for the MVP roster (worker, skiff, bastion, lancer, command, barracks, habitat, turret, refinery) | DONE | P0-T08 | Each generator is deterministic, budgeted (tri-count assertion per mesh), and readable at MVP camera distance (playtest) | **Ten** meshes, not nine: the colony ship is the first thing a player ever sees (ADR-0010 §4). Readability is still open — it needs the playtest (P1-T24) |
| P1-T07 | Tier configuration (T0–T3) as data + auto-detection + measured correction + settings override | DONE | P0-T06 | Test: SwiftShader/llvmpipe renderer strings select T0; a stubbed 3-second budget miss drops a tier once and notifies; override persists | The measurement window is **time-based, not frame-count-based**: a count-based window let one 800 ms hitch drop a tier on a fast machine ~4 s later, and made the drop unreachable on a machine slow enough to need it |
| P1-T08 | Renderer conformance suite; WebGL implementation passing it | DONE | P0-T08 | Same suite green against `RecordingRenderer` and `WebGLRenderer` | Suite runs in both places: Node against the fake (fast, in the red-green loop) and Chromium against all three implementations including Canvas2D. Caught a real Canvas2D defect — it reported zero draw calls for the terrain before the first `setFog` |
| P1-T09 | Instanced entity rendering: one draw call per (mesh, owner) | DONE | P1-T06, P1-T08 | Test: 200 units of 4 types across 2 owners ⇒ ≤ 8 instanced draw calls; `FrameStats` proves it | Measured: 15 draw calls total at the T0 perf scene (200 units, 80 buildings) including terrain, nodes and every overlay |
| P1-T10 | RTS camera rig: pan, zoom-with-pitch, yaw (Q-01), bounds clamping, focus-base | DONE | P0-T10 | Test: camera never leaves bounds at any zoom/yaw; focus centres the target; pure math, no DOM | Q-01 answered in ADR-0010: yaw snaps to 8. Clearance is checked under the **eye**, not under the target — the camera flies over mesas on its way somewhere else |
| P1-T11 | Input → intent translation: click, box select, double-click type-select, move/attack-move/stop/hold, hotkeys | DONE | P1-T10 | Test: each gesture produces exactly one intent with the right payload; no intent writes sim state directly | Hotkeys are upstream's letter for letter (ADR-0010 §5) — stop is `X`, not `S`, because W/A/S/D pan |
| P1-T12 | Ray → ground picking against the elevation field, and entity picking | DONE | P1-T04, P1-T10 | Test: picked `(x, y)` within ±0.5 world units of truth across a matrix of yaw × pitch × zoom × terrain type (PRD F-03) | Worst measured error across the matrix is far inside ±0.5. Two tests, because a world round-trip alone cannot distinguish a picking bug from correct occlusion: the second sweeps every on-screen pixel and demands it round-trip to within one pixel |
| P1-T13 | Architecture tests: no `view/**` → `engine/**` import; no `z`/elevation field crossing the bridge | DONE | P1-T02 | A fixture violating either rule fails the test | Plus: only `src/engine/index.ts` may import vendored JS, and in the render path a typed array may only be allocated in a constructor, a field initialiser or an `ensure*` helper |
| P1-T14 | Fog of war rendering: three states, single low-res lookup, no per-entity branching | DONE | P1-T05, P1-T09 | Test: hidden entities are absent from the snapshot, not merely undrawn; fog texture updates once per tick, not per frame | One texture fetch in the terrain shader; the version counter is asserted by the conformance suite |
| P1-T15 | Selection, health bars, veterancy chevrons and rally lines as overlays | DONE | P1-T09 | Conformance test: overlays render in both WebGL and Canvas2D implementations; legible at min zoom (playtest) | Drawn as projected 2D over the scene in both implementations, so they keep a constant pixel size. Legibility still needs the playtest |
| P1-T16 | HUD: resource bar, selection panel, production buttons, supply, alerts (plain DOM) | DONE | P1-T02 | Test: panel content is a pure function of a snapshot; every number matches the engine's own value | `hudModel(snapshot)` is pure and tested without a DOM; the DOM writer only touches nodes whose text changed |
| P1-T17 | Minimap with terrain, fog, entities and click-to-move-camera | DONE | P1-T05, P1-T14 | Test: minimap→world coordinate conversion round-trips; redraw cost inside budget | Fog layer is repainted only when `fog.version` moves, then blitted |
| P1-T18 | Build placement: 3D ghost, validity shading (terrain, collision, build reach), commit | DONE | P1-T12, P1-T16 | Test: validity matches the engine's own placement rules exactly, on every terrain type | Verified by sweeping the whole map and comparing verdict-for-verdict against `canPlaceBuilding` + `sampleTerrain`. Validity is shape **and** colour (dashed + crossed when invalid), never colour alone (N-05) |
| P1-T19 | Canvas2D fallback renderer, feature-reduced but playable | DONE | P1-T08 | Conformance suite green; the no-WebGL boot test reaches a playable frame | Projects through the same camera matrix as the WebGL path, painter-sorted. Ground is drawn as fog-grid cells rather than the merged mesh |
| P1-T20 | Save/load of the single world (upstream `GALAXY_SAVE_VERSION` parity) | DONE | P1-T01 | Test: a save written here loads in the 2D client's format checker and round-trips to an identical state hash | Uses upstream's own `serializeGalaxy`/`deserializeGalaxy`. A corrupt save is rejected without touching the running session — upstream signals failure two ways (null **and** a throw), and both had to be caught |
| P1-T21 | Determinism fixtures: recorded seed + command stream → committed end-state hash | DONE | P1-T11 | Replay is bit-identical in CI and on two developer machines; a deliberate engine tweak fails it | The fixture is **generated** by `test/determinism/record.test.ts` (`RECORD_FIXTURE=1`), not hand-written: engine ids depend on *when* an order is issued, so a hand-written fixture hashes deterministically while every order in it silently fails. Still needs confirming on a second and third machine (see the gate note below) |
| P1-T22 | No-WebGL boot path test (context creation stubbed to fail) | DONE | P1-T19 | App starts, selects Canvas2D, reaches a playable frame, no uncaught error | Asserts pixels were actually drawn, not merely that boot completed |
| P1-T23 | Perf gate at MVP content: T0 200 units @ 33 ms, T2 400 units @ 16.6 ms | PARTIAL | P1-T09, P1-T14 | `npm run perf` green at both tiers on the committed scene; baseline recorded | **T0 passes: p95 12.7 ms against 33 ms**, under SwiftShader, which *is* the T0 target. **T2's budget cannot be gated in CI** — it is defined as "integrated GPU ≥ 2019" and CI has no GPU at all, so the T2 scene is run for its hardware-independent contracts and its frame time is recorded, not asserted. See the gate note below |
| P1-T24 | Playtest script `docs/playtests/mvp.md` + one recorded playtest against S1/S6 | IN-PROGRESS | P1-T18 | Script exists; 3 of 5 testers find the build menu unaided, or a follow-up task is filed | Script written and updated for the built MVP (world, controls, tier switching). **The five-tester session has not been run** — it needs people, not code |

---

## Phase 1 exit gate — status

Checked against PRD §5 (Phase 1) and §4.2. Two criteria are **not** met, and neither can be met by
writing more code.

| Criterion | Status | Evidence |
|---|---|---|
| S1 — land, build a Command Center, train units, destroy something | **Automated ✔, human ✘** | The whole chain runs end to end in `e2e/smoke.spec.ts` and in the determinism fixture. The *judgement* S1 asks for is a playtest (P1-T24) |
| S2 — 30 fps at 1280×720, 200 units, software rendering | **PASS** | p95 **12.7 ms** against a 33 ms budget, Chromium forced to SwiftShader (`e2e/perf.spec.ts`) |
| S3 — 60 fps at 1600×900, 400 units, integrated GPU ≥ 2019 | **NOT VERIFIABLE IN CI** | CI has no GPU. The T2 scene's frame time is measured and printed but not asserted; S3 needs a run on real 2019-or-later integrated hardware before the gate can be called green |
| S4 — bit-identical simulation for the same seed and inputs | **PASS in CI, unconfirmed across machines** | `test/determinism/replay.test.ts`. The PRD asks for three machines; this is one |
| S5 — cold load to interactive ≤ 5 s on 10 Mbit | **PASS by payload** | 192 kB gzipped against a 3 MB budget — ~0.15 s of transfer at 10 Mbit. A real Lighthouse run on a throttled connection has not been done |
| S6 — a first-time player finds the build menu unaided | **NOT MEASURED** | Needs P1-T24's five testers |

**What the next session should pick up, in order:**

1. **P1-T24** — run the playtest with five people. It gates S1 and S6, and it is the only thing that
   can tell us whether the meshes and overlays actually read. Everything else on this board is green
   without it and means less than it looks.
2. **S3 on real hardware** — one run of `npm run smoke` on a laptop with a 2019-or-later integrated
   GPU, with the T2 assertion turned back on locally. File what it says.
3. **S4 on two more machines** — `npx vitest run test/determinism` elsewhere and compare the hash.
4. **S5 properly** — a throttled Lighthouse run, not an inference from payload size.

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
| Q-01 | Camera yaw: free orbit or snapped? | Phase 1 (P1-T10) | **ANSWERED** — snapped to 8, ADR-0010. Revisit in Phase 6 with a readability test, not an opinion |
| Q-02 | MVP starts on a fixed world or the seed's draw? | Phase 1 (P1-T01) | **ANSWERED** — fixed, ADR-0010. The world is **Helix Belt**, not `ferros`: Ferros Prime's terrain grid is uniformly open, so an MVP built on it would render a flat plane and demonstrate none of the relief that is the point of the exercise |
| Q-03 | Starmap: true 3D scene or 2.5D diagram? | Phase 4 | OPEN |
| Q-04 | Ship Observer Mode, or is a free camera enough? | Phase 5 | OPEN |
| Q-05 | Ever bridge the 3D view back into the 2D repo? | any | OPEN — recommendation: no |
| Q-06 | Audio: reuse upstream procedural WebAudio, or none? | Phase 6 | OPEN |
