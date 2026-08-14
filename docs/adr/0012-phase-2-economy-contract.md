# ADR-0012: The Phase 2 economy contract — snapshot width, power, draw calls and panels

**Status:** Accepted — **§3's mechanism is superseded by [ADR-0013](0013-silhouette-families-not-a-variant-attribute.md)**; its ≤ 28 draw-call budget stands
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §5 (Phase 2), §10 (Q-07…Q-10); ADR-0004, ADR-0005, ADR-0006, ADR-0008

## Context

Phase 1 rendered 9 building types, 3 commodities and one owner's stockpile. Phase 2 is the same
game with the economy switched on: **29 building types, 23 commodities, 9 recipes, 4 power bands.**
That is mostly breadth, and breadth is exactly what the MVP's two hard constraints dislike —
ADR-0006's zero-per-frame-allocation rule and ADR-0005's one-draw-call-per-(mesh, owner) rule both
scale with *how many distinct things exist*, not with how clever any one of them is.

Four questions had to be answered before the code (Q-07…Q-10 on the board).

## Decision

**1. Q-07 — totals for every building, full buffers for the selection only.**

The snapshot carries, per building, the recipe index, a 0..1 progress, a stop-reason enum and an
output-buffer fullness — four numbers, all in existing-width typed arrays. The full input/output
commodity buffers are extracted **only for the entities in `snapshot.selection`**, into a small
fixed-size side table.

23 commodities × 300 buildings is 6 900 floats a tick, and 6 897 of them would be read by nobody:
a commodity buffer is only ever *displayed*, and the only building whose buffers are on screen is
the one the player clicked. The four-number summary is what the *world* needs (a stalled smelter
must look stalled), and that is genuinely per-building.

The cost: selecting 200 buildings in a box-select extracts 200 buffer sets. The side table is
capped and the cap is the selection limit, so the worst case is bounded and small.

**2. Q-08 — power reuses the fog machinery exactly.**

A second `Uint8Array` field at fog resolution, a second version counter, a second texture, one
extra lookup in the terrain shader. `POWER_TIERS` is a distance field over the map; fog is a
distance-ish field over the map; ADR-0006 already demanded "one low-res lookup, not per-entity
branching" and the fog path already satisfies it.

The band is stored per cell, not the multiplier: four states in a byte, and the view maps them to
colour. That keeps the engine's numbers (1×, 1.3×, 1.7×, 2.3×) out of the view, where they would
be a second copy of a rule.

**3. Q-09 — the draw-call contract is per (mesh, owner, LOD), and Phase 2 keeps it by cutting
meshes, not by raising the budget.**

29 types × 2 owners is ~58 building draws against the MVP's 15 for an entire scene. The answer is
**not** to accept 58: the buildings that need a distinct silhouette are the ones a player looks at
and acts on. The nine industrial-chain buildings share **one parameterised chassis mesh** — same
geometry, a per-instance variant attribute picking the roofline — so the whole chain is one draw
call per owner instead of nine.

That is the same trick `instanceShade` already plays, and it is the reason the attribute path was
built to be per-instance rather than per-mesh in Phase 1.

Budget for Phase 2: **≤ 28 draw calls** for the 300-building scene, asserted by the perf gate.

**4. Q-10 — one pure model per panel, composed, never one growing `hudModel`.**

`hudModel(snap)` is 300 lines and covers one panel. Six more panels in one function is a function
nobody can test a branch of. Each panel gets `xModel(snap, …): XModel`, pure, tested without a DOM,
and the HUD composes them. The DOM writers stay separate for the same reason they already are:
they are the only part that costs anything per frame.

**5. The bridge never re-implements a rule it can ask about.** Every economy command goes through
the engine's own predicate — `researchTech`, `canRecycle`, `buy`/`sell`, `beginRecycle` — and the
panel shows what the engine returned rather than what the panel predicted. Phase 1 established this
with `canPlaceBuilding`; the economy is where it stops being obvious, because a market price
recomputed locally will disagree with the engine within one trade.

## Consequences

**This makes easy:**
- The snapshot stays a fixed-width table with a small bounded side channel, so ADR-0006's
  allocation rule survives a 23-commodity economy.
- The chain reads as a chain — nine buildings that look like siblings, because they are.
- A panel's logic test builds a snapshot and calls one function.

**This makes hard / gives up:**
- **The nine chain buildings are deliberately less distinct from each other than from anything
  else.** A player must read the roofline variant, not the silhouette, to tell a Chip Fab from a
  Smelter. That is a legibility risk taken knowingly, and it is exactly the kind of thing the
  deferred playtest (ADR-0011) would have caught early.
- Selection-scoped buffers mean a future feature that wants "show me every buffer at once" — a
  logistics overview — needs a different path, not a wider snapshot.
- Two field textures instead of one. At fog resolution this is a few kB and one fetch; at a higher
  resolution it would not be, and nothing here stops someone raising it.

**Obligations it creates:**
- The perf gate asserts the ≤ 28 draw calls, or decision 3 is an aspiration.
- Every new panel is a pure model plus a writer, and its test does not touch the DOM.
- If the chassis trick makes the chain unreadable, the fix is a new ADR, not more draw calls
  quietly added to the baseline.

## Alternatives considered

### Widen the snapshot to every buffer every tick
Simple, uniform, and 6 900 floats a tick for three of them to be read. It also breaks the
fixed-width table shape that makes the allocation scan possible.

### Give all 29 buildings distinct meshes and raise the draw-call budget
The honest version of "we'll fix perf later". At T0, under a software rasteriser, draw calls are
not free, and the budget is the one thing ADR-0006 says never to negotiate away quietly.

### Put power in the snapshot as a per-building boolean
Half the information — a building can be on-grid, near, far or isolated, and the multiplier
between them is 2.3×. A boolean would make "why is this slow?" unanswerable from the screen.
