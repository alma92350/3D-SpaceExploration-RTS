// The WebGL2 implementation of the `Renderer` port, on three.js (ADR-0005).
//
// Everything here is shaped by the CPU-only budget (ADR-0006), which inverts the usual cost model:
// on a software rasteriser, fragments and draw calls dominate and vertex count barely registers.
// So:
//
//   • **One `InstancedMesh` per (mesh, owner, LOD) key**, created lazily and reused forever. The
//     per-frame work is writing a matrix array and setting `count` — no allocation, no rebind storm.
//   • **`MeshBasicMaterial`, vertex-coloured, no lights.** Lighting is per-fragment work that buys
//     nothing a flat colour does not already say, and a shadow map at T0 would cost more than the
//     whole rest of the frame.
//   • **Fog is one texture sampled by the terrain material**, not a per-entity branch. Entities
//     under fog never reach the renderer at all (the bridge drops them), so the texture only has
//     to darken ground.
//   • **Overlays are drawn into a 2D canvas layered over the GL canvas.** They are text-adjacent
//     UI at heart — crisp lines, exact pixel widths, no perspective distortion — and drawing them
//     as world geometry costs both fill rate and legibility. The one place the two renderer
//     implementations genuinely share code.

import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, DynamicDrawUsage,
  Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, LinearFilter, Mesh, NearestFilter, Object3D,
  PerspectiveCamera, RedFormat, Scene, ShaderMaterial, UnsignedByteType,
  WebGLRenderer as ThreeWebGLRenderer,
} from "three";
import {
  type CameraState, type FogField, type PowerField, type FrameStats, type InstanceBatch, type MeshData,
  type OverlayLayer, type Renderer, type TerrainMesh, type Tier,
} from "./port.js";
import { OWNER_COLORS, drawOverlayLayer } from "./overlays2d.js";
import { TIERS } from "./tiers.js";

export interface WebGLRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  readonly tier: Tier;
}

/** Thrown when the browser refuses a WebGL2 context. The caller falls back to Canvas2D (P1-T22). */
export class WebGLUnavailableError extends Error {}

export class WebGLRenderer implements Renderer {
  readonly name = "webgl2";

  private readonly three: ThreeWebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 16 / 9, 1, 4000);
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly overlayCanvas: HTMLCanvasElement;

  private readonly meshes = new Map<string, MeshData>();
  private readonly instanced = new Map<string, InstancedMesh>();
  private readonly dummy = new Object3D();

  private terrainMesh: Mesh | null = null;
  private terrainVersion = -1;
  private fogTexture: DataTexture | null = null;
  private fogVersion = -1;
  private powerTexture: DataTexture | null = null;
  private powerVersion = -1;
  private showPower = 0;

  private tier: Tier;
  private frameStart = 0;
  private readonly stats: FrameStats = {
    drawCalls: 0, instances: 0, triangles: 0, overlayItems: 0,
    terrainUploads: 0, fogUploads: 0, powerUploads: 0, cpuMs: 0,
  };
  private cssWidth = 1280;
  private cssHeight = 720;
  private dpr = 1;

  constructor(opts: WebGLRendererOptions) {
    this.tier = opts.tier;
    const context = opts.canvas.getContext("webgl2", { antialias: TIERS[opts.tier].antialias, alpha: false });
    if (!context) throw new WebGLUnavailableError("WebGL2 context creation failed");

    this.three = new ThreeWebGLRenderer({
      canvas: opts.canvas,
      context,
      antialias: TIERS[opts.tier].antialias,
      // No stencil, no depth-of-field, no post stack. Every one of these is fill rate at T0.
      stencil: false,
      powerPreference: "high-performance",
    });
    this.three.setClearColor(new Color(0x05060b), 1);
    this.three.autoClear = true;

    this.overlayCanvas = opts.overlayCanvas;
    const ctx = opts.overlayCanvas.getContext("2d");
    if (!ctx) throw new WebGLUnavailableError("2D overlay context creation failed");
    this.overlayCtx = ctx;
  }

  registerMeshes(meshes: readonly MeshData[]): void {
    for (const m of meshes) this.meshes.set(m.id, m);
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    // Render scale is a tier knob: at T0 we shade 44% fewer pixels and upscale (ADR-0006).
    const scale = TIERS[this.tier].renderScale;
    this.three.setPixelRatio(dpr * scale);
    this.three.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.overlayCanvas.width = Math.round(width * dpr);
    this.overlayCanvas.height = Math.round(height * dpr);
  }

  setTier(tier: Tier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    // A tier switch must not lose the session (PRD F-09), so it only touches renderer knobs —
    // never the scene graph, never the meshes, and certainly never the simulation.
    this.resize(this.cssWidth, this.cssHeight, this.dpr);
  }

  setFog(fog: FogField): void {
    if (fog.version === this.fogVersion) return;
    this.fogVersion = fog.version;
    if (!this.fogTexture || this.fogTexture.image.width !== fog.cols || this.fogTexture.image.height !== fog.rows) {
      this.fogTexture?.dispose();
    this.powerTexture?.dispose();
      this.fogTexture = new DataTexture(new Uint8Array(fog.cols * fog.rows), fog.cols, fog.rows, RedFormat, UnsignedByteType);
      this.fogTexture.minFilter = LinearFilter;
      this.fogTexture.magFilter = LinearFilter;
    }
    const data = this.fogTexture.image.data as Uint8Array;
    // Three brightnesses rather than a mask, so the shader stays a single multiply and F-06's
    // three states stay visually distinct.
    //
    // Unexplored is 30, not 0. Pure black was correct and awful: at the start of a match the player
    // has seen ~8% of the map, so ~90% of the screen was a black rectangle that reads as "nothing
    // loaded" rather than as "a world you have not walked yet". 30/255 shows the ground is THERE
    // without showing anything on it — and nothing is on it, because entities under fog never
    // reach the renderer at all (they are dropped at the bridge), so this cannot leak.
    for (let i = 0; i < data.length; i++) data[i] = fog.state[i] === 2 ? 255 : fog.state[i] === 1 ? 96 : 30;
    this.fogTexture.needsUpdate = true;
    this.stats.fogUploads++;
    const material = this.terrainMesh?.material as ShaderMaterial | undefined;
    if (material?.uniforms?.fogMap) material.uniforms.fogMap.value = this.fogTexture;
  }

  setPower(power: PowerField | null): void {
    // The uniform is set every call so a toggle takes effect immediately; the TEXTURE is only
    // rebuilt when the version moves, which is the same contract the fog has and the reason
    // switching the overlay on and off costs nothing.
    this.showPower = power === null ? 0 : 1;
    const material = this.terrainMesh?.material as ShaderMaterial | undefined;
    if (material?.uniforms?.powerOn) material.uniforms.powerOn.value = this.showPower;
    if (power === null || power.version === this.powerVersion) return;
    this.powerVersion = power.version;

    if (!this.powerTexture || this.powerTexture.image.width !== power.cols || this.powerTexture.image.height !== power.rows) {
      this.powerTexture?.dispose();
      this.powerTexture = new DataTexture(new Uint8Array(power.cols * power.rows), power.cols, power.rows, RedFormat, UnsignedByteType);
      // NEAREST, unlike the fog: a band edge is information — it is where the cost multiplier
      // changes — and smoothing it would draw a gradient the engine does not have.
      this.powerTexture.minFilter = NearestFilter;
      this.powerTexture.magFilter = NearestFilter;
    }
    const data = this.powerTexture.image.data as Uint8Array;
    // Band index → a value the shader can threshold. 0 stays 0 so "no grid" is a clean test.
    for (let i = 0; i < data.length; i++) data[i] = power.state[i]! * 60;
    this.powerTexture.needsUpdate = true;
    this.stats.powerUploads++;
    if (material?.uniforms?.powerMap) material.uniforms.powerMap.value = this.powerTexture;
  }

  beginFrame(camera: CameraState): void {
    this.frameStart = now();
    this.stats.drawCalls = 0;
    this.stats.instances = 0;
    this.stats.triangles = 0;
    this.stats.overlayItems = 0;

    this.camera.position.set(camera.eyeX, camera.eyeY, camera.eyeZ);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(camera.targetX, 0, camera.targetY);
    this.camera.updateMatrixWorld();

    for (const mesh of this.instanced.values()) mesh.count = 0;
    this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.lastCamera = camera;
  }

  private lastCamera: CameraState | null = null;

  drawTerrain(terrain: TerrainMesh): void {
    if (terrain.version !== this.terrainVersion) {
      this.terrainVersion = terrain.version;
      this.uploadTerrain(terrain);
      this.stats.terrainUploads++;
    }
    this.stats.drawCalls++;
    this.stats.triangles += terrain.triangles;
  }

  drawInstances(batch: InstanceBatch): void {
    const source = this.meshes.get(batch.mesh);
    if (!source) return;
    const key = `${batch.mesh}|${batch.owner}|${batch.lod}`;
    let mesh = this.instanced.get(key);
    if (!mesh) {
      mesh = this.createInstanced(source, batch, key);
      this.instanced.set(key, mesh);
      this.scene.add(mesh);
    }
    if (mesh.instanceMatrix.count < batch.count) {
      // Capacity is per key and only ever grows, in powers of two, outside the hot path's
      // expectations — a mid-match army that doubles reallocates once and never again.
      this.scene.remove(mesh);
      mesh.dispose();
      mesh = this.createInstanced(source, batch, key, nextPow2(batch.count));
      this.instanced.set(key, mesh);
      this.scene.add(mesh);
    }

    const shade = mesh.geometry.getAttribute("instanceShade") as InstancedBufferAttribute | undefined;
    for (let i = 0; i < batch.count; i++) {
      this.dummy.position.set(batch.xyz[i * 3]!, batch.xyz[i * 3 + 1]!, batch.xyz[i * 3 + 2]!);
      this.dummy.rotation.set(0, batch.yaw[i]!, 0);
      const s = batch.scale[i]!;
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      if (shade) shade.setX(i, batch.shade[i]!);
    }
    mesh.count = batch.count;
    mesh.instanceMatrix.needsUpdate = true;
    if (shade) shade.needsUpdate = true;

    this.stats.drawCalls++;
    this.stats.instances += batch.count;
    this.stats.triangles += batch.count * source.triangles;
  }

  drawOverlay(layer: OverlayLayer): void {
    if (layer.count === 0 || !this.lastCamera) return;
    drawOverlayLayer(this.overlayCtx, this.lastCamera, layer, this.dpr);
    this.stats.drawCalls++;
    this.stats.overlayItems += layer.count;
  }

  endFrame(): FrameStats {
    this.three.render(this.scene, this.camera);
    this.stats.cpuMs = now() - this.frameStart;
    return this.stats;
  }

  /** See `Renderer.flush` — perf measurement only, never the game loop. */
  flush(): void {
    const gl = this.three.getContext();
    // `readPixels` rather than `finish()`: a single-pixel read is a hard barrier that no driver is
    // free to defer, whereas `finish()` is honoured inconsistently — SwiftShader in particular can
    // return from it with work still queued, which is precisely the case this exists to measure.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, FLUSH_PIXEL);
  }

  dispose(): void {
    for (const mesh of this.instanced.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.instanced.clear();
    this.terrainMesh?.geometry.dispose();
    this.fogTexture?.dispose();
    this.three.dispose();
  }

  private createInstanced(source: MeshData, batch: InstanceBatch, key: string, capacity?: number): InstancedMesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(source.positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(source.colors, 3));
    geometry.setAttribute("ownerMix", new Float32BufferAttribute(source.ownerMix, 1));
    geometry.setIndex(new BufferAttribute(source.indices, 1));

    const cap = capacity ?? Math.max(64, nextPow2(batch.count));
    // `InstancedBufferAttribute`, emphatically not `BufferAttribute`. A plain attribute is read
    // PER VERTEX, so a mesh with more vertices than the batch has instances runs off the end of
    // the buffer and every vertex past that point shades to zero — the model renders solid for its
    // first few faces and pure black for the rest. It looks like a lighting or winding bug and is
    // neither, and no structural test can see it — the guard is the pixel check in
    // `e2e/smoke.spec.ts` ("draws the base in the player's colour, not black").
    const attr = new InstancedBufferAttribute(new Float32Array(cap).fill(1), 1);
    attr.setUsage(DynamicDrawUsage);
    geometry.setAttribute("instanceShade", attr);

    const mesh = new InstancedMesh(geometry, this.instanceMaterial(batch.owner), cap);
    mesh.frustumCulled = false;    // we cull in the scene composer, against the tier's own distances
    mesh.name = key;
    mesh.count = 0;
    return mesh;
  }

  /**
   * The instance material: vertex colour blended toward the owner colour by the mesh's own
   * `ownerMix`, then scaled by the per-instance `instanceShade`.
   *
   * A hand-written shader rather than `MeshBasicMaterial` because the owner mix and the shade are
   * exactly the two knobs instancing gives us, and doing them on the CPU would mean a colour
   * attribute rewrite per entity per frame — the allocation-free rule's most expensive violation.
   */
  private instanceMaterial(owner: number): ShaderMaterial {
    const tint = OWNER_COLORS[owner] ?? OWNER_COLORS[2]!;
    return new ShaderMaterial({
      uniforms: { ownerColor: { value: new Color(tint) } },
      vertexShader: `
        attribute float ownerMix;
        attribute float instanceShade;
        uniform vec3 ownerColor;
        varying vec3 vColor;
        void main() {
          vColor = mix(color, ownerColor, ownerMix) * instanceShade;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
      vertexColors: true,
    });
  }

  private uploadTerrain(terrain: TerrainMesh): void {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(terrain.positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(terrain.colors, 3));
    geometry.setIndex(new BufferAttribute(terrain.indices, 1));

    const material = new ShaderMaterial({
      uniforms: {
        fogMap: { value: this.fogTexture },
        powerMap: { value: this.powerTexture },
        powerOn: { value: this.showPower },
        mapSize: { value: [terrain.width, terrain.height] },
      },
      vertexShader: `
        varying vec3 vColor;
        varying vec2 vUv;
        uniform vec2 mapSize;
        void main() {
          vColor = color;
          vUv = vec2(position.x / mapSize.x, position.z / mapSize.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying vec2 vUv;
        uniform sampler2D fogMap;
        uniform sampler2D powerMap;
        uniform float powerOn;
        void main() {
          // One texture fetch for the whole fog of war (ADR-0006): three states arrive as three
          // brightnesses and the whole thing is a single multiply.
          //
          // The apron (terrain/mesh.ts) lies OUTSIDE the map, so its UVs fall outside [0,1] and
          // sample the clamped edge of the fog texture — which is unexplored, so the border came
          // out multiplied down to black and the fix looked like it had done nothing. Off-map
          // ground is not fogged: there is nothing out there to hide.
          vec2 d = abs(vUv - 0.5) * 2.0;
          float outside = step(1.0, max(d.x, d.y));
          float vis = mix(texture2D(fogMap, vUv).r, 1.0, outside);
          vec3 lit = vColor * vis;

          // The power grid: a SECOND fetch of the same shape, and only when the overlay is on
          // (ADR-0012 §2). Bands arrive as 0/60/120/180/240; the tint goes from a confident green
          // on-grid to a warning amber at the isolated band, which is where a factory costs 2.3x
          // the grid capacity to run. Off-grid ground is left alone rather than tinted, so the
          // overlay reads as "here is your grid" and not as "here is a coloured map".
          float band = texture2D(powerMap, vUv).r * powerOn * (1.0 - outside);
          vec3 tint = mix(vec3(0.25, 0.85, 0.45), vec3(0.95, 0.65, 0.2), clamp((band - 0.235) / 0.71, 0.0, 1.0));
          gl_FragColor = vec4(mix(lit, tint, step(0.01, band) * 0.35), 1.0);
        }`,
      vertexColors: true,
      side: DoubleSide,
    });

    this.terrainMesh = new Mesh(geometry, material);
    this.terrainMesh.frustumCulled = false;
    this.scene.add(this.terrainMesh);
  }
}

function nextPow2(n: number): number {
  let v = 64;
  while (v < n) v *= 2;
  return v;
}

/** One pixel of scratch for `flush`. Module-level so measurement never allocates either. */
const FLUSH_PIXEL = new Uint8Array(4);

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
