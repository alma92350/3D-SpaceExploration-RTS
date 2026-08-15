// P4-T05 — the landing picker as a 3D approach view.
//
// The row's claim is one sentence with two halves, and the second half is the one with teeth: *a
// landing site is chosen in 3D, and the chosen point is `snapLandingPoint`'s, not the raw click.*
//
// **Every equality about the site in this file is `toBe`, never a tolerance.** That is not fussiness
// — it is the difference between a test and a decoration. `LANDING_PICK_GRID` is 160 and the
// margin is 100, so a picker with no snapping at all sits within 80 units of the right answer
// everywhere, and any test written with a tolerance loose enough to survive a floating-point
// projection would pass on a picker that had never heard of the grid. `the snap is not decorative`
// below exists purely to prove the exact comparisons are not vacuous: it measures how far the
// engine actually moves a click, and how many distinct answers a hundred clicks collapse into.
//
// The other trap is the one `landingZone` sets, and it is the reason this row exists at all:
// **`jumpCapital` does not necessarily land where you asked.** On a world where the player already
// holds a Spaceport the landing point is discarded and the jump comes in at the pad. So the
// strongest assertions here are not about the picker at all — they run the engine's own
// `jumpCapital` through `applyIntent` and check where the riders physically ended up, on a fresh
// world and on a held one, against what the picker had promised a moment earlier.
//
// The rider ring is **measured, never assumed**. `jumpCapital` scatters riders on a ring around the
// landing zone, and hard-coding its radius here would put a second engine constant in a file whose
// whole point is that constants must not be copied. So every landing assertion runs a control jump
// in an identical galaxy, to a point the snap maps to itself, and recovers the offset from that.
//
// Mutation log for this file is in the task notes; each claim below was broken in the way it names
// and watched go red before being restored.

import { describe, expect, it } from "vitest";
import {
  LANDING_PICK_GRID, landingSites, activeState, createGalaxy, makeBuilding, makeUnit, playerSpaceports,
  previewPlanet, snapLandingPoint,
} from "../../src/engine/index.js";
import { applyIntent } from "../../src/bridge/commands.js";
import {
  type ApproachBrief, ApproachView, WAYPOINT_PAD, WAYPOINT_PAD_CHOSEN, landingSite, snapStep,
} from "../../src/view/landing.js";
import { type ElevationField, elevation, elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { type CameraState } from "../../src/view/renderer/port.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { pickGround, projectToScreen } from "../../src/input/picking.js";
import { MAX_DISTANCE, PITCH_FAR } from "../../src/input/camera.js";

const SEED = 20260814;
const HOME = "helix";
/** Live, unsettled and flat — the plain case: nothing standing, so the pick is what lands. */
const FRESH = "ferros";
/** Dormant and stamped with high ground — the case where the third dimension changes the answer. */
const RELIEF = "pyralis";

const VIEW_W = 1280;
const VIEW_H = 720;

/** A pad standing on a destination carries this the moment a jump lands riders on it. */
type PadStamp = Building & { lastLanding?: number };

/**
 * The brief, built straight from the engine — deliberately NOT through `ui/landing-panel.ts`.
 *
 * That module gets its own file. Here the point is that `view/landing.ts` holds the engine's real
 * `snapLandingPoint`, so that "the chosen point is `snapLandingPoint`'s" is a fact about this
 * module rather than about the one that wires it.
 */
function briefFor(galaxy: Galaxy, destId: string): ApproachBrief {
  const dest = previewPlanet(galaxy, destId) as State;
  const map = dest.map;
  return {
    destId,
    field: elevationFieldFrom(map.terrain, map.width, map.height),
    snap: (x, y) => snapLandingPoint(map, x, y),
    sites: landingSites(map),
    pads: playerSpaceports(dest).map((b) => ({
      id: b.id, x: b.x, y: b.y, lastLanding: (b as PadStamp).lastLanding ?? 0,
    })),
    anchorX: map.bases.player.x,
    anchorY: map.bases.player.y,
  };
}

function destMap(galaxy: Galaxy, destId: string): GameMap {
  return (previewPlanet(galaxy, destId) as State).map;
}

/**
 * A galaxy whose seat can actually launch: one completed Spaceport away from the opening base, and
 * exactly one colony ship staged on it.
 *
 * One rider, on purpose. `jumpCapital` places rider `i` at angle `2πi/n`, so a single rider sits at
 * angle zero — `cos 0` and `sin 0` are exact, which is what lets the recovered landing zone be
 * compared with `toBe`. The pad sits at (800, 300) rather than beside the base because the world
 * opens with a colony ship of its own at (160, 500), and a second rider would spoil that.
 */
function launchReady(): { galaxy: Galaxy; home: State } {
  const galaxy = createGalaxy({ seed: SEED, startId: HOME });
  galaxy.credits = 5000;
  galaxy.time = 120;
  const home = activeState(galaxy);
  const pad = makeBuilding("spaceport", "player", 800, 300);
  home.buildings.set(pad.id, pad);
  const ship = makeUnit("colonyship", "player", 820, 300);
  home.units.set(ship.id, ship);
  return { galaxy, home };
}

/** Jump through the bridge's own intent, exactly as the picker's confirm button would. */
function jumpTo(galaxy: Galaxy, destId: string, landing: { x: number; y: number } | null): string | null {
  return applyIntent(
    activeState(galaxy),
    landing
      ? { kind: "jump", destId, landingX: landing.x, landingY: landing.y }
      : { kind: "jump", destId },
    galaxy,
  );
}

/** Where the riders of the last jump ended up. Galaxy-relocated entities take `g`-prefixed ids. */
function riderPositions(galaxy: Galaxy, destId: string): Array<{ x: number; y: number }> {
  const dest = galaxy.planets.get(destId)!;
  return [...dest.units.values()].filter((u) => u.id.startsWith("g")).map((u) => ({ x: u.x, y: u.y }));
}

/**
 * The offset `jumpCapital` puts between the landing zone and its single rider, MEASURED.
 *
 * A control jump aimed at a point the engine's snap maps to itself, so the landing zone is known
 * exactly and whatever the rider's position differs by is the ring. It depends only on the rider's
 * index and the rider count — both 1 in every scenario here — so one measurement serves them all.
 *
 * The control runs on a destination with **no pad**, necessarily: a pad would capture the control
 * jump too and the measurement would come back as the pad's own coordinates. Finding that out the
 * hard way is a small demonstration of the behaviour the rest of this section is about.
 */
function measureRingOffset(destId: string): { dx: number; dy: number } {
  const { galaxy } = launchReady();
  const fixed = snapLandingPoint(destMap(galaxy, destId), 800, 480);
  expect(snapLandingPoint(destMap(galaxy, destId), fixed.x, fixed.y)).toEqual(fixed);
  expect(jumpTo(galaxy, destId, fixed)).toBeNull();
  const riders = riderPositions(galaxy, destId);
  expect(riders).toHaveLength(1);
  return { dx: riders[0]!.x - fixed.x, dy: riders[0]!.y - fixed.y };
}

/**
 * Point the view at a world coordinate, through the screen.
 *
 * Projects the target to a pixel with the frame's own view-projection and points at that pixel, so
 * a test can choose ground deliberately and still exercise the whole pixel → ray → relief → snap
 * path rather than reaching past it.
 */
function pointAtWorld(view: ApproachView, camera: CameraState, x: number, y: number): void {
  const screen = { x: 0, y: 0, behind: false };
  projectToScreen(camera, x, elevation(view.brief.field, x, y), y, screen);
  expect(screen.behind).toBe(false);
  expect(view.pointAt(camera, screen.x, screen.y)).toBe(true);
}

/** Every pixel of a coarse sweep that actually lands on the destination's ground. */
function sweepPixels(): Array<{ px: number; py: number }> {
  const out: Array<{ px: number; py: number }> = [];
  for (let px = 80; px <= VIEW_W - 80; px += 96) {
    for (let py = 60; py <= VIEW_H - 60; py += 54) out.push({ px, py });
  }
  return out;
}

describe("the approach view is the destination's own ground", () => {
  it("the premise: a fresh destination has no pad, and the picker opens on the real map", () => {
    // Without this the whole file could be asserting about an empty world and a 1×1 map.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = briefFor(galaxy, FRESH);
    expect(brief.pads).toEqual([]);
    expect(brief.field.width).toBe(1600);
    expect(brief.field.height).toBe(1000);
    expect(brief.field.type.length).toBe(brief.field.cols * brief.field.rows);
    expect(destMap(galaxy, FRESH).bases.player).toEqual({ x: brief.anchorX, y: brief.anchorY });
  });

  it("opens under the snapped rig, at its far stop (ADR-0019 leaves no free orbit for Phase 4)", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const view = new ApproachView(briefFor(galaxy, FRESH));
    const camera = view.camera(VIEW_W, VIEW_H);
    expect(camera.distance).toBe(MAX_DISTANCE);
    expect(camera.pitch).toBeCloseTo(PITCH_FAR, 10);
    expect(camera.yaw).toBe(0);
    // Opened on the world's own answer with nothing picked yet — the anchor, here.
    expect(camera.targetX).toBe(view.brief.anchorX);
    expect(camera.targetY).toBe(view.brief.anchorY);
  });

  it("a pixel becomes a ground point through the game's own ray-march, and back again", () => {
    // The 3D half of the row, stated as a round trip: project the chosen site to a pixel with the
    // same view-projection the frame is drawn with, point at that pixel, and land on the same site.
    const galaxy = createGalaxy({ seed: SEED, startId: RELIEF });
    const view = new ApproachView(briefFor(galaxy, FRESH));
    const camera = view.camera(VIEW_W, VIEW_H);
    expect(view.pointAt(camera, 700, 400)).toBe(true);
    const site = view.site;

    const screen = { x: 0, y: 0, behind: false };
    projectToScreen(camera, site.x, elevation(view.brief.field, site.x, site.y), site.y, screen);
    expect(screen.behind).toBe(false);
    expect(view.pointAt(camera, screen.x, screen.y)).toBe(true);
    expect(view.site.x).toBe(site.x);
    expect(view.site.y).toBe(site.y);
  });

  it("refuses a ray that leaves the world rather than clamping it to the edge", () => {
    // Clamping is the engine's word — `snapLandingPoint` rounds and then clamps to its own margin.
    // A picker that clamped first would be a second opinion about where the edge is.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const view = new ApproachView(briefFor(galaxy, FRESH));
    const camera = view.camera(VIEW_W, VIEW_H);
    expect(view.pick).toBeNull();
    expect(view.pointAt(camera, 4, 4)).toBe(false);
    expect(view.pick).toBeNull();
    expect(view.site.source).toBe("anchor");
  });

  it("the ground the picker reads is the relief, not a plane — and it changes the answer", () => {
    // The claim that makes this a 3D approach view rather than a diagram with a camera. Same
    // camera, same pixel, two elevation fields differing only in whether the world has hills: the
    // ray hits high ground sooner, and on a real fraction of pixels that lands the colony in a
    // different grid cell entirely.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = briefFor(galaxy, RELIEF);
    expect([...brief.field.type].some((c) => c === 2)).toBe(true);   // the world really has relief

    const flat: ElevationField = { ...brief.field, type: new Uint8Array(brief.field.type.length) };
    const view = new ApproachView(brief);
    const camera = view.camera(VIEW_W, VIEW_H);

    let shifted = 0;
    let differentSite = 0;
    let maxShift = 0;
    for (let px = 40; px < VIEW_W - 40; px += 7) {
      for (let py = 40; py < VIEW_H - 40; py += 7) {
        const onRelief = pickGround(camera, brief.field, px, py);
        const rx = onRelief.x, ry = onRelief.y;
        const onPlane = pickGround(camera, flat, px, py);
        const shift = Math.hypot(rx - onPlane.x, ry - onPlane.y);
        if (shift < 1) continue;
        shifted++;
        maxShift = Math.max(maxShift, shift);
        const a = brief.snap(rx, ry);
        const b = brief.snap(onPlane.x, onPlane.y);
        if (a.x !== b.x || a.y !== b.y) differentSite++;
      }
    }
    expect(shifted).toBeGreaterThan(100);
    // 18 units of high ground at ~74° of pitch displaces the hit by ~5 world units.
    expect(maxShift).toBeGreaterThan(3);
    expect(differentSite).toBeGreaterThan(0);
  });
});

describe("the chosen point is snapLandingPoint's", () => {
  it("every picked pixel resolves to exactly the engine's snap of the raw ground point", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = briefFor(galaxy, FRESH);
    const map = destMap(galaxy, FRESH);
    const view = new ApproachView(brief);
    const camera = view.camera(VIEW_W, VIEW_H);

    let checked = 0;
    for (const { px, py } of sweepPixels()) {
      if (!view.pointAt(camera, px, py)) continue;
      const raw = view.pick!;
      const site = view.site;
      const engine = snapLandingPoint(map, raw.x, raw.y);
      // Exact. A tolerance here would pass with no snapping at all — see the file header.
      expect(site.x).toBe(engine.x);
      expect(site.y).toBe(engine.y);
      expect(site.source).toBe("picked");
      expect(site.honoured).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("the snap is not decorative: it moves clicks, and it collapses them", () => {
    // The anti-vacuity test for the one above. If the picker returned the raw click, the
    // displacement would be zero everywhere and every pixel would produce its own site.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = briefFor(galaxy, FRESH);
    const view = new ApproachView(brief);
    const camera = view.camera(VIEW_W, VIEW_H);

    const sites = new Set<string>();
    let picks = 0;
    let maxDrift = 0;
    for (const { px, py } of sweepPixels()) {
      if (!view.pointAt(camera, px, py)) continue;
      const raw = view.pick!;
      const site = view.site;
      picks++;
      sites.add(`${site.x},${site.y}`);
      maxDrift = Math.max(maxDrift, Math.hypot(raw.x - site.x, raw.y - site.y));
      // Every answer is on the engine's lattice, or on the margin the clamp pins it to.
      const onLattice = site.x % LANDING_PICK_GRID === 0 && site.y % LANDING_PICK_GRID === 0;
      const onMargin = site.x === 100 || site.y === 100
        || site.x === brief.field.width - 100 || site.y === brief.field.height - 100;
      expect(onLattice || onMargin).toBe(true);
    }
    expect(picks).toBeGreaterThan(50);
    // Half a grid step is the worst a rounding snap can move a point on one axis.
    expect(maxDrift).toBeGreaterThan(LANDING_PICK_GRID / 4);
    expect(sites.size).toBeLessThan(picks / 2);
  });

  it("derives the grid step from the engine's function instead of naming it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = briefFor(galaxy, FRESH);
    expect(snapStep(brief.snap, brief.field.width, brief.field.height)).toBe(LANDING_PICK_GRID);
    // The marker ring is the inradius of the square of clicks that land on this site, so it can
    // never overstate the ground it covers.
    expect(new ApproachView(brief).markerRadius).toBe(LANDING_PICK_GRID / 2);
  });

  it("the colony lands where the picker said, through the real jump", () => {
    // The row's Definition of Done, end to end: pick in the 3D view, send the intent the panel
    // would send, and find the riders at the advertised point — not near it.
    const ring = measureRingOffset(FRESH);
    const { galaxy } = launchReady();
    const view = new ApproachView(briefFor(galaxy, FRESH));
    const camera = view.camera(VIEW_W, VIEW_H);
    pointAtWorld(view, camera, 1180, 220);
    const raw = view.pick!;
    const site = view.site;
    // The scenario is worth nothing if the click happened to be on a grid line already.
    expect(Math.hypot(raw.x - site.x, raw.y - site.y)).toBeGreaterThan(1);

    expect(jumpTo(galaxy, FRESH, raw)).toBeNull();
    const riders = riderPositions(galaxy, FRESH);
    expect(riders).toHaveLength(1);
    expect(riders[0]!.x - ring.dx).toBe(site.x);
    expect(riders[0]!.y - ring.dy).toBe(site.y);
  });

  it("snaps to a fixed point, so forwarding the picker's own answer is now safe", () => {
    // **This test used to assert the opposite, and that is the point of keeping it.**
    // `snapLandingPoint` rounded and then clamped, so it was not idempotent inside the margin —
    // 161 of 1601 x-values on a 1600-wide map — and the picker forwards the RAW ground point
    // because of it. Reported from here as upstream issue #94 and fixed in 50ceb88: the engine now
    // picks the nearest entry of `landingSites`, so its output is always a site and re-snapping is
    // the identity.
    //
    // The picker still forwards the raw point. That is no longer load-bearing, but it is still
    // correct and one fewer thing to change; what this test now guards is the property the engine
    // promises, so a regression upstream is caught here rather than as a mysterious offset.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const map = destMap(galaxy, FRESH);
    let moved = 0;
    for (let x = 0; x <= map.width; x += 10) {
      const once = snapLandingPoint(map, x, 500);
      const twice = snapLandingPoint(map, once.x, once.y);
      if (once.x !== twice.x || once.y !== twice.y) moved++;
    }
    expect(moved, "snapLandingPoint is not a fixed point — issue #94 has regressed").toBe(0);

    // And every answer is a real site rather than a bare multiple of the grid — the distinction
    // that made "nearest lattice point" a wrong re-derivation near an edge.
    const { xs } = landingSites(map);
    expect(xs, "the site list is empty").not.toHaveLength(0);
    for (const x of [0, 30, 90, map.width, map.width - 30]) {
      expect(xs, `snap(${x}) left the site list`).toContain(snapLandingPoint(map, x, 500).x);
    }
  });
});

describe("a world you already hold", () => {
  /** The launch-ready galaxy, with `pads` standing on the destination before the jump. */
  function withPads(stamps: Array<{ x: number; y: number; lastLanding?: number }>): { galaxy: Galaxy; home: State } {
    const ready = launchReady();
    const dest = previewPlanet(ready.galaxy, FRESH) as State;
    for (const s of stamps) {
      const pad = makeBuilding("spaceport", "player", s.x, s.y) as PadStamp;
      if (s.lastLanding !== undefined) pad.lastLanding = s.lastLanding;
      dest.buildings.set(pad.id, pad);
    }
    return ready;
  }

  it("the pad wins, the pick is discarded, and the picker says so before the jump", () => {
    const ring = measureRingOffset(FRESH);
    const { galaxy } = withPads([{ x: 300, y: 700 }]);
    const brief = briefFor(galaxy, FRESH);
    expect(brief.pads).toHaveLength(1);

    const view = new ApproachView(brief);
    const camera = view.camera(VIEW_W, VIEW_H);
    pointAtWorld(view, camera, 1180, 220);
    const raw = view.pick!;
    const site = view.site;

    // What the picker promises: the pad, flagged as not the player's choice.
    expect(site.source).toBe("pad");
    expect(site.honoured).toBe(false);
    expect(site.padId).toBe(brief.pads[0]!.id);
    expect(site.x).toBe(300);
    expect(site.y).toBe(700);
    // …and the pick it discarded is genuinely somewhere else — further than the snap alone could
    // ever move a point, so nothing but the pad can account for the difference.
    const discarded = brief.snap(raw.x, raw.y);
    expect(Math.hypot(discarded.x - site.x, discarded.y - site.y)).toBeGreaterThan(LANDING_PICK_GRID);

    // What the engine does with the very same pick.
    expect(jumpTo(galaxy, FRESH, raw)).toBeNull();
    const riders = riderPositions(galaxy, FRESH);
    expect(riders).toHaveLength(1);
    expect(riders[0]!.x - ring.dx).toBe(site.x);
    expect(riders[0]!.y - ring.dy).toBe(site.y);
  });

  it("prefers the pad most recently landed at, and breaks ties the engine's way", () => {
    // `landingZone` keeps the FIRST maximum of `lastLanding` over `playerSpaceports`' id order, so a
    // tie falls to the lowest id. A mirror that used `>=` would silently prefer the last.
    const cases: Array<{ a?: number; b?: number; winner: 0 | 1 }> = [
      { winner: 0 },                        // never landed at either → lowest id
      { a: 0, b: 9, winner: 1 },
      { a: 9, b: 0, winner: 0 },
      { a: 5, b: 5, winner: 0 },            // the tie
    ];
    const ring = measureRingOffset(FRESH);
    for (const c of cases) {
      const { galaxy } = withPads([
        { x: 300, y: 700, lastLanding: c.a }, { x: 1200, y: 200, lastLanding: c.b },
      ]);
      const brief = briefFor(galaxy, FRESH);
      expect(brief.pads).toHaveLength(2);
      // The order the mirror depends on is the engine's own, lowest id first.
      expect(brief.pads.map((p) => p.id)).toEqual([...brief.pads].map((p) => p.id).sort());

      const site = landingSite(brief, { x: 641, y: 333 });
      const expected = brief.pads[c.winner]!;
      expect(site.padId).toBe(expected.id);
      expect(site.x).toBe(expected.x);
      expect(site.y).toBe(expected.y);

      expect(jumpTo(galaxy, FRESH, { x: 641, y: 333 })).toBeNull();
      const riders = riderPositions(galaxy, FRESH);
      expect(riders).toHaveLength(1);
      expect(riders[0]!.x - ring.dx).toBe(site.x);
      expect(riders[0]!.y - ring.dy).toBe(site.y);
    }
  });

  it("falls back to the world's anchor when there is no pad and nothing picked", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = briefFor(galaxy, FRESH);
    const site = landingSite(brief, null);
    expect(site.source).toBe("anchor");
    expect(site.honoured).toBe(false);
    expect(site.x).toBe(brief.anchorX);
    expect(site.y).toBe(brief.anchorY);
  });
});

describe("the frame", () => {
  function renderOnce(view: ApproachView): RecordingRenderer {
    const renderer = new RecordingRenderer();
    renderer.registerMeshes(buildMeshes());
    const terrain = buildTerrainMesh(view.brief.field, { relief: true, apron: 200 });
    view.compose(renderer, terrain, view.camera(VIEW_W, VIEW_H));
    return renderer;
  }

  function overlay(renderer: RecordingRenderer, kind: string) {
    return renderer.lastFrame.overlays.find((o) => o.kind === kind);
  }

  it("draws the ground, the lander on the site, and the ring the site owns", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const view = new ApproachView(briefFor(galaxy, FRESH));
    const camera = view.camera(VIEW_W, VIEW_H);
    pointAtWorld(view, camera, 1180, 220);
    const site = view.site;
    const renderer = renderOnce(view);

    expect(renderer.lastFrame.terrainVersion).not.toBeNull();
    const lander = renderer.lastFrame.batches.find((b) => b.mesh === "colonyship")!;
    expect(lander.count).toBe(1);
    // On the site, and sitting ON the ground rather than on the zero plane — this screen exists to
    // show relief, and a marker floating over a mesa would be the same lie in a different register.
    // `Math.fround` throughout: the port's buffers are Float32 and the picker's are doubles, so the
    // rounding is the storage's, not a disagreement about the point.
    expect(lander.xyz[0]).toBe(site.x);
    expect(lander.xyz[2]).toBe(site.y);
    expect(lander.xyz[1]).toBe(Math.fround(elevation(view.brief.field, site.x, site.y)));

    const ghosts = overlay(renderer, "ghost")!;
    expect(ghosts.count).toBe(2);            // where you land, and where you clicked
    expect(ghosts.data[0]).toBe(site.x);
    expect(ghosts.data[2]).toBe(site.y);
    expect(ghosts.data[3]).toBe(view.markerRadius);
    expect(ghosts.data[4]).toBe(1);          // the live one
    const raw = view.pick!;
    expect(ghosts.data[6]).toBe(Math.fround(raw.x));
    expect(ghosts.data[8]).toBe(Math.fround(raw.y));
    expect(ghosts.data[10]).toBe(0);         // the dead one

    // And the line that says the two are not the same point.
    const rally = overlay(renderer, "rally")!;
    expect(rally.count).toBe(1);
    expect(rally.data[0]).toBe(Math.fround(raw.x));
    expect(rally.data[2]).toBe(Math.fround(raw.y));
    expect(rally.data[3]).toBe(site.x);
    expect(rally.data[5]).toBe(site.y);
  });

  it("puts the marker on the ground, not on the zero plane", () => {
    // Asserted on a world with relief, and against a site whose own elevation is non-zero —
    // otherwise "height equals `elevation(site)`" is two zeroes agreeing, which is what the flat
    // destination the tests above use would have quietly given.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const view = new ApproachView(briefFor(galaxy, RELIEF));
    const field = view.brief.field;

    let high: { x: number; y: number } | null = null;
    for (let x = LANDING_PICK_GRID; x <= field.width - LANDING_PICK_GRID && !high; x += LANDING_PICK_GRID) {
      for (let y = LANDING_PICK_GRID; y <= field.height - LANDING_PICK_GRID; y += LANDING_PICK_GRID) {
        if (elevation(field, x, y) > 1) { high = { x, y }; break; }
      }
    }
    expect(high, "no landing site on this world stands above the zero plane").not.toBeNull();

    const camera = view.camera(VIEW_W, VIEW_H);
    pointAtWorld(view, camera, high!.x, high!.y);
    const site = view.site;
    const groundHeight = elevation(field, site.x, site.y);
    expect(groundHeight).toBeGreaterThan(1);

    const renderer = renderOnce(view);
    const lander = renderer.lastFrame.batches.find((b) => b.mesh === "colonyship")!;
    expect(lander.xyz[1]).toBe(Math.fround(groundHeight));
    expect(overlay(renderer, "ghost")!.data[1]).toBeGreaterThan(groundHeight);
  });

  it("draws no correction when the click is already the site", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const view = new ApproachView(briefFor(galaxy, FRESH));
    const renderer = new RecordingRenderer();
    renderer.registerMeshes(buildMeshes());
    const terrain = buildTerrainMesh(view.brief.field, { relief: true, apron: 200 });
    // Nothing picked: the anchor case. There is no click to correct, so no dead ring and no line.
    view.compose(renderer, terrain, view.camera(VIEW_W, VIEW_H));
    expect(overlay(renderer, "ghost")!.count).toBe(1);
    expect(overlay(renderer, "rally")).toBeUndefined();
  });

  it("shows every pad and flags the one the jump will use", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const dest = previewPlanet(galaxy, FRESH) as State;
    const cold = makeBuilding("spaceport", "player", 300, 700);
    const warm = makeBuilding("spaceport", "player", 1200, 200) as PadStamp;
    warm.lastLanding = 40;
    dest.buildings.set(cold.id, cold);
    dest.buildings.set(warm.id, warm);

    const view = new ApproachView(briefFor(galaxy, FRESH));
    const renderer = renderOnce(view);
    const pads = renderer.lastFrame.batches.find((b) => b.mesh === "port")!;
    expect(pads.count).toBe(2);

    const marks = overlay(renderer, "waypoint")!;
    expect(marks.count).toBe(2);
    const kinds = new Map<string, number>();
    for (let i = 0; i < marks.count; i++) {
      kinds.set(`${marks.data[i * marks.stride]},${marks.data[i * marks.stride + 2]}`, marks.data[i * marks.stride + 3]!);
    }
    expect(kinds.get("1200,200")).toBe(WAYPOINT_PAD_CHOSEN);
    expect(kinds.get("300,700")).toBe(WAYPOINT_PAD);
  });

  it("shows the ground and the player's own pads, and nothing else — a blind landing stays blind", () => {
    // The destination is a live world with a neighbour already on it, and with every deposit the
    // map generator laid down. None of it may appear on a screen the player reaches before ever
    // going there — and the reason it cannot is structural: the brief has no channel to carry it.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const dest = previewPlanet(galaxy, FRESH) as State;
    expect([...dest.units.values()].some((u) => u.owner === "ai")).toBe(true);
    expect(dest.map.nodes.length).toBeGreaterThan(0);

    const view = new ApproachView(briefFor(galaxy, FRESH));
    const renderer = renderOnce(view);
    expect(renderer.lastFrame.batches.map((b) => b.mesh).sort()).toEqual(["colonyship"]);
    // The key list is pinned so a future field has to argue for itself here. `sites` did: it was
    // added when upstream's 50ceb88 exposed `landingSites`, and it is the landing LATTICE — a
    // function of the map's width and height and two engine constants, identical on every world of
    // the same size. It tells a player nothing about the destination they have not been to, which
    // is the property this test exists to protect. `field` is the terrain and is already here on
    // the same footing: the approach view is a terrain screen by design.
    expect(Object.keys(view.brief)).toEqual(
      ["destId", "field", "snap", "sites", "pads", "anchorX", "anchorY"],
    );
    // Asserted rather than argued: the site list is the same on a world the player has never seen
    // as on their own, so it cannot be a channel for anything about the destination.
    const home = briefFor(galaxy, HOME);
    expect(view.brief.sites, "the landing lattice differs per world — it would be a real intel leak")
      .toEqual(home.sites);
  });
});
