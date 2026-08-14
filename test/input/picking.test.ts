// P1-T12 / PRD F-03 — a click resolves to the same world coordinate the sim would use, to within
// ±0.5 world units, at ANY camera angle and over every terrain type.
//
// The test is a round trip, and deliberately so: project a known world point to a pixel, then pick
// that pixel and demand the original point back. A round trip catches the errors a one-way check
// misses — a swapped axis, an off-by-half-a-cell elevation sample, a Y flip that happens to look
// fine dead-on and drifts at an angle.

import { describe, expect, it } from "vitest";
import { CameraRig, MAX_DISTANCE, MIN_DISTANCE, YAW_SNAP_COUNT } from "../../src/input/camera.js";
import { pickGround, projectToScreen } from "../../src/input/picking.js";
import { type ElevationField, elevation } from "../../src/view/terrain/elevation.js";

const CELL = 40;
const COLS = 40;
const ROWS = 25;

/** A world with all three terrain types, laid out so the sample points below straddle every edge. */
function mixedField(): ElevationField {
  const type = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const code = x > 24 && y > 8 && y < 18 ? 2 : x > 8 && x < 14 ? 1 : 0;
      type[y * COLS + x] = code;
    }
  }
  return { cols: COLS, rows: ROWS, cell: CELL, type, width: COLS * CELL, height: ROWS * CELL };
}

const TOLERANCE = 0.5;   // PRD F-03, in world units

describe("ground picking", () => {
  const field = mixedField();
  const limits = { mapWidth: field.width, mapHeight: field.height };
  const screen = { x: 0, y: 0, behind: false };

  it("round-trips within ±0.5 world units across yaw × zoom × terrain", () => {
    const samples: Array<[number, number]> = [
      [200, 500],      // open ground
      [420, 500],      // rough
      [1100, 500],     // high ground, interior
      [1000, 500],     // the cliff edge onto high ground
      [1000, 340],     // a corner of the plateau
      [60, 60],        // near the map corner
    ];

    const worst = { err: 0, at: "" };
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      for (const distance of [MIN_DISTANCE, 200, 420, 700, MAX_DISTANCE]) {
        for (const [wx, wy] of samples) {
          const rig = new CameraRig(limits, field);
          rig.yawIndex = yawIndex;
          rig.distance = distance;
          rig.focusOn(wx, wy);
          const camera = rig.update(1280, 720);

          projectToScreen(camera, wx, elevation(field, wx, wy), wy, screen);
          // Off-screen at this angle is not a picking failure — there is no pixel to click.
          if (screen.behind || screen.x < 0 || screen.y < 0 || screen.x > 1280 || screen.y > 720) continue;

          const hit = pickGround(camera, field, screen.x, screen.y);

          // Skip samples the camera cannot actually see. From a low angle behind a mesa, the
          // pixel showing (1000, 500) is showing the cliff top in FRONT of it — the ray hits that
          // first, and returning it is correct occlusion, not a picking error. A round-trip test
          // that ignores this measures the wrong thing and then gets "fixed" by making picking
          // ignore terrain, which is the actual bug it was meant to catch.
          const eyeToHit = Math.hypot(hit.x - camera.eyeX, hit.y - camera.eyeZ);
          const eyeToSample = Math.hypot(wx - camera.eyeX, wy - camera.eyeZ);
          if (eyeToHit < eyeToSample - 1) continue;

          const err = Math.hypot(hit.x - wx, hit.y - wy);
          if (err > worst.err) { worst.err = err; worst.at = `yaw=${yawIndex} d=${distance} (${wx},${wy})`; }
        }
      }
    }
    expect(worst.err, `worst picking error ${worst.err.toFixed(3)} world units at ${worst.at} — F-03 allows ${TOLERANCE}`)
      .toBeLessThanOrEqual(TOLERANCE);
  });

  it("lands on the surface and back on the same pixel, for every pixel on screen", () => {
    // The complement of the test above: it sweeps the whole viewport, including the pixels showing
    // a cliff face, and asserts the two properties that hold everywhere — the picked point IS on
    // the terrain, and projecting it back lands on the pixel we picked. Together these pin the
    // unprojection and the elevation sample against each other with no visibility caveat.
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex += 2) {
      for (const distance of [MIN_DISTANCE, 300, MAX_DISTANCE]) {
        const rig = new CameraRig(limits, field);
        rig.yawIndex = yawIndex;
        rig.distance = distance;
        rig.focusOn(1000, 500);
        const camera = rig.update(1280, 720);

        for (let py = 120; py <= 700; py += 145) {
          for (let px = 60; px <= 1220; px += 145) {
            const hit = pickGround(camera, field, px, py);
            if (!hit.hit) continue;                 // the pixel shows sky, not ground
            projectToScreen(camera, hit.x, elevation(field, hit.x, hit.y), hit.y, screen);
            expect(Math.hypot(screen.x - px, screen.y - py),
              `pixel (${px},${py}) at yaw=${yawIndex} d=${distance} round-tripped to (${screen.x.toFixed(1)},${screen.y.toFixed(1)})`)
              .toBeLessThan(1);
          }
        }
      }
    }
  });

  it("picks the top of a mesa, not the ground behind it", () => {
    // The failure this guards: a plane intersection at height 0 puts the click somewhere past the
    // cliff, so ordering a unit onto high ground walks it off the far side.
    const rig = new CameraRig(limits, field);
    rig.yawIndex = 0;
    rig.distance = 420;
    rig.focusOn(1100, 500);
    const camera = rig.update(1280, 720);

    const wx = 1100, wy = 500;
    projectToScreen(camera, wx, elevation(field, wx, wy), wy, screen);
    const hit = pickGround(camera, field, screen.x, screen.y);
    expect(hit.hit).toBe(true);
    expect(elevation(field, hit.x, hit.y)).toBeGreaterThan(10);
  });

  it("still returns a coordinate when the ray misses the ground", () => {
    // Clicking the sky must not swallow the order silently; it falls back to the zero plane and
    // the caller clamps. `hit` reports the difference so a caller that cares can tell.
    const rig = new CameraRig(limits, field);
    rig.distance = MIN_DISTANCE;
    const camera = rig.update(1280, 720);
    const result = pickGround(camera, field, 640, 0);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
  });

  it("allocates nothing per pick", () => {
    const rig = new CameraRig(limits, field);
    const camera = rig.update(1280, 720);
    const first = pickGround(camera, field, 400, 400);
    const second = pickGround(camera, field, 500, 300);
    // Same object back: a mousemove handler running at 60 Hz cannot allocate (ADR-0006).
    expect(second).toBe(first);
  });
});
