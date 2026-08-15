// The landing picker's model half (P4-T05): what the approach view is told, and what it is
// allowed to promise.
//
// Two jobs, and they are the two the 3D view deliberately cannot do for itself.
//
// **1. It builds the brief, and it is the only place the engine is called.** `view/landing.ts` may
// not import the engine (ADR-0008); a panel model may, and every other one in this directory
// already does (`operations-panel.ts`, `research-panel.ts`, `market-panel.ts` all read engine state
// directly). So the seam sits here: `snapLandingPoint` is bound to the destination's map and handed
// over as a function, the pads come from `playerSpaceports` in the engine's own order, and the
// anchor is the map's own. Nothing about the landing rules is re-derived on either side of that
// line — the grid constant is never read, never copied and never transported.
//
// **2. It decides what the jump intent carries**, which is a smaller decision than it looks and a
// sharper one:
//
//   • The intent carries the **raw** pointer point, never the snapped one. `snapLandingPoint` is
//     NOT idempotent at the map edge — it rounds first and clamps second, so a click at x = 30 is
//     shown at the 100-unit margin, and feeding 100 back through rounds it up to the next grid line
//     instead. Forward the point the picker snapped and the colony lands a grid step from the ring
//     the player was looking at, on exactly the clicks nearest the edge that a player is most
//     deliberate about. The engine snaps once; the picker snaps the same point once, for display.
//   • On a world where a pad already stands, the intent carries **no** landing point at all.
//     `landingZone` would discard it, and an intent that shipped a number the engine throws away is
//     a promise the recording keeps and the game does not.
//
// Everything player-facing here follows from `landingSite`'s `source`, so the words and the marker
// can never disagree about which of the three cases the jump is in.

import { playerSpaceports, previewPlanet, snapLandingPoint } from "../engine/index.js";
import { elevationFieldFrom } from "../view/terrain/elevation.js";
import { type ApproachBrief, type GroundPoint, type LandingSite } from "../view/landing.js";

/**
 * `Building.lastLanding` — written by `jumpCapital` when riders touch down at a pad, read by
 * `landingZone` to prefer the pad you most recently came in at. It is not in the hand-written
 * declarations (`src/engine/types/shared.d.ts`), so it is narrowed here rather than assumed.
 */
type PadStamp = Building & { lastLanding?: number };

/**
 * Open the picker on `destId`.
 *
 * **Call this once per screen, not once per frame.** `previewPlanet` builds a dormant world's whole
 * state — map generation, market, diplomacy — to look at without waking it, and it is not
 * observationally free: it re-seeds the engine's global entity-id counter and then bumps it past
 * every id in the live roster (`bumpEntityCounterPastGalaxy`). Since a throwaway world's own seeding
 * usually reaches a LOWER id than whatever was last minted, the net effect is that the counter moves
 * **backwards**, and the next entity built anywhere reuses an id that was just handed out. The test
 * for this asserts exactly that — two `makeBuilding` calls either side of an `approachBrief` come
 * back with the same id — because a warning nobody can falsify is a warning nobody keeps.
 *
 * Nothing in the app is currently exposed to it (every live entity is registered in a world's state
 * before the next mint, and the bump scans exactly those), and repeated calls are idempotent rather
 * than cumulative, so this is a reason to hold the brief for the life of the screen, not a defect
 * to route around. A live world is returned as-is and touches nothing at all.
 */
export function approachBrief(galaxy: Galaxy, destId: string): ApproachBrief {
  // Declared `unknown` in `src/engine/types/engine/galaxy.d.ts` — a stub from P4-T09, which needed
  // the name to exist and not its shape. It returns a planet state; `buildPlanetState` is the
  // shared core of it and `addPlanet` alike.
  const dest = previewPlanet(galaxy, destId) as State;
  const map = dest.map;
  return {
    destId,
    field: elevationFieldFrom(map.terrain, map.width, map.height),
    // The engine's own function, bound to this map. Not a grid, not a copy of the rounding.
    snap: (x: number, y: number) => snapLandingPoint(map, x, y),
    // `playerSpaceports` sorts by id, lowest first, and `landingZone` breaks its ties on that
    // order — so the order is carried, not just the set.
    pads: playerSpaceports(dest).map((b) => ({
      id: b.id, x: b.x, y: b.y, lastLanding: (b as PadStamp).lastLanding ?? 0,
    })),
    anchorX: map.bases.player.x,
    anchorY: map.bases.player.y,
  };
}

export interface LandingPanelModel {
  readonly destId: string;
  /** The site, in the player's words. */
  readonly headline: string;
  /** Where the site came from. */
  readonly detail: string;
  /** Present only when the engine will overrule the pick, and it says so plainly. */
  readonly override: string | null;
  readonly siteX: number;
  readonly siteY: number;
  /** How far the engine moved the pointer's point, in world units. Zero when it did not move it. */
  readonly drift: number;
  /** `Intent.landingX` — null when the jump must not carry one. */
  readonly landingX: number | null;
  /** `Intent.landingY` — null when the jump must not carry one. */
  readonly landingY: number | null;
  /**
   * Whether the jump can be committed from this screen.
   *
   * False only in the anchor case — no pad, and nothing picked yet. The engine would fall back
   * cleanly, but falling back is what this screen exists to replace: a picker that let you confirm
   * without choosing has told the player their choice was optional.
   */
  readonly canConfirm: boolean;
}

export function landingPanelModel(
  brief: ApproachBrief, pick: GroundPoint | null, site: LandingSite,
): LandingPanelModel {
  const at = `${Math.round(site.x)}, ${Math.round(site.y)}`;
  const drift = pick ? Math.hypot(pick.x - site.x, pick.y - site.y) : 0;

  if (site.source === "pad") {
    return {
      destId: brief.destId,
      headline: `Landing at your Spaceport — ${at}`,
      detail: "A return trip comes in at your own pad, not at the world's anchor.",
      override: pick
        ? "Your mark is ignored: a Spaceport stands here and the landing homes in on it."
        : null,
      siteX: site.x, siteY: site.y, drift,
      // The engine discards a landing point whenever a pad stands, so the intent carries none.
      landingX: null, landingY: null,
      canConfirm: true,
    };
  }

  if (site.source === "picked") {
    return {
      destId: brief.destId,
      headline: `Landing at ${at}`,
      detail: drift > 0
        ? "A blind approach is coarse: your mark is pulled onto the approach grid, and this is where the colony sets down."
        : "Your mark sits on the approach grid, and this is where the colony sets down.",
      override: null,
      siteX: site.x, siteY: site.y, drift,
      // The RAW point, not `site`. See the file header: the engine snaps it on arrival, and the
      // snap is not idempotent at the map edge.
      landingX: pick!.x, landingY: pick!.y,
      canConfirm: true,
    };
  }

  return {
    destId: brief.destId,
    headline: "No landing site chosen",
    detail: "Mark a spot on the approach. Without one the jump falls back to the world's own anchor.",
    override: null,
    siteX: site.x, siteY: site.y, drift: 0,
    landingX: null, landingY: null,
    canConfirm: false,
  };
}
