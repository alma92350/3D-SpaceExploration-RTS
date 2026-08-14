# Stellar Frontier: Odyssey 3D

A 3D-rendered version of the **Odyssey** open-world mode from
[**alma92350/SpaceExploration-RTS**](https://github.com/alma92350/SpaceExploration-RTS) — land on a
world with a colony ship, build an industrial base, deal with the neighbour who lives there, raise a
Spaceport, and jump on across an eleven-world galaxy that keeps running without you.

**Status: Phase 1 (MVP) built, awaiting its playtest.** One world, in 3D: land, deploy, mine, build,
train, fight — at 30 fps on a machine with no GPU at all. The galaxy layer, the economy chain, the
full roster and everything else are Phases 2–6. What is done, what is not, and what the next session
should pick up: [`docs/planning/TASKS.md`](docs/planning/TASKS.md).

---

## Run it

```sh
npm ci
npm run dev          # http://localhost:5173
```

You land on **Helix Belt** with a colony ship and nothing else. Select it, press **Deploy base**,
and the Odyssey starts.

| | |
|---|---|
| Left-click / drag | select · box-select |
| Right-click | move · attack · gather (decided by what is under the cursor) |
| `Z` `A` `X` `H` `R` | deploy · attack-move · stop · hold · patrol |
| `WASD`, arrows, screen edge, middle-drag | pan |
| `,` `.` · wheel · `Space` | rotate · zoom (and tilt) · focus base |

The **T0–T3** buttons in the sidebar force a graphics tier; the choice persists. T0 is what a
machine with no GPU gets automatically.

## Start here

| You want to… | Read |
|---|---|
| Know what we are building and why | [`docs/PRD.md`](docs/PRD.md) |
| Pick up a task and ship it | [`docs/planning/WORKING-AGREEMENT.md`](docs/planning/WORKING-AGREEMENT.md) → [`docs/planning/TASKS.md`](docs/planning/TASKS.md) |
| Know where the project stands | [`docs/planning/TASKS.md`](docs/planning/TASKS.md) § Phase 1 exit gate |
| Understand a technical choice | [`docs/adr/`](docs/adr/) |
| Look up a game rule, world, unit or number | [`docs/reference/universe.md`](docs/reference/universe.md), then the source repo |

## The three things that shape this project

1. **We do not rewrite the game.** The source repo's simulation — deterministic, DOM-free, ~15.6k
   lines behind ~41k lines of tests — is vendored here **unmodified** and reused as a headless core.
   The 3D client is a *view*. Rule changes go upstream first.
   ([ADR-0003](docs/adr/0003-vendor-the-2d-engine-as-the-simulation-core.md))

2. **The simulation stays 2D; 3D is a projection.** Entity positions remain `(x, y)`; elevation is
   derived from the terrain grid the engine already has. Nothing in the sim knows the camera exists.
   ([ADR-0004](docs/adr/0004-the-simulation-stays-2d.md))

3. **It must run with no GPU at all.** 30 fps at 1280×720 with 200 units under a software
   rasteriser, gated in CI. That constraint decides the rendering architecture: instancing, zero
   per-frame allocation, no textures, no post-processing, and a Canvas2D fallback for machines with
   no WebGL at all. ([ADR-0005](docs/adr/0005-rendering-stack-and-the-renderer-port.md),
   [ADR-0006](docs/adr/0006-cpu-only-performance-budget.md))

## Layout

```
src/app/       boot, the fixed-step loop, settings, renderer selection
src/bridge/    the ONLY layer that knows both worlds: snapshots out, commands in
src/view/      the 3D presentation — renderer port, three.js and Canvas2D impls, meshes, terrain
src/input/     camera rig, ray→ground picking, gesture→intent translation
src/ui/        HUD and minimap, plain DOM
src/engine/    VENDORED, UNMODIFIED simulation from the 2D repo — do not edit (CI fails on drift)
test/          Vitest: logic + render-contract + architecture + determinism
e2e/           Playwright: smoke, no-WebGL fallback, renderer conformance, the T0 perf gate
perf/          the scripted perf scene, its harness and its committed baseline
```

Two rules the tests enforce rather than trust: `view/` never imports `engine/`, and nothing crossing
the bridge carries a `z`. See [`test/architecture/layering.test.ts`](test/architecture/layering.test.ts).

## Scripts

| Command | What it checks |
|---|---|
| `npm run dev` / `npm run build` | Vite dev server / production bundle |
| `npm run typecheck` | TypeScript, strict |
| `npm test` | logic, render-contract, architecture and determinism tests (Vitest) |
| `npm run test:sim` | the **vendored upstream suite**, unmodified (`node --test`) — 1,483 tests |
| `npm run check:vendor` | the vendored engine is byte-identical to upstream (offline) |
| `npm run sync:engine` | pull a newer upstream ref and re-pin it |
| `npm run perf` | CPU-side frame budget against `perf/baseline.json` |
| `npm run smoke` | Playwright: smoke, conformance, and the T0 budget under a software rasteriser |
| `npm run check:size` | 3 MB payload budget + the three.js import surface |
| `npm run check:adr` | every ADR is in the index with a status |

## CI

Six jobs, each failing independently so a red build says *which* promise broke:
**verify** (typecheck · tests · vendored sim suite · build) · **vendor** (drift) · **perf** ·
**browser** (smoke · conformance · T0 budget) · **size** · **docs**.

## How work happens

- **TDD is mandatory** — the test comes first, it must fail for the right reason, and production
  behaviour without a test that would have failed before it does not merge.
  ([ADR-0009](docs/adr/0009-test-strategy.md))
- **Every architectural decision is recorded as an ADR before the code.**
  ([ADR-0001](docs/adr/0001-record-architecture-decisions.md))
- **Development is phased**, each phase with measurable exit criteria and a demo.
- **The task board is the project's memory.** Claim a task in a commit, leave a note a stranger
  could continue from, update it in the same PR as the code.

### Changing the simulation

You cannot, here. `src/engine/**` is upstream's, vendored byte-for-byte, and CI fails on any local
edit. A behaviour change is a PR to
[SpaceExploration-RTS](https://github.com/alma92350/SpaceExploration-RTS), then
`npm run sync:engine -- --ref=<new-ref>` here, then re-record the determinism fixture
(`RECORD_FIXTURE=1 npx vitest run test/determinism/record.test.ts`) in its own commit naming the
ref. Anything the 3D client needs that the engine does not expose is added **above** the boundary,
in `src/bridge/`.

## Stack

TypeScript (strict) · Vite · Vitest · three.js (WebGL2) behind a swappable renderer port, plus a
Canvas2D fallback · the vendored engine as plain ES modules · Playwright for browser smoke and the
CPU-only perf gate. Exactly one runtime dependency, pinned; adding another needs an ADR.
([ADR-0007](docs/adr/0007-toolchain-and-dependency-policy.md))

## Scope

**In:** the Odyssey, single-player, desktop browser.
**Out:** skirmish mode, competitions/ELO, scenarios, multiplayer, mobile, VR.
([ADR-0002](docs/adr/0002-scope-odyssey-only.md))

## Related repositories

- [alma92350/SpaceExploration-RTS](https://github.com/alma92350/SpaceExploration-RTS) — the source
  of the universe and of the simulation. **Canonical for every game rule.**
- [alma92350/SpaceExploration](https://github.com/alma92350/SpaceExploration) — the turn-based
  ancestor. Background lore only.
