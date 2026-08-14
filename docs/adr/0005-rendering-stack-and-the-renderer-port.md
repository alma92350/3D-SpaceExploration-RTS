# ADR-0005: Rendering stack — three.js behind a Renderer port, with a Canvas2D fallback

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §6.2, §7; ADR-0006, ADR-0007

## Context

We need a 3D renderer for a browser RTS that must also run on machines with **no GPU** (PRD §6.2,
persona P2). Three sub-questions:

1. **Which library?** Raw WebGL2 is the most controllable and the slowest to build with. three.js
   is the de-facto standard: mature, ESM, tree-shakeable, huge documentation surface, and it does
   not impose an engine/editor/asset pipeline the way Babylon or PlayCanvas do. WebGPU is not an
   option — the target machines are exactly the ones without it.
2. **What happens with no GPU?** Browsers fall back to a software rasteriser (SwiftShader in
   Chromium, llvmpipe on Mesa). WebGL still *works* there; it is simply slow, and slow in a
   specific way: fill rate and per-draw-call overhead dominate, vertex count matters less than
   overdraw and state changes.
3. **What if WebGL is unavailable at all?** Locked-down enterprise builds, some VDI stacks and
   headless environments disable it. An RTS that shows an error page there fails persona P2
   entirely — and we already have proven 2D drawing code upstream.

The parent project's art style — flat vector silhouettes drawn from canvas paths, no image
assets — is an unusually good fit for all of this: procedural low-poly geometry with vertex colours
needs no textures, no asset pipeline, and no fill-rate-hungry shading.

## Decision

**1. `view/` draws through a `Renderer` port, never through three.js directly.**

```ts
interface Renderer {
  resize(w: number, h: number, dpr: number): void;
  setTier(tier: Tier): void;
  beginFrame(camera: CameraState): void;
  drawTerrain(handle: TerrainHandle): void;
  drawInstances(batch: InstanceBatch): void;   // one mesh, many transforms + colours
  drawOverlay(layer: OverlayLayer): void;      // selection rings, health bars, fog edges
  endFrame(): FrameStats;                      // draw calls, instances, frame ms — asserted in tests
  dispose(): void;
}
```

Three implementations:
- **`WebGLRenderer`** — three.js, WebGL2. The product renderer for tiers T0–T3.
- **`Canvas2DRenderer`** — an orthographic/isometric projection drawn with Canvas2D, reusing the
  silhouette vocabulary of the upstream 2D client. Feature-reduced (no relief shading, no
  perspective) but *playable*. Used when WebGL is absent.
- **`RecordingRenderer`** — a test fake that records every call. Render-layer tests assert against
  it: draw-call counts, instance counts, batch composition, and that nothing allocates.

**2. three.js is pinned and imported by name, never by side effect.** Only tree-shakeable named
imports; no examples/ addons unless an ADR adds one. Version pinned in `package.json` and in
ADR-0007's dependency table.

**3. Art is procedural, low-poly, flat-shaded, vertex-coloured.** No textures, no normal maps, no
skeletal animation, no glTF pipeline in the MVP. Meshes are built at boot from parameterised
generators that mirror the 2D silhouettes, so a Skiff reads as a Skiff from the first frame.

**4. Everything the player must read is an overlay, not a shader trick.** Selection rings, health
bars, veterancy chevrons, rally lines, build ghosts and fog edges go through `drawOverlay`, which
both renderer implementations support, because these are the elements that must survive the drop to
T0 and to Canvas2D.

## Consequences

**This makes easy:**
- Swapping or upgrading the 3D library later touches one implementation, not the whole view layer.
- Testing rendering *logic* (what should be drawn, batched how) without a GPU or a canvas at all.
- A genuine no-WebGL product path instead of an apology page.

**This makes hard / gives up:**
- The port is a lowest-common-denominator API: fancy three.js-specific features (post-processing
  stacks, custom render targets) are not reachable without extending it deliberately — which is the
  intent, but it will feel restrictive during effects work.
- Two renderer implementations to keep in step. Mitigated by a shared conformance test suite that
  runs against every implementation, including the fake.
- Procedural art caps visual ambition. Accepted: readability over fidelity (PRD §4.3).

**Obligations it creates:**
- A renderer conformance suite every implementation must pass (`P1-T08`).
- `FrameStats` is real, returned every frame, and asserted by the perf gate (ADR-0006).
- A no-WebGL boot test (context creation stubbed to fail) that asserts the Canvas2D path starts
  and reaches a playable frame (`P1-T22`).

## Alternatives considered

### Raw WebGL2, no library
Maximum control over exactly the thing we must control (draw calls, state changes). Rejected for
the MVP on schedule: instancing, camera math, frustum culling and picking are all weeks we would
spend re-deriving what three.js ships. The `Renderer` port keeps this reversible — a raw-GL
implementation can be added later behind the same interface if profiling demands it.

### Babylon.js
Excellent engine, bigger runtime, and its strengths (physics, WebXR, node materials, an editor) are
all things ADR-0004 and the CPU-only budget rule out. More weight for capability we cannot spend.

### PlayCanvas / Unity WebGL / Godot web export
Whole-engine solutions that would own the app shell, the asset pipeline and the build, and would
make vendoring a JavaScript simulation (ADR-0003) awkward-to-hostile. Rejected.

### WebGPU with a WebGL fallback
Two rendering backends to maintain, for a speed-up on hardware our constraint persona does not
have. Revisit if the budget ever demands it on high-end machines — which would be a strange
priority for this project.

### 2.5D sprites (pre-rendered turntables) instead of meshes
A classic CPU-only RTS trick and genuinely fast. Rejected because it needs an asset pipeline and
bakes in the camera angles, which fights the free-ish camera we want. Kept in reserve as a T0 LOD
technique (billboard imposters at distance — ADR-0006).
