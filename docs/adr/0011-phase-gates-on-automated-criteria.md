# ADR-0011: Phases close on their automated criteria; the human and GPU gates are deferred

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §4.2 (S1–S6), §5 (phase gates); ADR-0006, ADR-0009

## Context

PRD §5 says a phase's exit gate must be green before the next phase's tasks start, and Phase 1's
gate has three criteria that no amount of code can close:

| | Needs |
|---|---|
| S1, S6 | five playtesters in a room |
| S3 | a 2019-or-later integrated GPU |
| S4 (fully) | two more machines to compare a hash on |

Everything else is green and measured: S2 at p95 17.7 ms against 33 ms, S5 at 331 ms against 5 s,
S4 reproducible in CI, and the whole S1 chain automated end to end in `e2e/smoke.spec.ts`.

Held strictly, the rule stops the project on three items that are not about the software's
correctness at all — they are about who is available to look at it. Held loosely, "the gate is
green" stops meaning anything and the phases become labels.

## Decision

**1. A phase closes when every criterion that CI can decide is green.** Criteria that require a
person or hardware CI does not have are *deferred*, not waived: they stay on the board, unticked,
in a standing "Deferred verification" section, and they are named in the phase's closing commit.

**2. The CPU-only target is the whole target for now.** ADR-0006's T0 — 200 units at 1280×720 under
a software rasteriser — is the budget that gates. **S3 is deferred indefinitely**, not merely
delayed: no work is scheduled against integrated-GPU performance, T2's frame time continues to be
*recorded and printed but never asserted*, and the tier machinery stays because it costs nothing
and a GPU may show up later.

This narrows the risk rather than widening it. The MVP already found that the CPU path is where the
budget actually binds; a T2 number nobody can reproduce was never gating anything.

**3. Playtests are deferred as a batch, not per phase.** P1-T24 and its Phase 2–6 equivalents are
written when the phase is built and run together when there are people. That is a real cost, taken
knowingly: legibility questions — does this mesh read, is this cue clear — will go unanswered
until then, and some of the answers will be "no" and will cost rework.

**4. Where a human gate is deferred, its question gets the strongest automated proxy that is
honestly available, and the proxy is never described as the criterion.** A silhouette-distinguishes
test is not a readability test; it fails the cases a person would obviously fail, which is worth
having and is not the same thing. Board and ADR both say which is which.

## Consequences

**This makes easy:**
- The project moves. Phases 2–6 can be built, merged and demoed without waiting on scheduling.
- One performance target instead of two, and it is the one that is measurable here.

**This makes hard / gives up:**
- **Legibility is unverified until the playtests happen**, and it is the single thing 3D was
  supposed to buy. Every phase from here accumulates that debt.
- S3 is not merely unmeasured but unpursued. If the project later wants a GPU target, the tier
  work is intact but the *evidence* starts from zero.
- "Phase N is done" now means "done to the extent CI can tell", and every reader of the board has
  to hold that distinction. §5's original rule was blunter and harder to misread.

**Obligations it creates:**
- Every phase's closing commit names the criteria it deferred. A phase that closes silently on a
  deferred gate is the failure this ADR is one step away from.
- The deferred list lives in one place (`planning/TASKS.md` § Deferred verification) and only ever
  grows until someone runs the checks.

## Alternatives considered

### Hold the line and stop until the playtest happens
Honest, and it converts a scheduling problem into an indefinite halt. The five criteria that *are*
green would sit unused while the thing they gate is not built.

### Drop S1/S3/S6 from the PRD
Cheapest to administer and dishonest: it would let the project claim a green gate it never earned,
and it would delete the only criteria that ask whether the game is any good rather than whether it
is fast.

### Simulate the playtest with an automated "readability" metric
Tempting and worthless. Contrast ratios and silhouette distance measure what is easy to measure,
and S6 asks whether a person who has never seen the game knows what to click. A number here would
be a green light with nothing behind it — worse than an admitted gap.
