// The in-browser test harness entry (loaded by `harness.html`, driven by Playwright).
//
// Two things need a real browser and a real rasteriser, and neither can be faked in Node:
//   • the renderer conformance suite against `WebGLRenderer` (P1-T08) — it needs a GL context;
//   • the perf gate at T0 (P1-T23) — headless Chromium's software rasteriser IS the T0 target
//     hardware (ADR-0006 §4), so this is the only honest measurement of the budget.
//
// It is a separate entry point rather than a debug flag on the game so that nothing in the shipped
// app has a branch that only exists for testing.

import { runConformance, type ConformanceCase } from "./view/renderer/conformance.js";
import { RecordingRenderer } from "./view/renderer/recording.js";
import { Canvas2DRenderer } from "./view/renderer/canvas2d.js";
import { WebGLRenderer } from "./view/renderer/webgl.js";
import { buildMeshes } from "./view/meshes/generators.js";
import { type Renderer } from "./view/renderer/port.js";
import { SCENES } from "../perf/scene.js";
import { judge, runScene, type PerfResult } from "../perf/harness.js";

function canvas(id: string): HTMLCanvasElement {
  return document.getElementById(id) as HTMLCanvasElement;
}

const IMPLEMENTATIONS: Record<string, () => Renderer> = {
  recording: () => new RecordingRenderer(),
  canvas2d: () => new Canvas2DRenderer(canvas("h-overlay")),
  webgl2: () => new WebGLRenderer({ canvas: canvas("h-scene"), overlayCanvas: canvas("h-overlay"), tier: "T2" }),
};

export interface HarnessApi {
  conformance(name: string): ConformanceCase[];
  implementations(): string[];
  perf(scene: string, seconds: number): { result: PerfResult; problems: string[] };
}

const api: HarnessApi = {
  implementations: () => Object.keys(IMPLEMENTATIONS),

  conformance(name) {
    const create = IMPLEMENTATIONS[name];
    if (!create) throw new Error(`unknown renderer implementation "${name}"`);
    return runConformance({ create, meshes: buildMeshes() });
  },

  perf(scene, seconds) {
    const spec = SCENES[scene];
    if (!spec) throw new Error(`unknown perf scene "${scene}"`);
    // The real WebGL renderer, on the software rasteriser — the whole point of running here.
    const renderer = new WebGLRenderer({
      canvas: canvas("h-scene"), overlayCanvas: canvas("h-overlay"), tier: spec.tier,
    });
    try {
      const result = runScene(scene, spec, renderer, {
        seconds, targetFps: 60, now: () => performance.now(),
      });
      // Budgets only: the committed baseline is the CPU-side runner's, measured against the
      // recording renderer, and comparing a GPU-path number to it would be comparing two different
      // things. What the browser gate enforces is PRD §6.2's absolute budget, which is the number
      // that actually matters to a player.
      return { result, problems: judge(result, undefined).problems };
    } finally {
      renderer.dispose();
    }
  },
};

(globalThis as unknown as { __harness: HarnessApi }).__harness = api;
document.body.dataset.harnessReady = "1";
