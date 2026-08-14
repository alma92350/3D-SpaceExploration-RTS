# Architecture Decision Records

An ADR captures **one decision**: what we chose, what it rules out, and why — written at the moment
the choice is live, not reconstructed later. The value is entirely in the "why". A reader six months
from now can find *what* the code does by reading it; they cannot find why the obvious alternative
was rejected.

## When you must write one

Before writing the code, if the decision is any of:

- **Hard to reverse** — a dependency, a data format, a public boundary, a save shape.
- **Cross-cutting** — it affects more than one module, or how other people must write theirs.
- **Surprising** — a future reader would ask "why on earth", or would innocently "fix" it back.
- **A constraint trade-off** — anything that spends the performance budget, the load budget, or the
  determinism guarantee.

If you are unsure, write it. A short ADR costs ten minutes; an undocumented constraint costs a
rediscovered bug and a re-litigated argument.

**You do not need an ADR** for: naming, file layout inside a module, a local algorithm with no
external contract, or anything a test already pins down.

## Format

One file per decision, `NNNN-kebab-case-title.md`, numbered sequentially and never renumbered.
Template: [`0000-template.md`](0000-template.md). Keep it to a page. Sections:

- **Status** — Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- **Context** — the forces. Constraints, requirements, what we know and do not know.
- **Decision** — what we will do, in the active voice: "We will…"
- **Consequences** — what this makes easy, what it makes hard, what it forecloses. Be honest about
  the costs; an ADR with no downsides is an advertisement, not a record.
- **Alternatives considered** — each with the reason it lost. This is the section people actually
  come back for.

## Lifecycle

- ADRs are **immutable once Accepted**, except for the Status line. You do not edit a decision you
  no longer agree with — you write a new ADR that supersedes it, and set the old one's status to
  `Superseded by ADR-NNNN`.
- An ADR is Accepted when its PR merges. Proposing one is a normal PR with the ADR as the diff.
- The PRD links to ADRs; ADRs do not restate the PRD.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-scope-odyssey-only.md) | Scope: the Odyssey, single-player, in the browser | Accepted |
| [0003](0003-vendor-the-2d-engine-as-the-simulation-core.md) | Vendor the 2D engine, unmodified, as the simulation core | Accepted |
| [0004](0004-the-simulation-stays-2d.md) | The simulation stays 2D; 3D is a projection | Accepted |
| [0005](0005-rendering-stack-and-the-renderer-port.md) | Rendering stack: three.js behind a Renderer port, with a Canvas2D fallback | Accepted |
| [0006](0006-cpu-only-performance-budget.md) | The CPU-only performance budget and how it is enforced | Accepted |
| [0007](0007-toolchain-and-dependency-policy.md) | Toolchain and dependency policy | Accepted |
| [0008](0008-sim-render-boundary.md) | The sim/render boundary: fixed step, snapshots, worker-ready | Accepted |
| [0009](0009-test-strategy.md) | Test strategy: TDD, three layers, and what may be faked | Accepted |
| [0010](0010-phase-1-view-contract.md) | The Phase 1 view contract: camera, start world, and the shape of the port | Accepted |
| [0011](0011-phase-gates-on-automated-criteria.md) | Phases close on their automated criteria; the human and GPU gates are deferred | Accepted |
| [0012](0012-phase-2-economy-contract.md) | The Phase 2 economy contract: snapshot width, power, draw calls and panels | Accepted (§3 superseded by ADR-0013) |
| [0013](0013-silhouette-families-not-a-variant-attribute.md) | Six silhouette families, not one chassis with a variant attribute | Accepted |
