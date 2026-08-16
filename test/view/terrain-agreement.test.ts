// PT-10 — the ground a player sees is the ground entities stand on.
//
// Reported as *"there is some display problem with high grounds. object seem to enter the high
// ground then reappear."* It is not a shader bug and not a z-fighting bug: it is two different
// answers to "how high is the ground here".
//
//   • `SceneComposer` places every entity, tracer, blast and impact at `elevation(field, x, y)` —
//     a smooth ramped curve.
//   • `buildTerrainMesh` samples that same curve on a lattice and draws FLAT TRIANGLES between the
//     samples.
//
// The two agree exactly at the samples and nowhere else. Between them the chord cuts across the
// curve, so the drawn ground is above the true curve in some places and below it in others — and a
// unit walking a slope sinks into the hillside and pops back out, which is the report.
//
// Measured on Helix before the fix: **3.909 units of burial** at the worst point, against a
// smallest unit radius of 6. The whole ridge is only 18 units tall.
//
// This file is deliberately about the AGREEMENT and not about a subdivision number. The number is
// how the agreement is currently bought and it may change; the property is what must not regress.

import { describe, expect, it } from "vitest";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { type ElevationField, elevation, elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { UNITS, activeState, createGalaxy } from "../../src/engine/index.js";

const SEED = 20260814;

/**
 * Helix, and the choice is load-bearing.
 *
 * `ferros` — this suite's usual fixture — carries **no high ground at all** (`PLANET_MODIFIERS`
 * gives terrain features only to the later worlds, and the original three deliberately have none).
 * The first draft of this measurement ran on it and reported a worst-case error of 0.000 across the
 * entire map, which is a pass that proves nothing. Helix is the MVP's own world and has a
 * 55-cell high-ground ridge down its centreline.
 */
function helix(): ElevationField {
  const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
  return elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
}

/** The smallest thing that stands on the ground, which is what sets "how much burial shows". */
const SMALLEST_RADIUS = Math.min(...Object.values(UNITS).map((u) => (u as { radius: number }).radius));

/**
 * The height the RASTERISER draws at a world point: the two triangles of the quad the point falls
 * in, interpolated exactly as a GPU would. Not `elevation()` — the difference is the whole test.
 */
function drawnSurface(field: ElevationField, subdivision: number) {
  const step = field.cell / subdivision;
  const cols = Math.ceil(field.width / step);
  const rows = Math.ceil(field.height / step);
  const vertsX = cols + 1;
  const mesh = buildTerrainMesh(field, { relief: true, apron: 0, subdivision });
  const vh = (vx: number, vy: number): number =>
    mesh.positions[(Math.min(vy, rows) * vertsX + Math.min(vx, cols)) * 3 + 1]!;

  return (x: number, y: number): number => {
    const fx = x / step;
    const fy = y / step;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const tx = fx - cx;
    const ty = fy - cy;
    const h00 = vh(cx, cy);
    const h10 = vh(cx + 1, cy);
    const h01 = vh(cx, cy + 1);
    const h11 = vh(cx + 1, cy + 1);
    return tx + ty <= 1
      ? h00 + (h10 - h00) * tx + (h01 - h00) * ty
      : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - ty);
  };
}

/** Worst gap in each direction across the whole map, sampled off-lattice on purpose. */
function worstGap(field: ElevationField, subdivision: number) {
  const surface = drawnSurface(field, subdivision);
  let buried = 0;
  let floating = 0;
  // 2.3 is coprime-ish with the 10/20-unit steps, so samples land BETWEEN vertices — which is the
  // only place the two functions can disagree. A stride that divided the step evenly would sample
  // exactly where they agree by construction and report a perfect zero.
  for (let y = 1; y < field.height - 1; y += 2.3) {
    for (let x = 1; x < field.width - 1; x += 2.3) {
      const gap = surface(x, y) - elevation(field, x, y);
      if (gap > buried) buried = gap;
      if (-gap > floating) floating = -gap;
    }
  }
  return { buried, floating };
}

describe("the drawn ground agrees with where things stand (PT-10)", () => {
  it("has high ground to measure, or it measures nothing", () => {
    // The vacuity guard, first, because the first draft of this file failed exactly here without
    // saying so: it ran on a flat world and reported a perfect score.
    const field = helix();
    const high = [...field.type].filter((t) => t === 2).length;
    expect(high, "the fixture world has no high ground, so any error measured on it is 0 by "
      + "construction and this whole file is a green light for nothing").toBeGreaterThan(20);
  });

  it("never buries a unit by a visible fraction of itself, at the tier that draws relief", () => {
    const field = helix();
    const { buried, floating } = worstGap(field, TIERS.T3.terrainSubdivision);

    // Burial is the half a player notices: the ground is drawn ABOVE where the unit stands, so it
    // sinks in. Held to a sixth of the smallest unit's radius — at SUBDIVISION 2 this was 3.909,
    // which is 65% of a worker.
    expect(buried, `the drawn ground sits ${buried.toFixed(2)} units above where entities stand; a `
      + `${SMALLEST_RADIUS}-radius worker is ${Math.round((buried / SMALLEST_RADIUS) * 100)}% swallowed`)
      .toBeLessThan(SMALLEST_RADIUS / 6);

    // Floating is the other direction and is looser on purpose: a unit a little above the ground
    // reads as a unit on the ground, while a unit inside it reads as a bug.
    expect(floating, "entities hover above the drawn ground").toBeLessThan(SMALLEST_RADIUS / 4);
  });

  it("is better at every relief tier than the setting that produced the report", () => {
    // The property, stated against the thing that was actually wrong rather than against a
    // constant: whatever subdivision a relief tier picks, it must beat SUBDIVISION 2's 3.909.
    const field = helix();
    const shipped = worstGap(field, 2).buried;
    expect(shipped, "SUBDIVISION 2 no longer reproduces the reported defect, so this comparison is "
      + "no longer measuring the thing it was written for").toBeGreaterThan(3);

    for (const tier of ["T1", "T2", "T3"] as const) {
      const config = TIERS[tier];
      if (config.terrain !== "relief") continue;
      const { buried } = worstGap(field, config.terrainSubdivision);
      expect(buried, `${tier} draws ground ${buried.toFixed(2)} units above where entities stand, `
        + `which is no better than the ${shipped.toFixed(2)} that was reported`)
        .toBeLessThanOrEqual(shipped);
    }
  });

  it("costs nothing on the flat tier, which has no curve to miss", () => {
    // T0 draws `relief: false`, so every height is 0 and entities stand at 0 too. More samples
    // there would be memory spent on an agreement that is already exact.
    const field = helix();
    const mesh = buildTerrainMesh(field, { relief: false, apron: 0, subdivision: TIERS.T0.terrainSubdivision });
    let maxHeight = 0;
    for (let i = 1; i < mesh.positions.length; i += 3) maxHeight = Math.max(maxHeight, mesh.positions[i]!);
    expect(maxHeight, "the flat tier grew relief").toBe(0);
    expect(TIERS.T0.terrainSubdivision, "the flat tier is paying for samples it cannot use").toBe(1);
  });
});
