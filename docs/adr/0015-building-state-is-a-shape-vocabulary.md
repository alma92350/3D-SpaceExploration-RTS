# ADR-0015: Building state is a shape vocabulary behind a new overlay kind

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Relates to:** ADR-0005 §4, ADR-0006, ADR-0012 §5, PRD N-05, P2-T08

## Context

P2-T08 requires the five building states — constructing, working, idle, throttled, unpowered — to be
distinguishable **by shape or motion in a still frame**, in both renderer implementations.

Three facts constrain the answer, and all three are measured rather than assumed:

1. **There is no per-instance colour channel.** `InstanceBatch` carries `xyz`, `yaw`, `scale` and
   `shade`; colour comes from the batch key's `owner`. So "tint the building red" is not a small
   change — it is a second material per state per owner, which is what ADR-0006 exists to refuse.
2. **`shade` and `scale` are already spoken for.** Construction drives both (P1-T09), and cargo
   drives `shade` for units (P2-T05, ADR-0014 §2). A third consumer would collide with one of them.
3. **The engine cannot tell idle from working.** `buildingConcern` returns `null` for an idle
   Barracks *and* for a producing smelter: a Barracks has no recipe, so the engine has nothing to
   complain about. The distinction the board called the dangerous one — a player thinking the game
   is broken — does not exist in the simulation at all.

The buildings draw-call budget is also full: 28 of 28 (ADR-0012 §3, ADR-0013). A per-state mesh
would cost two calls per state per family and is not available at any price.

## Decision

**1. A new overlay kind, `status`, packed `(x, y, z, concern, activity)`.**

Overlays are the port surface ADR-0005 §4 already reserves for "things the player must READ", they
are drawn by one shared 2D module that both product renderers call, and they cost **one draw call
for every badge in the frame** rather than one per state. The conformance suite sweeps every kind in
`OVERLAY_STRIDE`, so both implementations are covered the moment the kind exists.

**2. Two codes in the payload, not one merged code.** `concern` is the engine's own answer;
`activity` is ours. Merging them would mean inventing a value one past `CONCERN_THROTTLED`, which
breaks silently the day upstream adds a seventh concern.

**3. The badge is a SHAPE, and the shapes live in their own module as pure data.**

`view/renderer/glyphs.ts` holds one polyline set per state and a `statusGlyph(concern, activity)`
that picks between them. It draws nothing and imports no renderer, so a test can prove two states
differ by comparing geometry — no pixels, no colour, no GPU. Every badge strokes in **one colour**,
deliberately: if each glyph had its own, a later change could drop the shapes and still pass a
visual review.

The vocabulary pairs the confusable states as opposites: `starved` points down and `bufferFull`
points up; `idle` is a closed ring and `noPower` is a broken bolt — round versus jagged, which is
the pair the board singled out.

**4. `ACTIVITY_*` is ours and lives in its own array.** ADR-0012 §5 promises `concern` is
`buildingConcern`'s answer "mapped to an integer and not otherwise touched". Appending a code we
invented would quietly make that array a mixture of the engine's answer and ours, and the next
person to trust the comment would be wrong. Today `ACTIVITY_IDLE` means one thing: a building that
trains units and has an empty queue.

**5. A healthy working building wears no badge at all**, and constructing buildings are excluded —
their state is the scale ramp, and a badge on a half-risen shell reads as a fault rather than as
progress. 300 badges is not a cue, it is a texture.

## Consequences

**This makes easy:**
- Adding a state: one glyph, one entry, and both renderers draw it with no per-implementation work.
- Proving N-05 holds. The claim "these two states are distinguishable without colour" is a unit test
  over point sets, not a screenshot review — which matters because the playtest that would otherwise
  catch it is deferred (ADR-0011).

**This makes hard / gives up:**
- **Six glyphs is a vocabulary a player must learn.** Shape is colour-blind-safe and it is not
  self-evident; a ring meaning "idle" has to be taught by the tutorial or the panel. This is a real
  cost paid to N-05, and the deferred playtest is where it would be measured.
- One more draw call in any frame containing a badge, and one more overlay kind every future
  implementation must support.
- `activity` is one byte per entity in the snapshot, spent on buildings and wasted on units.
- The badge is 2D and constant-sized on screen, so a base seen from far out shows badges at full
  size. The LOD gate hides them past imposter range, which bounds it but does not solve it.

**Obligations it creates:**
- Every `CONCERN_*` the bridge can emit must have a glyph. A test sweeps the enum and fails if one
  is added without one.
- Precedence is fixed: the engine's concern wins over our activity, so a building never wears two
  badges. Today no building can be both; the rule is stated so the first one that can does not
  render whichever branch happened to come first.

## Alternatives considered

### Tint the building
The obvious implementation, and it breaks N-05 on exactly the objects a player scans for problems.
It also has no home in the port: there is no per-instance colour, so it means a second material per
state per owner — ADR-0006's named failure.

### A per-state mesh
Shape, honestly done, and it costs two draw calls per state per family against a buildings budget
that is at 28 of 28. Not available at any price.

### Animate it — a stopped factory stops turning
Genuinely the best cue, and it fails the criterion as written: P2-T08 asks for a **still frame**,
because a player takes in a base at a glance and a screenshot has to work. Motion is a good addition
later, not a substitute.

### Reuse `shade`
Free, no new port surface, and it collides with construction on buildings — the one entity class
this is about. It is also brightness, which is a colour cue wearing a different name.
