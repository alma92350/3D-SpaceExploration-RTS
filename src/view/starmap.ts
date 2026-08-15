// The starmap: worlds, claims, stances, alerts (P4-T03), composed exactly as ADR-0019 decided.
//
// This is `view/scene.ts`'s opposite number for the screen above the battlefield, and it is built
// on one settled decision rather than a fresh design. **ADR-0019: the starmap is a 2.5D diagram on
// a plate, because the galaxy has one coordinate.** Everything structural here descends from that
// and none of it is re-litigated:
//
//   • **`x` is the only load-bearing coordinate.** It is the axis the engine's own two spatial
//     functions read — `jumpCost` charges `|Δx|`, `checkExpansion` colonises the nearest unclaimed
//     world by `|Δx|` — so a world twice as far along the plate really does cost about twice as
//     much to reach. `plateX` is that mapping and it is affine and monotone, which is what makes
//     the claim checkable rather than decorative.
//   • **The cross-axis carries nothing.** `plateZ` is a function of the ROSTER INDEX and of
//     absolutely nothing else. Measured price: 5.2 % of ranked destination pairs read backwards,
//     bought with six marker collisions removed (`perf/starmap-probe.mjs`). The moment anything is
//     encoded on it, the plate acquires the exact defect the ADR rejected 3D for — so
//     `test/view/starmap.test.ts` re-lays the whole plate under wildly different galaxies and
//     asserts every z is unchanged.
//   • **The plate does not orbit.** `AUTHORED_VIEW` is the one orientation it is read at, on
//     `ui/minimap.ts`'s precedent: "a minimap that rotated with the camera would be worse at its
//     only job." The layout is authored for yaw 0 and priced there.
//   • **Worlds are instanced meshes through the same port** — this is 2.5D, not 2D. Same batching
//     rule, same conformance suite, same Canvas2D path, which draws the identical screen rather
//     than a reduced one.
//
// **The overlay vocabulary is the port's existing one, unextended, and that is a constraint worth
// stating.** Adding an `OverlayKind` means adding to `OVERLAY_STRIDE` and teaching all three
// implementations to draw it. Nothing here needed a new geometry badly enough to justify that, so
// each channel below is an existing kind used for the shape it already draws: a bar with a
// fraction, a ground ring, a dot, a highlight ring. Where that costs legibility it is said so out
// loud rather than papered over — see `ALERT_KINDS`.

import {
  NO_FACTION, WORLD_COLONY, WORLD_CONTESTED, WORLD_PACIFIED, WORLD_SEAT, WORLD_UNEXPLORED,
  type GalaxySnapshot,
} from "../bridge/galaxy-snapshot.js";
import { type MeshId } from "./meshes/generators.js";
import {
  type CameraState, type FrameStats, LOD_MESH, OVERLAY_STRIDE, OWNER_AI, OWNER_NEUTRAL,
  OWNER_PLAYER, type OverlayKind, type OwnerSlot, type Renderer,
} from "./renderer/port.js";

/* =================================================================================================
   THE PLATE — placement, and nothing else.

   Both numbers below are `perf/starmap-probe.mjs`'s, unchanged. They are not taste: the probe
   measured this exact layout at 5.2 % discordance against `jumpCost` and 0 marker collisions at
   the authored view, and the alternatives it priced (a bare line, a galactic shell, 3D with `x`
   preserved) are recorded in ADR-0019 §3. Changing either is re-running the probe, not editing a
   constant.
   ================================================================================================= */

/** World units per unit of planet `x`. Sized so the eleven-world roster fills the plate. */
export const PLATE_SPREAD = 60;

/**
 * The stagger: three rows, for marker separation ONLY.
 *
 * ADR-0019 decision 2, in full: "Nothing may ever be encoded on it — the moment it means something,
 * the plate acquires the exact defect this ADR rejected 3D for." Laying the roster on a bare line
 * instead scores a perfect 0.0 % discordance and collides six marker pairs at every view; this is
 * what removing those six costs.
 */
export const STAGGER_ROWS: readonly number[] = [-130, 0, 130];

/**
 * Where the plate sits in scene space, and the one orientation it is read at.
 *
 * `yawIndex: 0` is not a default — it is the authored view. The probe measured the same plate at
 * all eight of the rig's snapped yaws: 5.2 % discordant at 0 and 4, up to 6.7 % elsewhere, and the
 * roster's narrow screen axis swinging between 208 px and 476 px. A diagram is read at one
 * orientation, so yaw is not a starmap control.
 */
export const AUTHORED_VIEW = {
  /** Scene x/z the plate is centred on — the camera's own look-at point. */
  centreX: 1200,
  centreZ: 1200,
  /** Fully zoomed out, which is where the rig's pitch is nearest to overhead (74°). */
  distance: 900,
  yawIndex: 0,
} as const;

/**
 * The mesh a world is drawn with.
 *
 * `node` is the deposit rock, borrowed. It is the wrong noun and the right shape — a small, neutral,
 * owner-tintable solid that reads as a marker on a plane — and adding a purpose-built disc means
 * editing `meshes/generators.ts`, which this change deliberately does not touch. The batch key is
 * `(mesh, owner, LOD)`, so swapping the geometry later changes the picture and not one line of the
 * arithmetic below.
 */
export const STARMAP_WORLD_MESH: MeshId = "node";

/**
 * Instance scale for a world, before its status modifies it.
 *
 * The `node` mesh is 9 world units of radius, so 3.5 puts a world at ~31 units — about 25 px at the
 * authored view, against the 28 px marker radius the probe's collision measurement assumed. Worlds
 * are therefore no closer to overlapping than the layout was priced for.
 */
export const WORLD_DISC_SCALE = 3.5;

/** Ring radii, world units. Both sit outside the disc so neither hides it. */
const CLAIM_RING_RADIUS = 44;
const SEAT_RING_RADIUS = 56;

/** Overlay lift off the plate. Flat, so these separate layers rather than clearing terrain. */
const RING_LIFT = 0.3;
const BAR_LIFT = 34;
const MARK_LIFT = 52;

/**
 * The mid-point of the roster's `x` span, so the plate is centred under the camera.
 *
 * Computed from the roster that exists rather than hard-coded, because `deserializeGalaxy` can
 * append worlds a save predates — and a plate centred on yesterday's roster drifts off the look-at
 * point the day one arrives.
 */
export function plateMidX(x: Float32Array, count: number): number {
  if (count <= 0) return 0;
  let lo = x[0]!;
  let hi = x[0]!;
  for (let i = 1; i < count; i++) {
    const v = x[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return (lo + hi) / 2;
}

/**
 * A world's position along the plate's ONE meaningful axis.
 *
 * Affine and strictly increasing in the engine's `x`, which is the whole of ADR-0019's fidelity
 * claim: screen order along this axis is `|Δx|` order, and `|Δx|` order is `jumpCost` order.
 */
export function plateX(engineX: number, midX: number): number {
  return AUTHORED_VIEW.centreX + (engineX - midX) * PLATE_SPREAD;
}

/**
 * A world's position across the plate — **a function of its roster index and nothing else.**
 *
 * Deliberately takes no world data at all. A signature that could not see a stance, a claim or a
 * status is the cheapest possible guarantee that none of them can leak onto this axis, and the
 * guarantee is the point (ADR-0019 decision 2).
 */
export function plateZ(rosterIndex: number): number {
  return AUTHORED_VIEW.centreZ + STAGGER_ROWS[rosterIndex % STAGGER_ROWS.length]!;
}

/* =================================================================================================
   THE PER-WORLD VOCABULARY — one mesh, per-instance channels.

   ADR-0019 §6 left this open on purpose and priced both answers: 8 draw calls for one shared mesh,
   20 for a mesh per status, against a derived ceiling of 119. "The budget does not bind, which by
   ADR-0016's own reasoning means legibility decides it and not arithmetic."

   Legibility decides one mesh, for a reason that is specific to this screen rather than general: a
   starmap marker's identity is WHERE IT IS. The player is looking for Ferros, and Ferros is the
   fourth marker from the left whether it is a disc or a fortress. Five silhouettes would ask them
   to learn a vocabulary to read a channel — status — that the colour, the size and the badge above
   the marker already carry three ways over. On the battlefield the opposite is true, which is why
   ADR-0016 went the other way there: a Lancer is identified by its shape because it MOVES.
   ================================================================================================= */

/**
 * Which owner colour a world flies. Ordered, and the order is the decision.
 *
 * 1. **Yours** — the seat, a colony you still hold, or a world you pacified. Pacified outranks a
 *    claim on purpose: pacification is a fact about your own conquest and it pays you
 *    `PACIFIED_INCOME` every second, while a faction flag over a world whose capital you razed is a
 *    flag over a graveyard.
 * 2. **Somebody else's** — claimed by a faction (`checkExpansion`'s spread), or contested: a world
 *    you have been to and hold nothing on.
 * 3. **Nobody's** — the unexplored, unclaimed fringe.
 *
 * Colour is never the only cue (N-05): scale says how known a world is, the badge above it says how
 * its neighbour feels, and position says which world it is.
 */
export function ownerSlotForWorld(status: number, claim: number): OwnerSlot {
  if (status === WORLD_SEAT || status === WORLD_COLONY || status === WORLD_PACIFIED) return OWNER_PLAYER;
  if (claim !== NO_FACTION || status === WORLD_CONTESTED) return OWNER_AI;
  return OWNER_NEUTRAL;
}

/**
 * How big a world draws: how much of it you know.
 *
 * The seat is largest because "where am I" is the first question anyone asks of a screen that is
 * not the battlefield (P4-T12 will ask it out loud). An unexplored world is smallest because that
 * is what it is — a destination, not a place yet.
 */
export function worldScale(status: number): number {
  if (status === WORLD_SEAT) return WORLD_DISC_SCALE * 1.5;
  if (status === WORLD_UNEXPLORED) return WORLD_DISC_SCALE * 0.7;
  return WORLD_DISC_SCALE;
}

/**
 * How bright a world draws: whether you could go there right now.
 *
 * `canJumpTo` is the engine's own answer and it is emphatically not "do I have a Spaceport" — a
 * stranded force can always fall back to a world where it still holds a foothold. It is also
 * `false` for the seat, because the seat is not a destination, so the seat is special-cased here
 * rather than dimmed as if it were unreachable. That trap is the reason this reads a status code
 * and not just the flag.
 */
export function worldShade(status: number, reachable: number): number {
  if (status === WORLD_SEAT) return 1;
  return reachable === 1 ? 0.9 : 0.5;
}

/**
 * The neighbour's stance, as the fraction a bar is filled to.
 *
 * Monotone in the engine's raw -1..1 stance and **banded nowhere**. `stanceLabel` owns the five
 * bands (Hostile, Wary, Neutral, Cordial, Allied) and their edges move with `PEACE_THRESHOLD`;
 * neither the function nor the constants are exported past the bridge, so a threshold invented here
 * would be a second, divergent answer to a question the simulation already answers — ADR-0012 §5's
 * exact case. A monotone map needs no thresholds to be true, and a bar that fills and empties makes
 * a stance CHANGE visible on the map itself, with no panel opened, which is what P4-T03 owes.
 *
 * (`overlays2d.ts` does colour its bar in three bands of its own — owner colour above 0.5, amber
 * above 0.25, red below — and those land at stance 0 and stance -0.5. The second coincides with
 * `stanceLabel`'s own "Hostile" edge. Noted because it is pleasant, relied on by nothing.)
 */
export function stanceFraction(stance: number): number {
  const clamped = stance < -1 ? -1 : stance > 1 ? 1 : stance;
  return (clamped + 1) / 2;
}

/* -------------------------------------------------------------------------------------------
   ALERTS — conditions, not events.

   Both are read straight off the current table, so there is no clock, no pool and no per-frame
   ageing here: a starmap alert is a STATE the galaxy is in, and it stops being drawn when the
   galaxy stops being in it. That is the opposite of `view/alerts.ts`, whose whole subject is a
   moment that the snapshot has already forgotten by the next tick, and the difference is real
   rather than stylistic.
   ------------------------------------------------------------------------------------------- */

export const ALERT_NONE = -1;
/** Somebody is charging an Antimatter Gate. `galaxyStatus` raises this one itself. */
export const ALERT_RIVAL_GATE = 0;
/** A world you had and no longer hold — the engine's `contested`, and its only bad news. */
export const ALERT_LOST_COLONY = 1;

/**
 * The two alert codes, and the honest note about them.
 *
 * They pack into the `waypoint` overlay's `kind` field, which is what that field is for — and
 * **both currently draw as the same dot**, because `overlays2d.ts` ignores `kind` and both product
 * renderers share that function. So the map today says "look here" and not "look here, and this is
 * why". Fixing it is a change to the shared overlay drawing, which is outside what this change
 * touches; it is recorded here rather than left for someone to discover by squinting at the screen.
 */
export const ALERT_KINDS: readonly number[] = [ALERT_RIVAL_GATE, ALERT_LOST_COLONY];

/** Why world `i` wants attention, or `ALERT_NONE`. The gate outranks a loss: it is galaxy-wide. */
export function alertForWorld(snap: GalaxySnapshot, i: number): number {
  if (snap.rivalGateIndex === i) return ALERT_RIVAL_GATE;
  if (snap.worlds.status[i] === WORLD_CONTESTED) return ALERT_LOST_COLONY;
  return ALERT_NONE;
}

/* =================================================================================================
   COMPOSITION
   ================================================================================================= */

const INITIAL_BATCH_CAPACITY = 16;

/** One bucket of instances sharing a mesh, an owner and a LOD. Grown in powers of two, off-frame. */
class Batch {
  count = 0;
  xyz: Float32Array;
  yaw: Float32Array;
  scale: Float32Array;
  shade: Float32Array;

  constructor(capacity: number) {
    this.xyz = new Float32Array(capacity * 3);
    this.yaw = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.shade = new Float32Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.yaw.length) return;
    let next = this.yaw.length || INITIAL_BATCH_CAPACITY;
    while (next < needed) next *= 2;
    this.xyz = new Float32Array(next * 3);
    this.yaw = new Float32Array(next);
    this.scale = new Float32Array(next);
    this.shade = new Float32Array(next);
  }

  push(x: number, y: number, z: number, scale: number, shade: number): void {
    const i = this.count;
    this.ensure(i + 1);
    this.xyz[i * 3] = x;
    this.xyz[i * 3 + 1] = y;
    this.xyz[i * 3 + 2] = z;
    // Yaw is 0 for every world: a marker on a diagram has no facing, and a rotation would read as
    // information the moment two markers disagreed about it.
    this.yaw[i] = 0;
    this.scale[i] = scale;
    this.shade[i] = shade;
    this.count = i + 1;
  }
}

/** Scratch for one overlay kind. Same growth discipline as the batches. */
class OverlayBuffer {
  count = 0;
  data: Float32Array;

  constructor(readonly stride: number, capacity = 16) {
    this.data = new Float32Array(capacity * stride);
  }

  ensure(items: number): void {
    const need = items * this.stride;
    if (need <= this.data.length) return;
    let next = this.data.length || this.stride * 16;
    while (next < need) next *= 2;
    this.data = new Float32Array(next);
  }

  push(...values: number[]): void {
    this.ensure(this.count + 1);
    const off = this.count * this.stride;
    for (let i = 0; i < this.stride; i++) this.data[off + i] = values[i] ?? 0;
    this.count++;
  }
}

/** The overlay kinds a starmap frame can carry, in draw order. */
const STARMAP_OVERLAYS: readonly OverlayKind[] = ["aura", "healthbar", "waypoint", "selection"];

/** Every owner colour the port has. Exactly three, which is why the plate never needs a fourth. */
const OWNER_SLOTS: readonly OwnerSlot[] = [OWNER_PLAYER, OWNER_AI, OWNER_NEUTRAL];

/**
 * Snapshot → plate → the `Renderer` port.
 *
 * Structurally `SceneComposer`: preallocated batches keyed on (mesh, owner, LOD), preallocated
 * overlay scratch, nothing allocated in a steady-state frame. Three things it does NOT do, each
 * because the plate is a diagram and not a place:
 *
 *   • **No terrain.** There is no ground here to walk on. The starmap replaces the battlefield's
 *     frame rather than overlaying it (ADR-0019 §1 prices both: 8 draw calls against 30, neither
 *     binding), so nothing else is on screen to be occluded by.
 *   • **No culling and no LOD.** Eleven markers, all of them the point of the screen. A world
 *     dropped for being far from the camera would be a world the player cannot plan a jump to.
 *   • **No interpolation.** Nothing on this screen moves between ticks. A claim lands, a stance
 *     drifts, a status flips — all of them are step changes on the galaxy's own ~1 Hz scan, and
 *     smoothing them would invent motion the simulation does not have.
 */
export class StarmapComposer {
  private readonly batches = new Map<OwnerSlot, Batch>();
  private readonly overlays = new Map<OverlayKind, OverlayBuffer>();

  constructor() {
    // Three owner slots, allocated up front and in a fixed order: the WebGL implementation binds
    // one instanced buffer per batch key, and a key order that shuffled frame to frame would be a
    // rebind storm. There are exactly three because the port has exactly three.
    for (const slot of OWNER_SLOTS) {
      this.batches.set(slot, new Batch(INITIAL_BATCH_CAPACITY));
    }
    for (const kind of STARMAP_OVERLAYS) {
      this.overlays.set(kind, new OverlayBuffer(OVERLAY_STRIDE[kind]));
    }
  }

  /**
   * Draw one starmap frame and return what it cost.
   *
   * `camera` is the caller's, not the composer's — the same shape `SceneComposer.compose` has, and
   * for the same reason: the rig lives in `input/` and one screen's composer has no business
   * owning it. What this module does own is `AUTHORED_VIEW`, which is the orientation the caller is
   * expected to have put the rig in, because the layout below is only priced at that one.
   */
  compose(renderer: Renderer, snap: GalaxySnapshot, camera: CameraState): FrameStats {
    this.reset();

    const w = snap.worlds;
    const midX = plateMidX(w.x, w.count);
    const claims = this.overlays.get("aura")!;
    const stances = this.overlays.get("healthbar")!;
    const alerts = this.overlays.get("waypoint")!;
    const here = this.overlays.get("selection")!;

    for (let i = 0; i < w.count; i++) {
      const x = plateX(w.x[i]!, midX);
      const z = plateZ(i);
      const status = w.status[i]!;

      this.batchFor(ownerSlotForWorld(status, w.claim[i]!))
        .push(x, 0, z, worldScale(status), worldShade(status, w.reachable[i]!));

      // A CLAIM (`checkExpansion`'s spread) is a dashed ring in the claimant's colour. The ring is
      // what makes spread read as spread: it appears on a world next to one that already has it,
      // and the frontier creeps along the axis it actually creeps along. WHICH faction owns it
      // crosses the bridge in `claim`/`factionNames` and is not drawn — three owner slots cannot
      // name five factions, and a ring whose radius meant "syndicate" would be exactly the
      // undecodable channel ADR-0019 refused elsewhere.
      if (w.claim[i] !== NO_FACTION) claims.push(x, RING_LIFT, z, CLAIM_RING_RADIUS, OWNER_AI);

      // THE STANCE, on the map rather than behind a panel — the row's own definition of done.
      // Drawn in the AI's colour because it is the neighbour's attitude, not the player's, and on
      // every world the engine reports one for.
      if (w.stanceKnown[i] === 1) {
        stances.push(x, BAR_LIFT, z, stanceFraction(w.stance[i]!), OWNER_AI);
      }

      const alert = alertForWorld(snap, i);
      if (alert !== ALERT_NONE) alerts.push(x, MARK_LIFT, z, alert);

      // "You are here", and only that. The highlight ring is spent on the seat rather than held
      // back for a future selection because a starmap whose first question is unanswered is a
      // starmap nobody keeps looking at; a picker that wants its own ring can add the kind it needs.
      if (i === snap.activeIndex) here.push(x, RING_LIFT, z, SEAT_RING_RADIUS);
    }

    renderer.beginFrame(camera);
    for (const [slot, batch] of this.batches) {
      if (batch.count === 0) continue;
      renderer.drawInstances({
        mesh: STARMAP_WORLD_MESH, owner: slot, lod: LOD_MESH, count: batch.count,
        xyz: batch.xyz, yaw: batch.yaw, scale: batch.scale, shade: batch.shade,
      });
    }
    for (const [kind, buf] of this.overlays) {
      if (buf.count === 0) continue;
      renderer.drawOverlay({ kind, count: buf.count, stride: buf.stride, data: buf.data });
    }
    return renderer.endFrame();
  }

  /** How many draw calls the last composition issued. Asserted by `test/view/starmap.test.ts`. */
  get expectedDrawCalls(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.count > 0) n++;
    for (const o of this.overlays.values()) if (o.count > 0) n++;
    return n;
  }

  private batchFor(owner: OwnerSlot): Batch {
    return this.batches.get(owner)!;
  }

  private reset(): void {
    for (const b of this.batches.values()) b.count = 0;
    for (const o of this.overlays.values()) o.count = 0;
  }
}

/** Where the plate wants the camera. The caller sets the rig; the composer never touches it. */
export function authoredCamera(rig: {
  targetX: number; targetY: number; distance: number; yawIndex: number;
}): void {
  rig.targetX = AUTHORED_VIEW.centreX;
  rig.targetY = AUTHORED_VIEW.centreZ;
  rig.distance = AUTHORED_VIEW.distance;
  rig.yawIndex = AUTHORED_VIEW.yawIndex;
}
