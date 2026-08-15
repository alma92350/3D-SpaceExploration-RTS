# ADR-0025 — Yaw 0 looks north, and every screen-space control is derived from that

**Status:** Accepted
**Date:** 2026-08-15
**Supersedes:** nothing. **Amends:** ADR-0024 (one line of it — the imposter's facing).

## Context

The first playtest of `docs/playtests/mvp.md` (PT-01) produced this, from the only tester the
project has ever had:

> *"to pan to see the left part of the map, i need to move my mouse all the way to the opposit side
> of the screen ie right side, and inversaly, same for seeing the upper part of the screen i need to
> move the mouse to the bottom"*

and, separately:

> *"by default … the minimap and the battle field are inverted. once i rotate the camera by 180°
> they are in sync again."*

Both were true, and they are the same defect seen from two sides.

`eyePosition` placed the eye at `target − (sin yaw, cos yaw) × horizontal`. At yaw 0 that puts the
eye at *lower* sim-Y looking toward higher Y, so `lookAt` lands the camera's right axis on world
**−X** and the world renders mirrored on both axes: sim +X drew on the screen's LEFT, sim +Y drew at
the TOP. Measured with the project's own `pickGround`, at the default camera: sim X **441.6** under
the right screen edge against **1158.4** under the left.

Three things then disagreed with each other, and had since Phase 0:

- **`camera.ts` disagreed with itself.** `yawIndex`'s own comment says yaw 0 *"looks north (down −Y
  in sim space)"*. The code looked the other way. `game.ts` and `keyboard-play.test.ts` describe the
  yaw-0 ray as coming *"from the south"*, which contradicts the comment in the third direction.
  **Nobody had ever written down which way this camera faces**, so each author picked one.
- **`minimap.ts` disagreed with the battlefield.** It maps sim +X → right and +Y → down, which is the
  simulation's convention and upstream's 2D renderer's. The 3D view did the opposite on both axes,
  making the minimap a **180° rotation** of the picture beside it. This is what the tester was
  compensating for by hand.
- **`pan` disagreed with the basis it was panning in.** It rotated the screen delta by `+yaw`, which
  is correct against a rotation and wrong against a **reflection**. The consequence is not a constant
  inversion but one that changes with yaw: pushing right sent the view LEFT · UP · RIGHT · DOWN ·
  LEFT · UP · RIGHT · DOWN across the eight snaps — correct at two of eight, by luck.

Nothing caught it in six phases. `camera.test.ts` asserted only that pan *magnitude* matched across
yaws, which any sign or basis error passes. The single assertion in the repo that pinned a pan
direction, `keyboard-play.test.ts:1226`, stated it in **sim coordinates** — pointer at the left edge,
`targetX` decreases — and sim +X is only "rightward" if you already know which way the camera faces,
which was the broken thing. It was green on the defect.

## Decision

**Yaw 0 looks north — the eye sits on the `+(sin yaw, cos yaw)` side of the target and looks along
`−(sin yaw, cos yaw)`.** This is what `camera.ts` has claimed since Phase 0 and what `minimap.ts` has
drawn all along; the code is what moved.

**Every screen-space control is derived from that basis rather than written alongside it.** With the
eye on the `+(sin, cos)` side, `lookAt` puts the screen axes on the ground at:

```
screen RIGHT = ( cos yaw, −sin yaw)        screen DOWN = ( sin yaw,  cos yaw)
```

and a pan is `screenDx · right + screenDy · down`, which is the two lines `pan` now contains and
nothing else.

**The alternative was rejected.** Flipping only `pan`'s signs is two lines and fixes the controls,
and it was rejected because it leaves the minimap a 180° rotation of the battlefield — the tester's
*other* complaint — and leaves `camera.ts` contradicting its own comment forever. Setting the default
`yawIndex` to 4 was rejected for the same reason and one more: it hides a wrong basis behind a right
starting angle, so the next person to touch `eyePosition` re-derives the bug with no test between
them and it.

## Consequences

**The rendered world turns 180°.** Every frame the game has ever drawn was mirrored; it is not any
more. That is a visible change to every screenshot and it is the intended one.

**Two things were coupled to the old sign and both broke loudly, which is the good outcome.**

- **The imposter's facing (ADR-0024, and this ADR amends it).** `SceneComposer` used
  `imposterYaw = camera.yaw + π` and its comment stated the dependency in these words: *"the eye
  sits at −(sin yaw, cos yaw) × horizontal … so θ = yaw + π points the quad at the camera"*. With
  the eye moved, the π became the exact back-facing bug that comment was written to fix. It is now
  `θ = yaw`. `test/view/lod-imposter.test.ts` caught it on the same commit — the one place in this
  repo where a comment naming its own dependency paid for itself.
- **Six fixture placements in that test** put their crowd at `eye + (sin, cos) × range`, which was
  in front of the old camera and is behind the new one. The frames drew nothing, and the assertions
  then failed as `NaN` and a one-element set rather than as "the crowd is off screen" — a reminder
  that a fixture computing its own geometry from the code under test inherits that code's bugs.

**`pointAt` misses on the other screen edge now.** `approachRig` frames the landing site rather than
the map centre, so one vertical edge looks past the world and returns no mark. That was equally true
before, at the opposite edge; only which edge changed. The test that asserted a mark there claimed
*"at every pixel"*, which was never true, and now asserts the orientation-independent half — the
picker's camera does not move at either edge — instead.

**The guard is stated in the player's terms from now on.** `camera.test.ts` gains an assertion that
reads the ground under each screen edge with `pickGround` and requires the view to travel toward the
edge the player pushed, at all eight snaps. It mentions neither X nor Y, which is the point: a
mirrored basis that adds up cannot satisfy it. Both historical mutants — the old `eyePosition` sign
and the old `pan` signs — were restored in turn and each killed it.

**What this does not fix.** `detectTier` still disagrees across browsers (P7-T07), and the two
pointer-only gestures are still pointer-only. Neither touches orientation.
