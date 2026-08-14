# ADR-0001: Record architecture decisions

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §8.3

## Context

This project will be built incrementally by multiple contributors and by AI agents that do not
share a conversation history. Nearly every hard problem here — the CPU-only budget, the vendored
engine, the 2D-sim/3D-view split — is a constraint that is invisible in the code that satisfies it.
An agent who does not know *why* the render loop preallocates its buffers will helpfully "clean it
up" into a version that allocates, and nothing in the type system will object.

The parent project keeps its rationale in long file-header comments, which works well for
*implementation* rationale but has no home for a decision that spans modules or predates the code.

## Decision

We will keep Architecture Decision Records in `docs/adr/`, one file per decision, numbered
sequentially, in the lightweight format described in [`README.md`](README.md).

An ADR is written **before** the code that implements the decision, and is Accepted when its PR
merges. Accepted ADRs are immutable except for their Status line; a change of mind is a new ADR
that supersedes the old one.

The triggers that make an ADR mandatory (hard to reverse, cross-cutting, surprising, or spending a
budget) are listed in `README.md` and are part of the definition of done for any task that hits one.

## Consequences

**This makes easy:**
- Onboarding a new agent: the ADR index is a two-minute read of every load-bearing choice.
- Rejecting a well-meant regression in review — "this violates ADR-0006" is a specific, checkable
  objection rather than a matter of taste.

**This makes hard / gives up:**
- Small friction on every architectural change. That is the point, but it is a real cost.
- ADRs can rot into fiction if superseding is skipped. The index's Status column is the only
  defence, and it must be maintained in the same PR that changes the decision.

**Obligations it creates:**
- `docs/adr/README.md`'s index is updated in the same PR as any new or superseded ADR.
- CI checks that every file matching `docs/adr/[0-9]*.md` appears in the index (Phase 0, task
  `P0-T09`).

## Alternatives considered

### Rationale in file headers only (the parent repo's approach)
Excellent for "why is this function shaped like this", useless for "why three.js and not Babylon",
which belongs to no file. We keep the header-comment culture *as well* — it is why the parent repo
is readable — and add ADRs for the decisions that span files.

### A design doc per feature
Bigger, staler, and it mixes the durable decision with the perishable plan. The plan belongs in the
PRD phases and the task board; the decision belongs here.

### Nothing; rely on git history and PR discussion
Search-hostile, and PR threads are not durable in practice. An agent cannot read a thread that was
resolved and collapsed a year ago.
