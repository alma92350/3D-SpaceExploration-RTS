// Elevation: the whole third dimension, derived from the sim's own terrain grid (ADR-0004, P1-T04).
//
// This is the single source of visual height. The terrain mesh, unit placement, the build ghost,
// camera collision and ray→ground picking all call `elevation()` — because the moment two of them
// compute height differently, a click lands somewhere the unit does not go, and PRD F-03's
// ±0.5-unit promise is quietly false.
//
// The sim's grid is three flat values on 40-unit cells (open / rough / high ground). Drawn
// literally, that is a Lego world of hard steps. So sampling is **bilinear across cell centres**:
// each cell contributes its own base height, and points between centres blend. That turns a step
// into a short ramp about one cell wide, which reads as a slope without inventing geography the
// sim does not have — exactly the line ADR-0004 draws.
//
// Properties this must keep, all covered by tests:
//   • Pure and deterministic. Same (x, y) ⇒ same height, forever, on every machine.
//   • Exactly the cell's own base height at a cell centre — so a mesa's top is flat and level.
//   • Defined and finite outside the map, so a camera or a stray ray never reads NaN.

/** Base height per terrain code, in world units. Open ground is the zero plane. */
export const TERRAIN_HEIGHT: readonly number[] = [0, 3, 18];

/**
 * How wide the blend between neighbouring cells is, as a fraction of a cell.
 *
 * 1.0 (full bilinear) makes high ground a smooth hill and loses the cliff that makes a mesa read as
 * a strong point. 0 restores hard steps. 0.55 keeps the top plateau visibly flat while giving the
 * edge a short, readable ramp — chosen by eye at the MVP camera pitch and worth revisiting only
 * with a readability test in hand (R2).
 */
export const BLEND_WIDTH = 0.55;

export interface ElevationField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly type: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export function elevationFieldFrom(terrain: TerrainGrid, width: number, height: number): ElevationField {
  return { cols: terrain.cols, rows: terrain.rows, cell: terrain.cell, type: terrain.type, width, height };
}

/** The terrain code at a cell, clamped at the edges so out-of-bounds extends the border. */
export function codeAt(field: ElevationField, cx: number, cy: number): number {
  const x = cx < 0 ? 0 : cx >= field.cols ? field.cols - 1 : cx;
  const y = cy < 0 ? 0 : cy >= field.rows ? field.rows - 1 : cy;
  return field.type[y * field.cols + x]!;
}

function baseHeight(field: ElevationField, cx: number, cy: number): number {
  return TERRAIN_HEIGHT[codeAt(field, cx, cy)] ?? 0;
}

/**
 * Visual height at a world point. The only elevation function in the project.
 *
 * @param x sim world X
 * @param y sim world Y (the ground plane's second axis — NOT scene-space Y, which is height)
 */
export function elevation(field: ElevationField, x: number, y: number): number {
  const cell = field.cell;
  // Cell centres, not cell corners: a cell's own height must be exact at its centre, which is what
  // keeps a plateau flat. Offsetting by half a cell puts the sample lattice on the centres.
  const fx = x / cell - 0.5;
  const fy = y / cell - 0.5;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);

  const tx = ramp(fx - cx);
  const ty = ramp(fy - cy);

  const h00 = baseHeight(field, cx, cy);
  const h10 = baseHeight(field, cx + 1, cy);
  const h01 = baseHeight(field, cx, cy + 1);
  const h11 = baseHeight(field, cx + 1, cy + 1);

  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Squash a 0..1 interpolant into a narrower band centred on the cell boundary.
 *
 * With BLEND_WIDTH = 1 this is the identity (full bilinear). Below 1 the middle stays a straight
 * ramp but the ends flatten, so the region near each cell centre reads at that cell's own height.
 */
function ramp(t: number): number {
  if (BLEND_WIDTH >= 1) return t;
  const half = BLEND_WIDTH / 2;
  const lo = 0.5 - half;
  const hi = 0.5 + half;
  if (t <= lo) return 0;
  if (t >= hi) return 1;
  return (t - lo) / BLEND_WIDTH;
}

/**
 * Slope magnitude, for the camera's terrain clearance and for shading the terrain mesh.
 * Central differences over half a cell — cheap, and it never needs to be exact.
 */
export function slopeAt(field: ElevationField, x: number, y: number): number {
  const d = field.cell * 0.5;
  const dx = elevation(field, x + d, y) - elevation(field, x - d, y);
  const dy = elevation(field, x, y + d) - elevation(field, x, y - d);
  return Math.hypot(dx, dy) / (2 * d);
}
