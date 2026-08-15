// P1-T10 / PRD F-05 — the camera never leaves the map and never clips through terrain.

import { describe, expect, it } from "vitest";
import {
  CameraRig, MAX_DISTANCE, MIN_DISTANCE, PITCH_FAR, PITCH_NEAR, TERRAIN_CLEARANCE, YAW_SNAP_COUNT, YAW_STEP,
} from "../../src/input/camera.js";
import { type ElevationField, elevation } from "../../src/view/terrain/elevation.js";
import { pickGround } from "../../src/input/picking.js";

const CELL = 40;

function fieldWith(rows: number[][]): ElevationField {
  const cols = rows[0]!.length;
  const type = new Uint8Array(cols * rows.length);
  rows.forEach((row, y) => row.forEach((v, x) => { type[y * cols + x] = v; }));
  return { cols, rows: rows.length, cell: CELL, type, width: cols * CELL, height: rows.length * CELL };
}

const flat = fieldWith(Array.from({ length: 25 }, () => new Array(40).fill(0)));
const limits = { mapWidth: flat.width, mapHeight: flat.height };

describe("CameraRig", () => {
  it("clamps the look-at point to the map at every yaw and zoom", () => {
    // Clamping the EYE instead would let the look-at point leave the map, and then the world
    // slides off screen at the corners — the bug this test exists to prevent.
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      for (const distance of [MIN_DISTANCE, 400, MAX_DISTANCE]) {
        const rig = new CameraRig(limits, flat);
        rig.yawIndex = yawIndex;
        rig.distance = distance;
        for (let i = 0; i < 60; i++) rig.pan(500, 500);
        expect(rig.targetX).toBeLessThanOrEqual(limits.mapWidth);
        expect(rig.targetY).toBeLessThanOrEqual(limits.mapHeight);
        for (let i = 0; i < 120; i++) rig.pan(-500, -500);
        expect(rig.targetX).toBeGreaterThanOrEqual(0);
        expect(rig.targetY).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("snaps yaw to eight compass directions and wraps both ways (Q-01)", () => {
    const rig = new CameraRig(limits, flat);
    expect(rig.yaw).toBe(0);
    rig.rotate(1);
    expect(rig.yaw).toBeCloseTo(YAW_STEP, 9);
    rig.rotate(-2);
    expect(rig.yawIndex).toBe(YAW_SNAP_COUNT - 1);
    rig.rotate(YAW_SNAP_COUNT);
    expect(rig.yawIndex).toBe(YAW_SNAP_COUNT - 1);
  });

  it("ramps pitch with zoom, nearly top-down when far out", () => {
    const rig = new CameraRig(limits, flat);
    rig.distance = MAX_DISTANCE;
    expect(rig.pitch).toBeCloseTo(PITCH_FAR, 6);
    rig.distance = MIN_DISTANCE;
    expect(rig.pitch).toBeCloseTo(PITCH_NEAR, 6);
    // Monotone in between, so a wheel notch never tilts the camera the "wrong" way.
    let previous = -Infinity;
    for (let d = MIN_DISTANCE; d <= MAX_DISTANCE; d += 25) {
      rig.distance = d;
      expect(rig.pitch).toBeGreaterThanOrEqual(previous);
      previous = rig.pitch;
    }
  });

  it("clamps zoom at both ends", () => {
    const rig = new CameraRig(limits, flat);
    for (let i = 0; i < 100; i++) rig.zoom(1);
    expect(rig.distance).toBeCloseTo(MAX_DISTANCE, 6);
    for (let i = 0; i < 200; i++) rig.zoom(-1);
    expect(rig.distance).toBeCloseTo(MIN_DISTANCE, 6);
  });

  it("pans in screen space, so the controls do not change meaning when yaw does", () => {
    const north = new CameraRig(limits, flat);
    north.focusOn(500, 500);
    north.pan(100, 0);
    const movedNorth = { x: north.targetX - 500, y: north.targetY - 500 };

    const turned = new CameraRig(limits, flat);
    turned.focusOn(500, 500);
    turned.yawIndex = 2;                    // a quarter turn
    turned.pan(100, 0);
    const movedTurned = { x: turned.targetX - 500, y: turned.targetY - 500 };

    // Same screen gesture, same distance travelled, a different world direction — which is exactly
    // what "push the world, not the axes" means.
    expect(Math.hypot(movedNorth.x, movedNorth.y)).toBeCloseTo(Math.hypot(movedTurned.x, movedTurned.y), 6);
    expect(movedNorth.x).not.toBeCloseTo(movedTurned.x, 2);
  });

  // **The direction a player would recognise, which nothing asserted for six phases** (PT-01,
  // ADR-0025). The test above is the one that was here, and it is kept because it still says
  // something true — but on its own it is exactly the shape of gate this project keeps catching:
  // it compares a MAGNITUDE and an inequality, so it passed unchanged while pushing right moved the
  // view left at six of the eight snaps. The one other assertion in the repo that pinned a pan sign
  // stated it in SIM coordinates, which is the same mistake wearing a number: sim +X is only
  // "rightward" if you already know which way the camera faces, and that was the broken thing.
  //
  // So this states it the way the complaint arrived — *"to see the left of the map I push the mouse
  // to the RIGHT"* — by asking the renderer's own `pickGround` what is actually under each screen
  // edge, and requiring the view to travel toward the edge the player pushed. Nothing here mentions
  // X or Y, which is the point: it cannot be satisfied by a mirrored basis that happens to add up.
  it("moves the view toward the screen edge the player pushes, at every yaw snap", () => {
    const W = 1280;
    const H = 720;

    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      const rig = new CameraRig(limits, flat);
      rig.yawIndex = yawIndex;
      rig.focusOn(flat.width / 2, flat.height / 2);
      const camera = rig.update(W, H);

      // The screen's own axes, in world units, read off the frame the renderer would draw.
      const ground = (px: number, py: number) => {
        const hit = pickGround(camera, flat, px, py);
        expect(hit.hit, `yaw snap ${yawIndex}: the ground under (${px}, ${py}) could not be read, `
          + "so this snap proves nothing").toBe(true);
        return { x: hit.x, y: hit.y };
      };
      const right = ground(W - 4, H / 2);
      const left = ground(4, H / 2);
      const bottom = ground(W / 2, H - 4);
      const top = ground(W / 2, 4);
      const screenRight = { x: right.x - left.x, y: right.y - left.y };
      const screenDown = { x: bottom.x - top.x, y: bottom.y - top.y };

      for (const [dx, dy, want] of [
        [1, 0, "right"], [-1, 0, "left"], [0, 1, "down"], [0, -1, "up"],
      ] as const) {
        const r = new CameraRig(limits, flat);
        r.yawIndex = yawIndex;
        r.focusOn(flat.width / 2, flat.height / 2);
        const from = { x: r.targetX, y: r.targetY };
        r.pan(dx * 40, dy * 40);
        const moved = { x: r.targetX - from.x, y: r.targetY - from.y };

        // Project the travel onto the screen axes. Positive along `screenRight` means the view went
        // right on screen, whatever that is in sim coordinates at this yaw.
        const alongX = (moved.x * screenRight.x + moved.y * screenRight.y)
          / Math.hypot(screenRight.x, screenRight.y);
        const alongY = (moved.x * screenDown.x + moved.y * screenDown.y)
          / Math.hypot(screenDown.x, screenDown.y);
        const went = Math.abs(alongX) > Math.abs(alongY)
          ? (alongX > 0 ? "right" : "left")
          : (alongY > 0 ? "down" : "up");

        expect(went, `at yaw snap ${yawIndex} a push ${want} moved the view ${went}. The player `
          + "pushes an edge and the world goes the other way, which is PT-01 all over again.")
          .toBe(want);
      }
    }
  });

  it("never lets the eye sink into terrain it is flying over (F-05)", () => {
    // A mesa on one side, a valley on the other: looking into the valley from close in puts the
    // eye directly over the high ground, which is the case a target-height-only clamp misses.
    const mesa = fieldWith([
      [2, 2, 2, 2, 0, 0, 0, 0],
      [2, 2, 2, 2, 0, 0, 0, 0],
      [2, 2, 2, 2, 0, 0, 0, 0],
      [2, 2, 2, 2, 0, 0, 0, 0],
    ]);
    const rig = new CameraRig({ mapWidth: mesa.width, mapHeight: mesa.height }, mesa);
    const eye = { x: 0, y: 0, z: 0 };
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      for (const distance of [MIN_DISTANCE, 150, 300]) {
        for (let tx = 0; tx <= mesa.width; tx += 20) {
          for (let ty = 0; ty <= mesa.height; ty += 20) {
            rig.yawIndex = yawIndex;
            rig.distance = distance;
            rig.focusOn(tx, ty);
            rig.eyePosition(eye);
            const ground = elevation(mesa, eye.x, eye.z);
            expect(eye.y, `eye clipped terrain at yaw=${yawIndex} d=${distance} target=(${tx},${ty})`)
              .toBeGreaterThanOrEqual(ground + TERRAIN_CLEARANCE - 1e-6);
          }
        }
      }
    }
  });

  it("produces a finite view-projection matrix at every angle", () => {
    const rig = new CameraRig(limits, flat);
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      for (const distance of [MIN_DISTANCE, MAX_DISTANCE]) {
        rig.yawIndex = yawIndex;
        rig.distance = distance;
        const state = rig.update(1280, 720);
        for (const v of state.viewProj) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("focus-base centres the target exactly", () => {
    const rig = new CameraRig(limits, flat);
    rig.focusOn(321, 654);
    expect(rig.targetX).toBe(321);
    expect(rig.targetY).toBe(654);
  });

  it("reuses one camera-state object rather than allocating per frame", () => {
    const rig = new CameraRig(limits, flat);
    expect(rig.update(1280, 720)).toBe(rig.update(1280, 720));
  });
});
