// The terrain as one merged static mesh (ADR-0006, P1-T05).
//
// The terrain never changes during a match — it is stamped from fixed fractional specs at map
// generation and read-only from then on. So it is built once, uploaded once, and drawn as a single
// draw call for the rest of the session. `version` exists purely so the renderer can prove it
// re-uploaded once and not 600 times; the rebuild-count test asserts exactly that.
//
// Two vertices per grid cell corner, coloured by the terrain code beneath. No texture, no
// lightmap: colour carries the information (open / rough / high ground) and the vertex-level
// brightness variation does the rest. On a software rasteriser a textured ground plane is the
// single most expensive thing on screen, and it tells the player nothing a flat colour does not.
//
// At T0 the mesh collapses to a flat plane with the same colours (ADR-0004's sanctioned fallback):
// the same information, none of the vertices, and no silhouette against the sky to overdraw.

import { type ElevationField, elevation } from "./elevation.js";
import { type TerrainMesh } from "../renderer/port.js";

/** Colour per terrain code. Chosen to stay distinguishable in the colour-blind-safe palette (N-05). */
const TERRAIN_COLOR: readonly (readonly [number, number, number])[] = [
  [0.24, 0.27, 0.33],   // open — cold neutral, so units of either colour pop against it
  [0.33, 0.28, 0.22],   // rough — warm brown, unmistakably "not open"
  [0.30, 0.36, 0.42],   // high ground — lighter and bluer, reads as raised even head-on
];

/** Subdivisions per terrain cell. 1 = one quad per 40-unit cell; 2 softens the ramps. */
export const SUBDIVISION = 2;

let nextVersion = 1;

export interface TerrainBuildOptions {
  /** `flat` is the T0 variant: same colours, zero relief, minimum vertices. */
  readonly relief: boolean;
  /** How far the dark border extends past the map edge, in world units. 0 disables it. */
  readonly apron: number;
}

/**
 * The border beyond the playable area.
 *
 * Without it the terrain mesh simply stops at the map bounds and everything past that edge is the
 * clear colour — which at the MVP's camera angles is a hard black wedge across a third of the
 * screen, and reads as "the page did not load" rather than as the edge of a map. Eight quads in
 * the same mesh, so it costs one extra sliver of the terrain's single draw call.
 *
 * Deliberately not a bigger heightfield: the apron is flat, unlit and nearly black, because its
 * whole job is to be ignorable. It should say "the world continues and you cannot go there", not
 * invite the eye out of the play area.
 */
const APRON_COLOR: readonly [number, number, number] = [0.055, 0.062, 0.078];

/**
 * Build the merged mesh. Called once per world load — never per frame, never per tier switch
 * unless the tier actually changes the `relief` flag.
 */
export function buildTerrainMesh(field: ElevationField, opts: TerrainBuildOptions): TerrainMesh {
  const step = field.cell / SUBDIVISION;
  const cols = Math.ceil(field.width / step);
  const rows = Math.ceil(field.height / step);
  const vertsX = cols + 1;
  const vertsY = rows + 1;
  const vertexCount = vertsX * vertsY;

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(cols * rows * 6);

  for (let vy = 0; vy < vertsY; vy++) {
    for (let vx = 0; vx < vertsX; vx++) {
      const i = vy * vertsX + vx;
      const wx = Math.min(vx * step, field.width);
      const wy = Math.min(vy * step, field.height);
      positions[i * 3] = wx;
      positions[i * 3 + 1] = opts.relief ? elevation(field, wx, wy) : 0;
      positions[i * 3 + 2] = wy;

      const code = codeAtWorld(field, wx, wy);
      const c = TERRAIN_COLOR[code] ?? TERRAIN_COLOR[0]!;
      // A faint deterministic dither, keyed on the grid position. Without it a 1600×1000 flat
      // plane at T0 reads as a solid rectangle and the player loses all sense of scale and motion.
      // Keyed on position, not a PRNG, so the terrain is byte-identical on every machine.
      const n = 0.94 + 0.06 * (((vx * 7 + vy * 13) % 5) / 4);
      colors[i * 3] = c[0] * n;
      colors[i * 3 + 1] = c[1] * n;
      colors[i * 3 + 2] = c[2] * n;
    }
  }

  let t = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const a = cy * vertsX + cx;
      const b = a + 1;
      const c = a + vertsX;
      const d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }

  const base = { positions, colors, indices, triangles: cols * rows * 2 };
  const withApron = opts.apron > 0 ? appendApron(base, field, opts.apron) : base;

  return {
    positions: withApron.positions,
    colors: withApron.colors,
    indices: withApron.indices,
    triangles: withApron.triangles,
    version: nextVersion++,
    width: field.width,
    height: field.height,
  };
}

interface RawMesh {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  triangles: number;
}

/** A picture-frame of 8 quads around the map, at ground level, in `APRON_COLOR`. */
function appendApron(base: RawMesh, field: ElevationField, apron: number): RawMesh {
  const x0 = -apron, x1 = 0, x2 = field.width, x3 = field.width + apron;
  const z0 = -apron, z1 = 0, z2 = field.height, z3 = field.height + apron;
  const quads: Array<[number, number, number, number]> = [
    [x0, z0, x3, z1],   // top strip, full width
    [x0, z2, x3, z3],   // bottom strip, full width
    [x0, z1, x1, z2],   // left strip, between them
    [x2, z1, x3, z2],   // right strip
  ];

  const vertexCount = base.positions.length / 3;
  const positions = new Float32Array(base.positions.length + quads.length * 4 * 3);
  const colors = new Float32Array(base.colors.length + quads.length * 4 * 3);
  const indices = new Uint32Array(base.indices.length + quads.length * 6);
  positions.set(base.positions);
  colors.set(base.colors);
  indices.set(base.indices);

  let v = vertexCount;
  let t = base.indices.length;
  for (const [qx0, qz0, qx1, qz1] of quads) {
    const corners: Array<[number, number]> = [[qx0, qz0], [qx1, qz0], [qx1, qz1], [qx0, qz1]];
    for (const [cx, cz] of corners) {
      positions[v * 3] = cx;
      // A whisker below zero so it can never z-fight with the terrain's own edge vertices.
      positions[v * 3 + 1] = -0.5;
      positions[v * 3 + 2] = cz;
      colors[v * 3] = APRON_COLOR[0];
      colors[v * 3 + 1] = APRON_COLOR[1];
      colors[v * 3 + 2] = APRON_COLOR[2];
      v++;
    }
    const a = v - 4;
    indices[t++] = a; indices[t++] = a + 2; indices[t++] = a + 1;
    indices[t++] = a; indices[t++] = a + 3; indices[t++] = a + 2;
  }

  return { positions, colors, indices, triangles: base.triangles + quads.length * 2 };
}

function codeAtWorld(field: ElevationField, x: number, y: number): number {
  const cx = Math.min(field.cols - 1, Math.max(0, Math.floor(x / field.cell)));
  const cy = Math.min(field.rows - 1, Math.max(0, Math.floor(y / field.cell)));
  return field.type[cy * field.cols + cx]!;
}

/**
 * Vertex budget for the merged mesh at the MVP map size.
 *
 * 1600×1000 at 40-unit cells subdivided ×2 is 80×50 quads ⇒ ~8k triangles for the entire ground.
 * That is one draw call and a rounding error next to 200 instanced units, which is the whole
 * argument for merging it (ADR-0006).
 */
export function expectedTriangles(field: ElevationField, apron = 0): number {
  const step = field.cell / SUBDIVISION;
  const grid = Math.ceil(field.width / step) * Math.ceil(field.height / step) * 2;
  return grid + (apron > 0 ? 8 : 0);
}
