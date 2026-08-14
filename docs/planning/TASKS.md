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
| P1-T25 | First-run readability: the opening must not read as a blank page | DONE | P1-T16 | The first frame shows a legible colony ship, ground rather than void, and one line saying what to do | Raised by looking at the built app. Four causes, all fixed: the camera opened at 420 on a single small ship; unexplored terrain rendered pure black over ~90% of the view; the map edge ended in a hard black wedge; nothing said what to click. **Scope change: the starfield in PRD §5 is cut** — the camera's pitch ramp means the horizon is never on screen, so a skybox is invisible by construction. A dark terrain apron replaces it (ADR-0010 §5–6) |
| P1-T26 | CI: the browser job could never start | DONE | P0-T02 | `npm run smoke` reaches the tests on a GitHub runner | `vite preview` binds `localhost`, which resolves to `::1` on a dual-stack runner while Playwright polled `127.0.0.1` — three minutes of webServer timeout with no test ever running. Binds explicitly now. Also stopped reusing an existing preview server: a stale one silently serves an old `dist/`, so the browser suite tests a build that no longer matches the source |
| P1-T27 | Publish the build to GitHub Pages | DONE | P0-T02 | A public URL serves the playable game; the build works from a subpath | Pages had been pointed at a *branch*, which publishes Vite source and yields an unstyled "Loading the Odyssey…" that never boots. Source must be **GitHub Actions**. `base` is `"./"` so one artefact works at both `/` and `/<repo>/` — no deploy-only build path for nobody to test — and `e2e/subpath.spec.ts` serves the real build from a nested path so a rooted asset URL fails CI rather than the public site |
| P1-T28 | S5 measured rather than inferred: cold load to interactive under a throttled connection | DONE | P1-T16 | `npm run smoke` fails if a cold load at 10 Mbit reaches a playable frame later than 5 s | S5 had been called a pass by arithmetic — 192 kB at 10 Mbit is 0.15 s, therefore fine — which ignores everything between the last byte and a playable frame: parse, compile, GL context creation, mesh generation, the terrain build, the first draw. On a machine with no GPU that is where the time actually is. `performance.mark("odyssey:interactive")` is set from the entry point after the first frame returns (§4.2 asks for `performance` marks), and CDP throttles the link. **Measured: 331 ms against 5 000 ms.** The second test in the file is the important one — it re-runs the load unthrottled and fails if the two numbers match, because a throttling harness that silently fails open reports a comfortable number forever |
| P1-T29 | The perf gate's regression message pointed at the one action that disables the gate | DONE | P1-T23 | `judge()` has tests; a regression message sends the reader to re-measure on a clean checkout before it mentions the baseline | Found by hitting it: this container measured T2 p95 **7.16 ms against a 5.16 ms baseline it had recorded itself hours earlier**, with no code change and CI green on the same commit — host load, not a regression. The old message's only advice was "re-record the baseline", and following it would have written a loaded machine's number into the repo, after which the gate passes forever and detects nothing. Message fixed and pinned; `judge()` had no tests at all before this, so its four real rules got them too. **The baseline was deliberately NOT re-recorded** |
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
| S5 — cold load to interactive ≤ 5 s on 10 Mbit | **PASS, measured** | **331 ms** to a drawn frame with the link throttled to 10 Mbit and the HTTP cache disabled (`e2e/coldload.spec.ts`, P1-T28). Was previously a pass by arithmetic from the payload size, which measured none of the parse/compile/GL-init/first-draw time that actually dominates it |
| S6 — a first-time player finds the build menu unaided | **NOT MEASURED** | Needs P1-T24's five testers |

**Scope deviations from PRD §5, both recorded in ADR-0010:** the MVP world is Helix Belt rather
than the illustrative `ferros`; and the starfield skybox is cut, because the camera can never see
the sky. The PRD should be amended for both.

## Deferred verification

Criteria that CI cannot decide, kept in one place so a closed phase never quietly implies they
passed (ADR-0011). This list only grows until someone runs the checks.

| Criterion | Phase | Needs | Deferred because |
|---|---|---|---|
| S1 — the chain judged by a person | 1 | five playtesters | Automated end to end in `e2e/smoke.spec.ts`; the *judgement* is the point and needs people |
| S6 — a first-time player finds the build menu unaided | 1 | five playtesters | The one criterion that asks whether the game is legible rather than fast |
| S3 — 60 fps at 1600×900, 400 units | 1 | a 2019-or-later integrated GPU | CI has no GPU. **Deferred indefinitely**, not merely delayed: CPU-only is the whole target |
| S4 on a second and third machine | 1 | two more machines | Reproducible in CI; the PRD asks for three |
| Mesh and overlay legibility | 1, 2 | playtesters | The silhouette tests fail what a person would obviously fail, which is not the same as reading well |
| "Every combat cue is legible in a blind readability test" | 3 | playtesters | Same shape as S6, and it will be deferred the same way |

**What the next session should pick up, in order:**

1. **P1-T24** — run the playtest with five people, now that there is a URL to send them:
   https://alma92350.github.io/3D-SpaceExploration-RTS/ It gates S1 and S6, and it is the only thing that
   can tell us whether the meshes and overlays actually read. Everything else on this board is green
   without it and means less than it looks.
2. **S3 on real hardware** — one run of `npm run smoke` on a laptop with a 2019-or-later integrated
   GPU, with the T2 assertion turned back on locally. File what it says.
3. **S4 on two more machines** — `npx vitest run test/determinism` elsewhere and compare the hash.

All three need a person or a machine this project does not have in CI. Everything on the gate that
could be closed by writing code has been: S5 was the last of them (P1-T28).

## Phase 2 — The economy

Goal: the full per-world build/economy loop that Odyssey actually runs on. Exit criteria: PRD §5,
Phase 2 — *a player can run the full 2D economy in 3D with no panel missing; every economy panel has
a logic test; perf budgets hold with 300 buildings on screen.*

> **Phase 1's gate is closed on its automated criteria (ADR-0011).** S1, S3 and S6 are deferred —
> they need five playtesters and a GPU, not code — so Phase 2 is under way rather than waiting.
> Rows still marked `BLOCKED` are blocked on their `Deps`, nothing more.

**What the MVP taught us, which is why this decomposition looks like it does.** The numbers below
are from the vendored engine, not from the PRD's prose:

- **29 buildings and 23 commodities.** The MVP renders 9 building types and shows 3 commodities plus
  credits. Phase 2 is mostly *breadth*: 20 more building types, 20 more commodities, and the panels
  to read them. That is a different kind of work from Phase 1's, and it is why the perf risk is
  draw calls and snapshot width rather than any single clever system.
- **The industrial chain is 9 recipes, not 7.** `recipeOf` covers smelter, assembler, chipfab,
  machineworks, antimatterforge, aifoundry, torpedoworks, chemplant and fabricator — PRD §5's arrow
  diagram omits the Chemical Plant and the Fabricator, and both are on the consumer-goods path.
  Four recipes are tech-gated (`metallurgy`, `electronics`, `antimatter`, `aicores`), so the
  research UI (P2-T11) is a dependency of the chain reading correctly, not a side panel.
- **Power is a distance field, not a boolean.** `POWER_TIERS` bands by range — on-grid ≤ 190,
  near ≤ 320, far ≤ 470, isolated beyond — each with a cost multiplier (1×, 1.3×, 1.7×, 2.3×). It
  is the same shape of problem as fog, which is already solved as one low-res texture with a version
  counter, and Q-08 asks whether to reuse that machinery.

| ID | Task | Status | Deps | Definition of done | Notes |
|---|---|---|---|---|---|
| P2-T01 | Snapshot: the owner's full commodity stockpile, supply and power totals | DONE | P1-T02 | Every commodity in `COM` (23) reaches the view with the engine's own value; 600 frames allocate nothing; growth stays power-of-two and off-frame | The MVP carries ore/crystals/radioactives/credits. Widening the stockpile is cheap — it is per-owner, not per-entity — and it is the dependency of every panel below |
| P2-T02 | Snapshot: per-building production state (recipe, progress, input buffers, output buffer, throttle reason) | DONE | P2-T01 | Matches `recipeOf` + the engine's building fields for a hand-built world of every producing type; no per-frame allocation | **Answer Q-07 first.** 23 commodities × 300 buildings is 6 900 floats a tick if every buffer crosses every tick; the alternative is totals for all, detail for the selection only |
| P2-T03 | Bridge commands: research, recycle, repair, market buy/sell, doctrine, logistics priority | DONE | P2-T01 | Each intent produces exactly one engine call and is refused exactly when the engine refuses it — asserted against the engine's own predicate, not a copy of its rules | The MVP's rule: the bridge never re-implements a rule it can ask about (`canPlaceBuilding` is the precedent). `researchTech`, `beginRecycle`/`canRecycle`, `buy`/`sell`, `LOGI_PRIORITIES` |
| P2-T04 | Meshes for the remaining 19 building types | DONE | P1-T06 | Every engine building type maps to a built mesh; each mesh inside its triangle budget; the families distinguishable from each other by profile | **Scope changed by ADR-0013**, which supersedes ADR-0012 §3's variant attribute: that mechanism would have put all nine rooflines in the vertex buffer and collapsed eight per instance — 36k triangles of vertex work at 300 buildings against a scene that runs 13k in total, spending more budget than the draw calls it saved. Six families instead, 14 building meshes, 28 draws at two owners. **Nine chain buildings now look identical on the field** — a bigger loss than ADR-0012 admitted, and it belongs to the deferred playtest. The profile test earned itself immediately: it failed the first Fortress for coming within 8% of the Refinery |
| P2-T05 | Logistics unit meshes + visible cargo | BLOCKED | P2-T04 | `hauler`, `heavyhauler`, `bulkfreighter`, `freighter` render; a laden unit is distinguishable from an empty one at camera distance; **cargo adds no draw call** | Cargo as a per-instance attribute, like `instanceShade` — a second mesh per laden unit would double the logistics draw calls, which is the one place unit counts are highest |
| P2-T06 | Power / electrification zones rendered | DONE | P1-T14 | The four `POWER_TIERS` bands render in every implementation; one extra texture fetch, no per-entity branching; uploaded once per tick behind a version counter, asserted by the conformance suite | Q-08's answer held: reusing the fog machinery made this small. `setPower(field \| null)` — one method, null hides — with the texture kept so toggling costs nothing, and a conformance case that fails if hiding counts as an upload. **It is a placement cue first**, on automatically while a build ghost is up (the moment "will this run efficiently here?" is actually asked) and otherwise on `G`. NEAREST filtering, unlike the fog: a band edge is where the cost multiplier changes, and smoothing it would draw a gradient the engine does not have |
| P2-T07 | Gathering and hauling read correctly in 3D | BLOCKED | P2-T05 | A recorded worker round trip — `updateGather` → `nearestGatherDrop` → drop-off — matches the visible cargo state at every tick of the replay | The economy's most-watched animation. `zoneFirst` means workers prefer their home zone, so the visuals must not imply nearest-node behaviour |
| P2-T08 | Building state reads without colour: constructing, working, idle, throttled, unpowered | BLOCKED | P2-T02 | Each of the five states is distinguishable by shape or motion in a still frame; conformance suite covers both renderer implementations | N-05 again. "Unpowered" and "idle" being confusable is the failure mode that makes a player think the game is broken |
| P2-T09 | Building detail panel: recipe, buffers, throughput, why it is stopped | DONE | P2-T02 | Pure `panelModel(snapshot, id)` tested without a DOM; every number equals the engine's; the stop reason names the actual cause (`powerThrottle`, missing input, output full) | Q-10's pattern, established here for the five panels that follow: `buildingPanelModel(snap)` is its own module, pure, tested without a DOM, and composed into `hudModel` rather than growing it. The stop reason is the engine's `buildingConcern` code turned into a sentence — six codes, six *different things to do about it*, and throttled is a warning rather than a stop because the factory is producing, just slower. Energy is dropped from the recipe text: it is a power flow, not a hauled good, and listing it sends a player looking for energy to haul |
| P2-T10 | Market panel | DONE | P2-T03 | Every price equals `unitPrice`/`quoteSell`; a trade goes through `buy`/`sell` and the panel shows the engine's result rather than its own arithmetic; `TRADE_LOT` and the glut/pressure bounds are visible, not implied | Every price is `unitPrice`'s or `quoteSell`'s. The one that matters is **`sellLotProceeds`, which is `quoteSell`'s dry run of the real lot walk, not `sellUnit × TRADE_LOT`** — `sell` slips the price between lots, so a big order earns strictly less than the multiplication says, and it is wrong by *more* the larger the order. Upstream already solved it; a panel that multiplied would be wrong exactly when the player is paying attention. Reads engine `State` rather than the snapshot: prices are read when a panel is open, not 20 times a second, and widening the snapshot for them would put 23 more numbers a tick behind a panel most players have closed |
| P2-T11 | Research / tech UI | DONE | P2-T03 | Available, queued, in-progress and locked match the engine's gating exactly, swept over all of `TECHS`; cancel returns what the engine says it returns | `canStart` is a **dry run of `researchTech` itself**, called and undone, not a copy of its six-step gating — one of those steps is "a prerequisite counts as met if it is queued ahead on this same Datacenter", which nobody would think to copy. Tested by sweeping ALL of `TECHS` and comparing against the engine node by node, because one node's gating drifting while the rest look fine shows up to the player as a button that does nothing. The dry run restores the queue **in place**: replacing the array left the caller holding a reference to the mutated one, which surfaced as a third tech in a queue of two |
| P2-T12 | Refinery doctrines UI | BLOCKED | P2-T03 | Selecting a doctrine changes exactly what the engine changes; the panel states the trade-off in the engine's own numbers | |
| P2-T13 | Logistics panel: haulers, priorities, upkeep | DONE | P2-T03 | `LOGI_PRIORITIES` round-trip through the UI; `countLogistics` and `aiUpkeepRate` shown per owner; a priority change re-targets the next assignment, asserted on `assignHaul` | **`countLogistics` could not be used, and finding out why matters more than the panel does.** It looks exactly like the query this wants and is a *mutator* — it walks every unit's order and writes `haulers`/`servers`/`ferriers` tallies onto buildings. Calling it from a panel would have the view writing sim state on a frame: an ADR-0008 violation and a determinism bug that would appear only while a panel happened to be open. The model counts read-only instead. Counting an order is observation; `assignHaul`'s decision about which building deserves the next worker stays in the engine |
| P2-T14 | Supply and Habitats in the HUD | DONE | P2-T01 | Supply used/cap match `supplyUsed`/`supplyCap`; being supply-blocked is stated, not left to be inferred from a failed click | Closed. Being supply-blocked is now *stated* — the MVP showed "3 / 3" and let the player discover the cap by clicking a train button that did nothing. A cap of zero is a real state at the start of a match and would have put `Infinity` into a progress bar's width |
| P2-T15 | Repair and recycling UI | PARTIAL | P2-T03 | Recycle shows `recycleValue` before committing and is cancellable; repair targeting matches `pickRepairTarget` | Recycle half is done: the preview is `recycleValue`'s own number, which counts a fraction of the build cost **plus everything in the entity's buffers** — a factory holding 30 metals refunds those too, and a panel guessing from the build cost would understate a full building badly, with the player finding out only after it was gone. **Repair UI is not built**: `NEEDS_REPAIR`/`HEALED` hysteresis still needs to be visible or menders will look indecisive |
| P2-T16 | Plasma Rig survey and yield UI | BLOCKED | P2-T03 | `rigSurvey` results render inside `SURVEY_RADIUS`; the rolled `YIELD_TIERS` tier is shown from `rigInfo`, never re-derived | The one building whose value depends on *where* it is put, so the survey has to be readable at placement time (P1-T18's ghost) |
| P2-T17 | The remaining commodity/resource node meshes | BLOCKED | P1-T06 | Ice, gas, biomass, spice and relics nodes are distinguishable from ore/crystals/radioactives at camera distance | `PLASMA_VEINS` names six vein types; the MVP renders three |
| P2-T18 | Perf: the Phase 2 scene and its gate | **BLOCKED — the criterion fails** | P2-T04, P2-T06 | 300 buildings across all 29 types plus 200 units holds the T0 budget; draw calls asserted | **Draw calls: proven at 28, exactly the ceiling** (`test/view/economy-draw-calls.test.ts`). **Frame time: the budget does NOT reliably hold.** Two runs of the new `P2` scene measured p95 **31.9 ms and 35.2 ms against 33 ms** — straddling it. The shape says where the cost is: p50 is 0.27 ms and `sim per frame` is ~10 ms, so the p95 is the frames a simulation tick lands on, not rendering. Triangles are 16k and draw calls 27, both comfortable. **This is the engine's cost at 300 buildings, not the view's** — which means ADR-0006's budget was written assuming rendering is the constraint, and at Phase 2 content it is not. Under ADR-0003 the fix would be upstream, not here. Measured on a container running ~37% slower than when it recorded its own baseline hours earlier, so the GitHub-runner number is the one that decides it |
| P2-T19 | Determinism fixture extended with economy orders | BLOCKED | P2-T03 | The recorded replay includes research, market, recycle and priority orders and hashes identically | Re-record with `RECORD_FIXTURE=1` in its own commit (P1-T21's rule) — never hand-edit the fixture |
| P2-T20 | Phase 2 playtest script + one recorded session | BLOCKED | P2-T09 … P2-T16 | Script exists; a tester runs the full chain to machinery without help, or a follow-up task is filed | The Phase 2 equivalent of P1-T24, and it will be the gate again |

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
| Q-07 | Do per-building commodity buffers cross the bridge every tick, or only for the selection? | Phase 2 (P2-T02) | OPEN — 23 commodities × 300 buildings is 6 900 floats a tick against a snapshot designed for ~5 columns per entity. Recommendation: totals for all buildings, full buffers for the selection, because only the selection has a panel to read them |
| Q-08 | Power/electrification: a second low-res field texture like fog, or a projected overlay? | Phase 2 (P2-T06) | OPEN — `POWER_TIERS` is a distance field, the same shape as fog, and fog's texture + version counter already satisfies ADR-0006's "one lookup, not per-entity branching". Recommendation: reuse it |
| Q-09 | 29 building types × 2 owners breaks "one draw call per (mesh, owner)". Merge rare types, or raise the budget? | Phase 2 (P2-T18) | OPEN — ~58 building draws against 15 measured for the whole MVP scene. The answer decides whether PRD §5's "300 buildings" exit criterion is reachable at T0 |
| Q-10 | One pure model per panel, or one growing `hudModel`? | Phase 2 (P2-T09) | OPEN — six or more panels are coming. Recommendation: one model per panel, composed, so a panel's logic test does not have to build the whole HUD |
| Q-03 | Starmap: true 3D scene or 2.5D diagram? | Phase 4 | OPEN |
| Q-04 | Ship Observer Mode, or is a free camera enough? | Phase 5 | OPEN |
| Q-05 | Ever bridge the 3D view back into the 2D repo? | any | OPEN — recommendation: no |
| Q-06 | Audio: reuse upstream procedural WebAudio, or none? | Phase 6 | OPEN |
