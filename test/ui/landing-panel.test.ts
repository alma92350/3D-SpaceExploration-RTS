// P4-T05 — the picker's model half: the brief it hands the 3D view, and what it lets the jump
// promise.
//
// `test/view/landing.test.ts` proves the marker lands on `snapLandingPoint`'s point. This file
// proves the two things that surround it, both of which can be wrong while the marker is perfect:
//
//   1. **The brief really carries the engine's own function.** A brief that carried a lookalike —
//      a reimplemented round, a copied 160 — would satisfy every assertion in the view's file,
//      because that file is handed whatever `snap` it is given. So the check here is against
//      `snapLandingPoint` itself, over a sweep that crosses both the rounding and the clamp.
//   2. **The intent forwards the RAW point, not the snapped one.** The snap rounds and then clamps,
//      which makes it non-idempotent inside the margin: feed the picker's own answer back in and it
//      moves by a whole grid step. That is a defect with no visible symptom — the marker is drawn
//      in the right place and the colony lands somewhere else — so it is asserted by running the
//      jump both ways and showing they disagree.
//
// One engine behaviour is pinned here rather than described: opening the picker on a dormant world
// rewinds the engine's global entity-id counter. It is why the brief is built once per screen and
// not once per frame, and a comment saying so would be a claim nobody could falsify.

import { describe, expect, it } from "vitest";
import {
  activeState, createGalaxy, makeBuilding, makeUnit, playerSpaceports,
  previewPlanet, snapLandingPoint,
} from "../../src/engine/index.js";
import { applyIntent } from "../../src/bridge/commands.js";
import { ApproachView, landingSite } from "../../src/view/landing.js";
import { approachBrief, landingPanelModel } from "../../src/ui/landing-panel.js";

const SEED = 20260814;
const HOME = "helix";
/** Live, unsettled: no pad standing, so the pick is what lands. */
const FRESH = "ferros";
/** Dormant for this seed — `previewPlanet` has to build it, which is what the id test needs. */
const DORMANT = "pyralis";

type PadStamp = Building & { lastLanding?: number };

/** As `test/view/landing.test.ts`: one pad, one staged colony ship, so a jump lands one rider. */
function launchReady(): Galaxy {
  const galaxy = createGalaxy({ seed: SEED, startId: HOME });
  galaxy.credits = 5000;
  galaxy.time = 120;
  const home = activeState(galaxy);
  const pad = makeBuilding("spaceport", "player", 800, 300);
  home.buildings.set(pad.id, pad);
  const ship = makeUnit("colonyship", "player", 820, 300);
  home.units.set(ship.id, ship);
  return galaxy;
}

function jumpWith(galaxy: Galaxy, destId: string, x: number | null, y: number | null): void {
  const intent = x !== null && y !== null
    ? { kind: "jump" as const, destId, landingX: x, landingY: y }
    : { kind: "jump" as const, destId };
  expect(applyIntent(activeState(galaxy), intent, galaxy)).toBeNull();
}

function riderPosition(galaxy: Galaxy, destId: string): { x: number; y: number } {
  const riders = [...galaxy.planets.get(destId)!.units.values()].filter((u) => u.id.startsWith("g"));
  expect(riders).toHaveLength(1);
  return { x: riders[0]!.x, y: riders[0]!.y };
}

/**
 * The offset between a landing zone and its single rider, measured from a control jump aimed at a
 * point the snap maps to itself. Measured rather than assumed, so no engine constant is copied into
 * a file about not copying engine constants.
 */
function measureRingOffset(destId: string): { dx: number; dy: number } {
  const galaxy = launchReady();
  const map = (previewPlanet(galaxy, destId) as State).map;
  const fixed = snapLandingPoint(map, 800, 480);
  expect(snapLandingPoint(map, fixed.x, fixed.y)).toEqual(fixed);
  jumpWith(galaxy, destId, fixed.x, fixed.y);
  const rider = riderPosition(galaxy, destId);
  return { dx: rider.x - fixed.x, dy: rider.y - fixed.y };
}

describe("the brief", () => {
  it("carries the engine's own snap, not a lookalike", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = approachBrief(galaxy, FRESH);
    const map = (previewPlanet(galaxy, FRESH) as State).map;

    let moved = 0;
    for (let x = -40; x <= map.width + 40; x += 17) {
      for (let y = -40; y <= map.height + 40; y += 23) {
        const mine = brief.snap(x, y);
        const theirs = snapLandingPoint(map, x, y);
        expect(mine.x).toBe(theirs.x);
        expect(mine.y).toBe(theirs.y);
        if (mine.x !== x || mine.y !== y) moved++;
      }
    }
    // The sweep has to cross ground the snap actually changes, or it compares two constants.
    expect(moved).toBeGreaterThan(1000);
    // And it has to cross the clamp, which is the half a reimplementation gets wrong.
    expect(brief.snap(-40, 500).x).toBe(100);
    expect(brief.snap(map.width + 40, 500).x).toBe(map.width - 100);
  });

  it("carries the pads in the engine's own order, with their landing stamps", () => {
    const galaxy = launchReady();
    const dest = previewPlanet(galaxy, FRESH) as State;
    const later = makeBuilding("spaceport", "player", 1200, 200) as PadStamp;
    const earlier = makeBuilding("spaceport", "player", 300, 700) as PadStamp;
    later.lastLanding = 77;
    dest.buildings.set(later.id, later);
    dest.buildings.set(earlier.id, earlier);

    const brief = approachBrief(galaxy, FRESH);
    // `landingZone` breaks its ties on `playerSpaceports`' order, so the order is part of the data.
    expect(brief.pads.map((p) => p.id)).toEqual(playerSpaceports(dest).map((b) => b.id));
    expect(brief.pads.find((p) => p.id === later.id)!.lastLanding).toBe(77);
    // A pad never landed at carries no stamp at all upstream; it must not arrive as `undefined`.
    expect(brief.pads.find((p) => p.id === earlier.id)!.lastLanding).toBe(0);
  });

  it("reads the destination's own terrain and anchor, without waking the world", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const before = [...galaxy.planets.keys()];
    const brief = approachBrief(galaxy, DORMANT);
    const map = (previewPlanet(galaxy, DORMANT) as State).map;

    expect(brief.field.width).toBe(map.width);
    expect(brief.field.height).toBe(map.height);
    expect(brief.field.type).toEqual(map.terrain.type);
    expect(brief.anchorX).toBe(map.bases.player.x);
    expect(brief.anchorY).toBe(map.bases.player.y);
    // Opening the picker must not add a world to the live set — backing out of the screen would
    // otherwise leave a world simulating that the player never visited.
    expect([...galaxy.planets.keys()]).toEqual(before);
  });

  it("opening on a dormant world rewinds the engine's entity-id counter — hence once per screen", () => {
    // `previewPlanet` re-seeds the global id counter for the throwaway world and then bumps it past
    // the live roster, which usually leaves it LOWER than it was. The observable consequence is
    // this: the next building minted anywhere reuses the id just handed out.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const first = makeBuilding("habitat", "player", 0, 0).id;
    const second = makeBuilding("habitat", "player", 0, 0).id;
    expect(second).not.toBe(first);

    approachBrief(galaxy, DORMANT);
    // Not merely "an id repeats": the counter goes back past BOTH mints, to just above the live
    // roster's highest id.
    expect(makeBuilding("habitat", "player", 0, 0).id).toBe(first);

    // A fixed point rather than a slide — repeated opens land on the same value, which is why
    // holding one brief for the life of the screen is enough and why this is a reason to build it
    // once rather than a defect to route around.
    approachBrief(galaxy, DORMANT);
    expect(makeBuilding("habitat", "player", 0, 0).id).toBe(first);

    // A live world is returned as it stands and touches nothing.
    approachBrief(galaxy, FRESH);
    expect(makeBuilding("habitat", "player", 0, 0).id).toBe(second);
  });
});

describe("what the jump is allowed to promise", () => {
  it("forwards the RAW pointer point, and forwarding the snapped one would move the landing", () => {
    // The whole reason `ApproachView.pick` is un-snapped. Both jumps below are honest attempts to
    // land on the same site; only one of them does.
    const ring = measureRingOffset(FRESH);
    const near = { x: 30, y: 500 };

    const honest = launchReady();
    const brief = approachBrief(honest, FRESH);
    const site = landingSite(brief, near);
    const model = landingPanelModel(brief, near, site);
    expect(model.landingX).toBe(near.x);
    expect(model.landingY).toBe(near.y);
    // Upstream 50ceb88 (issue #94) made the snap pick the nearest real landing SITE, so this is a
    // site rather than the old off-lattice clamp margin of 100.
    expect(brief.sites.xs, "the picker left the engine's own site list").toContain(model.siteX);
    jumpWith(honest, FRESH, model.landingX, model.landingY);
    const landed = riderPosition(honest, FRESH);

    const naive = launchReady();
    jumpWith(naive, FRESH, site.x, site.y);              // the picker's own answer, fed back in
    const drifted = riderPosition(naive, FRESH);

    // The forwarded raw point lands exactly where the player was shown.
    expect(landed.x - ring.dx).toBe(model.siteX);
    expect(landed.y - ring.dy).toBe(model.siteY);
    // **And so does the snapped point, which it did NOT before.** This assertion is inverted from
    // what it was: the snap used to round then clamp, so feeding the picker's own answer back in
    // landed 60 units from the ring it had drawn. Reported as upstream issue #94, fixed in 50ceb88,
    // and the panel still forwards the raw point — no longer because it must, but because it is
    // correct either way and this test now guards the engine's promise rather than working round it.
    expect(drifted.x, "the snap is no longer a fixed point — issue #94 has regressed").toBe(landed.x);
    expect(drifted.y).toBe(landed.y);
  });

  it("sends no landing point at all when a pad will discard it", () => {
    const galaxy = launchReady();
    const dest = previewPlanet(galaxy, FRESH) as State;
    const pad = makeBuilding("spaceport", "player", 300, 700);
    dest.buildings.set(pad.id, pad);

    const brief = approachBrief(galaxy, FRESH);
    const pick = { x: 1180, y: 220 };
    const site = landingSite(brief, pick);
    const model = landingPanelModel(brief, pick, site);

    expect(model.landingX).toBeNull();
    expect(model.landingY).toBeNull();
    expect(model.siteX).toBe(300);
    expect(model.siteY).toBe(700);
    expect(model.override).toBeTruthy();
    expect(model.canConfirm).toBe(true);

    // An intent with no landing fields and one carrying the discarded pick are the same jump —
    // which is exactly why shipping the number would be a promise the recording keeps and the game
    // does not.
    jumpWith(galaxy, FRESH, model.landingX, model.landingY);
    expect(riderPosition(galaxy, FRESH).y).toBe(700);
  });

  it("says the site is a snap of the mark, and says how far it moved", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = approachBrief(galaxy, FRESH);
    const pick = { x: 641, y: 333 };
    const model = landingPanelModel(brief, pick, landingSite(brief, pick));

    expect(model.siteX).toBe(640);
    expect(model.siteY).toBe(320);
    expect(model.headline).toContain("640, 320");
    expect(model.override).toBeNull();
    expect(model.drift).toBeCloseTo(Math.hypot(1, 13), 10);
    expect(model.canConfirm).toBe(true);
  });

  it("will not confirm a jump nobody has aimed", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const brief = approachBrief(galaxy, FRESH);
    const model = landingPanelModel(brief, null, landingSite(brief, null));
    expect(model.canConfirm).toBe(false);
    expect(model.landingX).toBeNull();
    expect(model.siteX).toBe(brief.anchorX);
  });

  it("the wording follows the site's source, so the words and the marker cannot disagree", () => {
    const galaxy = launchReady();
    const brief = approachBrief(galaxy, FRESH);
    const view = new ApproachView(brief);
    const camera = view.camera(1280, 720);
    expect(view.pointAt(camera, 700, 400)).toBe(true);

    const picked = landingPanelModel(brief, view.pick, view.site);
    expect(picked.siteX).toBe(view.site.x);
    expect(picked.siteY).toBe(view.site.y);
    expect(picked.override).toBeNull();
    expect(picked.landingX).toBe(view.pick!.x);

    const dest = previewPlanet(galaxy, FRESH) as State;
    const pad = makeBuilding("spaceport", "player", 300, 700);
    dest.buildings.set(pad.id, pad);
    const held = new ApproachView(approachBrief(galaxy, FRESH));
    expect(held.pointAt(held.camera(1280, 720), 700, 400)).toBe(true);
    const overruled = landingPanelModel(held.brief, held.pick, held.site);
    expect(overruled.siteX).toBe(300);
    expect(overruled.override).toBeTruthy();
    expect(overruled.landingX).toBeNull();
  });
});
