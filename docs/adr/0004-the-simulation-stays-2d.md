# ADR-0004: The simulation stays 2D; 3D is a projection

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §7; ADR-0003

## Context

"A 3D version of the game" can mean two very different things:

1. **A 3D simulation** — entities have a `z`, terrain has real slopes, projectiles arc, line of
   sight is volumetric, pathing is 3D.
2. **A 3D presentation of a 2D simulation** — the world is a plane, and the camera, meshes and
   lighting are three-dimensional.

The source simulation is unambiguously planar: positions are `(x, y)` floats, radii are circles,
collision is circle-vs-circle, fog is a 2D byte grid at 40-unit cells, terrain is that same grid
with three values (open / rough / high ground), and combat, movement and sight all read that grid.
Vendoring it unmodified (ADR-0003) means the sim's dimensionality is not ours to change.

That is not a limitation to apologise for. Almost every readable RTS — including the ones that
render in 3D — simulates on a plane. Height in those games is a terrain *attribute* that modifies
movement, vision and damage, which is precisely what the existing terrain grid already is.

## Decision

We will keep the simulation strictly 2D and treat the third dimension as **presentation derived
from existing sim data**.

- World coordinates remain `(x, y)`. No sim value gains a `z`.
- **Elevation is a pure function of the terrain grid**: `elevation(x, y) = f(terrain.type[cell])`,
  with `0` (open), `1` (rough) and `2` (high ground) mapping to three base heights, smoothed across
  cell boundaries for rendering only. This function lives in `src/view/terrain/elevation.ts` and is
  the single source of visual height — meshes, unit placement, camera collision and picking all
  call it.
- Entities are placed at `(x, elevation(x, y), y)` in scene space. Their *simulation* position is
  unchanged.
- Ground picking projects the camera ray onto the elevation field, then **returns `(x, y)` only**.
  Order placement must agree with the sim's coordinate to within ±0.5 world units at any camera
  angle (PRD F-03).
- Anything the sim does not model — projectile arcs, banking, recoil, hover bob, muzzle flashes —
  is allowed as **pure decoration**, must be deterministic-safe (derived from entity id, tick and
  interpolation alpha, never from a private random or accumulated state), and must never feed back
  into a sim value.

## Consequences

**This makes easy:**
- The entire simulation, its determinism guarantee and its 41k lines of tests carry over untouched.
- Perf: no 3D pathing, no volumetric visibility, no physics. The frame budget is spent on drawing.
- Readability: a plane with modest relief keeps the RTS legibility that a fully 3D battlefield loses.

**This makes hard / gives up:**
- No genuine multi-level maps, bridges, tunnels or flying-over-terrain gameplay. Ever, without a
  new sim.
- Dramatic terrain is off the table: elevation is a three-value grid, so cliffs are the only kind
  of relief available. Visual smoothing can soften this; it cannot invent geography.
- The temptation to "just add a little z for this one effect" will recur. It is forbidden precisely
  because the second time is what breaks determinism.

**Obligations it creates:**
- `elevation()` is covered by tests including cell boundaries and map edges (`P1-T04`).
- A picking test suite across camera yaw/pitch/zoom and all three terrain values (`P1-T12`).
- A lint/architecture test forbidding `z`, `height`, or `elevation` fields on any object that
  crosses the bridge from the sim (`P1-T13`).

## Alternatives considered

### A true 3D simulation
Would require rewriting movement, collision, fog, combat and AI — i.e. abandoning ADR-0003 and the
tests with it — to deliver gameplay nobody asked for. Rejected decisively.

### A heightmap authored independently of the terrain grid
Prettier terrain, but then two sources of truth disagree: the sim says a cell is passable open
ground, the view draws a ridge there, and the player's orders stop making sense. If we ever want
richer terrain, it must come from the sim's own grid — upstream.

### Flat ground, 3D only for the entities
Cheapest of all and briefly considered for tier T0. Rejected as the *default* because the terrain
relief is one of the few things 3D genuinely adds to this game. It survives as a T0 fallback knob:
at the compatibility tier the terrain mesh may collapse to a plane with the terrain types painted as
flat colour — the same information, no vertices.
