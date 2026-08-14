# ADR-0013: Six silhouette families, not one chassis with a variant attribute

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Supersedes:** ADR-0012 §3 (the mechanism only; its ≤ 28 draw-call budget stands)
**Relates to:** ADR-0005, ADR-0006

## Context

ADR-0012 §3 answered Q-09 — 29 building types × 2 owners breaks one-draw-call-per-(mesh, owner) —
by putting the nine industrial-chain buildings on **one chassis mesh with a per-instance variant
attribute picking the roofline**. One draw call per owner for the whole chain.

Building it exposed a cost the decision did not account for. A per-instance attribute can only
*choose* between geometry that is already in the vertex buffer, so "nine rooflines, pick one"
means all nine are in the buffer and eight collapse to degenerate triangles per instance. The
chassis goes from ~30 triangles to ~120, of which ~40 rasterise. At 300 buildings that is 36k
triangles of vertex work against a scene that currently runs 13k *in total* — to save draw calls
under a software rasteriser, where vertex work is not free either.

The decision was made to protect the T0 budget and, implemented literally, would have spent more
of it than it saved.

## Decision

**The 29 building types collapse into six silhouette families, each one mesh.**

| Family | Types | Reads as |
|---|---|---|
| Factory | smelter, assembler, chipfab, machineworks, antimatterforge, aifoundry, torpedoworks, chemplant, fabricator | a shed with a stack |
| Power | reactor, combustor, biomassreactor | a squat drum |
| Relay | substation | a mast |
| Fortress | bastille, aegisbastion, torpedobattery | a walled block |
| Works | foundry, arsenal | a hall |
| Landmark | spaceport + stardock, market + datacenter, plasmarig, antimatter_gate | four distinct, deliberately tall |

With Phase 1's five (command, barracks, habitat, turret, refinery) that is **14 building meshes,
28 draw calls at two owners in the worst case** — exactly ADR-0012's budget, which is unchanged.

**A family shares a role, and that is the point.** The player is not being asked to tell a Chip Fab
from a Smelter by shape — they are being told "that shape is a factory", which is the read that
matters when scanning a base. Identity comes from the selection panel, the badge, and the label.

**The four landmarks stay distinct and stay tall**, because those are the buildings a player
navigates by.

## Consequences

**This makes easy:**
- The T0 budget, on both axes at once: 14 meshes is 28 draws worst case, and no instance pays for
  geometry it does not draw.
- Adding a building later. A new factory is a table entry, not a mesh.

**This makes hard / gives up:**
- **Nine buildings look identical on the field, and this is a bigger loss than ADR-0012 admitted.**
  That ADR gave up "distinct silhouettes" but kept a distinguishing roofline; this gives up the
  roofline too. A player wanting to find their Chip Fab must use the minimap or click.
- If the deferred playtest (ADR-0011) says the chain is unnavigable, the fix is a real one — per-
  family colour banding, or a badge — not a smaller version of the variant attribute.

**Obligations it creates:**
- The perf gate keeps asserting the draw-call ceiling, or this ADR is an aspiration too.
- A test asserts every one of the 29 types maps to a mesh, so a type added upstream cannot silently
  fall back to a worker-sized block.
- The families are distinguishable **from each other** by silhouette, asserted rather than assumed.

## Alternatives considered

### Build the variant attribute anyway and accept 36k triangles
Rejected on the measurement above. It trades the budget it was written to protect.

### One mesh per building type, and raise the draw-call ceiling
58 draws. ADR-0006 says the budget is the thing never negotiated away quietly, and "quietly" is
exactly how this would happen — one type at a time.

### Distinguish the chain by colour only
Cheapest, and it breaks N-05 (never colour alone) on the largest group of buildings in the game.
