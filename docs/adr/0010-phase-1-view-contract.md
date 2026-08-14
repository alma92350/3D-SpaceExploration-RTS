# ADR-0010: The Phase 1 view contract — camera, start world, and the shape of the port

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §5 (Phase 1), §10 (Q-01, Q-02); ADR-0004, ADR-0005, ADR-0006

## Context

Phase 1 could not start with three questions open, and building the MVP surfaced a fourth that the
PRD's roster does not mention. All four are cross-cutting and hard to reverse once content and
tests are written against them, which is exactly ADR-0001's trigger.

1. **Q-01 — camera yaw: free orbit or snapped?** The PRD recommends snapped for the MVP.
2. **Q-02 — a fixed start world, or the seed's own draw?** The PRD recommends fixed, and names
   `ferros` in passing.
3. **The `Renderer` port's exact surface.** ADR-0005 sketches it; the MVP needs meshes registered
   and a fog field uploaded, and neither appears in that sketch.
4. **The Odyssey opening.** The PRD's MVP roster lists nine entity types, none of which is the
   colony ship — but in Odyssey both sides land with a colony ship instead of a placed Command
   Center (`engine/colony.js`), so without it there is no base and no game to judge.

## Decision

**1. Yaw snaps to eight compass directions (Q-01: snapped).**

A free orbit costs the player their sense of where north is on a map whose two bases are always east
and west, and it costs the renderer the option of pre-sorting instances by facing. Snapped, a
rotation is a deliberate act with a known destination. Pitch is not a separate control at all: it
ramps with zoom (nearly top-down when far out, tilted toward the horizon when close in), so the
player has one camera control instead of three. Revisit in Phase 6 against a readability test,
as the PRD suggests — not before.

**2. The MVP always starts on the same world (Q-02: fixed) — and that world is Helix Belt, not
Ferros Prime.**

The recommendation Q-02 actually made was *fixed*, so playtest reports compare like with like, and
that stands. The world it named in passing does not survive contact with the terrain data: Ferros
Prime's grid is uniformly open — zero rough cells, zero high ground — so a Phase 1 built on it
renders a perfectly flat plane and demonstrates none of the relief ADR-0004 calls "one of the few
things 3D genuinely adds to this game". Only six of the eleven worlds carry terrain stamps at all.

Helix Belt has high ground *and* the roster's richest mixed deposits (ore 1.6, crystals 1.4,
radioactives 1.0), so the opening economy is not the bottleneck while someone is judging how the
world reads. The constant lives in one place (`MVP_WORLD` in `src/bridge/world.ts`).

**3. The `Renderer` port gains two calls beyond ADR-0005's sketch, both off-frame.**

- `registerMeshes(meshes)` — once at boot. Procedural geometry has to reach the implementation
  somehow, and passing it per draw would mean re-uploading it per draw.
- `setFog(field)` — once per sim tick, guarded by a version counter. ADR-0006 requires the fog to be
  "one low-res lookup, not per-entity branching", which means the implementation owns a texture, and
  a texture has to be given to it. Per-frame upload is what the version counter exists to prevent,
  and the conformance suite asserts it.

A third, `flush()`, is optional and exists **only for measurement**: WebGL submission is
asynchronous, so timing around `endFrame` measures how fast we can describe a frame rather than how
long one takes. The game never calls it. (An early perf gate without it reported 0.2 ms frames at
T0 and would have declared any amount of overdraw free.)

Overlay layers all pack scene-space `(x, y, z)` first, where `y` is derived elevation and never a
sim value — so a selection ring sits on the mesa its unit is standing on rather than on the zero
plane.

**4. The colony ship is in the MVP roster, and "deploy" is its first order.**

A tenth mesh, a `deploy` intent through `engine/colony.js`'s own `deployColonyShip`, a HUD button
that appears exactly when a colony ship is selected, and `Z` on the keyboard — upstream's first
positional action key. S6 asks that a first-time player find what to click without documentation,
and at `t=0` there is precisely one thing to click.

**5. There is no starfield, and PRD §5 is wrong to list one.**

Phase 1's scope names "a starfield skybox". It was built and then cut, because it can never be
seen: pitch ramps between 35.5° and 74.5° below horizontal and the vertical FOV is 51.6°, so the
top edge of the view sits between 9.7° and 48.7° BELOW the horizon at every zoom the rig allows.
The camera never looks up. A skybox would have been dead geometry in every frame the game draws.

What was mistaken for empty sky is the void past the map edge, where the terrain mesh stops. That
gets a **dark apron** instead — eight quads in the same merged mesh, so the whole border costs one
sliver of the terrain's existing draw call, exempt from the fog because there is nothing out there
to hide. If a later phase lowers the pitch floor far enough to show the horizon, a starfield becomes
worth having again and this decision should be revisited rather than assumed.

**6. Unexplored ground is dark, not black, and the opening is guided.**

Two changes with one cause: the first thing a player saw was a near-empty screen. At `t = 0` the
player owns one colony ship and has explored ~8% of the map, so pure-black unexplored terrain left
~90% of the view empty, the camera's default 420-unit distance framed the ship as a speck, and
nothing on screen said what to do.

So unexplored terrain now renders at 30/255 rather than 0 — enough to show the ground is there,
nothing else, and it cannot leak because entities under fog never reach the renderer at all. The
camera opens at 210. And the HUD carries a single contextual line while the player has no Command
Center ("Click your colony ship to select it" → "Press Deploy base…"), derived purely from the
snapshot. That last one is the interface answering S6's question rather than a tutorial, which
remains Phase 6's.

**7. Hotkeys are upstream's, letter for letter.** Stop is `X`, not `S`, because W/A/S/D pan the
camera (PRD §5) and upstream gave the pan keys priority; `A` genuinely double-books as pan-left and
arm-attack-move, which is upstream's own resolution. Rotation is `,` and `.` because upstream has
already spent `Q` and `E` on select-army and scout, and binding rotation to them would collide the
day Phase 3 adds those orders.

## Consequences

**This makes easy:**
- Comparable playtests, on a world that actually shows the feature under test.
- One camera control (zoom) instead of three, and a first frame a new player can read.
- A renderer port that three implementations can satisfy, with the fog and mesh paths pinned by the
  conformance suite rather than by convention.

**This makes hard / gives up:**
- Free-orbit expressiveness, deliberately, until Phase 6 revisits it with evidence.
- The MVP shows one world's terrain, so "does the relief read?" is answered for Helix and not for
  the five flat worlds. That is a smaller question, and Phase 4 will have to ask it again when the
  landing picker can drop the player anywhere.
- `flush()` on the port is a measurement-only method on an otherwise product-only interface. Its
  doc comment carries the whole warning; the alternative was a perf gate that lies.

**Obligations it creates:**
- `MVP_WORLD` is the single source of the start world; tests that need other terrain name the world
  they need and say why (see `test/bridge/commands.test.ts`'s rough-ground case).
- The conformance suite covers every port call, including the two added here, for every
  implementation (`e2e/conformance.spec.ts`).
- Q-01 is revisited in Phase 6 with a readability test, not with an opinion.

## Alternatives considered

### Free orbit with a snap-to-north key
The common compromise, and it keeps the readability cost while adding a control to explain. If free
orbit ever arrives it should arrive because a readability test says the snapping is not buying
anything — not as a hedge.

### Keep `ferros` and accept a flat MVP
Cheapest, and it makes the single most important question of Phase 1 — "does the world read better
in 3D?" — unanswerable, because there would be no relief to read. Rejected.

### Randomise the start world from the seed
What the finished game does, and wrong for an MVP whose whole output is comparable playtest reports.
Phase 4 turns this on when the landing picker exists.

### Put the fog in the snapshot only, and let the view rebuild a texture each frame
Keeps the port smaller. Costs a texture upload per frame at exactly the tier that cannot afford one,
for an interface saving of one method.
