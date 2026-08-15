# ADR-0017: A shot is a diff, not an event

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Answers:** Q-12
**Relates to:** ADR-0006, ADR-0008, ADR-0012 §5, P3-T05, P3-T06, P3-T07

## Context

PRD §5 asks Phase 3 for "combat feedback (tracers, impacts, death)" and adds an exit criterion that
"no combat feedback allocates per frame". The obvious implementation is to consume an engine event
per shot.

**There is no such event.** The simulation emits thirteen event types in total and exactly one of
them is about combat — `entityKilled`. No shot, no impact, no damage-dealt. Whatever draws a tracer
has to derive the fact that a shot happened.

Four things were measured before deciding, on a 120-unit fight over 400 ticks (20 s):

1. **`attackTimer` is written in exactly two ways.** Three sites decrement it toward zero
   (`combat.js` lines 30, 267, 468) and three reset it to `def.cooldown` on firing (92, 282, 487).
   Nothing else touches it. So **an increase between ticks is a shot, exactly** — not a heuristic,
   an invariant of the engine's own code.
2. **A unit cannot fire twice in one tick, by a factor of seventeen.** Cooldowns span 0.85–2.6 s
   against a 0.05 s tick (`PLAY_HZ` 20, ADR-0008), and the fire path is a single `else if` per call.
   A per-tick diff therefore loses nothing.
3. **Volume is small.** p50 **1** shot per tick, p95 **6**, max **33**, across 691 shots. A
   preallocated table sized in the low hundreds covers the T2 load with room to spare.
4. **12.9% of shots have a target that no longer exists when the snapshot is extracted** — and
   0% have no target id at all. The engine applies damage and removes the corpse inside the same
   tick, so *the killing shot* is precisely the one whose target cannot be looked up.

Point 4 is the one that decides the design. An implementation that resolved the endpoint by looking
the target up and skipped when it was missing would silently drop **one shot in eight, and
specifically the kills** — the shots a player most needs to see, in a feature whose entire purpose
is making fights readable. It would also look completely correct in a quiet skirmish.

## Decision

**1. The bridge synthesises a shot by diffing `attackTimer` between ticks.** It keeps the previous
tick's value per entity, exactly as it already keeps the previous position for interpolation, and
emits a shot wherever the timer rose. This is a *derivation*, which ADR-0012 §5 normally forbids —
and it is allowed here for the stated reason that there is nothing to ask instead. The invariant it
rests on is written down above so a future reader can check it against the engine rather than trust
it.

**2. A dead target's endpoint comes from `prevPos`, never from a lookup.** The extractor already
keeps last tick's position for every entity, and `rememberPreviousPositions` runs at the *end* of
extraction — so an entity removed this tick is still in that map with the position it died at. That
is the correct endpoint for a killing shot anyway: the tracer should end where the target was, not
be dropped because the target stopped existing.

**3. Shots cross the bridge as a preallocated parallel-array table**, like every other snapshot
structure: `fromX, fromY, toX, toY, owner`, with power-of-two growth off-frame. No object per shot,
at any layer.

**4. A shot crosses only if its shooter is visible to the viewer.** This is the conservative rule
and it is deliberately not the generous one. A tracer drawn from an unseen enemy would give away
that enemy's exact position — a line pointing straight at it — which is a fog leak dressed as a
feature. A player shot from the dark sees their own unit's health drop and has to scout.

**5. The engine's events survive the tick (P3-T07).** `WorldBridge.step` clears `state.events` with
a comment saying nothing consumes them. Deaths are the one combat cue the engine hands over
ready-made, and alerts, wreckage and craters all need the same stream.

## Consequences

**This makes easy:**
- Tracers, impacts and deaths with one mechanism and no engine fork (ADR-0003 holds).
- The zero-allocation criterion: a fixed table filled per tick, drained per frame.

**This makes hard / gives up:**
- **The bridge now derives something the engine does not state.** If upstream ever adds a third way
  to write `attackTimer` — a stun that resets it, an ability that refunds it — this silently invents
  shots. The invariant is asserted by a test that sweeps the engine's own source for assignments,
  so the failure is loud rather than visual.
- **A shot is known only at tick resolution.** The view renders at 60 Hz and the sim ticks at 20, so
  a tracer's *start* quantises to 50 ms. That is invisible for a tracer that lives ~150 ms, and it
  would matter for a projectile with real flight time, which this is not.
- **Being shot from the dark shows no tracer.** Correct for fog, and it will feel like a missing
  cue to a playtester who does not know why. That is a real cost and it goes on the Phase 3
  playtest script rather than being argued away here.
- One more per-entity map in the extractor (previous `attackTimer`), and one more table.

**Obligations it creates:**
- A test must assert the `attackTimer` invariant against the engine's source, not against a comment.
- A shot whose endpoint cannot be resolved at all must be **counted, not silently dropped** — a
  dropped-shot counter of zero is the only way to know the 12.9% case is still handled.

## Alternatives considered

### Wait for upstream to emit a shot event
The clean answer, and not available: ADR-0003 vendors the engine unmodified, and this project does
not get to add an event to it. Worth stating because it is what a reader will ask first.

### Look the target up, skip if missing
The obvious implementation. Measured to drop 12.9% of shots — every kill — while looking perfect in
any test that did not include a death. This is the alternative the measurement exists to reject.

### Carry `autoTarget` in the entity table and let the view infer
Cheaper: no new table, and the view already walks entities. But `autoTarget` is *sticky* — it names
a committed target across many ticks, not a shot — so the view would have to diff a timer it does
not have, and the derivation would move somewhere with no access to `prevPos`.

### Draw a tracer for any shot involving a visible entity
More generous, and it leaks: a line from an unexplored cell to your unit tells you exactly where the
shooter is standing. Rejected on the same grounds the snapshot already applies fog at the bridge —
"the renderer knows but does not draw" is how information escapes.
