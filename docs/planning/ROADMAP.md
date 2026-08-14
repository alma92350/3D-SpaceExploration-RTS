# Roadmap — status view

The **definitions** of the phases (scope, exit criteria, demo) live in [`../PRD.md`](../PRD.md) §5.
This file is the live status: where we are, what gate is next, and what has been signed off.
Update it at every phase transition.

## Where we are

| Phase | State | Gate |
|---|---|---|
| **0 — Foundation** | **IN PROGRESS** — docs and ADRs merged; scaffolding not started | Not met |
| 1 — MVP: one world in 3D ⭐ | Not started | — |
| 2 — The economy | Not started | — |
| 3 — Combat and the opponent | Not started | — |
| 4 — The galaxy | Not started | — |
| 5 — The long game | Not started | — |
| 6 — Polish and release | Not started | — |

## Sequencing rules

- **Phases are gates, not suggestions.** A phase's exit criteria are checked and recorded below
  before the next phase's tasks move to `READY`.
- **Within a phase, parallelise.** The dependency column in [`TASKS.md`](TASKS.md) is the only
  ordering constraint that matters.
- **A phase is decomposed into tasks at the end of the previous phase's gate review**, not up
  front — except Phases 0 and 1, which are decomposed now because they define the MVP.
- **Perf and determinism gates run continuously**, not at the phase boundary. A phase gate simply
  confirms they are still green with that phase's content.

## Gate reviews

Record each gate review here: date, who, evidence (the CI run, the perf numbers, the playtest), and
anything the review deferred.

### Phase 0 gate — *not yet held*

Checklist (from PRD §5):

- [ ] `npm test` green, ≥ 1 test in each of the three layers (ADR-0009)
- [ ] `npm run test:sim` runs the vendored upstream suite unmodified, green
- [ ] `npm run sync:engine` reports in sync; a local edit to vendored code fails CI
- [ ] `npm run perf` prints a budget report and fails on a seeded regression
- [ ] CI runs test + typecheck + perf + build + bundle size on every push and PR
- [ ] Phase 1 fully decomposed with testable definitions of done
- [ ] ADRs 0001–0009 merged and indexed

### Phase 1 gate (MVP) — *not yet held*

Checklist (from PRD §4.2 and §5):

- [ ] S1 playtest: land, build, train, destroy — passes
- [ ] S2: 30 fps, 1280×720, 200 units, **software rendering** — perf gate green
- [ ] S3: 60 fps, 1600×900, 400 units, integrated GPU — perf gate green
- [ ] S4: determinism fixtures bit-identical across three machines
- [ ] S5: cold load ≤ 5 s on 10 Mbit
- [ ] S6: 3 of 5 playtesters found the build menu unaided
- [ ] Every MVP input has a logic-layer test; the render layer has contract tests
- [ ] Decision recorded on Q-01 and Q-02

## Deliberately deferred

Things we have decided **not** to do yet, so nobody re-proposes them by accident:

| Item | Deferred to | Why |
|---|---|---|
| Sim in a Web Worker | When the perf gate demands it | ADR-0008 — the seam exists; the move is one module |
| Skirmish, competitions, scenarios | Out of scope entirely | ADR-0002 |
| Authored 3D art / glTF pipeline | Post-MVP at the earliest | ADR-0005 — procedural, no pipeline |
| Shadow maps, post-processing | T3 only, Phase 6 | ADR-0006 |
| Mobile / touch | Post-Phase 6 | PRD §3.2 |
| Pixel-diff visual regression tests | Only if visual regressions actually bite | ADR-0009 |
