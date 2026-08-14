// The minimap (P1-T17).
//
// The one part of the 3D client that is deliberately, unapologetically 2D. A minimap is an
// information display, and information displays rarely improve in 3D (the same argument Q-03 will
// have to settle for the starmap). Top-down, north-up, always the same orientation regardless of
// camera yaw — a minimap that rotated with the camera would be worse at its only job.
//
// The coordinate conversion is the part worth testing: click-to-move-camera and the camera's own
// viewport rectangle both go through it, so a round-trip error shows up as "clicking the minimap
// puts me slightly off" — small enough to live with and annoying forever.

import { FLAG_BUILDING_KIND, FOG_UNEXPLORED, FOG_VISIBLE, type Snapshot } from "../bridge/snapshot.js";
import { OWNER_CSS } from "../view/renderer/overlays2d.js";
import { type CameraState } from "../view/renderer/port.js";
import { projectToScreen } from "../input/picking.js";

export interface MinimapGeometry {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
}

/** Minimap pixel → world coordinate. */
export function minimapToWorld(g: MinimapGeometry, px: number, py: number): { x: number; y: number } {
  return {
    x: (px / g.pixelWidth) * g.worldWidth,
    y: (py / g.pixelHeight) * g.worldHeight,
  };
}

/** World coordinate → minimap pixel. The exact inverse of `minimapToWorld`. */
export function worldToMinimap(g: MinimapGeometry, x: number, y: number): { px: number; py: number } {
  return {
    px: (x / g.worldWidth) * g.pixelWidth,
    py: (y / g.worldHeight) * g.pixelHeight,
  };
}

export class MinimapView {
  private readonly ctx: CanvasRenderingContext2D;
  private fogVersion = -1;
  private readonly fogCanvas: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, private readonly geometry: MinimapGeometry) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("minimap needs a 2D context");
    this.ctx = ctx;
    canvas.width = geometry.pixelWidth;
    canvas.height = geometry.pixelHeight;

    // The fog layer is redrawn only when the fog actually changes (once a tick at most), then
    // blitted. Repainting a thousand cells at 60 fps would cost more than the 3D scene.
    this.fogCanvas = document.createElement("canvas");
    const fogCtx = this.fogCanvas.getContext("2d");
    if (!fogCtx) throw new Error("minimap needs a 2D context");
    this.fogCtx = fogCtx;
  }

  draw(snap: Snapshot, camera: CameraState): void {
    const { pixelWidth: w, pixelHeight: h } = this.geometry;
    const ctx = this.ctx;

    if (snap.fog.version !== this.fogVersion) {
      this.fogVersion = snap.fog.version;
      this.repaintFog(snap);
    }

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#05060b";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.fogCanvas, 0, 0, w, h);

    const e = snap.entities;
    for (let i = 0; i < e.count; i++) {
      const { px, py } = worldToMinimap(this.geometry, e.x[i]!, e.y[i]!);
      const isBuilding = (e.flags[i]! & FLAG_BUILDING_KIND) !== 0;
      ctx.fillStyle = OWNER_CSS[e.owner[i]!] ?? OWNER_CSS[2]!;
      // Buildings are squares and units are dots: shape, not colour alone, distinguishes them (N-05).
      const size = isBuilding ? 3 : 2;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    }

    ctx.fillStyle = "#c8b48a";
    for (let i = 0; i < snap.nodes.count; i++) {
      const { px, py } = worldToMinimap(this.geometry, snap.nodes.x[i]!, snap.nodes.y[i]!);
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }

    this.drawViewport(camera);
  }

  /**
   * The camera's footprint, drawn by unprojecting the four screen corners onto the ground plane.
   * Deriving it rather than approximating it from distance keeps the box honest at every pitch.
   */
  private drawViewport(camera: CameraState): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const corners: Array<[number, number]> = [[0, 0], [camera.viewportWidth, 0], [camera.viewportWidth, camera.viewportHeight], [0, camera.viewportHeight]];
    for (let i = 0; i < corners.length; i++) {
      const world = groundUnderPixel(camera, corners[i]![0], corners[i]![1]);
      const { px, py } = worldToMinimap(this.geometry, world.x, world.y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  private repaintFog(snap: Snapshot): void {
    const { cols, rows, state } = snap.fog;
    this.fogCanvas.width = cols;
    this.fogCanvas.height = rows;
    const image = this.fogCtx.createImageData(cols, rows);
    for (let i = 0; i < state.length; i++) {
      const v = state[i]!;
      const shade = v === FOG_VISIBLE ? 74 : v === FOG_UNEXPLORED ? 8 : 34;
      image.data[i * 4] = shade;
      image.data[i * 4 + 1] = shade + 4;
      image.data[i * 4 + 2] = shade + 10;
      image.data[i * 4 + 3] = 255;
    }
    this.fogCtx.putImageData(image, 0, 0);
  }
}

const projected = { x: 0, y: 0, behind: false };

/**
 * Where a screen pixel meets the zero plane. The minimap's viewport box is allowed this
 * approximation — unlike order placement, which marches the real heightfield (`pickGround`) —
 * because being a few units out on a rectangle nobody clicks costs nothing, and marching four
 * rays every frame costs real time.
 */
function groundUnderPixel(camera: CameraState, px: number, py: number): { x: number; y: number } {
  // Solve by iterating the projection: start at the camera target and walk toward the pixel.
  let x = camera.targetX;
  let y = camera.targetY;
  for (let i = 0; i < 12; i++) {
    projectToScreen(camera, x, 0, y, projected);
    const errX = px - projected.x;
    const errY = py - projected.y;
    if (Math.abs(errX) < 0.5 && Math.abs(errY) < 0.5) break;
    // Numerical Jacobian, one probe per axis. Cheap, and it converges in a handful of steps at
    // any pitch we allow.
    const step = 8;
    projectToScreen(camera, x + step, 0, y, projected);
    const dxdx = projected.x, dydx = projected.y;
    projectToScreen(camera, x, 0, y + step, projected);
    const dxdy = projected.x, dydy = projected.y;
    projectToScreen(camera, x, 0, y, projected);
    const a = (dxdx - projected.x) / step, b = (dxdy - projected.x) / step;
    const c = (dydx - projected.y) / step, d = (dydy - projected.y) / step;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) break;
    x += (d * errX - b * errY) / det;
    y += (-c * errX + a * errY) / det;
  }
  return { x, y };
}
