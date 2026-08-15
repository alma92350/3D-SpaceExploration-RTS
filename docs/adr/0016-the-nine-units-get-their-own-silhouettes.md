# ADR-0016: The nine unmeshed units get their own silhouettes

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Relates to:** ADR-0006, ADR-0013, ADR-0014, P3-T01, P3-T02

## Context

Nine unit types have no mesh: `ranger`, `breacher`, `dreadnought`, `mender`, `wraith`, `aegis`,
`colossus`, `leviathan`, `heliumbomb`. `meshIdForType` falls back to `worker`, so **a Dreadnought
renders as a Worker today** and nothing goes red — the fallback is what hid it through two phases.

Twice now this project has answered a mesh question by collapsing types into families: ADR-0013 put
nine chain buildings on one mesh, ADR-0014 put four freighters on one hull. Both were forced by a
measured budget — 28 building batches of 28 available. The reflex is to do it a third time.

**So the budget was measured rather than assumed**, on the Phase 3 combat scene: 300 buildings
across all 29 types plus 200 units across all 18 types, at T0, 1280×720.

| | Batches |
|---|---|
| Measured today | **37** |
| Predicted by the batching rule over the same frame | 37 (exact) |
| Counterfactual: nine own meshes | **55** (+18, two per mesh — one per owner) |
| ADR-0014's derived ceiling, today | 83 |
| ADR-0014's derived ceiling, with nine more | 119 |

> **Correction, 2026-08-15, after P3-T02 built the meshes and re-measured.** The two absolute
> figures above are **understated: the honest numbers are 41 before and 59 after.** The measurement
> scene placed 200 units as `uTypes[i % 18]` with owner `i % 2`, and 18 is even — so every unit type
> only ever appeared for **one** owner, and each unit mesh was counted once instead of twice. The
> buildings were unaffected (29 types against `i % 2` decorrelates). **The delta was right**: each of
> the nine occupies exactly 2 slots, measured, for +18 — and 59 against a ceiling of 119 leaves the
> conclusion below not merely intact but with more margin than it claimed. The original figures are
> left visible rather than edited, because a corrected record is worth more than a tidy one.

**The budget does not bind.** 55 against a ceiling of 83 — and the ceiling moves with the roster by
construction, so it is 119 once the meshes exist. Nothing in the repo breaks: the hand-written
buildings cap is 28 and is a *buildings* cap, untouched by units; the perf baselines are per-scene
and the Phase 3 scene will record its own (P3-T16).

Two further measurements matter:

1. **Distance is free.** Past `tier.lodDistance` every entity collapses to the single shared
   `imposter` mesh, so a distant army costs two batches no matter how many types are in it. The +18
   is the worst case — every one of the nine simultaneously inside mesh range.
2. **At scale the sim consumes the budget, not the view.** P2-T18 measured the 300-building scene at
   p50 0.18 ms and p95 21.95 ms: the p95 frames are the ones a simulation tick lands on. Draw calls
   were not what spent that budget.

## Decision

**We will give all nine their own silhouettes. No families this time.**

The argument that forced ADR-0013 and ADR-0014 was a measured ceiling with no room in it. That
argument does not exist here, and applying its *conclusion* without its *premise* would be
pattern-matching to the last decision rather than deciding this one.

What is on the other side of the scale is worse than usual, because of which nine these are:

- **`mender` has no attack.** It is a healer that currently looks like a Worker, in an army.
- **`heliumbomb` has no attack either — it detonates for up to 3 000 damage in a radius.** Mistaking
  it for anything else is the single most expensive misread available in this game, in both
  directions: failing to shoot one, or walking into one.
- **`ranger` is the scout** — 115 speed against a Worker's 60. A player tracks scouts constantly.
- `breacher` / `colossus` / `leviathan` fight at 150–200 range; `aegis` fights at 26. Those are
  opposite tactical objects wearing one shape.

This project has accumulated silhouette debt in every phase so far and has never yet paid any of it
down. Adding nine more collisions to units the player must tell apart *during a fight* is a
different order of cost from nine chain buildings that sit still and can be clicked.

**The trigger, stated in advance:** if P3-T16's browser gate shows the Phase 3 scene breaking the
33 ms T0 budget, this ADR is superseded **with that measurement** — and the first thing to try is
families for the three siege units (`breacher`, `colossus`, `leviathan`), which are the closest
in silhouette and the least often confused under pressure.

## Consequences

**This makes easy:**
- P3-T03's static-defence ladder and P3-T06's combat feedback, both of which are unreadable while
  half the roster shares one shape.
- Paying down debt rather than adding to it, for the first time in this project.

**This makes hard / gives up:**
- **Nine meshes to design and build**, each inside the tier's triangle budget — a real cost, and the
  largest single art task in the project so far.
- +18 batches in the worst case, and a frame-time risk that is *not yet measured*: batch counts are
  structural and identical on every machine, but a draw call's cost is not. The gate that decides it
  is P3-T16, and it runs after the meshes exist. This ADR is decided on the batching contract, which
  is the thing ADR-0006 actually specifies, not on a frame time nobody has measured yet.
- The derived ceiling rises 83 → 119, which weakens it further as a regression detector — it was
  already weak by construction (ADR-0014).

**Obligations it creates:**
- `meshIdForType`'s fallback must stop being able to hide this. P3-T02 asserts **no type resolves by
  fallback**, not merely that meshes exist — a test that only checked "the mesh is registered" is
  what let a Dreadnought render as a Worker through two phases.
- The nine must be distinguishable from each other and from the five that already exist, by the same
  silhouette test the buildings use.

## Alternatives considered

### Families again — five meshes instead of nine
Scout, support, bomb, siege (breacher/colossus/leviathan), heavy (dreadnought/aegis), with `wraith`
reusing the Skiff. Ten batches instead of eighteen; ceiling 103. Genuinely defensible, and rejected
because **the premise is absent**: there is no budget pressure to buy the legibility loss with. It
stays on the table as the named fallback if P3-T16 measures a problem.

### Raise a ceiling to fit
Not applicable and worth recording as such: ADR-0014 made the whole-frame ceiling *derived*, so it
rises on its own when the roster does. There is no number here to edit — which is exactly what that
ADR was for.

### Leave the fallback
Free, and it is the status quo in which a Dreadnought is a Worker. It would also make PRD §5's
Phase 3 exit criterion — "every combat cue is legible in a blind readability test" — untestable
before it was ever run.
