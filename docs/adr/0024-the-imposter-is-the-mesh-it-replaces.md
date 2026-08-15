# ADR-0024: The LOD imposter is sized and shaped by the MESH it replaces, not by the entity's radius

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Relates to:** ADR-0005 §3, ADR-0006 §3, ADR-0013, ADR-0014 §2, ADR-0016, PRD §6.2, P6-T07, P7-T02

## Context

PRD §6.2 mandates "LOD with billboard imposters beyond a distance threshold". The imposter arrived in
the Phase 1 MVP commit as **one unit square, scaled by `entityRadius × 2.2` in both dimensions**, and
neither number had any working behind it.

P6-T07 fixed the quad's *facing* — it was not billboarded by either renderer, and at five of the
rig's eight yaw snaps the instance material culled it away entirely — and then measured its
*proportions* and deliberately left them, with numbers. Projecting every mesh vertex and every quad
corner through the same camera onto the 960×540 raster T0 rasterises: **the quad covered 0.73× to
10.35× the mesh's screen area**, median ≈ 2.5×. Binary-searching the distance at which both bounding
boxes agree within one rasterised pixel gave **7 151 to 43 858 world units against a cull distance of
1 100** — so there is no distance at which the swap is invisible, and no `lodDistance` fixes it.
`tiers.ts` recorded that and refused to move the threshold, which was the right call: re-tuning a
distance to hide a size is the "edit the number" move ADR-0006 and ADR-0014 are both about.

That left a real defect standing. ADR-0016 spent eighteen draw calls to give nine units their own
silhouettes because **the silhouette is how this game says what a thing is**; past the LOD distance a
median 57% of the entities on screen were wearing a wrong one. A Skiff is 12.4 units wide and 2.4
high; its imposter was a 15-unit square. A flat ship was replaced by a wall.

Three facts shape the answer, all measured by `perf/imposter-probe.mjs`, which is P6-T07's method as
a program rather than a paragraph — 896 on-screen camera samples × 47 engine types × 8 facings.

1. **The dominant error was the SIZE, and the size was asked of the wrong thing.** `entityRadius` is
   the engine's collision circle. Where ADR-0013's and ADR-0014's families put several types on one
   mesh, the two disagree outright: a Bulk Freighter's collision radius is 15, the freighter hull it
   actually draws is 7.7, and its imposter came out at **2.9× the mesh's screen width**. That single
   case is P6-T07's 10.35×.
2. **`Renderer.drawInstances` offers one uniform scale**, in both implementations and in the port
   (ADR-0005). A quad cannot be given a per-entity aspect ratio without widening `InstanceBatch`,
   which is a port change across three renderers and the conformance suite.
3. **The renderers apply a Y rotation and nothing else**, so an upright quad is foreshortened by the
   camera's pitch — **38% of a billboard's height at the far zoom**, which is exactly where imposters
   live, since that is when most of the field is past the LOD distance. `scene.ts` recorded this as
   "a full billboard needs a renderer change".

## Decision

**1. The imposter's size is `IMPOSTER_SIZE[mesh]` — the mean width of that MESH's own footprint,
averaged over every facing.** An imposter replaces a mesh, so the only size that cannot pop is the
size of the thing it replaces. Not `MeshData.radius × 2`, which is the *widest* the footprint ever
projects and overstates the on-screen width by a median 24% and by up to 2.17×; this is Cauchy's mean
width — the support width averaged over directions, which for a convex footprint is its perimeter
over π — because the imposter deliberately does not turn with the entity and therefore has to be
worth what the mesh is worth on average. Computed once at module load from the generators' own
vertices, read as one property lookup per imposter per frame.

**2. The quad leans away from the camera by `IMPOSTER_LEAN` = 0.96 rad, which is the camera rig's own
mid-pitch.** `input/camera.ts` ramps pitch between `PITCH_NEAR` 0.62 and `PITCH_FAR` 1.30 as a pure
function of zoom; the midpoint is 55.0°. A quad built already leaning by θ projects its height by
`cos(pitch − θ)`, so leaning at the middle of the ramp makes it a billboard to within ±19.5° at every
zoom the game has — **without touching a renderer**. Measured against a quad turned to face the eye
squarely at each zoom:

| camera pitch | 37.7° | 42.0° | 46.3° | 52.8° | 61.5° | 70.2° | 74.5° |
|---|---|---|---|---|---|---|---|
| leaning | 80% | 88% | 94% | 99% | 100% | 99% | 99% |
| upright | 113% | 102% | 90% | 73% | 55% | 42% | 38% |

The claim is not "leaning is closer at every zoom" — at the shallowest zooms, where the LOD distance
is a sliver at the top of the screen, upright is nearer and slightly over. It is that leaning is
**steady**: a fallback whose height depends on how far the player has zoomed changes size when
nothing in the world did. The lean also survives back-face culling by construction — the quad's
outward normal rotates up with it to `(0, sin θ, cos θ)` and the eye sits at elevation `pitch`, so the
facing dot product is `cos(pitch − θ) > 0` at every zoom rather than at most of them.

`generators.ts` writes 0.96 rather than importing it, because `input/` already imports `view/` and
that arrow must not turn around. `test/view/lod-imposter.test.ts` asserts the equality instead, so a
rig whose pitch ramp moved would go red on the commit that moved it.

**3. The quad stays square, and that is a measurement rather than a default.** Its projected aspect
has to stand in for a roster whose own height-over-width runs from 0.20 (Breacher) to 1.40 (relay
mast), and the pitched camera compresses that spread because a mesh's screen box is dominated by its
ground footprint. Square is the minimax: at 1.00 the worst case is a Skiff 2.20× too tall and a Plasma
Rig 0.48× too short, which are the same error in opposite directions. 0.85 makes the Plasma Rig 2.43×
wrong; 1.15 makes the Skiff 2.53× wrong.

**4. It remains ONE mesh for the whole roster.** The batch key is (mesh, owner, LOD), so a second
imposter mesh is a second draw call on every frame both are on screen — and the per-instance scale
channel that carries the size already exists, which is ADR-0014 §2's rule arrived at again. The fix
costs **no draw calls, no triangles and no allocation**; the frame's only new work is one property
lookup per imposter, in a loop that already does two for `meshIdForType`.

**5. What is left is named here rather than discovered later.** Screen-box agreement over the whole
sweep, quad against mesh:

| | screen width | screen height | screen area |
|---|---|---|---|
| before | 0.88–2.99× (median 1.67) | 0.34–5.60× (median 1.21) | 0.30–14.68× (median 2.01) |
| **after** | **0.95–1.13× (median 1.05)** | **0.48–2.20× (median 1.09)** | **0.49–2.23× (median 1.15)** |

At P6-T07's own single configuration, which is the one `tiers.ts` quotes: area **0.78–10.35×
→ 0.68–2.09×**, and the Bulk Freighter that was a 41.7×30.2 px quad over a 7.7×15.7 px mesh is now
15.5×15.3 px.

## Consequences

**This makes easy:**
- Reading a distant field. Width is now the mesh's own, to within 13% at every zoom and every yaw
  snap, so a distant Command Center is a Command Center's width and a distant Skiff is a Skiff's.
- Changing a mesh. The imposter follows it — it is computed from the same vertices — so a generator
  edit can no longer leave the fallback describing the shape it used to be.
- Adding a unit type. There is nothing to remember: no per-type constant, no table to update.

**This makes hard / gives up:**
- **The remaining height error is the roster's own aspect spread, and a uniform scale cannot follow
  it.** A Skiff 2.4 units high and a Plasma Rig 26 cannot both be a square. Closing that needs a
  per-instance non-uniform scale in `InstanceBatch` — a `Renderer` port change across three
  implementations and the conformance suite — and it is not worth it for a factor the measurement now
  bounds at 2.2× on one dimension, where it was 5.6× and unbounded on the other.
- **An imposter still does not turn with its entity**, so it cannot follow a mesh whose own screen
  width varies by up to 3.25× across its eight facings. Deliberate: `scene.ts` computes one yaw for
  the whole frame precisely so that imposters never rotate against each other, and the alternative is
  an `atan2` per instance per frame.
- **The leaning quad occupies ground behind the entity** — up to 0.82 × its size — so on a relief
  tier an imposter standing directly in front of a cliff can have its top edge inside the hill. T0,
  the tier the budget is about, draws flat terrain and cannot see this at all.
- **The quad's screen box still sits above the mesh's**, by a p95 of 0.39 of the mesh's own diagonal
  (0.62 before). The mesh's box hangs below the entity's position because its footprint recedes into
  the screen; the quad's base is *at* that position. Shifting the quad toward the camera halves the
  residual and was rejected: it would make an entity's drawn position a function of where the camera
  is standing, and the whole imposter field would slide when the player rotated.
- **Four freighters now share an imposter as well as a hull.** That is ADR-0014's cost, arriving one
  layer further out; the imposter was previously *disagreeing* with the mesh about it, which was not a
  benefit.

**Obligations it creates:**
- `perf/imposter-probe.mjs` is the measurement of record and must be re-run, not re-argued, if the
  quad, the roster or the camera's pitch ramp changes.
- `test/view/lod-imposter.test.ts` bounds the screen box **on both sides**. A quad that shrank to
  nothing would satisfy any "not too big" assertion ever written.
- The lean is asserted against `camera.ts`'s own constants. If `input/` and `view/` ever gain a shared
  place for camera geometry, that constant should move there rather than be copied again.

## Alternatives considered

### Leave it, and rule on it
Legitimate, and it was P6-T07's call with the information P6-T07 had: it is a visual decision, and
"the fix is the quad's proportions" reads like a request for a renderer feature. The measurement says
otherwise — the dominant term was the *size*, which needed no renderer at all, and the pitch term
turned out to be buyable with a lean baked into two triangles. Ruling on it would have parked a
defect behind a cost that is not real.

### One imposter mesh per silhouette
The most obvious fix and the one ADR-0006 forbids: the batch key is (mesh, owner, LOD), so N imposter
meshes is up to N × 2 extra draw calls on the frames that matter most — the far-zoom frames where the
whole field is imposters and the batch count is already at its peak. ADR-0014 spent draw calls on
distinctions a player acts on; this would spend them on a distinction that exists only at the range
where nothing is legible anyway.

### A per-instance aspect in `InstanceBatch`
The complete fix, and the only one that closes the remaining 2.2×. Rejected on scope rather than on
merit: it is a `Renderer` port change (ADR-0005) touching three implementations, the conformance
suite and every batch the game submits, in exchange for a factor the roster's own spread bounds at
2.2 on one dimension. Named here so the next person weighing it has the number rather than the
adjective.

### Scale the existing square to match the mesh's screen AREA
One line, no lean, no new geometry: pick the scale so `w × h` agrees. It gets the median right and
leaves both dimensions wrong in compensating directions — a Skiff becomes a small square instead of a
large one, which is a different wrong shape at the correct area. Measured: width 0.98–1.14, height
0.29–2.92, area 0.31–3.01, against 0.95–1.13 / 0.48–2.20 / 0.49–2.23 with the lean.

### Lean the quad all the way to the far pitch (74.5°)
Better at the far zoom, where imposters are most numerous, and worse everywhere else: measured height
0.31–1.44× against 0.48–2.20×, but biased low across the ramp — every imposter drawn short at the
zooms where the player is closest to reading them. The rig's mid-pitch is the balanced choice and it
is derived from the rig rather than fitted to the roster, which is the property that matters when
someone changes the roster.

### Lay the quad flat on the ground
A footprint patch tracks the mesh's screen box well at high pitch, needs no lean, and cannot be a
billboard: at the shallow zooms it collapses to a sliver, it z-fights the terrain it lies on, and PRD
§6.2 asks for a billboard. The lean gets the same benefit at high pitch without any of that.
