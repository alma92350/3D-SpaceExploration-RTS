// Render interpolation between sim ticks (ADR-0008, P1-T03).
//
// The sim moves entities 20 times a second; the display draws 30–60 times a second. Without this,
// units visibly step. With it they glide, and the whole game reads as smooth even at T0's 30 fps.
//
// Two edge cases are the entire difficulty, and both are cheap to get wrong in a way that looks
// like a rendering bug:
//
//   • **A unit that spawned this tick** has no previous position. Interpolating from a zeroed
//     buffer flies it in from the map origin — the classic "units teleport from the corner".
//   • **A unit that died this tick** must not linger for the remaining alpha. It is already gone
//     from the snapshot, so this module simply never sees it; the note is here because the
//     obvious "keep drawing it until alpha hits 1" fix is wrong and someone will propose it.
//
// Pure math over the snapshot's arrays, writing into caller-owned scratch. No allocation.

import { type Snapshot } from "../bridge/snapshot.js";

/**
 * Blend `prev` → `current` into `outX`/`outY`.
 *
 * @param alpha  in [0, 1) from the loop. Values outside are clamped rather than extrapolated:
 *               extrapolation overshoots a unit past the wall it just stopped at.
 */
export function interpolatePositions(
  snap: Snapshot,
  alpha: number,
  outX: Float32Array,
  outY: Float32Array,
): number {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const e = snap.entities;
  const n = Math.min(e.count, outX.length, outY.length);
  for (let i = 0; i < n; i++) {
    const id = e.ids[i]!;
    if (snap.spawned.has(id)) {
      // Born this tick: it has no history, so it stands where it was born until the next tick
      // gives it one. Sliding it in from `prevX` (which is its own current position anyway, but
      // would be a stale slot's if the tables ever reordered) is the bug this branch exists for.
      outX[i] = e.x[i]!;
      outY[i] = e.y[i]!;
      continue;
    }
    const px = e.prevX[i]!;
    const py = e.prevY[i]!;
    outX[i] = px + (e.x[i]! - px) * a;
    outY[i] = py + (e.y[i]! - py) * a;
  }
  return n;
}

/**
 * The distance an entity travelled last tick, used for LOD and for the movement flag.
 * Kept here so the "how far did it move" question has one answer.
 */
export function tickDisplacement(snap: Snapshot, i: number): number {
  const e = snap.entities;
  const dx = e.x[i]! - e.prevX[i]!;
  const dy = e.y[i]! - e.prevY[i]!;
  return Math.hypot(dx, dy);
}
