# ADR-0014: The frame's draw-call ceiling is derived from the roster, not chosen

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Answers:** Q-11
**Relates to:** ADR-0006, ADR-0012 §3, ADR-0013

## Context

Phase 2's last two visual tasks do not fit the frame's draw-call ceiling.

The frame measures **34 batches against a 36 ceiling**. P2-T05's four logistics units would add
four meshes across two owners; P2-T17's five extra deposit types would add five more. That is
**47 against 36**.

This is the third time this budget has bound Phase 2 — Q-09 for the buildings, then the 300-building
perf scene, now this — and the third time the tempting move has been to edit the number.

Two facts shape the answer, both measured rather than assumed:

1. **Deposits never take the imposter path.** `pushNodes` batches at `LOD_MESH` unconditionally
   (`src/view/scene.ts`), unlike entities, which drop to an imposter past a distance. So a deposit
   mesh costs its batch at every zoom, and there is no LOD relief to lean on.
2. **The deposit's commodity already crosses the bridge and is discarded.** `snap.nodes.comIndex`
   carries it; `pushNodes` ignores it and draws every deposit with the one `node` mesh. P2-T17 is a
   view change with no bridge work at all.

## Decision

**1. Families again, as for the buildings (ADR-0013).**

- **One freighter hull** for `hauler`, `heavyhauler`, `bulkfreighter` and `freighter`. They are the
  same silhouette at any distance a player cares about — a hull with a hold — and they differ in
  capacity, which is a number, not a shape.
- **Two deposit meshes, not three or five:** `rock` for the metallic and crystalline deposits, and
  `volatile` for ice, gas, biomass, spice and relics. Three was the obvious grouping and costs one
  batch more for a distinction — metallic versus crystalline — that a player acts on through the
  build menu rather than by looking at the ground.

**2. Cargo rides the per-instance channel it already has.** `FLAG_CARRYING` and a 0..1 cargo
fullness both cross the bridge today, and `InstanceBatch` already carries a per-instance `shade`.
A laden freighter is a shade change, not a second mesh — which is what P2-T05 asked for in the
first place, and it costs nothing.

**3. The whole-frame ceiling is DERIVED from the mesh roster, not written down as a constant.**

This is the part that matters. A hand-picked 36 has exactly one failure mode, and it is the one
this project keeps finding: someone adds a mesh, the number goes red, and the number gets edited.

So the test computes the ceiling from the rule itself — one batch per (mesh, owner, LOD) — over the
roster that actually exists, and asserts the frame does not exceed its own derivation. Adding a
mesh then changes the derivation visibly and in the same commit as the mesh, rather than requiring
someone to notice a constant.

**The buildings cap stays a hard, hand-written 28.** It is ADR-0012's, it is the one both ADR-0013
and the six families were bought with, and it must not float with the roster: that is precisely the
number a new building type should be made to argue against.

## Consequences

**This makes easy:**
- Adding a unit or deposit type without a budget argument every time, while the *building* budget —
  the one that was actually at risk — stays fixed and adversarial.
- Reading the ceiling: it is a formula in one place instead of a number whose origin is a commit
  message from three hours earlier.

**This makes hard / gives up:**
- **Four freighters look identical**, on top of the nine chain buildings ADR-0013 already merged.
  The legibility debt this project is accumulating against its deferred playtest (ADR-0011) is now
  large enough to name: *thirteen* entity types share a silhouette with something else.
- Metallic and crystalline deposits look the same. A player prospecting by eye must read the
  minimap or click; the build menu is where that decision is actually made, which is the argument
  for accepting it, but it is an argument rather than a free lunch.
- A derived ceiling is weaker than a fixed one by construction. It catches *batching* regressions —
  a key that splits, a batch submitted twice — and not *roster* growth. The buildings cap is what
  catches roster growth, and it only covers buildings.

**Obligations it creates:**
- The derivation lives in the test with its reasoning, and the buildings cap stays hand-written
  beside it so the difference between the two is visible.
- If unit or deposit types ever grow the way buildings did, this ADR is the one to supersede — with
  a measurement, not an opinion.

## Alternatives considered

### Raise 36 to 40 and move on
What the arithmetic invites. It is also the exact move ADR-0006 names as the failure it was written
about, and it would be the fourth number edited tonight rather than believed.

### Three deposit meshes
One batch more than two, for a distinction the player makes in a menu rather than on the ground.
Rejected on the measurement that deposits never LOD, so that batch is paid at every zoom.

### Distinguish deposits by colour on one mesh
Free, and it breaks N-05 (never colour alone) on the objects a colour-blind player most needs to
tell apart from each other.
