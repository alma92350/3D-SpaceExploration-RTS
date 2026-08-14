// The no-WebGL product path (ADR-0005, P1-T19/T22).
//
// Locked-down enterprise builds, some VDI stacks and a few headless environments disable WebGL
// outright. Persona P2 lives on exactly those machines, so "sorry, your browser is unsupported" is
// not a fallback — it is the product failing for the person it was designed for. This renderer is
// feature-reduced and honestly slower, but it is *playable*, and it draws the same world.
//
// It shares the camera matrix with the WebGL implementation, so it is a genuine 3D projection
// rather than a different game: meshes are projected vertex by vertex and filled as flat polygons,
// painter-sorted back to front. What it gives up is per-fragment anything — no fog texture (the
// fog is drawn as flat quads over the ground grid instead), no depth buffer (hence the sort), and
// a coarser terrain.
//
// The conformance suite runs against this implementation unchanged. That is the point: if a future
// change makes the WebGL path draw something this one cannot, the suite says so on the PR.

import {
  type CameraState, type FogField, type PowerField, type FrameStats, type InstanceBatch, type MeshData,
  type OverlayLayer, type Renderer, type TerrainMesh, type Tier,
} from "./port.js";
import { OWNER_CSS, drawOverlayLayer } from "./overlays2d.js";

/**
 * The four `POWER_TIERS` bands, on-grid to isolated.
 *
 * Green through amber, matching the WebGL shader's ramp: the amber end is where a consumer draws
 * 2.3× the grid capacity for the same job, so it reads as a warning rather than as decoration.
 */
const POWER_BAND_CSS = ["#2c6f43", "#4a7a3a", "#7a7231", "#8a5a25"] as const;
import { projectToScreen } from "../../input/picking.js";

interface Face {
  depth: number;
  points: number[];
  color: string;
}

export class Canvas2DRenderer implements Renderer {
  readonly name = "canvas2d";

  private readonly ctx: CanvasRenderingContext2D;
  private readonly meshes = new Map<string, MeshData>();
  private readonly faces: Face[] = [];
  private faceCount = 0;

  private fog: FogField | null = null;
  private fogVersion = -1;
  private power: PowerField | null = null;
  private powerVersion = -1;
  private showPower = false;
  private terrainVersion = -1;
  private camera: CameraState | null = null;
  private width = 1280;
  private height = 720;
  private dpr = 1;
  private frameStart = 0;

  private readonly stats: FrameStats = {
    drawCalls: 0, instances: 0, triangles: 0, overlayItems: 0,
    terrainUploads: 0, fogUploads: 0, powerUploads: 0, cpuMs: 0,
  };

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas2D context creation failed — no renderer is available");
    this.ctx = ctx;
  }

  registerMeshes(meshes: readonly MeshData[]): void {
    for (const m of meshes) this.meshes.set(m.id, m);
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.ctx.canvas.width = Math.round(width * dpr);
    this.ctx.canvas.height = Math.round(height * dpr);
  }

  setTier(_tier: Tier): void {
    // Tiers are a WebGL story: this renderer has no shadows, no antialias knob and no render
    // scale to trade. It draws the one way it can draw, which is why it is only ever chosen at T0.
  }

  setFog(fog: FogField): void {
    if (fog.version === this.fogVersion) return;
    this.fogVersion = fog.version;
    this.fog = fog;
    this.stats.fogUploads++;
  }

  setPower(power: PowerField | null): void {
    // `power` is the field to *show*; null hides it. The version guard still applies, so toggling
    // does not re-upload, and the reference is kept so toggling back on is free.
    if (power === null) { this.showPower = false; return; }
    this.showPower = true;
    if (power.version === this.powerVersion) return;
    this.powerVersion = power.version;
    this.power = power;
    this.stats.powerUploads++;
  }

  beginFrame(camera: CameraState): void {
    this.frameStart = now();
    this.camera = camera;
    this.faceCount = 0;
    this.stats.drawCalls = 0;
    this.stats.instances = 0;
    this.stats.triangles = 0;
    this.stats.overlayItems = 0;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = "#05060b";
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  drawTerrain(terrain: TerrainMesh): void {
    if (terrain.version !== this.terrainVersion) {
      this.terrainVersion = terrain.version;
      this.stats.terrainUploads++;
    }
    // Accounting happens BEFORE the early returns below. The terrain is one draw call whether or
    // not a fog field has arrived yet, and the very first frame of a session runs before the first
    // `setFog` — a renderer that reports zero draw calls on that frame makes the perf numbers and
    // the conformance suite disagree about what a frame is.
    this.stats.drawCalls++;
    this.stats.triangles += terrain.triangles;

    const camera = this.camera;
    if (!camera) return;

    // The ground is drawn as fog-grid cells, not as the merged mesh: at this cell size that is a
    // few hundred quads instead of thousands of triangles, and it lets the fog be a per-cell fill
    // rather than a texture we have no way to sample. Same information, a fraction of the work —
    // which is the whole compromise this renderer represents.
    const fog = this.fog;
    if (!fog) {
      // No fog yet: paint the whole map as explored-but-not-visible. A black screen on the first
      // frame reads as a hang, and this is one flat quad.
      this.fillGroundQuad(camera, 0, 0, terrain.width, terrain.height, "#14171d");
      return;
    }
    const cell = fog.cell;
    for (let cy = 0; cy < fog.rows; cy++) {
      for (let cx = 0; cx < fog.cols; cx++) {
        const vis = fog.state[cy * fog.cols + cx]!;
        const x0 = cx * cell;
        const y0 = cy * cell;
        projectToScreen(camera, x0, 0, y0, P0);
        if (P0.behind) continue;
        projectToScreen(camera, x0 + cell, 0, y0, P1);
        projectToScreen(camera, x0 + cell, 0, y0 + cell, P2);
        projectToScreen(camera, x0, 0, y0 + cell, P3);
        if (!onScreen(P0, this.width, this.height) && !onScreen(P2, this.width, this.height)) continue;

        // Unexplored is drawn, not skipped — dark enough to hide everything, light enough that the
        // world exists. Same reasoning as the WebGL path's fog ramp; see the comment there.
        //
        // The power overlay tints the same cell rather than adding a second pass: this renderer is
        // the T0 fallback, and a second pass over every ground cell is the one cost it cannot take.
        // Same four bands, same green-to-amber ramp as the shader, so switching renderers does not
        // change what the grid looks like.
        const band = this.showPower && this.power ? this.power.state[cy * this.power.cols + cx]! : 0;
        this.ctx.fillStyle = band > 0
          ? POWER_BAND_CSS[band - 1]!
          : vis === 2 ? "#2a2f3a" : vis === 1 ? "#14171d" : "#0b0d12";
        this.ctx.beginPath();
        this.ctx.moveTo(P0.x, P0.y);
        this.ctx.lineTo(P1.x, P1.y);
        this.ctx.lineTo(P2.x, P2.y);
        this.ctx.lineTo(P3.x, P3.y);
        this.ctx.closePath();
        this.ctx.fill();
      }
    }
  }

  private fillGroundQuad(
    camera: CameraState, x0: number, y0: number, x1: number, y1: number, fill: string,
  ): void {
    projectToScreen(camera, x0, 0, y0, P0);
    projectToScreen(camera, x1, 0, y0, P1);
    projectToScreen(camera, x1, 0, y1, P2);
    projectToScreen(camera, x0, 0, y1, P3);
    if (P0.behind && P1.behind && P2.behind && P3.behind) return;
    this.ctx.fillStyle = fill;
    this.ctx.beginPath();
    this.ctx.moveTo(P0.x, P0.y);
    this.ctx.lineTo(P1.x, P1.y);
    this.ctx.lineTo(P2.x, P2.y);
    this.ctx.lineTo(P3.x, P3.y);
    this.ctx.closePath();
    this.ctx.fill();
  }

  drawInstances(batch: InstanceBatch): void {
    const camera = this.camera;
    const mesh = this.meshes.get(batch.mesh);
    if (!camera || !mesh) return;

    const tint = hexToRgb(OWNER_CSS[batch.owner] ?? OWNER_CSS[2]!);
    for (let i = 0; i < batch.count; i++) {
      const ox = batch.xyz[i * 3]!;
      const oy = batch.xyz[i * 3 + 1]!;
      const oz = batch.xyz[i * 3 + 2]!;
      const yaw = batch.yaw[i]!;
      const scale = batch.scale[i]!;
      const shade = batch.shade[i]!;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);

      for (let t = 0; t < mesh.indices.length; t += 3) {
        let depth = 0;
        let visible = false;
        for (let v = 0; v < 3; v++) {
          const vi = mesh.indices[t + v]!;
          const vx = mesh.positions[vi * 3]! * scale;
          const vy = mesh.positions[vi * 3 + 1]! * scale;
          const vz = mesh.positions[vi * 3 + 2]! * scale;
          const wx = ox + vx * cos + vz * sin;
          const wz = oz - vx * sin + vz * cos;
          projectToScreen(camera, wx, oy + vy, wz, PV);
          if (!PV.behind) visible = true;
          SCRATCH_POINTS[v * 2] = PV.x;
          SCRATCH_POINTS[v * 2 + 1] = PV.y;
          depth += Math.hypot(wx - camera.eyeX, oy + vy - camera.eyeY, wz - camera.eyeZ);
        }
        if (!visible) continue;

        const c0 = mesh.indices[t]!;
        const mix = mesh.ownerMix[c0]!;
        const r = lerp(mesh.colors[c0 * 3]!, tint.r, mix) * shade;
        const g = lerp(mesh.colors[c0 * 3 + 1]!, tint.g, mix) * shade;
        const b = lerp(mesh.colors[c0 * 3 + 2]!, tint.b, mix) * shade;
        this.pushFace(depth / 3, r, g, b);
      }
      this.stats.instances++;
      this.stats.triangles += mesh.triangles;
    }
    this.stats.drawCalls++;
  }

  drawOverlay(layer: OverlayLayer): void {
    if (!this.camera || layer.count === 0) return;
    this.flushFaces();
    drawOverlayLayer(this.ctx, this.camera, layer, this.dpr);
    this.stats.drawCalls++;
    this.stats.overlayItems += layer.count;
  }

  endFrame(): FrameStats {
    this.flushFaces();
    this.stats.cpuMs = now() - this.frameStart;
    return this.stats;
  }

  dispose(): void {
    this.faces.length = 0;
    this.meshes.clear();
  }

  private pushFace(depth: number, r: number, g: number, b: number): void {
    let face = this.faces[this.faceCount];
    if (!face) {
      // Faces are pooled and reused; only a match that grows past its previous peak allocates.
      face = { depth: 0, points: [0, 0, 0, 0, 0, 0], color: "" };
      this.faces.push(face);
    }
    face.depth = depth;
    for (let i = 0; i < 6; i++) face.points[i] = SCRATCH_POINTS[i]!;
    face.color = rgbCss(r, g, b);
    this.faceCount++;
  }

  /**
   * Painter's algorithm. There is no depth buffer in Canvas2D, so the only way to get occlusion
   * right is to sort — back to front, by centroid distance. It is O(n log n) per frame and it is
   * the single biggest cost in this renderer, which is exactly why it is the fallback and not the
   * default.
   */
  private flushFaces(): void {
    if (this.faceCount === 0) return;
    const live = this.faces.slice(0, this.faceCount);
    live.sort((a, b) => b.depth - a.depth);
    const ctx = this.ctx;
    for (const face of live) {
      ctx.fillStyle = face.color;
      ctx.beginPath();
      ctx.moveTo(face.points[0]!, face.points[1]!);
      ctx.lineTo(face.points[2]!, face.points[3]!);
      ctx.lineTo(face.points[4]!, face.points[5]!);
      ctx.closePath();
      ctx.fill();
    }
    this.faceCount = 0;
  }
}

const P0 = { x: 0, y: 0, behind: false };
const P1 = { x: 0, y: 0, behind: false };
const P2 = { x: 0, y: 0, behind: false };
const P3 = { x: 0, y: 0, behind: false };
const PV = { x: 0, y: 0, behind: false };
const SCRATCH_POINTS = new Float64Array(6);

function onScreen(p: { x: number; y: number }, w: number, h: number): boolean {
  return p.x >= -80 && p.y >= -80 && p.x <= w + 80 && p.y <= h + 80;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(css: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(css.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function rgbCss(r: number, g: number, b: number): string {
  return `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
}

function clamp255(v: number): number {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
