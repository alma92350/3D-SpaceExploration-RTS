// The RTS camera rig (P1-T10, PRD F-05) — pure math, no DOM, no three.js.
//
// Everything about this camera is chosen for READABILITY over expressiveness (PRD §4.3, risk R2):
//
//   • **Yaw snaps to 8 compass directions** (Q-01, decided in ADR-0010). A free orbit costs the
//     player their sense of where north is on a map whose two bases are always east and west, and
//     it costs the renderer the ability to pre-sort instances by facing. Snapped, a rotation is a
//     deliberate act with a known destination.
//   • **Pitch ramps with zoom.** Zoomed out you are nearly top-down, which is the angle that reads
//     a battlefield; zoomed in you tilt toward the horizon, which is the angle that shows a mesh.
//     One control, and the player never has to think about pitch at all.
//   • **The target is clamped to map bounds**, not the eye. Clamping the eye lets the *look-at*
//     point leave the map, and then the world slides off screen at the corners.
//
// The output is a view-projection matrix, which both renderers consume and picking inverts. That
// shared matrix is what makes "where the player clicked" mean one thing across implementations.

import { type ElevationField, elevation } from "../view/terrain/elevation.js";
import { type CameraState } from "../view/renderer/port.js";

export const YAW_SNAP_COUNT = 8;
export const YAW_STEP = (Math.PI * 2) / YAW_SNAP_COUNT;

export const MIN_DISTANCE = 90;
export const MAX_DISTANCE = 900;

/** Nearly top-down when far out; a third of the way to the horizon when close in. */
export const PITCH_FAR = 1.30;    // radians from horizontal — 74°, almost overhead
export const PITCH_NEAR = 0.62;   // 36°, low enough to see a silhouette

const FOV_Y = 0.9;
const NEAR_PLANE = 1;
const FAR_PLANE = 4000;

/** Never let the eye get closer than this to the ground it is flying over (PRD F-05). */
export const TERRAIN_CLEARANCE = 12;

export interface CameraLimits {
  readonly mapWidth: number;
  readonly mapHeight: number;
}

export class CameraRig {
  targetX: number;
  targetY: number;
  distance = 420;
  /** Snap index 0..7; 0 looks "north" (down −Y in sim space). */
  yawIndex = 0;

  private readonly viewProj = new Float32Array(16);
  private readonly view = new Float32Array(16);
  private readonly proj = new Float32Array(16);
  private readonly state: {
    viewProj: Float32Array; eyeX: number; eyeY: number; eyeZ: number;
    targetX: number; targetY: number; yaw: number; pitch: number; distance: number;
    viewportWidth: number; viewportHeight: number;
  };

  constructor(private readonly limits: CameraLimits, private field: ElevationField | null = null) {
    this.targetX = limits.mapWidth / 2;
    this.targetY = limits.mapHeight / 2;
    this.state = {
      viewProj: this.viewProj, eyeX: 0, eyeY: 0, eyeZ: 0,
      targetX: this.targetX, targetY: this.targetY,
      yaw: 0, pitch: PITCH_FAR, distance: this.distance,
      viewportWidth: 1280, viewportHeight: 720,
    };
  }

  setElevationField(field: ElevationField): void {
    this.field = field;
  }

  get yaw(): number {
    return this.yawIndex * YAW_STEP;
  }

  /** Pitch is a pure function of zoom — see the class comment. */
  get pitch(): number {
    const t = (this.distance - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * clamped;
  }

  /**
   * Pan in SCREEN space — the player pushes the world, not the axes.
   * Screen-relative panning is why yaw can rotate at all without the controls becoming a puzzle.
   */
  pan(screenDx: number, screenDy: number): void {
    const yaw = this.yaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    this.targetX += screenDx * cos - screenDy * sin;
    this.targetY += screenDx * sin + screenDy * cos;
    this.clampTarget();
  }

  /** Positive zooms out. Multiplicative so a wheel notch feels the same at every distance. */
  zoom(notches: number): void {
    this.distance = clamp(this.distance * Math.pow(1.15, notches), MIN_DISTANCE, MAX_DISTANCE);
  }

  rotate(steps: number): void {
    this.yawIndex = (((this.yawIndex + steps) % YAW_SNAP_COUNT) + YAW_SNAP_COUNT) % YAW_SNAP_COUNT;
  }

  focusOn(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.clampTarget();
  }

  private clampTarget(): void {
    this.targetX = clamp(this.targetX, 0, this.limits.mapWidth);
    this.targetY = clamp(this.targetY, 0, this.limits.mapHeight);
  }

  /** Where the eye sits, given target, yaw, pitch and distance — and never inside a hill. */
  eyePosition(out: { x: number; y: number; z: number }): void {
    const pitch = this.pitch;
    const yaw = this.yaw;
    const horizontal = Math.cos(pitch) * this.distance;
    const groundHeight = this.field ? elevation(this.field, this.targetX, this.targetY) : 0;
    out.x = this.targetX - Math.sin(yaw) * horizontal;
    out.z = this.targetY - Math.cos(yaw) * horizontal;
    out.y = groundHeight + Math.sin(pitch) * this.distance;

    if (this.field) {
      // The eye can fly over a mesa on its way to a target in a valley. Lifting it to clear the
      // ground *under the eye* (not under the target) is what stops the camera clipping through
      // terrain — the second half of F-05, and the half that is easy to forget.
      const under = elevation(this.field, out.x, out.z);
      const floor = under + TERRAIN_CLEARANCE;
      if (out.y < floor) out.y = floor;
    }
  }

  /** Recompute the matrices and return the immutable-ish state both renderers read. */
  update(viewportWidth: number, viewportHeight: number): CameraState {
    const eye = SCRATCH_EYE;
    this.eyePosition(eye);
    const targetHeight = this.field ? elevation(this.field, this.targetX, this.targetY) : 0;

    lookAt(this.view, eye.x, eye.y, eye.z, this.targetX, targetHeight, this.targetY);
    perspective(this.proj, FOV_Y, viewportWidth / Math.max(1, viewportHeight), NEAR_PLANE, FAR_PLANE);
    multiply(this.viewProj, this.proj, this.view);

    const s = this.state;
    s.eyeX = eye.x;
    s.eyeY = eye.y;
    s.eyeZ = eye.z;
    s.targetX = this.targetX;
    s.targetY = this.targetY;
    s.yaw = this.yaw;
    s.pitch = this.pitch;
    s.distance = this.distance;
    s.viewportWidth = viewportWidth;
    s.viewportHeight = viewportHeight;
    return s;
  }
}

const SCRATCH_EYE = { x: 0, y: 0, z: 0 };

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Matrix math. Column-major, three.js/WebGL convention, all in-place.
// Written out rather than imported from three so `input/` and the Canvas2D path
// stay free of the 3D library (ADR-0005: view/ talks to a port, not to three).
// ---------------------------------------------------------------------------

export function perspective(out: Float32Array, fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function lookAt(
  out: Float32Array,
  ex: number, ey: number, ez: number,
  tx: number, ty: number, tz: number,
): Float32Array {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  // World up is +Y. When the camera looks straight down these are parallel and the cross product
  // collapses; the pitch ramp never reaches 90°, so it cannot happen — but a nudge keeps a future
  // "top-down mode" from producing NaNs instead of a picture.
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(zy) > 0.9999) { ux = 0; uy = 0; uz = 1; }

  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

export function multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!, b1 = b[c * 4 + 1]!, b2 = b[c * 4 + 2]!, b3 = b[c * 4 + 3]!;
    out[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    out[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    out[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    out[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return out;
}

export function invert(out: Float32Array, m: Float32Array): Float32Array | null {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}
