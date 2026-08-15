// P3-T10, the drawn half.
//
// `bomb-overlay.test.ts` proves the numbers reach the renderer; nothing there looks at what is
// actually stroked. The Canvas2D drawing path normally only runs under the browser conformance
// suite, which is on the deferred table for this phase — so the two claims that live purely in
// geometry are asserted here against a recording context instead:
//
//   • TWO rings, not one. A single circle at the blast radius promises a kill at the rim that the
//     falloff does not deliver; a single one at the core hides most of the threat.
//   • The countdown is an ARC of the ring, proportional to the time left, so "how long have I got"
//     survives a still frame. A pulse or a colour ramp would carry it only to someone watching at
//     that instant.
//
// The context is a stub because a real one is a browser API, and what is being asserted is the
// sequence of path commands, which is exactly what a stub can record faithfully.

import { describe, expect, it } from "vitest";
import { drawOverlayLayer } from "../../src/view/renderer/overlays2d.js";
import { OVERLAY_STRIDE, type CameraState, type OverlayLayer } from "../../src/view/renderer/port.js";
import { CameraRig } from "../../src/input/camera.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { activeState, createGalaxy } from "../../src/engine/index.js";

/** One closed run of `moveTo` + `lineTo`s, as the ring/arc helper emits it. */
interface Path { points: Array<{ x: number; y: number }>; width: number; dashed: boolean }

/** Records the path commands `drawOverlayLayer` issues. Only the calls that path uses. */
function recordingCtx() {
  const paths: Path[] = [];
  let current: Path | null = null;
  const state = { width: 1, dashed: false };
  const ctx = {
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    save() {},
    restore() {},
    scale() {},
    setLineDash(pattern: number[]) { state.dashed = pattern.length > 0; },
    beginPath() { current = { points: [], width: ctx.lineWidth, dashed: state.dashed }; },
    moveTo(x: number, y: number) { current?.points.push({ x, y }); },
    lineTo(x: number, y: number) { current?.points.push({ x, y }); },
    arc() {},
    fill() {},
    fillRect() {},
    stroke() {
      if (!current || current.points.length < 2) return;
      current.width = ctx.lineWidth;
      current.dashed = state.dashed;
      paths.push(current);
      current = null;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, paths };
}

function camera(): CameraState {
  const state = activeState(createGalaxy({ seed: 20260814, startId: "helix" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(state.map.bases.player.x, state.map.bases.player.y);
  return rig.update(1280, 720);
}

/** One `bomb` row, at the camera's focus so nothing is behind the near plane. */
function layerFor(cam: CameraState, lit: number, fuse01: number): OverlayLayer {
  const stride = OVERLAY_STRIDE.bomb;
  const data = new Float32Array(stride);
  data[0] = cam.targetX;
  data[1] = 1;
  data[2] = cam.targetY;
  data[3] = 15;      // core
  data[4] = 190;     // blast
  data[5] = lit;
  data[6] = fuse01;
  data[7] = 0;
  return { kind: "bomb", count: 1, stride, data };
}

/** Longest chord of a path, which for a projected ring is its screen diameter. */
function span(p: Path): number {
  let max = 0;
  for (const a of p.points) {
    for (const b of p.points) max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return max;
}

describe("the bomb overlay as drawn (P3-T10)", () => {
  it("strokes two rings of different size, the inner solid and the outer dashed", () => {
    const cam = camera();
    const { ctx, paths } = recordingCtx();
    drawOverlayLayer(ctx, cam, layerFor(cam, 0, 0), 1);

    expect(paths.length, "an unlit armed bomb should stroke exactly two rings").toBe(2);
    const [outer, inner] = paths;
    expect(span(outer!), "the two rings came out the same size — one radius reached the drawing")
      .toBeGreaterThan(span(inner!) * 2);
    expect(outer!.dashed, "the outer ring is solid, so it reads as a hard edge the blast does not have")
      .toBe(true);
    expect(inner!.dashed, "the inner ring is dashed, so certain death reads as a maybe").toBe(false);
    expect(inner!.width, "the inner ring is not the heavier of the two").toBeGreaterThan(outer!.width);
  });

  it("adds an arc only once the fuse is lit", () => {
    const cam = camera();
    const unlit = recordingCtx();
    drawOverlayLayer(unlit.ctx, cam, layerFor(cam, 0, 0), 1);
    const lit = recordingCtx();
    drawOverlayLayer(lit.ctx, cam, layerFor(cam, 1, 0.5), 1);

    expect(unlit.paths.length).toBe(2);
    expect(lit.paths.length, "a burning fuse drew nothing a quiet one does not").toBe(3);
  });

  it("sweeps the arc in proportion to the fuse, from nothing to the whole ring", () => {
    // The claim that makes the countdown readable in a still frame. Vertex count is the honest
    // measure here: the arc shares `drawGroundArc` with the full ring, so a fraction that was
    // ignored would produce an arc with exactly as many points as the ring itself.
    const cam = camera();
    const arcAt = (fuse01: number): Path => {
      const { ctx, paths } = recordingCtx();
      drawOverlayLayer(ctx, cam, layerFor(cam, 1, fuse01), 1);
      return paths[2]!;                                   // outer ring, inner ring, then the arc
    };

    const fresh = arcAt(0.01);
    const half = arcAt(0.5);
    const spent = arcAt(1);
    const ring = (() => {
      const { ctx, paths } = recordingCtx();
      drawOverlayLayer(ctx, cam, layerFor(cam, 1, 1), 1);
      return paths[0]!;
    })();

    expect(fresh.points.length, "a fresh fuse already drew half the ring")
      .toBeLessThan(half.points.length);
    expect(half.points.length, "a half-spent fuse drew as much as a spent one")
      .toBeLessThan(spent.points.length);
    expect(spent.points.length, "a spent fuse did not close the ring").toBe(ring.points.length);
    // Proportional, not merely monotonic: half the fuse is half the ring, ±one segment.
    expect(Math.abs(half.points.length - ring.points.length / 2)).toBeLessThanOrEqual(1);
  });

  it("leaves the full ring unchanged now that it shares the arc helper", () => {
    // `drawGroundEllipse` became `drawGroundArc(..., 1)` in this task, and the sweep starts at
    // twelve o'clock where the old ring started at three. For a 16-gon that is a rotation by
    // exactly four vertices, so the SHAPE is identical — but selection rings, build ghosts and
    // guard auras all go through this helper, and "identical" is worth checking rather than
    // reasoning about.
    const cam = camera();
    const { ctx, paths } = recordingCtx();
    const stride = OVERLAY_STRIDE.selection;
    const data = new Float32Array(stride);
    data[0] = cam.targetX;
    data[1] = 1;
    data[2] = cam.targetY;
    data[3] = 20;
    drawOverlayLayer(ctx, cam, { kind: "selection", count: 1, stride, data }, 1);

    const ring = paths[0]!;
    expect(ring.points.length, "the ring lost or gained segments").toBe(17);
    const first = ring.points[0]!;
    const last = ring.points[ring.points.length - 1]!;
    expect(Math.hypot(first.x - last.x, first.y - last.y), "the ring no longer closes")
      .toBeLessThan(1e-6);
  });
});
