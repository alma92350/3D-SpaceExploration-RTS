// The landing picker as a 3D approach view (P4-T05, ADR-0019 §4).
//
// Upstream's picker is a "blind minimap" (`landingPicker.js`, named in `galaxy.js`'s own comment):
// a flat rectangle you stab at before committing to a jump. This is the same decision taken on the
// destination's actual ground — its relief, its edges, its landmarks — through **the same camera
// rig, the same view-projection and the same ray-march the battlefield uses**. That reuse is the
// whole point rather than an economy: a picker with its own projection or its own ground
// intersection would put the marker where the battlefield would not, and the player would only
// find out after the jump.
//
// ## The boundary problem, and where the snap actually happens
//
// The chosen point is not the click. `snapLandingPoint` rounds it onto `LANDING_PICK_GRID` and
// then clamps it away from the map edge, and the colony lands on **that** point — so a picker that
// drew the raw click would be lying about the one thing it exists to say. But `snapLandingPoint`
// is the ENGINE's, and `view/` may not import the engine (ADR-0008, enforced by
// `test/architecture/layering.test.ts`). Something has to cross the boundary.
//
// **The engine's function crosses, not its constant.** `ApproachBrief.snap` is
// `snapLandingPoint` itself, bound to the destination's map by whoever opens the picker
// (`ui/landing-panel.ts`, which may import the engine as every other panel model does). This
// module therefore contains no grid, no margin, and no rounding — the point it marks IS
// `snapLandingPoint`'s, by construction rather than by agreement.
//
// That is one step past the precedent. `BombTable.fuseDelay` carries `BOMB_FUSE_DELAY` across as a
// number because the view needs to *divide* by it — the arithmetic (`1 - fuse / delay`) is the
// view's own presentation choice, and only the constant belongs to the engine. Here the arithmetic
// belongs to the engine too, and a copied algorithm drifts in ways a copied constant cannot:
//
//   • The snap ROUNDS and then CLAMPS, in that order. `snapLandingPoint`'s own comment says the
//     order is deliberate. Reimplement it the other way round and the two agree everywhere except
//     within a grid step of the map edge, which is precisely where a player parks a colony.
//   • "The nearest reachable site to the click" is NOT the snap. With a 160 grid and a 100 margin,
//     x = 90 snaps to 160 while the nearest site the engine can produce is 100. A picker that
//     offered the player a lattice to choose from would be wrong by 60 units and would look right.
//
// So the grid is never named here. Where the view genuinely needs the *size* of a step — to draw a
// ring covering the ground that lands on this site — it asks the function (`snapStep`) instead of
// being told the number.
//
// ## The one rule this module mirrors, and why
//
// `landingZone` — the function that decides where riders actually touch down — is NOT exported by
// the engine, and it does not necessarily use your point at all: on a world where you already hold
// a Spaceport, the jump comes in at the pad, and `opts.landingPoint` is ignored "harmlessly". A
// picker that promised the click on such a world would be exactly the class of lie this row
// exists to prevent, so `landingSite` below mirrors `landingZone`'s priority order line for line
// and reports which of the three cases it landed in. A mirror is a debt: `test/view/landing.test.ts`
// pays it by running the engine's own `jumpCapital` and asserting the riders arrive where this
// module said they would, on both a fresh world and a held one.
//
// ## Why this file reaches into `input/`
//
// `CameraRig` and `pickGround` live under `input/` because they are driven by input, not because
// they belong to it — they are pure math over an `ElevationField` and a `CameraState`, and
// `view/renderer/canvas2d.ts` and `view/renderer/overlays2d.ts` already import `projectToScreen`
// from exactly there. Reusing them is the same argument as reusing the snap: a picker with its own
// rig or its own ray-march would be a second answer to a question that already has one.
//
// ## A blind landing stays blind
//
// The brief carries the destination's terrain, the player's own pads and the world's anchor. It has
// no channel for the neighbour's base, units or fog — so this screen cannot leak what a jump has
// not yet earned, in the same way `view/alerts.ts` cannot leak a death the bridge did not pass. The
// constraint is the feature: there is no code path here that could show it.

import { type ElevationField, elevation } from "./terrain/elevation.js";
import { type MeshId } from "./meshes/generators.js";
import {
  type CameraState, type FrameStats, type Renderer, type TerrainMesh,
  LOD_MESH, OVERLAY_STRIDE, OWNER_PLAYER,
} from "./renderer/port.js";
import { CameraRig, MAX_DISTANCE } from "../input/camera.js";
import { pickGround } from "../input/picking.js";

/** A simulation ground point. Never a height — the third axis is the view's (ADR-0004). */
export interface GroundPoint {
  readonly x: number;
  readonly y: number;
}

/** The engine's `snapLandingPoint`, bound to one destination's map. */
export type SnapLanding = (x: number, y: number) => GroundPoint;

/**
 * A player Spaceport standing on the destination — a beacon the jump homes in on.
 *
 * `lastLanding` is the engine's own galaxy-time stamp, written by `jumpCapital` when riders
 * actually land at a pad. It is the tie-break that decides WHICH pad wins, so it crosses as data
 * rather than being inferred from anything up here.
 */
export interface LandingPad {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly lastLanding: number;
}

/**
 * Everything the approach view knows about the destination, as plain data plus one bound engine
 * function. Assembled by `ui/landing-panel.ts`'s `approachBrief`, once, when the picker opens.
 */
export interface ApproachBrief {
  readonly destId: string;
  /** The destination's terrain, sampled exactly as the battlefield's is. */
  readonly field: ElevationField;
  /** `snapLandingPoint`, bound to this destination's map. Never a grid constant. */
  readonly snap: SnapLanding;
  /**
   * `landingSites`, bound to this map — the sites the engine will actually accept, per axis.
   *
   * Added upstream in 50ceb88 (issue #94, reported from here). Before it, this module had to
   * *probe* the snap function to find its step (`snapStep` below), because the bare grid and the
   * real sites disagree near a map edge — "nearest multiple of LANDING_PICK_GRID" was up to 60
   * units wrong there. The list is the source of truth now; the probe is kept only as the fallback
   * for a snap with no site list.
   */
  readonly sites: { readonly xs: readonly number[]; readonly ys: readonly number[] };
  /** The player's completed Spaceports here, in the engine's own `playerSpaceports` order. */
  readonly pads: readonly LandingPad[];
  /** `map.bases.player` — the world's fixed generation-time anchor, the last fallback. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * Which of `landingZone`'s three cases produced the site.
 *
 * `"picked"` is the only one the player controls, and the only one where the jump intent should
 * carry a landing point at all.
 */
export type LandingSource = "pad" | "picked" | "anchor";

export interface LandingSite {
  readonly x: number;
  readonly y: number;
  readonly source: LandingSource;
  /** The pad that won, when one did. */
  readonly padId: string | null;
  /** Whether the player's pick is what the jump will use. False whenever a pad or the anchor wins. */
  readonly honoured: boolean;
}

/**
 * Where this jump touches down, given what the player is pointing at.
 *
 * A line-for-line mirror of the engine's `landingZone`, including its tie-breaks:
 *
 *   1. A player Spaceport on the destination — the one with the highest `lastLanding`, ties falling
 *      to the first in `pads` (the engine sorts `playerSpaceports` by id, lowest first, and the
 *      strict `>` below is what keeps the first maximum rather than the last).
 *   2. No pad and a pick — the pick, put through the engine's own snap.
 *   3. Neither — the world's generation-time anchor.
 *
 * Case 1 is the honest one: the pick is *discarded*, and everything downstream — the marker, the
 * panel's wording, the intent's landing fields — is built to say so rather than to hide it.
 */
export function landingSite(brief: ApproachBrief, pick: GroundPoint | null): LandingSite {
  const pads = brief.pads;
  if (pads.length > 0) {
    let best = pads[0]!;
    for (const p of pads) if ((p.lastLanding || 0) > (best.lastLanding || 0)) best = p;
    return { x: best.x, y: best.y, source: "pad", padId: best.id, honoured: false };
  }
  if (pick && Number.isFinite(pick.x) && Number.isFinite(pick.y)) {
    const snapped = brief.snap(pick.x, pick.y);
    return { x: snapped.x, y: snapped.y, source: "picked", padId: null, honoured: true };
  }
  return { x: brief.anchorX, y: brief.anchorY, source: "anchor", padId: null, honoured: false };
}

/**
 * The snap's step, **measured from the snap itself**.
 *
 * The view wants a ring that covers the ground which lands on this site, and that is a fact about
 * `LANDING_PICK_GRID` — a number this module is not allowed to know and must not copy. So it walks
 * out from the middle of the map until the engine's own function moves the answer, and the distance
 * it moves by is the step. Derived rather than transported: tune the grid upstream and the ring
 * follows on its own, with nothing here to update and nothing to drift.
 *
 * Probed from the map's middle deliberately — `snapLandingPoint` clamps near the edges, where
 * consecutive answers stop being a grid step apart. Returns 0 for a snap that never moves, which
 * is a snap with no grid to draw.
 */
export function snapStep(snap: SnapLanding, width: number, height: number): number {
  const originX = width / 2;
  const originY = height / 2;
  const base = snap(originX, originY).x;
  for (let d = 1; d <= width; d++) {
    const moved = snap(originX + d, originY).x;
    if (moved !== base) return Math.abs(moved - base);
  }
  return 0;
}

/** Fallback marker radius for a snap with no measurable grid. Legibility only, claims nothing. */
const FALLBACK_MARKER_RADIUS = 24;

/** Ground rings sit just clear of the terrain, exactly as the selection ring does in `scene.ts`. */
const MARKER_LIFT = 0.4;
/** The correction line is lifted further, so it does not vanish into a slope it crosses. */
const LINE_LIFT = 2.2;

/** `waypoint.kind`: a pad that will not be used. */
export const WAYPOINT_PAD = 0;
/** `waypoint.kind`: the pad the jump will actually come in at. */
export const WAYPOINT_PAD_CHOSEN = 1;

const PAD_MESH: MeshId = "port";
const LANDER_MESH: MeshId = "colonyship";

/**
 * The approach camera: the game's own rig, opened at its far stop.
 *
 * ADR-0019 closes with the constraint this has to live under — Q-01 stays shut until Phase 6, so no
 * free orbit arrives for Phase 4 and "the approach view now has to work under the snapped rig". It
 * does, and comfortably: `MAX_DISTANCE` puts the rig at `PITCH_FAR` (74° below horizontal, nearly
 * overhead), which frames essentially the whole 1600 × 1000 world at 16:9 and is the angle that
 * reads ground rather than silhouettes. Yaw stays at the rig's index 0 for `ui/minimap.ts`'s
 * reason: a picker that arrived at an arbitrary rotation would cost the player their bearings on a
 * world they have never seen.
 *
 * It is a full rig, not a frozen pose, so panning and zooming in to look at a valley are the same
 * two controls as on the battlefield.
 */
export function approachRig(brief: ApproachBrief): CameraRig {
  const rig = new CameraRig(
    { mapWidth: brief.field.width, mapHeight: brief.field.height },
    brief.field,
  );
  rig.distance = MAX_DISTANCE;
  rig.yawIndex = 0;
  // Open looking at where this jump would land with no pick at all — the world's own answer, which
  // on a held world is the pad the player is about to be told about.
  const opening = landingSite(brief, null);
  rig.focusOn(opening.x, opening.y);
  return rig;
}

/**
 * One open approach screen: the rig, the pointer's ground point, and the frame that draws them.
 *
 * The pick is held as two numbers rather than a `{x, y}`, and every buffer the frame submits is
 * allocated once here — `pointAt` runs on pointermove and `compose` runs every frame, which is the
 * path ADR-0006 sizes everything else for. The `pick`/`site` getters do build a small object each,
 * deliberately: two of them per frame on a modal screen is not the per-entity path that rule is
 * about, and threading out-parameters through a picker would cost more than it saves.
 */
export class ApproachView {
  readonly rig: CameraRig;
  /** Half a snap step: the inradius of the square of clicks that land on this site. */
  readonly markerRadius: number;

  private pickX = 0;
  private pickY = 0;
  private hasPick = false;

  private readonly padXyz: Float32Array;
  private readonly padYaw: Float32Array;
  private readonly padScale: Float32Array;
  private readonly padShade: Float32Array;
  private readonly landerXyz = new Float32Array(3);
  private readonly landerYaw = new Float32Array(1);
  private readonly landerScale = new Float32Array([1]);
  private readonly landerShade = new Float32Array([1]);
  private readonly ghostData: Float32Array;
  private readonly rallyData: Float32Array;
  private readonly waypointData: Float32Array;

  constructor(readonly brief: ApproachBrief) {
    this.rig = approachRig(brief);
    const step = snapStep(brief.snap, brief.field.width, brief.field.height);
    this.markerRadius = step > 0 ? step / 2 : FALLBACK_MARKER_RADIUS;

    const pads = Math.max(1, brief.pads.length);
    this.padXyz = new Float32Array(pads * 3);
    this.padYaw = new Float32Array(pads);
    this.padScale = new Float32Array(pads);
    this.padShade = new Float32Array(pads);
    // Two ghosts at most: where you land, and — when they differ — where you clicked.
    this.ghostData = new Float32Array(2 * OVERLAY_STRIDE.ghost);
    this.rallyData = new Float32Array(OVERLAY_STRIDE.rally);
    this.waypointData = new Float32Array(pads * OVERLAY_STRIDE.waypoint);
  }

  /** The camera state for this frame. The same call the battlefield makes, on the same rig. */
  camera(viewportWidth: number, viewportHeight: number): CameraState {
    return this.rig.update(viewportWidth, viewportHeight);
  }

  /**
   * Point at a pixel. Returns whether it landed on the world.
   *
   * The ray-march is `input/picking.ts`'s, unchanged — the same function that decides where a move
   * order goes, so the marker cannot sit somewhere the battlefield would disagree with.
   *
   * A ray that leaves the world is REFUSED rather than clamped, and that is deliberate. Clamping is
   * the engine's word: `snapLandingPoint` rounds and then clamps to its own margin, and a picker
   * that clamped first would be a second opinion about where the edge is. Refusing keeps the last
   * good pick, which is also what the player expects when the pointer slides off the planet.
   */
  pointAt(camera: CameraState, px: number, py: number): boolean {
    const hit = pickGround(camera, this.brief.field, px, py);
    const field = this.brief.field;
    if (!(hit.x >= 0 && hit.x <= field.width && hit.y >= 0 && hit.y <= field.height)) return false;
    this.pickX = hit.x;
    this.pickY = hit.y;
    this.hasPick = true;
    return true;
  }

  /** Forget the pick — backing out of the screen, or the pointer leaving it. */
  clearPick(): void {
    this.hasPick = false;
  }

  /**
   * The raw ground point under the pointer, un-snapped and un-clamped.
   *
   * This is what the jump intent must carry (see `ui/landing-panel.ts`): the engine snaps it once,
   * on arrival. Forwarding the SNAPPED point instead would put it through the snap twice, and the
   * snap is not idempotent at the map edge — a click that displays as the margin point would land a
   * whole grid step away from where the picker drew it.
   */
  get pick(): GroundPoint | null {
    return this.hasPick ? { x: this.pickX, y: this.pickY } : null;
  }

  /** Where this jump will actually touch down. `landingZone`'s answer, not the click. */
  get site(): LandingSite {
    return landingSite(this.brief, this.pick);
  }

  /**
   * Draw the approach.
   *
   * Four things, and every one of them is either the destination's own ground or the player's own
   * infrastructure:
   *
   *   • **The terrain**, so the choice is made against relief instead of against a rectangle.
   *   • **Every pad standing here**, as instanced meshes plus a `waypoint` marking which one wins —
   *     the held-world case made visible before the player commits, rather than explained after.
   *   • **The lander**, sitting on the site the jump will use.
   *   • **The disagreement**, whenever the click is not the site: a live ring where the colony
   *     lands, a dead ring where the pointer is, and a line between them. The same three cues cover
   *     both ways a click gets overruled — the snap moving it, and a pad discarding it — because
   *     they are the same statement: the engine's answer is not your click.
   */
  compose(renderer: Renderer, terrain: TerrainMesh, camera: CameraState): FrameStats {
    const brief = this.brief;
    const field = brief.field;
    const site = this.site;
    const pick = this.pick;

    let padCount = 0;
    let waypointCount = 0;
    for (const pad of brief.pads) {
      const h = elevation(field, pad.x, pad.y);
      this.padXyz[padCount * 3] = pad.x;
      this.padXyz[padCount * 3 + 1] = h;
      this.padXyz[padCount * 3 + 2] = pad.y;
      this.padYaw[padCount] = 0;
      this.padScale[padCount] = 1;
      this.padShade[padCount] = pad.id === site.padId ? 1 : 0.6;
      padCount++;

      const off = waypointCount * OVERLAY_STRIDE.waypoint;
      this.waypointData[off] = pad.x;
      this.waypointData[off + 1] = h + MARKER_LIFT;
      this.waypointData[off + 2] = pad.y;
      this.waypointData[off + 3] = pad.id === site.padId ? WAYPOINT_PAD_CHOSEN : WAYPOINT_PAD;
      waypointCount++;
    }

    const siteHeight = elevation(field, site.x, site.y);
    this.landerXyz[0] = site.x;
    this.landerXyz[1] = siteHeight;
    this.landerXyz[2] = site.y;

    let ghostCount = 0;
    this.writeGhost(ghostCount++, site.x, site.y, 1);

    let rallyCount = 0;
    if (pick && (pick.x !== site.x || pick.y !== site.y)) {
      this.writeGhost(ghostCount++, pick.x, pick.y, 0);
      this.rallyData[0] = pick.x;
      this.rallyData[1] = elevation(field, pick.x, pick.y) + LINE_LIFT;
      this.rallyData[2] = pick.y;
      this.rallyData[3] = site.x;
      this.rallyData[4] = siteHeight + LINE_LIFT;
      this.rallyData[5] = site.y;
      rallyCount = 1;
    }

    renderer.beginFrame(camera);
    renderer.drawTerrain(terrain);
    if (padCount > 0) {
      renderer.drawInstances({
        mesh: PAD_MESH, owner: OWNER_PLAYER, lod: LOD_MESH, count: padCount,
        xyz: this.padXyz, yaw: this.padYaw, scale: this.padScale, shade: this.padShade,
      });
    }
    renderer.drawInstances({
      mesh: LANDER_MESH, owner: OWNER_PLAYER, lod: LOD_MESH, count: 1,
      xyz: this.landerXyz, yaw: this.landerYaw, scale: this.landerScale, shade: this.landerShade,
    });
    // Empty layers are skipped rather than submitted, exactly as `scene.ts` skips them: an empty
    // overlay is not free in every implementation, and it is never information.
    if (waypointCount > 0) {
      renderer.drawOverlay({
        kind: "waypoint", count: waypointCount, stride: OVERLAY_STRIDE.waypoint, data: this.waypointData,
      });
    }
    renderer.drawOverlay({
      kind: "ghost", count: ghostCount, stride: OVERLAY_STRIDE.ghost, data: this.ghostData,
    });
    if (rallyCount > 0) {
      renderer.drawOverlay({
        kind: "rally", count: rallyCount, stride: OVERLAY_STRIDE.rally, data: this.rallyData,
      });
    }
    return renderer.endFrame();
  }

  /** One ring in the ghost buffer, lifted clear of the ground it sits on. */
  private writeGhost(index: number, x: number, y: number, valid: number): void {
    const off = index * OVERLAY_STRIDE.ghost;
    this.ghostData[off] = x;
    this.ghostData[off + 1] = elevation(this.brief.field, x, y) + MARKER_LIFT;
    this.ghostData[off + 2] = y;
    this.ghostData[off + 3] = this.markerRadius;
    this.ghostData[off + 4] = valid;
    this.ghostData[off + 5] = 0;   // no build reach on this screen
  }
}
