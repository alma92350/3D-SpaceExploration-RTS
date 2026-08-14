# Stellar Frontier: Odyssey 3D

A 3D-rendered version of the **Odyssey** open-world mode from
[**alma92350/SpaceExploration-RTS**](https://github.com/alma92350/SpaceExploration-RTS) — land on a
world with a colony ship, build an industrial base, deal with the neighbour who lives there, raise a
Spaceport, and jump on across an eleven-world galaxy that keeps running without you.

**Status: planning.** The repository currently contains the PRD, the architecture decisions and the
task board. No code yet — Phase 0 is the first thing to build, and
[`docs/planning/TASKS.md`](docs/planning/TASKS.md) says exactly what that means.

---

## Start here

| You want to… | Read |
|---|---|
| Know what we are building and why | [`docs/PRD.md`](docs/PRD.md) |
| Pick up a task and ship it | [`docs/planning/WORKING-AGREEMENT.md`](docs/planning/WORKING-AGREEMENT.md) → [`docs/planning/TASKS.md`](docs/planning/TASKS.md) |
| Know where the project stands | [`docs/planning/ROADMAP.md`](docs/planning/ROADMAP.md) |
| Understand a technical choice | [`docs/adr/`](docs/adr/) |
| Look up a game rule, world, unit or number | [`docs/reference/universe.md`](docs/reference/universe.md), then the source repo |

## The three things that shape this project

1. **We do not rewrite the game.** The source repo's simulation — deterministic, DOM-free, ~15.6k
   lines behind ~41k lines of tests — is vendored here **unmodified** and reused as a headless core.
   The 3D client is a *view*. Rule changes go upstream first. ([ADR-0003](docs/adr/0003-vendor-the-2d-engine-as-the-simulation-core.md))

2. **The simulation stays 2D; 3D is a projection.** Entity positions remain `(x, y)`; elevation is
   derived from the terrain grid the engine already has. Nothing in the sim knows the camera exists.
   ([ADR-0004](docs/adr/0004-the-simulation-stays-2d.md))

3. **It must run with no GPU at all.** 30 fps at 1280×720 with 200 units under a software
   rasteriser is a hard requirement, gated in CI from day one — before any content exists. That
   constraint decides the rendering architecture: instancing, zero per-frame allocation, no
   textures, no post-processing, and a Canvas2D fallback for machines with no WebGL at all.
   ([ADR-0005](docs/adr/0005-rendering-stack-and-the-renderer-port.md),
   [ADR-0006](docs/adr/0006-cpu-only-performance-budget.md))

## How work happens

- **TDD is mandatory** — the test comes first, it must fail for the right reason, and production
  behaviour without a test that would have failed before it does not merge.
  ([ADR-0009](docs/adr/0009-test-strategy.md))
- **Every architectural decision is recorded as an ADR before the code.**
  ([ADR-0001](docs/adr/0001-record-architecture-decisions.md))
- **Development is phased**, each phase with measurable exit criteria and a demo. Phase 1 is the
  MVP: one world, playable in 3D, enough to judge the idea.
- **The task board is the project's memory.** Claim a task in a commit, leave a note a stranger
  could continue from, update it in the same PR as the code.

## Planned stack

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
