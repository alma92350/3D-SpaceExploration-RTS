// Ray → ground picking (P1-T12, PRD F-03) and entity picking.
//
// This is the module PRD risk R4 is about. The sim thinks in flat `(x, y)`; the player clicks on a
// perspective image of a heightfield. If the two disagree by more than half a world unit at any
// camera angle, orders land in the wrong place — and they do it *subtly*, on sloped ground only,
// which is the worst kind of bug to notice.
//
// The method: unproject the click through the inverse view-projection to get a world ray, then
// march it against the elevation field. A closed-form plane intersection is not enough — the ground
// is not a plane — but full ray-marching every frame is not needed either, so it goes in two steps:
//
//   1. Intersect the ray with the *flat* plane at the height of the highest terrain and at the
//      lowest, giving a bounded segment: no unbounded march, and no missing a mesa behind the
//      camera's back.
//   2. March that segment at a fixed step, then bisect the crossing interval. Bisection is what
//      buys the sub-unit precision cheaply — 12 iterations narrows any step to well under 0.5.
//
// Returns simulation `(x, y)` only. Nothing above this ever learns a height (ADR-0004).

import { type ElevationField, TERRAIN_HEIGHT, elevation } from "../view/terrain/elevation.js";
import { type CameraState } from "../view/renderer/port.js";
import { invert } from "./camera.js";

const MAX_HEIGHT = Math.max(...TERRAIN_HEIGHT);
const MARCH_STEPS = 96;
const BISECT_STEPS = 14;
const SLAB_MARGIN = 1;

export interface GroundHit {
  x: number;
  y: number;
  hit: boolean;
}

const invVP = new Float32Array(16);
const nearPoint = { x: 0, y: 0, z: 0 };
const farPoint = { x: 0, y: 0, z: 0 };
const scratchHit: GroundHit = { x: 0, y: 0, hit: false };

/**
 * Screen pixel → simulation coordinate.
 *
 * @param px, py  pixels from the canvas's top-left.
 * @returns caller-must-copy scratch. Reused every call — allocation in a mousemove handler at
 *          60 Hz is exactly the GC pressure ADR-0006 forbids.
 */
export function pickGround(camera: CameraState, field: ElevationField, px: number, py: number): GroundHit {
  if (!invert(invVP, camera.viewProj)) {
    scratchHit.hit = false;
    return scratchHit;
  }

  // NDC. WebGL's Y is up, the canvas's is down.
  const ndcX = (px / camera.viewportWidth) * 2 - 1;
  const ndcY = 1 - (py / camera.viewportHeight) * 2;
  unproject(invVP, ndcX, ndcY, -1, nearPoint);
  unproject(invVP, ndcX, ndcY, 1, farPoint);

  const ox = nearPoint.x, oy = nearPoint.y, oz = nearPoint.z;
  let dx = farPoint.x - ox, dy = farPoint.y - oy, dz = farPoint.z - oz;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    scratchHit.hit = false;
    return scratchHit;
  }
  dx /= len; dy /= len; dz /= len;

  // Bound the march to the slab the terrain actually occupies. Looking at the horizon, `dy` is
  // nearly zero and an unbounded march would walk to the far plane one small step at a time.
  //
  // The slab is deliberately one unit PROUD of the terrain at both ends. Sitting it exactly on
  // the extremes puts the march's first sample at gap == 0 when the target is the flat top of a
  // mesa — and a crossing detector that needs `prevGap > 0` then never fires, so clicking high
  // ground silently missed. Padding costs two wasted samples and removes the whole edge case.
  const tTop = dy < -1e-6 ? (MAX_HEIGHT + SLAB_MARGIN - oy) / dy : 0;
  const tBottom = dy < -1e-6 ? (-SLAB_MARGIN - oy) / dy : len;
  let t0 = Math.max(0, Math.min(tTop, tBottom));
  let t1 = Math.min(len, Math.max(tTop, tBottom));
  if (!(t1 > t0)) { t0 = 0; t1 = len; }

  const step = (t1 - t0) / MARCH_STEPS;
  let prevT = t0;
  let prevGap = oy + dy * t0 - elevation(field, ox + dx * t0, oz + dz * t0);

  for (let i = 1; i <= MARCH_STEPS; i++) {
    const t = t0 + step * i;
    const gap = oy + dy * t - elevation(field, ox + dx * t, oz + dz * t);
    if (prevGap > 0 && gap <= 0) {
      // Crossing found. Bisect it: each iteration halves the interval, so 14 of them take a
      // ~10-unit march step below 0.001 — far inside F-03's ±0.5 budget, at negligible cost.
      let lo = prevT, hi = t;
      for (let b = 0; b < BISECT_STEPS; b++) {
        const mid = (lo + hi) * 0.5;
        const g = oy + dy * mid - elevation(field, ox + dx * mid, oz + dz * mid);
        if (g > 0) lo = mid; else hi = mid;
      }
      const tHit = (lo + hi) * 0.5;
      scratchHit.x = ox + dx * tHit;
      scratchHit.y = oz + dz * tHit;
      scratchHit.hit = true;
      return scratchHit;
    }
    prevT = t;
    prevGap = gap;
  }

  // No crossing: the ray went over the map (looking at the sky). Fall back to the zero plane so a
  // click still produces a coordinate — clamped by the caller — rather than swallowing the order.
  if (dy < -1e-6) {
    const t = -oy / dy;
    scratchHit.x = ox + dx * t;
    scratchHit.y = oz + dz * t;
    scratchHit.hit = false;
    return scratchHit;
  }
  scratchHit.hit = false;
  return scratchHit;
}

function unproject(inv: Float32Array, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const w = inv[3]! * x + inv[7]! * y + inv[11]! * z + inv[15]!;
  const iw = w === 0 ? 1 : 1 / w;
  out.x = (inv[0]! * x + inv[4]! * y + inv[8]! * z + inv[12]!) * iw;
  out.y = (inv[1]! * x + inv[5]! * y + inv[9]! * z + inv[13]!) * iw;
  out.z = (inv[2]! * x + inv[6]! * y + inv[10]! * z + inv[14]!) * iw;
}

/** World point → screen pixel. The overlay path and the box-select test both need it. */
export function projectToScreen(
  camera: CameraState,
  x: number, height: number, y: number,
  out: { x: number; y: number; behind: boolean },
): void {
  const m = camera.viewProj;
  const cx = m[0]! * x + m[4]! * height + m[8]! * y + m[12]!;
  const cy = m[1]! * x + m[5]! * height + m[9]! * y + m[13]!;
  const cw = m[3]! * x + m[7]! * height + m[11]! * y + m[15]!;
  out.behind = cw <= 0;
  const iw = cw === 0 ? 1 : 1 / cw;
  out.x = ((cx * iw) * 0.5 + 0.5) * camera.viewportWidth;
  out.y = (0.5 - (cy * iw) * 0.5) * camera.viewportHeight;
}
