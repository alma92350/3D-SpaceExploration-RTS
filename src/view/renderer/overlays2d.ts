// Overlay drawing, shared by both product renderers (ADR-0005 §4, P1-T15).
//
// Selection rings, health bars, veterancy chevrons, rally lines and the build ghost's footprint
// are what the player READS. So they are drawn the same way in both implementations — as 2D
// shapes projected through the camera's own matrix onto a canvas over the scene — rather than as
// world geometry in one and something else in the other.
//
// Drawing them in 2D is a deliberate quality choice as much as a budget one: a health bar drawn as
// a world quad shrinks with distance, tilts with pitch, and becomes unreadable at exactly the
// moment a player most wants it. Projected 2D keeps a constant pixel size and a crisp edge, and it
// costs a handful of `fillRect`s instead of transparent geometry — which at T0 is fill rate we do
// not have.

import { type CameraState, type OverlayLayer } from "./port.js";
import { projectToScreen } from "../../input/picking.js";

/**
 * Owner colours, colour-blind-safe against each other and against the terrain palette (N-05).
 * Blue/orange rather than the usual blue/red: red-green confusion is the common case, and orange
 * separates from blue on every axis including luminance.
 */
export const OWNER_COLORS: readonly number[] = [0x4fd1ff, 0xff9d4f, 0x9aa3b2];
export const OWNER_CSS: readonly string[] = ["#4fd1ff", "#ff9d4f", "#9aa3b2"];

const projected = { x: 0, y: 0, behind: false };

/** Draw one packed overlay layer. `dpr` scales to device pixels; the canvas is sized in them. */
export function drawOverlayLayer(
  ctx: CanvasRenderingContext2D,
  camera: CameraState,
  layer: OverlayLayer,
  dpr: number,
): void {
  const d = layer.data;
  ctx.save();
  ctx.scale(dpr, dpr);

  switch (layer.kind) {
    case "selection": {
      ctx.strokeStyle = "#7dffb0";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < layer.count; i++) {
        const off = i * layer.stride;
        drawGroundEllipse(ctx, camera, d[off]!, d[off + 1]!, d[off + 2]!, d[off + 3]!);
      }
      break;
    }

    case "healthbar": {
      for (let i = 0; i < layer.count; i++) {
        const off = i * layer.stride;
        projectToScreen(camera, d[off]!, d[off + 1]!, d[off + 2]!, projected);
        if (projected.behind) continue;
        const frac = d[off + 3]!;
        const owner = d[off + 4]! | 0;
        const w = 22;
        const x = projected.x - w / 2;
        const y = projected.y;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(x - 1, y - 1, w + 2, 5);
        // Health bars carry the owner colour too, so "who is hurt" reads without clicking. Colour
        // is never the ONLY cue (N-05): the bar's position over the unit already identifies it.
        ctx.fillStyle = frac > 0.5 ? OWNER_CSS[owner]! : frac > 0.25 ? "#f5c451" : "#ff5c5c";
        ctx.fillRect(x, y, w * frac, 3);
      }
      break;
    }

    case "chevron": {
      ctx.strokeStyle = "#ffe9a8";
      ctx.lineWidth = 1.4;
      for (let i = 0; i < layer.count; i++) {
        const off = i * layer.stride;
        projectToScreen(camera, d[off]!, d[off + 1]!, d[off + 2]!, projected);
        if (projected.behind) continue;
        const rank = d[off + 3]! | 0;
        for (let r = 0; r < rank; r++) {
          const y = projected.y - r * 3.2;
          ctx.beginPath();
          ctx.moveTo(projected.x - 4, y);
          ctx.lineTo(projected.x, y - 2.6);
          ctx.lineTo(projected.x + 4, y);
          ctx.stroke();
        }
      }
      break;
    }

    case "rally": {
      ctx.strokeStyle = "rgba(125,255,176,0.55)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      for (let i = 0; i < layer.count; i++) {
        const off = i * layer.stride;
        projectToScreen(camera, d[off]!, d[off + 1]!, d[off + 2]!, projected);
        if (projected.behind) continue;
        const sx = projected.x, sy = projected.y;
        projectToScreen(camera, d[off + 3]!, d[off + 4]!, d[off + 5]!, projected);
        if (projected.behind) continue;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(projected.x, projected.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      break;
    }

    case "ghost": {
      for (let i = 0; i < layer.count; i++) {
        const off = i * layer.stride;
        const valid = d[off + 4]! > 0.5;
        // Validity is shape AND colour, never colour alone (N-05): a valid footprint is a solid
        // ring, an invalid one is dashed and crossed.
        ctx.strokeStyle = valid ? "#7dffb0" : "#ff5c5c";
        ctx.lineWidth = 2;
        ctx.setLineDash(valid ? [] : [6, 5]);
        drawGroundEllipse(ctx, camera, d[off]!, d[off + 1]!, d[off + 2]!, d[off + 3]!);
        if (!valid) {
          projectToScreen(camera, d[off]!, d[off + 1]!, d[off + 2]!, projected);
          const r = 7;
          ctx.beginPath();
          ctx.moveTo(projected.x - r, projected.y - r);
          ctx.lineTo(projected.x + r, projected.y + r);
          ctx.moveTo(projected.x + r, projected.y - r);
          ctx.lineTo(projected.x - r, projected.y + r);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        const reach = d[off + 5]!;
        if (reach > 0) {
          ctx.strokeStyle = "rgba(125,255,176,0.25)";
          ctx.lineWidth = 1;
          drawGroundEllipse(ctx, camera, d[off]!, d[off + 1]!, d[off + 2]!, reach);
        }
      }
      break;
    }

    case "waypoint": {
      ctx.fillStyle = "#7dffb0";
      for (let i = 0; i < layer.count; i++) {
        const off = i * layer.stride;
        projectToScreen(camera, d[off]!, d[off + 1]!, d[off + 2]!, projected);
        if (projected.behind) continue;
        ctx.beginPath();
        ctx.arc(projected.x, projected.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }

  ctx.restore();
}

/**
 * A ground-plane circle, projected. Drawn as a polygon rather than `ctx.ellipse` because the
 * projected shape is only an ellipse when the ground is flat and the camera is centred — on a
 * slope or near the screen edge it genuinely is not, and an ellipse there sits visibly off the
 * unit it belongs to.
 */
function drawGroundEllipse(
  ctx: CanvasRenderingContext2D, camera: CameraState,
  x: number, height: number, z: number, radius: number,
): void {
  const SEGMENTS = 16;
  ctx.beginPath();
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    projectToScreen(camera, x + Math.cos(a) * radius, height, z + Math.sin(a) * radius, projected);
    if (projected.behind) return;
    if (i === 0) ctx.moveTo(projected.x, projected.y);
    else ctx.lineTo(projected.x, projected.y);
  }
  ctx.stroke();
}
