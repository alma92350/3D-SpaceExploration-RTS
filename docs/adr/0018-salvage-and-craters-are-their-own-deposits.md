# ADR-0018: Salvage and craters are their own deposit meshes

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Answers:** Q-13
**Relates to:** ADR-0006, ADR-0014, P3-T08, P3-T09

## Context

When something dies, the engine eventually turns the debris into a real `ResourceNode` carrying
`wreck: true`. When a Helium Bomb detonates, the crater becomes one carrying `crater: true`. Both
are, in `bomb.js`'s own words, "indistinguishable to gather.js/rendering/fog from anything
engine/map.js generated" — which is the intended behaviour for the *simulation* and a problem for
the *view*: battlefield salvage currently renders as an ordinary ore seam, and a crater looks like a
natural deposit that has always been there.

Both flags already cross to the bridge on the node and are discarded there — the identical situation
`comIndex` was in before P2-T17.

ADR-0014 refused a third deposit mesh, so the reflex is to refuse a fourth and fifth. **The budget
was measured instead**, on the Phase 3 combat scene (300 buildings across all 29 types, 200 units
across all 18, 80 salvage and crater nodes, T0):

| | Batches |
|---|---|
| Whole frame today | **60** |
| Deposits' share of it | **2** — `node\|2\|0` and `volatile\|2\|0` |
| ADR-0014's derived ceiling | **119** |
| Headroom | **59** |
| With two more deposit meshes | 62 against a ceiling of 121 |

**A deposit mesh costs one batch, not two.** Deposits are neutral — one owner slot, not two — and
`pushNodes` batches them at `LOD_MESH` unconditionally, so there is no imposter row either. That is
half what a unit or building mesh costs, and it is why ADR-0014's arithmetic does not transfer.

## Decision

**We will give salvage and craters their own deposit meshes.**

ADR-0014's actual reason for refusing a third mesh was not the batch. It was this:

> One batch more than two, for a distinction the player makes in a menu rather than on the ground.

That reason does not apply here, and the difference is the whole decision. Metallic versus
crystalline is a *build-menu* distinction — a player decides which refinery to place, not which rock
to look at. Salvage versus a natural seam is a **field** distinction:

- It says a fight happened here, which is tactical information a player acts on immediately.
- It is finite and incidental where a natural seam is permanent and planned, so it changes where
  workers get sent.
- A crater says a Helium Bomb went off — the single most consequential event in a match.

Rendering all three as one rock tells the player none of that while looking perfectly healthy.

**Two meshes, not one.** A wreck and a crater are different events with different meanings, and
collapsing them would re-create the problem one level in.

**The commodity stops deciding the mesh for these nodes.** A wreck of `metals` and a wreck of `ore`
are both wreckage; what matters is that they are wreckage. Origin wins over contents, which is a
genuine loss — a player cannot tell what a salvage pile holds by looking — and it is the right
trade, because the build menu and the panel both carry the commodity while nothing carried the
origin.

## Consequences

**This makes easy:**
- Reading a battlefield after the fact, which is most of what a player does between fights.
- P3-T10's blast feedback, since a crater is the lasting half of what a bomb leaves behind.

**This makes hard / gives up:**
- **A salvage pile no longer shows its commodity.** Two more meshes could not fix that without four
  more, and the panel already answers it.
- Two more batches, permanently, at every zoom — deposits never LOD. Measured as 2 of 59 headroom,
  which is affordable now and is not free.
- The deposit family grows from two to four, which is the direction ADR-0014 pushed against. It is
  reversed here on a measurement, not on a preference, and the measurement is recorded above so the
  next person can check whether it still holds.

**Obligations it creates:**
- The node table now carries an origin byte. A node whose origin is unknown must render as a natural
  deposit — the safe default, since that is what it looked like before this ADR.
- A test must assert salvage and craters are distinguishable from *both* natural deposit meshes, by
  the same silhouette metric the buildings and units use.

## Alternatives considered

### An overlay marker over the existing rock
One draw call for both instead of two, so very slightly cheaper. Rejected because a marker floating
above a rock that still looks like a rock is a worse answer than a rock that looks like wreckage:
the object *is* different, and every other deposit states what it is with its own mesh.

### Keep ADR-0014's answer and refuse
Consistent, and consistency with a decision whose stated reason does not apply is just
pattern-matching — the same trap ADR-0016 was written to avoid two rows ago.

### Distinguish by colour on the existing mesh
Free, and it breaks N-05 on objects a player scans a battlefield for.
