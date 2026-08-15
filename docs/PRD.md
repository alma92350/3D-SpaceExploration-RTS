# PRD — Stellar Frontier: Odyssey 3D

**Status:** Draft 1 (approved to start Phase 0)
**Owner:** @alma92350
**Last updated:** 2026-08-14
**Supersedes:** nothing. **Superseded by:** nothing.

---

## 0. How to read this document

This is the authoritative statement of **what** we are building and **in what order**. It does not
decide **how** — every technical choice lives in an [ADR](adr/) and is linked from here. If this
document and an ADR disagree, the ADR is newer and wins; open a PR to fix this document.

| If you are… | Read |
|---|---|
| An agent picking up work | [`planning/WORKING-AGREEMENT.md`](planning/WORKING-AGREEMENT.md), then [`planning/TASKS.md`](planning/TASKS.md) |
| Deciding scope for a phase | §5 (Phases) and §6 (Requirements) here |
| Looking for game rules / lore | [`reference/universe.md`](reference/universe.md) and the source repo (§2) |
| About to make a technical choice | [`adr/README.md`](adr/README.md) — write an ADR **before** the code |

---

## 1. Summary

**Stellar Frontier: Odyssey 3D** is a browser-based, single-player, real-time strategy game: a
**3D-rendered** presentation of the **Odyssey** open-world mode from
[`alma92350/SpaceExploration-RTS`](https://github.com/alma92350/SpaceExploration-RTS).

You land on one world of an eleven-world galaxy with a colony ship, found a base, mine, build an
industrial economy, deal with (or destroy) the neighbour who lives there, build a Spaceport, and
jump on. The worlds you leave keep running without you. There is no win condition — the Odyssey is
a play-forever sandbox whose progress is marked by milestones — and no permanent defeat.

The 2D original already contains a complete, deterministic, DOM-free simulation of all of that
(~15.6k lines of engine, ~41k lines of tests). **This project does not rewrite the game. It
replaces the view.** The simulation is reused as a headless core; everything new is presentation,
input, and the UI shell.

### The one-sentence goal of the MVP

> A player can land on a world, see it in 3D, order units around it, build a base, and fight —
> at 30 fps on a laptop with **no GPU at all** — and come away with a feel for what the game is.

---

## 2. Source of truth for the universe

The game universe — worlds, factions, units, buildings, commodities, economy, diplomacy, AI
behaviour, and every balance number — is defined by the source repository:

> **https://github.com/alma92350/SpaceExploration-RTS**

Rules:

1. **The source repo is canonical.** Where this project and the source repo disagree about a
   number, a rule, or a behaviour, the source repo is right and this project has a bug.
2. **Do not fork the rules.** A gameplay change belongs upstream first (PR to
   `SpaceExploration-RTS`), then arrives here through the vendoring sync (ADR-0003).
3. [`reference/universe.md`](reference/universe.md) is a **convenience digest** of the universe so
   an agent does not need both repos open. It is a copy, and copies rot — treat a conflict between
   it and the source repo as a bug in the digest.
4. Lore beyond the RTS (the turn-based ancestor,
   [`alma92350/SpaceExploration`](https://github.com/alma92350/SpaceExploration)) is background
   only; nothing depends on it.

---

## 3. Scope

### 3.1 In scope

- **Odyssey mode only** — the galaxy meta-layer plus the per-world real-time game it wraps.
- Single-player against the existing scripted AI.
- Browser delivery. Desktop-first (mouse + keyboard).
- A 3D presentation of the per-world battlefield and of the galaxy map.
- Save/load parity with the source repo's Odyssey save (`GALAXY_SAVE_VERSION`).

### 3.2 Explicitly out of scope (for now)

| Out | Why |
|---|---|
| Skirmish mode, match clock, score victory | ADR-0002 — Odyssey is the product; skirmish is a different game loop with its own UI surface |
| Competitions, ELO, tournaments, the AI genome editor | Large, self-contained subsystems that add no 3D value |
| Scenarios (escort / raider / bounty) | Not part of Odyssey |
| Multiplayer, netcode, accounts, servers | No server exists; determinism makes it *possible* later, not planned |
| Mobile / touch controls | Desktop input first; revisit after MVP |
| Authored 3D art (textures, rigs, animation clips) | ADR-0005 — procedural low-poly, no asset pipeline |
| VR / stereo | No |

Anything out of scope that later looks essential gets an ADR, not a quiet commit.

---

## 4. Users, goals, and success

### 4.1 Who this is for

- **P1 — The returning 2D player.** Knows the Odyssey; wants to *see* it. Judges the project on
  whether the world reads as well in 3D as it did top-down.
- **P2 — The new RTS player on modest hardware.** Office laptop, integrated graphics or a
  VM/thin client with **software rendering only**. Judges the project on whether it runs at all.
- **P3 — The developer/agent.** Judges the project on whether they can pick up a task and ship it
  without a week of archaeology.

P2 is the constraint that shapes the architecture. See §6.2.

### 4.2 Success criteria

**MVP (end of Phase 1) is successful when all of these are true:**

| # | Criterion | Measured by |
|---|---|---|
| S1 | A player lands on a world, builds a Command Center, trains units, and destroys something | Manual playtest script `docs/playtests/mvp.md` |
| S2 | 30 fps sustained at 1280×720 with 200 units on screen, **software rendering, no GPU** | Automated perf gate in CI (§6.2) |
| S3 | 60 fps at 1600×900 with 400 units on a 2019-or-later integrated GPU | Perf gate, tier T2 |
| S4 | Simulation results are bit-identical to the source repo for the same seed and inputs | Determinism test vs. recorded fixtures |
| S5 | Cold load to interactive ≤ 5 s on a 10 Mbit connection | Lighthouse/`performance` marks in CI |
| S6 | A first-time player understands what to click without documentation | 3 of 5 playtesters found and used the build menu unaided |

**Project-level success (end of Phase 5):** a player can run a full Odyssey session — settle,
trade, fight, jump, conquer, save, reload — entirely in the 3D client, with no feature they miss
from the 2D client badly enough to switch back.

### 4.3 Anti-goals

- **Not a graphical showcase.** Readability beats fidelity, every time. If a effect costs frames
  on P2's machine and does not help the player read the battlefield, it does not ship.
- **Not a rules rewrite.** Balance discussions belong upstream.
- **Not a rebuild of what already works.** Every line of simulation we re-implement is a line of
  tested behaviour we throw away.

---

## 5. Development phases

Each phase is a shippable increment with **entry criteria**, **exit criteria** (measurable, no
judgement calls), and a **demo** — the thing you show someone to prove the phase is done. Phases do
not overlap: a phase's exit gate must be green before the next phase's tasks start. Tasks within a
phase can and should run in parallel across agents.

Task IDs referenced below live in [`planning/TASKS.md`](planning/TASKS.md), which is the live board.

---

### Phase 0 — Foundation (no gameplay)

**Goal:** an empty but *trustworthy* repo: any agent can clone it, run the tests, and know what to
do next.

**Scope**
- Repo scaffolding, toolchain, CI (ADR-0007).
- The vendored simulation core and its sync/drift check (ADR-0003).
- The test harness and the three test layers (ADR-0009): sim, logic, render-contract.
- The perf harness and its CI gate — running under **software rendering** from day one (ADR-0006).
- ADRs 0001–0009 written and merged.
- Task board populated for Phases 0 and 1.
- A black canvas that clears to a colour, proving the render loop and the fixed-timestep clock.

**Exit criteria**
- `npm test` green, ≥ 1 test in each of the three layers.
- `npm run test:sim` runs the **vendored upstream suite unmodified** and is green.
- `npm run sync:engine` reports "in sync"; a deliberate local edit to vendored code fails CI.
- `npm run perf` prints a frame-time budget report and fails on a seeded regression.
- CI runs test + typecheck + perf + build on every push and PR.
- `docs/planning/TASKS.md` has every Phase 1 task written with a testable definition of done.

**Demo:** `npm run dev` → a window, a clear colour, a frame-time counter that reads a stable 16 ms.

---

### Phase 1 — MVP: one world, in 3D  ⭐ *the "get a feel" milestone*

**Goal:** one Odyssey world, playable enough to judge the idea. No galaxy layer.

**Scope**
- **World rendering:** terrain as a heightfield derived from the existing terrain grid (open /
  rough / high ground → three elevations, ADR-0004), map bounds, resource-node meshes, and a dark
  apron past the map edge. *(Amended at the Phase 1 gate: this line asked for a **starfield
  skybox**. It was built, then cut — the camera's pitch ramp puts the top of the view between 9.7°
  and 48.7° below the horizon at every zoom the rig allows, so a skybox is invisible by
  construction. The apron replaces it at the cost of eight quads in the terrain's existing draw
  call. ADR-0010 §5, and revisit if a later phase lowers the pitch floor.)*
- **Entity rendering:** procedural low-poly meshes for the MVP roster — Worker, Skiff, Bastion,
  Lancer, Command Center, Barracks, Habitat, Turret, Refinery — drawn with **GPU/CPU instancing,
  one draw call per (type, owner)** (ADR-0005, ADR-0006).
- **Camera:** RTS camera — pan (edge/WASD/drag), rotate (yaw only, snapped), zoom with pitch
  ramping, clamped to map bounds, plus "focus base" and "focus last alert".
- **Selection & orders:** click, box-select, double-click type-select, move, attack-move, stop,
  hold, patrol; ground picking that agrees with the 2D sim's coordinates to sub-unit precision.
- **Building:** the placement ghost in 3D with validity shading (terrain, collision, build reach).
- **Fog of war** in 3D: unexplored, explored-not-visible, visible.
- **HUD:** resource bar, selection panel, production buttons, minimap, supply, alerts.
- **Simulation:** the vendored engine at a fixed 20 Hz, render interpolation between ticks
  (ADR-0008), a single world created directly (galaxy layer stubbed to "one world, already there").
- **Renderer tiers T0 (compatibility) and T2 (standard)** implemented and switchable, with
  auto-detection (§6.2).
- Save/load of the single world.

**Explicitly deferred to later phases:** jumps, starmap, colonies, credits, diplomacy UI, market,
tech tree UI, the full unit/building roster, wonders, observer mode, audio.

**Exit criteria**
- S1 through **S6** from §4.2 all pass. *(Amended at the Phase 1 gate: this line read "S1, S2, S3,
  S4, S5" and silently dropped S6, which §4.2 lists as an MVP criterion and which is the whole
  point of the playtest. Both S1 and S6 are judged by the same session, so omitting S6 would have
  let the phase close on half a playtest.)*
- Every input in the MVP scope has a test at the logic layer; the render layer has contract tests
  (draw-call counts, instance counts, no per-frame allocation).
- A recorded 10-minute input trace replays to a bit-identical end state on three machines.

**Demo:** land, build a base, train Skiffs, kill the neighbour's Command Center — all in 3D, on a
machine with the GPU disabled.

---

### Phase 2 — The economy

**Goal:** the full per-world build/economy loop that Odyssey actually runs on.

**Scope:** workers gathering and hauling (with visible cargo), the finite-storage logistics loop,
factories and the industrial chain, power/electrification zones, the Market panel, the Refinery
doctrines and the tech/research UI, supply and Habitats, repair and recycling, the remaining
buildings.

*Amended at the Phase 1 gate:* this line described the chain as Reactor → Smelter → Assembler →
Chipfab → Machineworks → Plasma Rig → Antimatter Forge. The engine has **nine** recipes, not seven
— that list omits the **Chemical Plant** (biomass → chemicals) and the **Fabricator** (alloys +
chemicals → consumer goods), which are the whole consumer-goods branch — and four of the nine are
tech-gated (`metallurgy`, `electronics`, `antimatter`, `aicores`), which makes the research UI a
dependency of the chain rather than a side panel. `recipeOf` in `engine/industry.js` is canonical;
the decomposition in `planning/TASKS.md` is built from it.

**Exit criteria:** a player can run the full 2D economy in 3D with no panel missing; every economy
panel has a logic test; perf budgets hold with 300 buildings on screen.

**Demo:** a fully industrialised world producing machinery, seen from orbit-tilt camera.

---

### Phase 3 — Combat and the opponent

**Goal:** fights that read clearly in 3D.

**Scope:** the full unit roster (Ranger, Breacher, Mender, Dreadnought, Wraith, Aegis, Colossus,
Leviathan, freighters, Helium Bomb), veterancy chevrons, combat feedback (tracers, impacts, death,
wreckage, craters), turret tiers, the AI opponent live under its own fog, formations, escorts,
control groups, and the alert system.

*Amended at the Phase 2 gate,* from the vendored engine rather than from this list:

- **Veterancy chevrons were delivered in Phase 1** (P1-T15: `rankOf` plus the chevron overlay, drawn
  by both renderers). They are not Phase 3 work.
- **The unit roster gap is exactly the nine named here**, confirmed against `meshIdForType` — those
  nine have no mesh and silently fall back to the Worker's, so a Dreadnought renders as a Worker
  today. This line is accurate; the fallback is what hid it.
- **"Turret tiers" is not a tier mechanic.** `building.tier` is unrelated. The static-defence ladder
  is four separate building types: `turret` (20 damage / 130 range), `bastille` (32/115, gated on a
  Foundry) and `torpedobattery` (55/180, ammo-fed from `plasmatorp`, gated on Torpedo Works) — plus
  the **Aegis Bastion, which has no attack at all** and is a `guardAura` granting −20% damage taken
  within 130. Three of the four currently share one mesh (ADR-0013).
- **There is no "shot fired" event.** The engine emits thirteen event types and the only combat one
  is `entityKilled`. "Tracers, impacts" therefore has no engine signal behind it and needs a bridge
  decision (Q-12) before it can be built.

**Exit criteria:** a 20-minute AI-vs-player match runs at budget; every combat cue is legible in a
blind readability test; no combat feedback allocates per frame.

**Demo:** a defended base surviving (or not) a three-wave AI attack.

---

### Phase 4 — The galaxy

**Goal:** Odyssey becomes Odyssey — more than one world.

**Scope:** the 3D starmap (worlds in space, claims, stances, alerts), jumps and the Spaceport
staging ring, the landing-site picker rebuilt as a 3D approach view, background worlds (the seeded
bounded draw — see `reference/universe.md` §Living galaxy), colonies and passive income, universal
credits, freight lanes, colony standing orders, cargo holds.

**Exit criteria:** a player can settle a second world and run both; the galaxy save round-trips;
background simulation holds its frame budget while the active world renders.

**Demo:** jump from a settled homeworld to a new one and watch the colony pay you from afar.

---

### Phase 5 — The long game

**Goal:** everything that makes an Odyssey a campaign.

**Scope:** diplomacy (stances, tribute, gifts, favours), the Antimatter Gate and the rival Gate
race, domination milestones and fireworks, the relief mechanic, Observer Mode, the full save/load
UI, settings, onboarding, audio.

**Exit criteria:** feature parity with the 2D Odyssey; the parity checklist in
`docs/planning/PARITY.md` is fully ticked.

---

### Phase 6 — Polish and release

**Goal:** it feels finished.

**Scope:** LOD and effect budgets, accessibility (colour-blind-safe palettes, keyboard-only play,
motion reduction), tutorial, performance passes, error handling, a release build, docs, versioning
(ADR-0022: **no update check** — N-06 wins, and the version is stamped at build time).

---

## 6. Requirements

### 6.1 Functional requirements

Functional behaviour is **inherited**, not invented: the simulation is the source repo's, so the
functional spec for the *rules* is that code and its tests. What this project must specify is the
**presentation and interaction** contract.

| ID | Requirement | Phase |
|---|---|---|
| F-01 | The 3D view renders the exact simulation state — never an approximation, never a state of its own | 1 |
| F-02 | Every entity that exists in the sim and is visible under fog is visible on screen; nothing else is | 1 |
| F-03 | A click on the ground resolves to the same world coordinate the sim would use, ±0.5 world units at any camera angle | 1 |
| F-04 | Every order available in the 2D client is issuable in the 3D client, by mouse and by keyboard | 1–3 |
| F-05 | The camera can never leave the map bounds or clip through terrain | 1 |
| F-06 | Fog of war has three visually distinct states and never leaks information about hidden entities | 1 |
| F-07 | The HUD surfaces every number the 2D HUD surfaced, and no state lives only in the HUD | 1–5 |
| F-08 | Save files interoperate with the source repo's Odyssey saves at the same `GALAXY_SAVE_VERSION` | 1 |
| F-09 | The player can switch renderer tier at runtime without reloading or losing state | 1 |
| F-10 | The galaxy layer renders every world on the roster, live or dormant, without revealing which is which | 4 |

### 6.2 Performance requirements — the CPU-only constraint

**This is the hardest requirement in the project and it is not negotiable.** Persona P2 has no
usable GPU: an office laptop, a VDI session, a browser falling back to SwiftShader/llvmpipe. The
game must be *playable* there, not merely start.

**Budgets** (frame-time, 95th percentile, measured over a 60-second scripted scene):

| Tier | Target hardware | Resolution | Entities | Budget | Sustained |
|---|---|---|---|---|---|
| **T0 Compatibility** | Software rasteriser, no GPU | 1280×720 | 200 units, 80 buildings | 33 ms | 30 fps |
| **T1 Low** | Integrated GPU ≤ 2017 | 1280×720 | 300 / 150 | 16.6 ms | 60 fps |
| **T2 Standard** | Integrated GPU ≥ 2019 | 1600×900 | 400 / 200 | 16.6 ms | 60 fps |
| **T3 High** | Discrete GPU | 2560×1440 | 400 / 200 | 16.6 ms | 60 fps |

Of that budget, the **simulation gets at most 6 ms per rendered frame at T0** (it runs at a fixed
20 Hz, so it is not every frame) and **rendering gets the rest**. Allocation during a steady-state
frame must be zero — no GC pauses in a frame budget this tight.

**Mandated techniques** (details and rationale in ADR-0006):
- One draw call per (mesh, material, owner) via instancing; no per-entity meshes.
- Flat/vertex-coloured materials, no textures, no normal maps, no post-processing at T0/T1.
- Blob shadows at T0/T1; shadow maps only at T3.
- Frustum + distance culling; LOD with billboard imposters beyond a distance threshold.
- Pre-allocated typed-array scratch buffers; no allocation in the render loop.
- Terrain as one static merged mesh, rebuilt only on change (it never changes mid-match).
- Fog of war as a single low-resolution texture/attribute lookup, not per-entity branching.
- The sim runs on a **fixed 20 Hz clock decoupled from rendering**, interpolated (ADR-0008), and is
  worker-ready so it can be moved off the render thread when the budget demands it.

**Tier selection**: auto-detected at boot from renderer strings (`WEBGL_debug_renderer_info`:
SwiftShader / llvmpipe / Mesa software → T0), device memory and core count, then **corrected by
measurement** — if the first 3 seconds miss the budget, drop a tier and tell the player. Always
overridable in settings, and the override persists.

**The CI gate**: headless Chromium in CI runs with software rendering by default, which *is* the
T0 target. The perf suite runs there on every PR and fails the build on a regression beyond 10%.
We do not get to discover the CPU-only problem late.

**The fallback of last resort**: if WebGL is unavailable entirely, the client must still start —
see ADR-0005's Canvas2D fallback renderer, which reuses the source repo's proven 2D drawing at a
reduced feature level rather than showing an error page.

### 6.3 Non-functional requirements

| ID | Requirement |
|---|---|
| N-01 | **Determinism**: identical seed + identical input trace ⇒ identical state, on every machine and tier. The renderer may never write to sim state |
| N-02 | **Test coverage**: no production code merges without a test that failed before it (ADR-0009) |
| N-03 | **Load**: ≤ 5 s cold to interactive on 10 Mbit; ≤ 3 MB gzipped initial payload |
| N-04 | **Browsers**: last two versions of Chrome, Edge, Firefox, Safari. WebGL2 required for 3D tiers; the Canvas2D fallback covers the rest |
| N-05 | **Accessibility**: colour-blind-safe owner/faction palettes, keyboard-navigable UI, a reduced-motion setting, no information conveyed by colour alone |
| N-06 | **No secrets, no telemetry, no network calls** beyond loading the app itself (ADR-0022; enforced by `test/architecture/no-network.test.ts` rather than claimed) |
| N-07 | **Documentation**: every architectural choice has an ADR; every phase has exit criteria; the task board is current at the end of every session |
| N-08 | **Save safety**: saves are untrusted input — sanitised and version-checked exactly as upstream does |

---

## 7. Architecture at a glance

Full rationale in the ADRs; this is the map.

```
┌──────────────────────────────────────────────────────────────────┐
│ app/            boot, session, settings, save/load, scene routing │
├───────────────┬──────────────────────────────────┬───────────────┤
│ ui/           │ view/                            │ input/        │
│ HUD, panels,  │ 3D presentation:                 │ picking,      │
│ starmap UI,   │  renderer port + three.js impl   │ camera rig,   │
│ menus (DOM)   │  + Canvas2D fallback impl        │ hotkeys,      │
│               │  meshes, instancing, fog, LOD    │ order intents │
├───────────────┴──────────────────────────────────┴───────────────┤
│ bridge/        snapshot extraction, interpolation, command queue  │
├──────────────────────────────────────────────────────────────────┤
│ engine/        VENDORED, UNMODIFIED simulation from the 2D repo   │
│                pure, deterministic, DOM-free, 20 Hz fixed step    │
└──────────────────────────────────────────────────────────────────┘
```

Four rules hold this together:

1. **The engine is read-only to everything above it.** The only writes are through the same command
   functions the 2D client uses (`engine/commands.js`). (ADR-0003)
2. **The bridge is the only place that knows both worlds.** `view/` never imports `engine/`
   directly; it consumes snapshots. This is what lets the sim move to a Worker later without
   touching the renderer. (ADR-0008)
3. **`view/` talks to a `Renderer` port, not to three.js.** Two implementations ship: WebGL2 and
   Canvas2D. Tests use a third: a recording fake. (ADR-0005)
4. **The sim is 2D; 3D is a projection.** World coordinates stay `(x, y)`; elevation is derived
   from the terrain grid and is presentation-only. Nothing in the sim knows the camera exists.
   (ADR-0004)

---

## 8. Development methodology

### 8.1 Test-Driven Development is mandatory

**Every behavioural change starts with a failing test.** Not "tests are required" — *test first*.
The loop, per [`planning/WORKING-AGREEMENT.md`](planning/WORKING-AGREEMENT.md):

1. Turn the requirement into a test, written from the requirement, not from a planned
   implementation.
2. Run it. Watch it fail **for the right reason** (missing export, wrong value — not a typo).
3. Write the smallest change that makes it pass.
4. Refactor with the test green.
5. Run the whole suite plus typecheck plus perf before you push.

A PR whose diff adds production behaviour without a test that would have failed before it is
rejected on sight. Exceptions (pure renames, comment-only changes, vendored syncs) are listed in the
working agreement — nowhere else.

The three test layers, what each proves, and what may be mocked are specified in **ADR-0009**.

### 8.2 Planning is mandatory

- No task starts without a written definition of done in the task board.
- A task expected to exceed a day gets a short plan comment on its board entry first — the approach
  and the tests that will prove it — before code.
- Phase boundaries are hard gates: exit criteria are checked and recorded before the next phase
  opens.

### 8.3 Architecture decisions are recorded

Any decision that is **hard to reverse**, **affects more than one module**, or **future readers
will ask "why on earth"** gets an ADR **before** the code that implements it. Format, numbering and
lifecycle: [`adr/README.md`](adr/README.md). "I'll document it after" is how the CPU-only
requirement gets forgotten.

### 8.4 Task follow-up so a new agent can pick up work

The board is [`planning/TASKS.md`](planning/TASKS.md). Every task carries: a stable ID, its phase,
status, dependencies, a testable definition of done, and — once someone starts — a one-line running
note. An agent picking up work:

1. Reads the working agreement (once).
2. Takes the top `READY` task whose dependencies are `DONE`.
3. Sets it `IN-PROGRESS` **in a commit** with their session id, so two agents do not collide.
4. Ships it TDD-first, updates the note, sets it `DONE` in the same PR as the code.

State that lives only in a conversation is state that is lost. The board is the memory.

---

## 9. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **CPU-only budget is unmeetable at 3D fidelity** | Project premise fails for P2 | Budget-first: the perf gate runs in CI from Phase 0, before any content exists. Tier T0 is allowed to look plain. Canvas2D fallback is a real product path, not a stub (ADR-0005) |
| R2 | **The 3D view is less readable than the 2D view** | Players prefer the original | Readability tests in every phase gate; yaw-snapped camera and a top-down-ish default pitch; silhouettes carried over from the 2D vector art |
| R3 | **Vendored engine drifts from upstream** | Bugs diverge, fixes lost | `npm run sync:engine` + a CI drift test; local edits to vendored code fail the build (ADR-0003) |
| R4 | **Picking/precision mismatch** between 3D rays and 2D sim coordinates | Orders land in the wrong place | F-03 has a dedicated test suite across camera angles and elevations from Phase 1 |
| R5 | **Scope creep into skirmish/competitions** | MVP slips | ADR-0002 states the scope; anything else needs a superseding ADR |
| R6 | **three.js version churn / bundle size** | Load-time budget breaks | Pinned version, a size budget enforced in CI, tree-shaken imports only (ADR-0007) |
| R7 | **Sim on the render thread stalls frames at T0** | Stutter on the target machine | Worker-ready seam from day one; flip when the budget demands it (ADR-0008) |
| R8 | **Agent hand-off loses context** | Rework, contradictory designs | This document + ADRs + the board; the working agreement's "leave it pickup-able" rule |

---

## 10. Open questions

These need an answer before the phase in brackets. Track them as `Q-nn` on the board.

- **Q-01 [Phase 1] — ANSWERED (ADR-0010 §1): snapped to 8.** Snapping costs expressiveness and
  buys enormous readability and instancing wins. Pitch is not a separate control; it ramps with
  zoom. Revisit in Phase 6 against a readability test, not an opinion.
- **Q-02 [Phase 1] — ANSWERED (ADR-0010 §2): fixed, and the world is `helix`, not `ferros`.**
  Fixed so playtests compare like with like. The world named here originally does not survive
  contact with the terrain data — Ferros Prime's grid is uniformly open, zero rough cells and zero
  high ground, so an MVP built on it renders a flat plane and demonstrates none of the relief that
  is the point of the exercise. Only six of the eleven worlds carry terrain stamps at all. Phase 4
  turns the seed's own draw on when the landing picker exists.
- **Q-07 [Phase 2]** Do per-building commodity buffers cross the bridge every tick, or only for the
  selected building? *Recommendation: totals for every building, full buffers for the selection —
  only the selection has a panel that can read them.*
- **Q-08 [Phase 2]** Are power/electrification zones a second low-res field texture like fog, or a
  projected overlay? *Recommendation: reuse the fog machinery; it is the same shape of problem and
  already satisfies §6.2's "one lookup, not per-entity branching".*
- **Q-09 [Phase 2]** 29 building types across 2 owners breaks "one draw call per (type, owner)".
  Merge rarely-seen types onto a shared mesh, or raise the budget? *This decides whether Phase 2's
  "300 buildings on screen" exit criterion is reachable at T0.*
- **Q-10 [Phase 2]** One pure model per panel, or one growing `hudModel`? *Recommendation: one per
  panel, so a panel's logic test does not have to build the entire HUD.*
- **Q-03 [Phase 4]** Is the starmap a true 3D scene, or a 2.5D orbital diagram? The 2D client's
  starmap is an information display, and information displays rarely improve in 3D.
- **Q-04 [Phase 5]** Do we ship the 2D client's Observer Mode, or is a 3D free camera enough?
- **Q-05 [any]** Do we ever want the reverse bridge — this repo's 3D view as an option inside the
  2D repo? *Recommendation: no. One direction of dependency.*
- **Q-06 [Phase 6]** Audio: reuse the source repo's procedural WebAudio, or none for now?

---

## 11. Glossary

Universe terms (Odyssey, seat, colony, pacified, the Gate, …) are defined in
[`reference/universe.md`](reference/universe.md). Project terms:

| Term | Meaning |
|---|---|
| **Sim / engine** | The vendored deterministic simulation from the source repo |
| **Snapshot** | The read-only, per-tick view of sim state the renderer consumes |
| **Bridge** | The layer that turns sim state into snapshots and player intents into engine commands |
| **Renderer port** | The interface `view/` draws through; implementations: WebGL2, Canvas2D, recording fake |
| **Tier (T0–T3)** | A performance/quality preset, auto-detected and overridable |
| **Phase gate** | The measurable exit criteria a phase must meet before the next starts |
