// P2-T08 — the building-state badge vocabulary, as geometry.
//
// PRD N-05: never colour alone. A status badge is the single easiest place in this game to break
// that rule, because a red dot and an amber dot are the obvious implementation and they are the
// same shape. So the badge is a **shape**, and this module exists to make that assertable: the
// glyphs are pure data, one polyline set per state, and a test can prove any two states differ by
// comparing their geometry — no pixels, no colour, no renderer.
//
// It lives apart from `overlays2d.ts` for the same reason a panel model lives apart from its DOM
// (Q-10): the decision "what does a throttled factory look like?" is worth testing on its own, and
// a function that both draws and decides can only be tested by drawing.
//
// Coordinates are glyph space: a unit square centred on the origin, x right and y DOWN (screen
// convention, since these are projected 2D badges — see the header of `overlays2d.ts` for why the
// overlays are 2D and not world geometry). The caller scales and translates.

import {
  ACTIVITY_IDLE, CONCERN_BUFFER_FULL, CONCERN_NONE, CONCERN_NO_FUEL, CONCERN_NO_POWER,
  CONCERN_PAUSED, CONCERN_STARVED, CONCERN_THROTTLED,
} from "../../bridge/snapshot.js";

/** One stroked polyline in glyph space: [x0, y0, x1, y1, …]. */
export type Stroke = readonly number[];

/** A glyph is one or more strokes. `closed` rings back to the first point. */
export interface Glyph {
  readonly id: string;
  readonly strokes: readonly Stroke[];
  readonly closed: boolean;
}

/**
 * Nothing to say. Returned for a healthy, working building — which is most of them, most of the
 * time, and the reason "working" draws no badge at all: a cue on all 300 buildings is not a cue.
 */
export const GLYPH_NONE = null;

const ring = (sides: number, r: number): Stroke => {
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return pts;
};

/**
 * The vocabulary.
 *
 * Chosen so the pairs a player confuses under pressure are the pairs that differ MOST:
 *
 *  - **starved** (nothing coming in) points DOWN; **bufferFull** (nothing going out) points UP.
 *    Same figure, opposite orientation — one glyph's worth of ink for two states, and they are
 *    semantic opposites, so the mnemonic is the shape.
 *  - **idle** is an open ring: the only closed round figure, and the only badge that means "you
 *    forgot something" rather than "something is wrong". The board named idle-vs-unpowered as the
 *    confusion that makes a player think the game is broken, so those two are a ring and a bolt —
 *    round versus jagged, about as far apart as two small figures get.
 *  - **throttled** is an hourglass, which is the two triangles joined: it is literally between the
 *    two starvation states, and it is a warning rather than a stop (the factory IS producing).
 *  - **paused** is the universal two bars. It is the one state the player caused on purpose.
 *  - **noFuel** is a tank with a slash — a container, like bufferFull, but struck through.
 */
export const GLYPHS: Readonly<Record<number, Glyph>> = {
  [CONCERN_PAUSED]: {
    id: "paused",
    strokes: [[-0.35, -0.5, -0.35, 0.5], [0.35, -0.5, 0.35, 0.5]],
    closed: false,
  },
  [CONCERN_NO_POWER]: {
    // A lightning bolt, broken: the upper and lower halves are two strokes with a gap between them,
    // so it reads as a bolt that does not connect.
    id: "noPower",
    strokes: [[0.3, -0.6, -0.2, -0.05, 0.15, -0.05], [-0.05, 0.1, -0.35, 0.6, 0.2, 0.1]],
    closed: false,
  },
  [CONCERN_NO_FUEL]: {
    id: "noFuel",
    strokes: [[-0.4, -0.35, 0.4, -0.35, 0.4, 0.45, -0.4, 0.45], [-0.55, 0.6, 0.55, -0.5]],
    closed: false,
  },
  [CONCERN_STARVED]: {
    id: "starved",
    strokes: [[-0.5, -0.4, 0.5, -0.4, 0, 0.55]],
    closed: true,
  },
  [CONCERN_BUFFER_FULL]: {
    id: "bufferFull",
    strokes: [[-0.5, 0.4, 0.5, 0.4, 0, -0.55]],
    closed: true,
  },
  [CONCERN_THROTTLED]: {
    id: "throttled",
    strokes: [[-0.45, -0.5, 0.45, -0.5, -0.45, 0.5, 0.45, 0.5]],
    closed: true,
  },
};

/** Idle is ours, not a concern, so it is keyed separately rather than squeezed into the enum. */
export const IDLE_GLYPH: Glyph = { id: "idle", strokes: [ring(10, 0.5)], closed: true };

/**
 * Which badge a building wears, from the two codes the snapshot carries (P2-T08).
 *
 * Concern wins over activity, and that is the whole precedence rule: a building the engine says is
 * stopped gets the engine's reason, and "idle" only ever shows on a building with nothing wrong
 * with it. Two badges on one building would make the player choose which to believe.
 */
export function statusGlyph(concern: number, activity: number): Glyph | null {
  if (concern !== CONCERN_NONE) return GLYPHS[concern] ?? null;
  return activity === ACTIVITY_IDLE ? IDLE_GLYPH : GLYPH_NONE;
}

/**
 * Does this building wear a badge at all? The scene asks before packing an overlay slot, so a
 * 300-building base does not write 1 500 floats a frame to draw nothing.
 *
 * Defined as `statusGlyph(...) !== null` rather than as its own condition, because the same rule
 * written twice is the same rule until someone edits one of them.
 */
export function hasStatusGlyph(concern: number, activity: number): boolean {
  return statusGlyph(concern, activity) !== null;
}
