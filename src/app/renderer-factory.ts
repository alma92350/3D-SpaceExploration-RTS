// Choosing a renderer, and the fallback when there is nothing to choose (ADR-0005, P1-T22).
//
// Kept out of `boot.ts` because it is the one piece of startup with a genuine branch worth testing
// on its own: a machine with no WebGL must reach a playable frame through Canvas2D rather than an
// error page, and the only way to know that still works is a test that stubs context creation to
// fail. Isolating the decision makes that test three lines instead of a browser harness.

import { type Renderer, type Tier } from "../view/renderer/port.js";
import { Canvas2DRenderer } from "../view/renderer/canvas2d.js";
import { WebGLRenderer } from "../view/renderer/webgl.js";
import { type DetectionInputs, detectTier } from "../view/renderer/tiers.js";

export interface RendererChoice {
  readonly renderer: Renderer;
  readonly tier: Tier;
  /** Set when WebGL was unavailable, for the notice the player sees. */
  readonly fallbackReason: string | null;
}

export interface FactoryOptions {
  readonly glCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  readonly fallbackCanvas: HTMLCanvasElement;
  readonly tierOverride: Tier | null;
}

/**
 * Probe the machine, then build the best renderer it can actually run.
 *
 * The probe uses a throwaway context: reading `WEBGL_debug_renderer_info` needs a live context, and
 * doing it on the real canvas would leave a context we might then have to discard.
 */
export function createRenderer(opts: FactoryOptions): RendererChoice {
  const inputs = probe();
  const tier = opts.tierOverride ?? detectTier(inputs);

  if (inputs.hasWebGL2) {
    try {
      const renderer = new WebGLRenderer({ canvas: opts.glCanvas, overlayCanvas: opts.overlayCanvas, tier });
      return { renderer, tier, fallbackReason: null };
    } catch (err) {
      // The probe said yes and construction still failed — a context limit, a driver reset, a
      // policy that blocks the second context. Falling through is the whole point of having a
      // fallback: an exception here must not be the player's first impression.
      return {
        renderer: new Canvas2DRenderer(opts.fallbackCanvas),
        tier: "T0",
        fallbackReason: `3D acceleration failed to start (${(err as Error).message}); running the compatibility renderer.`,
      };
    }
  }

  return {
    renderer: new Canvas2DRenderer(opts.fallbackCanvas),
    tier: "T0",
    fallbackReason: "WebGL is unavailable in this browser; running the compatibility renderer.",
  };
}

export function probe(): DetectionInputs {
  let rendererString: string | null = null;
  let hasWebGL2 = false;
  try {
    const probeCanvas = document.createElement("canvas");
    const gl = probeCanvas.getContext("webgl2");
    if (gl) {
      hasWebGL2 = true;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) rendererString = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
      // Some browsers mask the vendor string entirely for fingerprinting reasons. `RENDERER` is
      // the un-masked-but-generic fallback; on SwiftShader it still says so.
      if (!rendererString) rendererString = String(gl.getParameter(gl.RENDERER));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    hasWebGL2 = false;
  }

  const nav = globalThis.navigator as Navigator & { deviceMemory?: number };
  return {
    rendererString,
    hasWebGL2,
    hardwareConcurrency: nav?.hardwareConcurrency ?? 2,
    deviceMemory: nav?.deviceMemory ?? null,
  };
}
