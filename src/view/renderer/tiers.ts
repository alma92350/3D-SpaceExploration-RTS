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
  /**
   * Beyond this distance an entity collapses to a billboard imposter.
   *
   * **PICKED, not derived, and P6-T07 says so with numbers rather than leaving it implied.** The
   * four values below arrived in the Phase 1 MVP commit with no working. PRD §6.2 mandates "LOD with
   * billboard imposters beyond a distance threshold" and names no threshold; nothing downstream
   * derives one. `test/view/tiers.test.ts` checks only that they are ordered and that the apron
   * outruns them, which is consistency, not derivation. What follows is what measuring found.
   *
   * **1. The CPU-side gate cannot price it, and that is a measurement, not an excuse.** Sweeping
   * T0's `lodDistance` over the real 200-unit scene and the real camera path, three gate-length runs
   * each: p95 2.33 ms with everything an imposter, 2.04 at 340, 2.18 with LOD off entirely — a
   * spread narrower than the scatter within any one setting. `npm run perf` runs against the
   * recording renderer, which shades no fragments, so a threshold whose whole job is to remove
   * fragments is invisible to it. The one thing that does move is TRIANGLES: 9 418 with everything
   * collapsed, 13 086 at 340, 19 548 with LOD off. So 340 is buying a 33% triangle cut on a T0
   * frame, and only `e2e/perf.spec.ts` under SwiftShader can turn that into milliseconds. It does
   * not sweep the threshold, which is the gap this comment is really about.
   *
   * **2. Batches: the switch costs two and saves nothing until the whole field is far.** Measured on
   * the T0 scene: 23 draw calls at 340, 23 with LOD off, 7 with everything collapsed. The imposter
   * pair is pure overhead at every camera position where any entity is still near.
   *
   * **3. "At what distance is the imposter indistinguishable?" — measured, and the answer is: at no
   * distance this game ever draws.** Projecting every vertex of each mesh and every corner of its
   * imposter quad through the same camera at T0's 340 and comparing screen-space bounding boxes on
   * the 960×540 raster T0 actually rasterises, the quad covers 0.73× to 10.35× the mesh's area
   * (median ≈ 2.5×; a Freighter is 7.7×15.7 px and its quad is 41.7×30.2). Binary-searching the
   * distance at which both bbox dimensions agree within one rasterised pixel gives 7 151 (civic) to
   * 43 858 (command) world units. T0's CULL distance is 1 100.
   *
   * **The cause was the quad's size, not the threshold, so no threshold could have fixed it — and
   * P7-T02 fixed the quad (ADR-0024).** The imposter is now sized by the mean footprint width of the
   * MESH it replaces rather than by the engine's collision radius, and it is built already leaning
   * back at this rig's own mid-pitch, so a Y-rotation-only renderer draws a billboard. Re-measured by
   * `perf/imposter-probe.mjs` over every zoom, yaw snap and facing: screen width 0.88–2.99× →
   * **0.95–1.13×**, height 0.34–5.60× → **0.48–2.20×**, area 0.30–14.68× → **0.49–2.23×**, for zero
   * draw calls and zero triangles.
   *
   * `lodDistance` was still not moved, and that is still the right call: **it was never the wrong
   * number.** The paragraph this replaces said the fix was "a visual decision with an owner" and
   * left it — which was right at the time and would have been wrong to leave standing, because a
   * comment that describes a closed defect as open is how the next reader spends a day on it.
   *
   * **4. It is doing a second job nobody measured.** `pushEntityOverlays` reuses this same distance
   * to decide whether a health bar, a chevron or a status badge is drawn at all — see the corrected
   * note there. One number answers "is the mesh worth drawing?" and "can the player read a bar?",
   * and those two questions have no reason to share an answer at any tier.
   */
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

/**
 * Renderer strings that name a GPU built for 3D, rather than one that comes with a CPU.
 *
 * **This list is the only POSITIVE evidence about graphics that a browser will give us**, and until
 * PT-07 it was used solely as a veto — `SOFTWARE_RENDERERS` to force T0, and a bare `!includes
 * ("intel")` to block T3. Everything that actually chose a tier was `hardwareConcurrency` and
 * `deviceMemory`, which describe the CPU and the RAM. A graphics setting was being decided by
 * asking about everything except the graphics.
 *
 * What that cost, measured with `detectTier` itself: a GeForce GTX 1060 6 GB behind an i7-4790K —
 * four cores, eight threads — could not reach T3, because T3 required twelve. It got **T2, the same
 * tier as an integrated Intel UHD 620 in a sixteen-thread laptop**. On a Small map (1600 x 1000,
 * diagonal ~1886) that is the difference between a `lodDistance` of 800, where most of the field is
 * a flat imposter quad, and 2400, where nothing on the map is ever an imposter at all.
 *
 * **Deliberately a family list and not a model list.** A model list is a thing somebody has to
 * maintain forever and that is wrong the week a card ships; these prefixes have named the same
 * product lines for over a decade. They are matched case-insensitively against the whole string
 * because vendors wrap them differently — Chrome reports ANGLE's paraphrase, Firefox reports the
 * driver's own.
 *
 * **The known imprecision, stated rather than hidden.** `geforce` matches a GeForce MX150, which is
 * a weak laptop part; `apple m` matches Apple Silicon, which is integrated by construction and
 * still fast. Both are guesses on the optimistic side, and being wrong here is cheap **because the
 * guess is not the answer**: this module's own header says the sequence is "guess from the renderer
 * string, then correct by measurement", and `TierMonitor` drops a tier that misses its budget
 * within `CORRECTION_WINDOW_MS`. What it will not do is raise one — so a guess that is too LOW is
 * the one that is permanent, and that is the failure this list exists to stop.
 */
const DEDICATED_GPUS = [
  "nvidia", "geforce", "quadro", "titan",   // covers GTX and RTX, which never appear without one of these
  "radeon rx", "radeon pro", "firepro",     // NOT bare "radeon": Ryzen APUs report "Radeon Vega 8" and are integrated
  "intel arc", "arc a",                     // Intel's discrete line, which the bare "intel" veto would otherwise catch
  "apple m",                                // Apple Silicon: integrated, and comfortably past this bar
];

/** Does the renderer string name a GPU built for 3D? See `DEDICATED_GPUS`. */
export function isDedicatedGpu(rendererString: string | null): boolean {
  const renderer = (rendererString ?? "").toLowerCase();
  if (!renderer) return false;
  if (SOFTWARE_RENDERERS.some((sw) => renderer.includes(sw))) return false;
  return DEDICATED_GPUS.some((gpu) => renderer.includes(gpu));
}

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

  // **The GPU decides the graphics tier, when the browser names one** (PT-07). A dedicated card
  // with a CPU able to feed it is the strongest evidence available, and it is checked FIRST so it
  // is not overridden by a thread count that says nothing about rendering. Four is the floor
  // because ADR-0006 puts the whole simulation on one thread and the frame on another — below that
  // the CPU is the bottleneck whatever the card is, and T3 would be a promise the machine cannot
  // keep.
  if (isDedicatedGpu(inputs.rendererString) && cores >= 4) return "T3";

  // No named GPU. Fall back to the CPU-shaped guess, which is what this function had always done —
  // and it is deliberately still conservative, because an unnamed renderer really is an unknown
  // machine. `deviceMemory` is Chromium-only and defaults to 4 elsewhere, so this branch is the one
  // that reads differently across browsers; the GPU branch above does not, which is how PT-07's
  // sharpest case stops mattering for anyone whose browser will name their card.
  if (cores >= 12 && memory >= 8 && renderer && !renderer.includes("intel")) return "T3";
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

  /**
   * Hand the tier back to measurement (P5-T10).
   *
   * `setManual` was a one-way door: a player who had ever forced a tier could not get detection back
   * without clearing the site's storage, which is what the settings row's "Auto" option exists to
   * undo. The window is reset with it because the samples in it were taken under a tier the PLAYER
   * chose — judging automatic correction on them would drop a tier on evidence from a different one.
   */
  clearManual(): void {
    this.manual = false;
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
