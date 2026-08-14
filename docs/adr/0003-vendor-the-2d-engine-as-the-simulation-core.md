# ADR-0003: Vendor the 2D engine, unmodified, as the simulation core

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §2, §7; ADR-0004, ADR-0008

## Context

The source repo's `engine/` is ~15,600 lines of simulation with ~41,000 lines of tests behind it,
and it was built under three invariants that happen to be exactly what a second front-end needs:

- **Pure and deterministic** — all randomness from a seeded PRNG, no `Math.random`, no clocks.
- **DOM-free** — no `document`, `window`, or browser globals; its own contributing guide states the
  goal that it "could one day run server-side (netcode, replays)".
- **Guarded** — purity, determinism and static-integrity tests fail the build if any of that slips.

Re-implementing it for a 3D client would mean re-deriving gathering, hauling, combat, veterancy,
diplomacy drift, AI archetypes, faction spread, market pricing, save sanitisation — and re-earning
41k lines of tests. Every line re-implemented is tested behaviour thrown away and a place for the
two games to disagree about their own universe.

The question is therefore not *whether* to reuse it, but *how* to hold a copy without the two
repos drifting apart.

## Decision

We will **vendor `engine/` (plus `data.js`) from the source repo into `src/engine/`, byte-for-byte
unmodified**, together with its test suite, and treat it as read-only third-party code.

- A script, `npm run sync:engine`, pulls a pinned upstream ref, copies the tracked file list, and
  records the upstream commit in `src/engine/VENDOR.json`.
- A CI check re-runs the copy and fails if the working tree differs — **a local edit to vendored
  code breaks the build**.
- The vendored upstream tests run in CI as `npm run test:sim`, unmodified.
- **Changes to simulation behaviour go upstream first** (a PR to `alma92350/SpaceExploration-RTS`),
  then arrive here through a sync that bumps the pinned ref.
- Anything the 3D client needs that the engine does not expose is added **above** the boundary, in
  `src/bridge/` — never by patching vendored code.

## Consequences

**This makes easy:**
- Phase 0 starts with a complete, tested game already running headlessly.
- Upstream bug fixes and balance changes arrive as a one-line ref bump.
- The universe cannot fork: there is exactly one implementation of the rules.

**This makes hard / gives up:**
- We cannot make a local engine change to unblock ourselves — the upstream round trip is real
  friction, deliberately.
- We inherit upstream's shape whether it suits a 3D view or not (e.g. `Map`-based state, mutation in
  place). ADR-0008's snapshot boundary is where we absorb that.
- Vendored code is JavaScript with JSDoc types, while new code is TypeScript (ADR-0007): the
  boundary needs hand-written declarations, which can drift from the JS. Mitigated by a type-level
  test that instantiates the real engine through the declarations.

**Obligations it creates:**
- `scripts/sync-engine.mjs` and the drift check exist before any view code (`P0-T03`, `P0-T04`).
- `src/engine/VENDOR.json` records the upstream commit, and the README says how to bump it.
- Declarations in `src/engine/engine.d.ts` are covered by a compile-time test (`P0-T05`).

## Alternatives considered

### Git submodule / npm dependency on the source repo
Cleaner in principle. Rejected for now because the source repo publishes no package and has no
build step; a submodule adds a checkout mode that agents and CI get wrong more often than a copy
plus a drift check. Revisit if the source repo ever publishes.

### Fork the engine and evolve it here
The fastest way to a 3D client and the fastest way to two divergent games. It also strands the 2D
client's 41k lines of tests, which are the actual asset. Rejected.

### Rewrite the simulation in TypeScript
Attractive for type safety across the whole codebase, and the single most expensive option on the
table — a full re-derivation of behaviour whose only proof of correctness is a test suite written
against the original. Rejected. If the engine ever becomes TypeScript, that happens upstream.

### Run the 2D client's engine over a network/IPC boundary
Absurd for a single-player browser game. Noted only because the "sim as a service" shape does show
up in the Worker decision (ADR-0008), where it is in-process.
