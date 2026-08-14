// Tier configuration, detection and measured correction (ADR-0006 §2, P1-T07).
//
// PRD §6.2 is the table of record; this is that table as data, in one file, so a budget question
// has exactly one answer. Everything downstream — the terrain mesh's detail, the LOD distance, the
// shadow style, the render scale — reads it from here rather than deciding for itself.
//
// The detection sequence is: **guess from the renderer string, then correct by measurement.** The
// guess is fast but lies (a laptop reporting a real GPU can still be throttled to nothing in a VM);
// the measurement is truthful but takes three seconds. Doing both, in that order, means the player
// with no GPU gets a playable first frame and an honest tier by the time they have panned once.
//
// **We never silently up-tier.** Dropping a tier is a notice the player can read; raising one
// behind their back turns a stable 30 fps into an oscillation between two tiers.

import { type Tier } from "./port.js";

export interface TierConfig {
  readonly tier: Tier;
  readonly label: string;
  /** 95th-percentile frame-time budget in milliseconds (PRD §6.2). */
  readonly frameBudgetMs: number;
  /** Fraction of the CSS pixel size actually rendered; upscaled to fit. Fill rate is the enemy. */
  readonly renderScale: number;
  /** Beyond this distance an entity collapses to a billboard imposter. */
  readonly lodDistance: number;
  /** Entities past this distance are not drawn at all. */
  readonly cullDistance: number;
  /** Terrain: `flat` paints the terrain types on one plane; `relief` builds the heightfield. */
  readonly terrain: "flat" | "relief";
  readonly shadows: "none" | "blob" | "map";
  readonly antialias: boolean;
  /**
   * How far the dark apron extends past the map edge, in world units.
   *
   * There USED to be a `starfield` knob here, and PRD §5 lists a starfield skybox in Phase 1's
   * scope. It was cut after being built, because the camera cannot see the sky: pitch ramps
   * between 35.5° and 74.5° below horizontal and the vertical FOV is 51.6°, so the top edge of the
   * view is between 9.7° and 48.7° BELOW the horizon at every zoom. A skybox would have been
   * invisible in every frame the game ever draws.
   *
   * What actually looked like empty sky was the void past the map edge, where the terrain mesh
   * simply stops. This is the fix for that: a dark border that carries the ground out beyond the
   * playable area so the world does not end in a hard diagonal line of nothing.
   */
  readonly apron: number;
}

export const TIERS: Readonly<Record<Tier, TierConfig>> = {
  // Software rasteriser, no GPU. Everything here is chosen to remove fragments, not triangles:
  // 0.75× render scale is a 44% cut in shaded pixels, and a flat terrain plane removes the
  // overdraw a heightfield's silhouette creates against the sky (ADR-0004's sanctioned fallback).
  T0: {
    tier: "T0", label: "Compatibility (no GPU)", frameBudgetMs: 33, renderScale: 0.75,
    lodDistance: 340, cullDistance: 1100, terrain: "flat", shadows: "none",
    antialias: false, apron: 700,
  },
  T1: {
    tier: "T1", label: "Low", frameBudgetMs: 16.6, renderScale: 0.9,
    lodDistance: 520, cullDistance: 1500, terrain: "relief", shadows: "blob",
    antialias: false, apron: 900,
  },
  T2: {
    tier: "T2", label: "Standard", frameBudgetMs: 16.6, renderScale: 1,
    lodDistance: 800, cullDistance: 2200, terrain: "relief", shadows: "blob",
    antialias: true, apron: 1200,
  },
  T3: {
    tier: "T3", label: "High", frameBudgetMs: 16.6, renderScale: 1,
    lodDistance: 2400, cullDistance: 4000, terrain: "relief", shadows: "map",
    antialias: true, apron: 1800,
  },
};

export const TIER_ORDER: readonly Tier[] = ["T0", "T1", "T2", "T3"];

/** Renderer strings that mean "there is no GPU here". Matched case-insensitively, as substrings. */
const SOFTWARE_RENDERERS = ["swiftshader", "llvmpipe", "software", "softpipe", "mesa offscreen", "microsoft basic render"];

export interface DetectionInputs {
  /** `WEBGL_debug_renderer_info`'s UNMASKED_RENDERER_WEBGL, when the browser gives it up. */
  readonly rendererString: string | null;
  readonly hardwareConcurrency: number;
  /** `navigator.deviceMemory` in GB, or null where it is not exposed (Firefox, Safari). */
  readonly deviceMemory: number | null;
  readonly hasWebGL2: boolean;
}

/**
 * The boot guess. Conservative by construction: an unknown machine gets T1, not T3, because being
 * pleasantly surprised by a tier bump is better than a first impression at 8 fps.
 */
export function detectTier(inputs: DetectionInputs): Tier {
  if (!inputs.hasWebGL2) return "T0";
  const renderer = (inputs.rendererString ?? "").toLowerCase();
  if (renderer && SOFTWARE_RENDERERS.some((s) => renderer.includes(s))) return "T0";

  const cores = inputs.hardwareConcurrency || 2;
  const memory = inputs.deviceMemory ?? 4;
  if (cores <= 2 || memory <= 2) return "T0";
  if (cores >= 12 && memory >= 8 && renderer && !renderer.includes("intel")) return "T3";
  if (cores >= 8 && memory >= 8) return "T2";
  if (cores >= 4) return "T2";
  return "T1";
}

/** How long a tier must miss its budget before we act. Long enough to survive a load hitch. */
export const CORRECTION_WINDOW_MS = 3000;

/**
 * How much recent history the percentile is taken over.
 *
 * Time-based, not a fixed sample count, and that distinction is the whole reason this constant
 * exists: a count-based window holds a one-second hitch for however many frames it takes to push
 * 20 bad samples out, which on a fast machine is thousands of good frames — long enough for the
 * over-budget streak below to reach 3 s and drop a tier the machine never deserved. Bounding the
 * window in TIME means a hitch is forgotten two seconds later regardless of frame rate, so only a
 * machine that is *persistently* slow can accumulate a full streak.
 */
export const SAMPLE_WINDOW_MS = 2000;

export interface TierCorrection {
  readonly tier: Tier;
  readonly dropped: boolean;
  readonly notice: string | null;
}

/**
 * Watch measured frame times and drop a tier when the budget is genuinely, persistently missed.
 *
 * Uses the rolling 95th percentile, not the mean: a budget is about the frames that stutter, and a
 * mean that looks fine while one frame in twenty takes 60 ms is the exact failure players describe
 * as "it feels choppy but the counter says 60".
 */
export class TierMonitor {
  /** Recent frame times, oldest first, spanning at most `SAMPLE_WINDOW_MS` of wall time. */
  private readonly samples: number[] = [];
  private windowMs = 0;
  private overBudgetMs = 0;
  private manual = false;

  constructor(private current: Tier) {}

  get tier(): Tier {
    return this.current;
  }

  /** A player override always wins and switches the monitor off (ADR-0006 §2). */
  setManual(tier: Tier): void {
    this.current = tier;
    this.manual = true;
    this.reset();
  }

  sample(frameMs: number): TierCorrection {
    if (this.manual) return { tier: this.current, dropped: false, notice: null };

    this.samples.push(frameMs);
    this.windowMs += frameMs;
    while (this.samples.length > 1 && this.windowMs - this.samples[0]! >= SAMPLE_WINDOW_MS) {
      this.windowMs -= this.samples.shift()!;
    }

    const budget = TIERS[this.current].frameBudgetMs;
    const p95 = percentile(this.samples, 0.95);
    this.overBudgetMs = p95 > budget ? this.overBudgetMs + frameMs : 0;

    // Two independent floors, both in TIME rather than in frames: we need a full window of
    // evidence, and we need the budget to have been missed for the whole correction window. Timing
    // both matters — a frame-count floor is unreachable on the machines that need this most, since
    // a machine rendering at 90 ms a frame fits only ~22 frames into two seconds and would have
    // sat there missing its budget forever without ever qualifying to be told about it.
    if (this.windowMs < SAMPLE_WINDOW_MS || this.overBudgetMs < CORRECTION_WINDOW_MS)
      return { tier: this.current, dropped: false, notice: null };

    const index = TIER_ORDER.indexOf(this.current);
    if (index <= 0) {
      // Already at T0 and still missing. There is no lower tier; the honest answer is to stop
      // measuring rather than to keep firing a notice the player can do nothing about.
      this.manual = true;
      return { tier: this.current, dropped: false, notice: null };
    }

    const next = TIER_ORDER[index - 1]!;
    this.current = next;
    this.reset();
    return {
      tier: next,
      dropped: true,
      notice: `Graphics dropped to ${TIERS[next].label} — this machine was missing the frame budget. `
            + `You can change this in Settings.`,
    };
  }

  private reset(): void {
    this.samples.length = 0;
    this.windowMs = 0;
    this.overBudgetMs = 0;
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}
