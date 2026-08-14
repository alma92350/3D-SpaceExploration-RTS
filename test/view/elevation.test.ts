// P1-T04 — elevation is a pure, deterministic function of the sim's terrain grid (ADR-0004).

import { describe, expect, it } from "vitest";
import {
  BLEND_WIDTH, type ElevationField, TERRAIN_HEIGHT, codeAt, elevation, elevationFieldFrom, slopeAt,
} from "../../src/view/terrain/elevation.js";
import { TERRAIN_CELL_SIZE, activeState, createGalaxy } from "../../src/engine/index.js";

const CELL = 40;

/** A hand-built field so each test states its own terrain rather than hunting for it on a map. */
function field(rows: number[][]): ElevationField {
  const cols = rows[0]!.length;
  const type = new Uint8Array(cols * rows.length);
  rows.forEach((row, y) => row.forEach((v, x) => { type[y * cols + x] = v; }));
  return { cols, rows: rows.length, cell: CELL, type, width: cols * CELL, height: rows.length * CELL };
}

const centre = (c: number) => c * CELL + CELL / 2;

describe("elevation", () => {
  it("returns each terrain code's own height at a cell centre", () => {
    // A flat plateau top is the whole point: units standing on high ground must be level with
    // each other, or the mesa reads as a dome.
    const f = field([[0, 1, 2]]);
    expect(elevation(f, centre(0), centre(0))).toBeCloseTo(TERRAIN_HEIGHT[0]!, 6);
    expect(elevation(f, centre(1), centre(0))).toBeCloseTo(TERRAIN_HEIGHT[1]!, 6);
    expect(elevation(f, centre(2), centre(0))).toBeCloseTo(TERRAIN_HEIGHT[2]!, 6);
  });

  it("keeps the interior of a plateau flat, not domed", () => {
    const f = field([
      [2, 2, 2],
      [2, 2, 2],
      [2, 2, 2],
    ]);
    const h = elevation(f, centre(1), centre(1));
    for (const dx of [-10, 0, 10]) {
      for (const dy of [-10, 0, 10]) {
        expect(elevation(f, centre(1) + dx, centre(1) + dy)).toBeCloseTo(h, 6);
      }
    }
  });

  it("ramps across a cell boundary instead of stepping", () => {
    const f = field([[0, 2]]);
    const boundary = CELL;                       // the shared edge of cell 0 and cell 1
    const mid = elevation(f, boundary, centre(0));
    expect(mid).toBeGreaterThan(TERRAIN_HEIGHT[0]!);
    expect(mid).toBeLessThan(TERRAIN_HEIGHT[2]!);
    // The ramp is narrow enough that a cliff still reads as a cliff (ADR-0004's readability line).
    const rampHalfWidth = (CELL * BLEND_WIDTH) / 2;
    expect(elevation(f, boundary - rampHalfWidth - 1, centre(0))).toBeCloseTo(TERRAIN_HEIGHT[0]!, 6);
    expect(elevation(f, boundary + rampHalfWidth + 1, centre(0))).toBeCloseTo(TERRAIN_HEIGHT[2]!, 6);
  });

  it("is monotonic across a rise — no dips on the way up", () => {
    const f = field([[0, 0, 2, 2]]);
    let last = -Infinity;
    for (let x = 0; x <= 4 * CELL; x += 2) {
      const h = elevation(f, x, centre(0));
      expect(h).toBeGreaterThanOrEqual(last - 1e-9);
      last = h;
    }
  });

  it("extends the border outward instead of falling off the map", () => {
    // A camera panned to the edge, or a ray that overshoots, must not read NaN or a hole.
    const f = field([[2, 2], [2, 2]]);
    for (const [x, y] of [[-500, -500], [-1, centre(0)], [10_000, 10_000], [centre(0), -80]]) {
      const h = elevation(f, x!, y!);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeCloseTo(TERRAIN_HEIGHT[2]!, 6);
    }
  });

  it("is deterministic — the same point always reads the same height", () => {
    const f = field([[0, 1, 2], [2, 0, 1], [1, 2, 0]]);
    for (let i = 0; i < 200; i++) {
      const x = (i * 37) % (3 * CELL);
      const y = (i * 53) % (3 * CELL);
      expect(elevation(f, x, y)).toBe(elevation(f, x, y));
    }
  });

  it("clamps cell lookups at the grid edge", () => {
    const f = field([[0, 2]]);
    expect(codeAt(f, -5, 0)).toBe(0);
    expect(codeAt(f, 99, 0)).toBe(2);
    expect(codeAt(f, 0, -3)).toBe(0);
  });

  it("reports zero slope on flat ground and non-zero on a cliff edge", () => {
    const f = field([[0, 0, 2, 2]]);
    expect(slopeAt(f, centre(0), centre(0))).toBeCloseTo(0, 6);
    expect(slopeAt(f, 2 * CELL, centre(0))).toBeGreaterThan(0);
  });

  it("reads a real generated world's terrain grid without special-casing", () => {
    const state = activeState(createGalaxy({ seed: 20260814, startId: "ferros" }));
    const f = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
    expect(f.cell).toBe(TERRAIN_CELL_SIZE);
    for (let i = 0; i < 500; i++) {
      const x = (i * 7919) % state.map.width;
      const y = (i * 104_729) % state.map.height;
      const h = elevation(f, x, y);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(TERRAIN_HEIGHT[2]!);
    }
  });
});
