# ADR-0019: The starmap is a 2.5D diagram on a plate, because the galaxy has one coordinate

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Answers:** Q-03
**Relates to:** PRD §5 (Phase 4), §10 (Q-03); ADR-0004, ADR-0005, ADR-0010, ADR-0014, P4-T02, P4-T03

## Context

Q-03 has been open since Phase 0 and is now due: is the starmap a true 3D scene, or a 2.5D
diagram? P4-T02 frames it as a **draw-call and legibility** question and requires a measurement.

Everything below was measured with `perf/starmap-probe.mjs`, against the real engine data, the real
`Renderer` port and the real `CameraRig`.

### 1. The draw-call question does not decide it

| | Draw calls | With the battlefield still drawn | ADR-0014's derived ceiling |
|---|---|---|---|
| True 3D scene, one shared body mesh | **8** | 30 | 119 |
| True 3D, plus a mesh per world status | **20** | 42 | 119 |
| 2.5D diagram, one shared disc mesh | **8** | 30 | 119 |

Eleven worlds, their lanes, their stances and their alerts come to **eight draw calls** — three
instance batches (one per owner slot, and the port has exactly three) and five overlay layers. It is
the same eight either way, because the difference between the two options is *where the worlds are*,
not *what is drawn*. Against a ceiling of 119 the arithmetic P4-T02 asked for **has no opinion**, and
that is worth stating rather than dressing up: the answer had to come from a measurement that could
actually separate them.

The same holds for "replaces or overlays". The battlefield's own T0 frame measures 22 draw calls
today (`npm run perf`), so a starmap drawn *over* it is 30 of 119 and a starmap that *replaces* it is
8. Neither binds. What replacing does not free is the simulation — `stepGalaxy` runs whether or not
the battlefield is on screen — and the sim is the half that spends this project's budget anyway
(ADR-0016, P2-T18).

One constraint did fall out of the port while counting. **`InstanceBatch.scale` is a single uniform
scale per instance**, so a lane segment of arbitrary length cannot be an instanced mesh at all: lanes
are either one batch each (55 in the worst case) or one `rally`-shaped overlay layer for all of them.
That is forced, and it is forced identically for both options.

### 2. The galaxy has one coordinate, and two functions read it

| | |
|---|---|
| `ODYSSEY_WORLDS` | **11** |
| Coordinate fields present on **every** world in `data.js` `PLANETS` | **`x`** |
| Coordinate fields present on **any** world | **none besides `x`** |
| Engine read-sites of a world's position | **2**, both `Math.abs(Δx)` |

The two are `jumpCost` (`galaxy.js:975`) — fuel scales with `|Δx|` — and `checkExpansion`
(`galaxy.js:605`), where a developed faction colonises **the nearest unclaimed world by `|Δx|`**.
That second one is not incidental: claims spreading across the roster is something P4-T03 must
*draw*.

Verified against the function rather than against its comment — `jumpCost` from `helix`:

```
pyralis 342cr@Δx1  verdani 342cr@Δx1  kybernet 364cr@Δx2  ferros 387cr@Δx3  nimbus 387cr@Δx3
glacius 409cr@Δx4  forge 431cr@Δx5  korrath 498cr@Δx8   oort 520cr@Δx9    vesper 564cr@Δx11
```

Monotone in `|Δx|`. **`|Δx|` is the quantity a player ranks when choosing where to jump.**

Everything else about world-to-world relationships is topological, not spatial. A lane is
`{ id, from, to, commodities, shipIds }` — no geometry, no length, no travel time — and `runLanes`
moves cargo on a fixed `LANE_PERIOD` regardless of how far apart the two worlds are.

So a 3D starmap would require **22 invented numbers** — a `y` and a `z` per world — that no engine
value can validate, corroborate or contradict.

### 3. Measured: what those invented numbers cost

For each layout, over every seat and every pair of destinations from it, how often does the screen
rank the two destinations in the **opposite order** to what the engine charges to jump between them?

| Layout | Discordant, authored view | Discordant, worst view | Marker collisions, worst | Narrowest axis |
|---|---|---|---|---|
| **Plate**: `x` on one axis, three-row stagger | **5.2 %** | 6.7 % | **0** | 208 px |
| Plate with no stagger at all | 0.0 % | 0.8 % | 6 | 0 px |
| **3D shell** — a galaxy that looks like a galaxy | 37.6 % | **45.9 %** | 1 | 399 px |
| **3D with `x` preserved as one axis** | 5.4 % | 7.5 % | **3** | 331 px |

A diagram is read at its authored view only — it does not orbit, for the same reason `ui/minimap.ts`
stays north-up "regardless of camera yaw". A scene has to hold up at every view, so a scene's honest
figure is the worst column and a diagram's is the authored one.

Two readings, and both point the same way:

- **A 3D starmap that looks 3D is wrong about jump cost four times in ten.** 45.9 % discordant is
  worse than a coin flip on the one spatial quantity the game computes.
- **The best possible 3D starmap is no more truthful than the plate** — 5.4 % against 5.2 % — and it
  adds up to three marker collisions the plate does not have. Preserving `x` as one axis is the most
  faithful 3D layout available, and it buys **nothing measurable** over simply drawing that axis.

The plate is not perfect either, and the stagger is why: laying the eleven worlds on a bare line
scores 0.0 % but collides six pairs of markers at every view. **5.2 % discordance is the price of
legibility, paid deliberately**, and it is the smaller of the two costs.

### 4. Why a collision cannot be fixed, in either renderer

`WebGLRenderer.drawOverlay` draws to `this.overlayCtx` — a **second, flat 2D canvas stacked over the
WebGL canvas**. `Canvas2DRenderer.drawOverlay` calls `flushFaces()` and then draws on top. **Neither
implementation depth-tests an overlay against scene geometry, and neither can**, because in one of
them the overlay is not in the scene at all.

ADR-0005 §4 puts everything the player must read behind `drawOverlay`. On a starmap that is
*everything*: `galaxyStatus` reports nine channels per world — `id, status, income, pacified, stance,
industry, tech, faction, controlledBy` — and not one of them is geometry. A starmap is almost purely
overlay, and overlays are depth-blind.

In a volume, that means a stance ring belonging to a world far behind another paints straight over
the nearer one, with nothing available inside the port to disambiguate it. On a plate nothing is
behind anything, so depth-blindness costs exactly zero. **This is the ADR-0005 constraint P4-T02
predicted would be load-bearing, and it is.**

Canvas2D's *throughput* is not the problem and should not be mistaken for it: the starmap submits
**720 triangles against the 13 086** the fallback already sorts every frame on a T0 battlefield —
5.5 %. It can draw a 3D starmap. It cannot draw a depth-correct marker, and neither can WebGL.

### 5. What 3D would actually buy

ADR-0004 names relief as "one of the few things 3D genuinely adds to this game". **There is no relief
here.** A starmap has no terrain grid, no elevation field and nothing with a height — the one thing
3D was admitted for is absent by construction.

ADR-0010 §5 cut Phase 1's starfield on the finding that **the camera never looks up**: pitch ramps
between 35.5° and 74.5° *below* horizontal at every zoom the rig allows. A volume of worlds needs a
free orbit that looks up and around — which is the camera ADR-0010 refused for the battlefield under
Q-01, on readability grounds, with "revisit in Phase 6" attached. A true 3D starmap does not merely
want a new layout; it wants that decision reopened two phases early, to buy 0.2 percentage points of
*worse* fidelity.

## Decision

**We will build the starmap as a 2.5D diagram: worlds on a plate, `x` mapped to one screen axis, read
at one authored orientation.**

1. **`x` is the only load-bearing coordinate in the layout.** It is the axis the engine's own two
   spatial functions read, so a world that looks twice as far away costs about twice as much to reach
   and is roughly where a faction's claims will spread next.

2. **The cross-axis carries no meaning.** It is an authored stagger, for marker separation only.
   Measured price: 5.2 % discordance instead of 0.0 %, bought with six marker collisions removed.
   Nothing may ever be encoded on it — the moment it means something, the plate acquires the exact
   defect this ADR rejected 3D for.

3. **The plate does not orbit. Yaw is not a starmap control.** `ui/minimap.ts`'s precedent, for its
   reason: "a minimap that rotated with the camera would be worse at its only job."

4. **Worlds are still instanced meshes through the port — this is 2.5D, not 2D.** Same `Renderer`,
   same batching rule, same conformance suite, same Canvas2D path. The starmap does not become a
   second drawing stack, and it shares its projection with P4-T05's landing picker, which is the
   genuinely 3D thing Phase 4 builds.

5. **Lanes are one `rally`-shaped overlay layer, not geometry.** Forced by the port's uniform-only
   `InstanceBatch.scale`; the alternative is 55 batches for a line.

6. **What the per-world vocabulary is — one mesh with per-instance channels, or a mesh per status —
   is P4-T03's, not this ADR's.** Measured here so that row does not have to measure it again: **8
   draw calls against 20, both against 119.** The budget does not bind, which by ADR-0016's own
   reasoning means legibility decides it and not arithmetic.

## Consequences

**This makes easy:**
- P4-T03's actual job. Every channel `galaxyStatus` reports lands on a plate where no marker is ever
  occluded by a world, so "a stance change is visible without opening a panel" is reachable.
- P4-T04's jump UI. The map already shows what a jump costs, because the axis *is* the cost.
- The Canvas2D path, which draws the identical screen instead of a reduced one — the first screen in
  this project where the fallback loses nothing at all.
- Faction spread reads as spread: claims creep along the axis they actually creep along.

**This makes hard / gives up:**
- **The starmap will not look like a galaxy**, and PRD §5 calls it "worlds in space". A plate of
  eleven discs is honest and plain, and someone will want to make it a nebula. That temptation is the
  thing this ADR exists to answer, and the answer is a number: 45.9 %.
- **The plate lies a little too** — 5.2 % of ranked pairs, from the stagger. Not zero, deliberately,
  and the bare-line alternative is priced above.
- **Depth is off the table as an information channel forever**, not just now. If the galaxy ever
  wants to show something a plate cannot hold, this decision has to be reopened rather than bent.
- No free-orbit camera arrives for Phase 4, so Q-01 stays shut until Phase 6 as ADR-0010 intended —
  which is a consequence, not a bonus: P4-T05's approach view now has to work under the snapped rig.

**Obligations it creates:**
- **P4-T03 must assert that the galaxy is still one-dimensional**: a test that every `ODYSSEY_WORLDS`
  entry carries exactly the numeric coordinate `x` and no other, and that no engine function reads a
  world position except as `Math.abs(Δx)`. This ADR's premise is a fact about vendored data that
  `scripts/sync-engine.mjs` can change without anyone noticing. The test is what makes the supersede
  trigger below fire instead of rot.
- The stagger's meaninglessness needs pinning too, or it will quietly acquire a meaning.
- P4-T12's playtest script must ask "which world is the cheap jump?" and check the answer against
  `jumpCost`. Everything above is a proxy for comprehension; nobody has measured comprehension.

## The trigger, stated in advance

**This ADR is superseded, with a measurement, when either of these happens:**

1. **A world gains a second coordinate.** If `PLANETS` entries acquire a `y`, or any engine function
   starts reading a world position as something other than `|Δx|`, the premise is gone: the galaxy
   would be genuinely two- or three-dimensional and a plate would then be the thing throwing
   information away. The test named above is what reports it, in the same sync that lands it.
2. **P4-T12's playtest reports players cannot attribute a marker to a world on the plate.** Then the
   first thing to try is a wider stagger and labels — re-measuring discordance and collisions with
   `perf/starmap-probe.mjs`, which is why it is committed — and *not* 3D, which measured worse on
   both counts.

Note what is deliberately **not** a trigger: "it looks flat". That is the argument this ADR was
written to settle, and it was settled with the table in §3.

## Alternatives considered

### A true 3D scene — worlds on a galactic shell
The thing Q-03 actually asks about, and the thing the PRD's own phrase "worlds in space" pictures.
**37.6 %–45.9 % discordant against jump cost**: the screen tells the player the wrong thing about
where to jump roughly four times in ten. Rejected on that number.

### A true 3D scene with `x` preserved as one axis
The strongest form of the 3D answer, and the one worth taking seriously: keep `x` honest, use the
other two axes for arrangement. Measured at **5.4 %–7.5 % discordant** — no better than the plate's
5.2 % — while adding **up to three marker collisions** the port cannot disambiguate, and requiring a
free-orbit camera ADR-0010 refused under Q-01. It costs a reopened camera decision and buys nothing
that measures. Rejected, and it is the alternative to re-run the probe against if trigger 1 fires.

### A bare line — perfect fidelity, no stagger
**0.0 % discordant**, which is the best fidelity available from any layout, and **six colliding
marker pairs at every view**. Rejected for the same reason 3D was: an overlay that cannot be
attributed to a world is not information. The stagger's 5.2 % is what that costs, priced and paid.

### Raise or re-derive something to make the draw-call framing decide
There is nothing to raise. ADR-0014 made the ceiling derived, and both options measure 8 draw calls
against 119. Recorded because the row was *framed* as a draw-call question and it is not one — the
budget stopped being the binding constraint somewhere around Phase 3, and pretending otherwise would
have produced a confident answer from a measurement that had no opinion.

### A pure 2D panel, outside the renderer port
`ui/minimap.ts` is exactly this and is deliberately 2D, so the precedent exists. Rejected because the
plate costs 5.5 % of a T0 battlefield's faces — there is no budget argument for leaving the port —
and because P4-T05's landing picker needs a camera and a projection to share with it. A second
drawing stack for the screen Phase 4 exists to build is a cost with no matching saving.
