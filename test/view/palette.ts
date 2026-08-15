// What "colour-blind-safe" is, numerically — shared by the palette check and the colour-alone sweep.
//
// This is the colour half of PRD N-05, and it is the same kind of instrument as `silhouette.ts`:
// the honest, weaker stand-in for a test with a human in it. It cannot tell you whether a palette
// *reads*; it can tell you whether two colours a player is asked to tell apart still differ after
// the eye that has to tell them apart is simulated. That is the failure a colour-blind tester would
// spot in the first thirty seconds and which no other test in this repo would catch — N-05 was
// cited in eight source comments and verified in none of them before P6-T02.
//
// IT LIVES UNDER test/ AND NOT UNDER src/, DELIBERATELY.
// `test/input/phase4-input.test.ts` asserts that every module in `src/` is reachable at runtime
// from `src/main.ts` or `src/harness-entry.ts`, because this project has been caught four times by
// a module that was complete, tested and called by nobody. A colour-science module in `src/` that
// only tests import would be exactly that module, and it would turn that guard red on arrival. It
// is an instrument, not a feature: nothing a player does runs it. `test/view/silhouette.ts` is the
// same shape and set the precedent.
//
// =================================================================================================
// THE MODEL: Machado, Oliveira & Fernandes (2009), severity 1.0
// =================================================================================================
// "A Physiologically-based Model for Simulation of Color Vision Deficiency", IEEE Transactions on
// Visualization and Computer Graphics 15(6):1291-1298. Chosen over Viénot/Brettel for four reasons,
// in the order they mattered:
//
//   1. **It is published as a linear-RGB matrix.** Viénot 1999 and Brettel 1997 are defined in LMS,
//      so using them means getting an RGB→LMS matrix, a cone fundamental set, and (for Brettel) two
//      anchor wavelengths and a half-plane test all correct as well. Every transform removed is a
//      transform that cannot be silently wrong, and a palette test that is wrong in the direction
//      of "everything looks fine" passes vacuously and tells nobody.
//   2. **It treats tritanopia on the same footing as the other two.** Viénot's single-plane
//      simplification is documented *by its own authors* as unsuitable for tritanopia; the
//      widely-copied tritan matrix from that paper is the known-bad one. Brettel's two-plane
//      version fixes it and costs the anchors from (1).
//   3. **It is what the browser shows.** Chrome and Firefox DevTools emulate vision deficiency with
//      this model, so a reviewer checking this palette by eye sees the numbers this file computes
//      rather than a second opinion that disagrees.
//   4. **Its rows sum to unity**, so neutrals are preserved exactly — a cheap, exact invariant the
//      test asserts rather than assumes.
//
// Viénot 1999 is *also* implemented here, and is used by the test as an independent second opinion.
// Two models recalled and transcribed separately agreeing to within a few ΔE is the strongest
// available evidence that neither is badly wrong, and it costs nine numbers.
//
// =================================================================================================
// THE DISTANCE: CIEDE2000
// =================================================================================================
// CIE 142-2001. Not RGB euclidean, which is not a perceptual distance at all, and not CIE76, which
// is badly non-uniform in exactly the blue and saturated regions this palette lives in — the owner
// colours are a saturated cyan and a saturated orange, and CIE76 overstates blue differences by
// roughly a factor of two there.
//
// The implementation is verified against the 28 reference pairs of Sharma, Wu & Dalal (2005), "The
// CIEDE2000 color-difference formula: implementation notes, supplementary test data and
// mathematical observations", Color Research & Application 30(1):21-30 — a dataset published for
// precisely this purpose, because the formula's hue-angle averaging and its RT rotation term have
// several plausible-looking wrong implementations that agree with the right one nearly everywhere.
// See `palette.test.ts`; agreement to 1e-4 on all 28 is what licenses every other number here.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** CIE L*a*b*, D65. */
export type Lab = readonly [number, number, number];

/** Linear-light sRGB, 0..1 — the space the deficiency matrices operate in. */
export type LinearRgb = readonly [number, number, number];

export const DEFICIENCIES = ["protanopia", "deuteranopia", "tritanopia"] as const;
export type Deficiency = (typeof DEFICIENCIES)[number];

/* -------------------------------------------------------------------------------------------
   The thresholds. Both are hand-written, and this comment is where they are argued with.
   ------------------------------------------------------------------------------------------- */

/**
 * The floor a pair of colours the player must tell apart has to clear, under **each** simulated
 * dichromacy, in ΔE00.
 *
 * Where it comes from: ΔE00 = 1 is the unit the formula is designed around — one just-noticeable
 * difference for a trained observer, side by side, under controlled light (CIE 142-2001, and the
 * scale Sharma's test data is expressed in). Ten of those is an order of magnitude above threshold,
 * which is the region categorical-palette work treats as "a different colour" rather than "a
 * different shade of the same one" — and a categorical palette is exactly what an owner palette is.
 *
 * **The multiple is chosen, not derived, and this file does not pretend otherwise.** It is the same
 * kind of number as ADR-0014's buildings cap of 28: stated once, applied to every pair uniformly,
 * with every measured margin reported by the test whether it passes or fails. That is what makes it
 * arguable — a new colour has to argue against 10, and the person arguing can see how much room
 * every existing pair has.
 *
 * One in-repo cross-check for scale: the shipped minimap asks a player to read three fog states out
 * of three greys, and its narrowest step (explored → visible) measures ΔE00 13.0. So this floor
 * sits just below the weakest distinction the app already ships and expects a player to make at
 * 220×138. It is a floor, not a target.
 */
export const MIN_SEPARATION = 10;

/**
 * The floor for a distinction that must survive colour being removed **entirely**, in ΔL*.
 *
 * N-05's second clause is stricter than its first. "Colour-blind-safe" means a dichromat can use
 * the palette; "no information conveyed by colour alone" means the information is still there when
 * hue and saturation are gone — a greyscale screenshot, a monochrome display, an achromatopsic
 * player. Only lightness survives that, so only lightness counts.
 *
 * Same 10, on a scale where L* runs 0..100 and where a pure lightness step of 10 is worth almost
 * exactly ΔE00 10 near mid-grey (S_L ≈ 1 there). One number for the whole task rather than two to
 * keep straight.
 */
export const MIN_LIGHTNESS_STEP = 10;

/* -------------------------------------------------------------------------------------------
   sRGB → linear → XYZ → Lab
   ------------------------------------------------------------------------------------------- */

/** IEC 61966-2-1's transfer function, piecewise — not the 2.2 power approximation. */
function decodeChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** `#rrggbb` (or `#rgb`) → linear-light sRGB. Throws rather than guessing: a silently mis-parsed
 *  colour would show up as a suspiciously large separation, which is the failure that hides. */
export function hexToLinear(hex: string): LinearRgb {
  const raw = hex.trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  const n = Number.parseInt(full, 16);
  return [
    decodeChannel(((n >> 16) & 255) / 255),
    decodeChannel(((n >> 8) & 255) / 255),
    decodeChannel((n & 255) / 255),
  ];
}

/** Linear sRGB → CIE XYZ (D65), then → L*a*b*. sRGB primaries per IEC 61966-2-1. */
export function linearToLab(rgb: LinearRgb): Lab {
  const [r, g, b] = rgb;
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  // D65 white as the sRGB primaries actually sum to, not the rounded tabulated value: using
  // (0.95047, 1, 1.08883) here leaves pure white at L*=100, a*=-0.02, b*=+0.01 instead of exactly
  // neutral, and that tiny chroma is enough to move a near-neutral pair's ΔE00 in the third digit.
  const XN = 0.4124564 + 0.3575761 + 0.1804375;
  const YN = 0.2126729 + 0.7151522 + 0.0721750;
  const ZN = 0.0193339 + 0.1191920 + 0.9503041;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(X / XN);
  const fy = f(Y / YN);
  const fz = f(Z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToLab(hex: string): Lab {
  return linearToLab(hexToLinear(hex));
}

/** L* alone — the only channel that survives colour being removed. */
export function lightness(hex: string): number {
  return hexToLab(hex)[0];
}

/* -------------------------------------------------------------------------------------------
   CIEDE2000 (CIE 142-2001)
   ------------------------------------------------------------------------------------------- */

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** ΔE00 between two Lab colours, with kL = kC = kH = 1 (the reference conditions). */
export function deltaE2000(a: Lab, b: Lab): number {
  const [L1, a1, b1] = a;
  const [L2, a2, b2] = b;

  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const cBar7 = Math.pow(cBar, 7);
  const G = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  // atan2(0, 0) is 0 by definition in the standard, and the hue of a neutral is undefined rather
  // than zero — which is why every term below that uses it is gated on C1p * C2p.
  let h1p = a1p === 0 && b1 === 0 ? 0 : toDeg(Math.atan2(b1, a1p));
  if (h1p < 0) h1p += 360;
  let h2p = a2p === 0 && b2 === 0 ? 0 : toDeg(Math.atan2(b2, a2p));
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(toRad(dhp) / 2);

  const LBarp = (L1 + L2) / 2;
  const CBarp = (C1p + C2p) / 2;
  let hBarp: number;
  if (C1p * C2p === 0) {
    hBarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarp = (h1p + h2p) / 2;
  } else {
    hBarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const T = 1
    - 0.17 * Math.cos(toRad(hBarp - 30))
    + 0.24 * Math.cos(toRad(2 * hBarp))
    + 0.32 * Math.cos(toRad(3 * hBarp + 6))
    - 0.20 * Math.cos(toRad(4 * hBarp - 63));

  const CBarp7 = Math.pow(CBarp, 7);
  const RC = 2 * Math.sqrt(CBarp7 / (CBarp7 + Math.pow(25, 7)));
  const dTheta = 30 * Math.exp(-Math.pow((hBarp - 275) / 25, 2));
  const RT = -Math.sin(toRad(2 * dTheta)) * RC;

  const dL50 = Math.pow(LBarp - 50, 2);
  const SL = 1 + (0.015 * dL50) / Math.sqrt(20 + dL50);
  const SC = 1 + 0.045 * CBarp;
  const SH = 1 + 0.015 * CBarp * T;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/* -------------------------------------------------------------------------------------------
   The deficiency simulations
   ------------------------------------------------------------------------------------------- */

type Matrix3 = readonly [LinearRgb, LinearRgb, LinearRgb];

/**
 * Machado, Oliveira & Fernandes (2009), Table 1, severity 1.0 — linear-RGB, sRGB primaries.
 * Rows sum to 1 (to the six digits published), which is what makes neutrals fixed points.
 */
export const MACHADO: Readonly<Record<Deficiency, Matrix3>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

/* --- The second opinion: Viénot, Brettel & Mollon (1999), for cross-checking only --- */

/** Linear sRGB → LMS on the Smith & Pokorny (1975) fundamentals, as the Viénot paper uses. */
const RGB_TO_LMS: Matrix3 = [
  [0.31399022, 0.63951294, 0.04649755],
  [0.15537241, 0.75789446, 0.08670142],
  [0.01775239, 0.10944209, 0.87256922],
];
const LMS_TO_RGB: Matrix3 = [
  [5.47221206, -4.64196010, 0.16963708],
  [-1.12524190, 2.29317094, -0.16789520],
  [0.02980165, -0.19318073, 1.16364789],
];
/** The reduced-gamut projections in LMS: one cone class replaced by a plane through white. */
const VIENOT_LMS: Readonly<Record<Deficiency, Matrix3>> = {
  protanopia: [[0, 1.05118294, -0.05116099], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [[1, 0, 0], [0.95130920, 0, 0.04866992], [0, 0, 1]],
  tritanopia: [[1, 0, 0], [0, 1, 0], [-0.86744736, 1.86727089, 0]],
};

function multiply(A: Matrix3, B: Matrix3): Matrix3 {
  const row = (i: number): LinearRgb => [0, 1, 2].map(
    (j) => A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]!,
  ) as unknown as LinearRgb;
  return [row(0), row(1), row(2)];
}

/** Viénot 1999 folded into linear RGB, so both models present the same interface. */
export const VIENOT: Readonly<Record<Deficiency, Matrix3>> = {
  protanopia: multiply(LMS_TO_RGB, multiply(VIENOT_LMS.protanopia, RGB_TO_LMS)),
  deuteranopia: multiply(LMS_TO_RGB, multiply(VIENOT_LMS.deuteranopia, RGB_TO_LMS)),
  tritanopia: multiply(LMS_TO_RGB, multiply(VIENOT_LMS.tritanopia, RGB_TO_LMS)),
};

/**
 * A colour as that eye receives it.
 *
 * Clamped back into gamut, because a reduced-gamut projection can land outside the cube and a
 * display cannot show what is outside the cube either — an unclamped negative channel would make
 * two colours look further apart than a monitor could ever render them.
 */
export function simulate(hex: string, deficiency: Deficiency, model: Readonly<Record<Deficiency, Matrix3>> = MACHADO): LinearRgb {
  const [r, g, b] = hexToLinear(hex);
  const M = model[deficiency];
  const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  return [
    clamp(M[0]![0]! * r + M[0]![1]! * g + M[0]![2]! * b),
    clamp(M[1]![0]! * r + M[1]![1]! * g + M[1]![2]! * b),
    clamp(M[2]![0]! * r + M[2]![1]! * g + M[2]![2]! * b),
  ];
}

export interface Separation {
  /** ΔE00 as a standard trichromat sees it. Reported so a failure says WHICH thing broke it. */
  readonly normal: number;
  readonly protanopia: number;
  readonly deuteranopia: number;
  readonly tritanopia: number;
  /** The smallest of the three simulated distances — what the pair is actually held to. */
  readonly worst: number;
  /** Which deficiency produced `worst`. */
  readonly worstUnder: Deficiency;
  /** |ΔL*| — the part of the difference that survives colour being removed entirely. */
  readonly lightnessStep: number;
}

/** Every number this task reports about one pair of colours. */
export function separation(
  hexA: string,
  hexB: string,
  model: Readonly<Record<Deficiency, Matrix3>> = MACHADO,
): Separation {
  const labA = hexToLab(hexA);
  const labB = hexToLab(hexB);
  const under = (d: Deficiency): number => deltaE2000(
    linearToLab(simulate(hexA, d, model)),
    linearToLab(simulate(hexB, d, model)),
  );
  const values: Record<Deficiency, number> = {
    protanopia: under("protanopia"),
    deuteranopia: under("deuteranopia"),
    tritanopia: under("tritanopia"),
  };
  let worstUnder: Deficiency = "protanopia";
  for (const d of DEFICIENCIES) if (values[d] < values[worstUnder]) worstUnder = d;
  return {
    normal: deltaE2000(labA, labB),
    ...values,
    worst: values[worstUnder],
    worstUnder,
    lightnessStep: Math.abs(labA[0] - labB[0]),
  };
}

/** One line per pair, for a failure message that reports the measurement rather than a verdict. */
export function describeSeparation(name: string, s: Separation): string {
  const n = (v: number): string => v.toFixed(1).padStart(5);
  return `${name.padEnd(34)} normal ${n(s.normal)} | protan ${n(s.protanopia)}`
    + ` deutan ${n(s.deuteranopia)} tritan ${n(s.tritanopia)} | ΔL* ${n(s.lightnessStep)}`;
}

/* -------------------------------------------------------------------------------------------
   Reading the real colours out of the real stylesheet
   ------------------------------------------------------------------------------------------- */

export interface CssRule {
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/**
 * Every stylesheet under `src/`, concatenated.
 *
 * Discovered rather than named, for the same reason the palettes below are queries rather than
 * lists. `src/style.css` was the only stylesheet in this project for five phases and stopped being
 * so during Phase 6, when `src/a11y.css` arrived — a sweep hard-coded to a filename would have gone
 * on passing while half the rules in the app were outside it. Concatenation is safe here because
 * everything downstream groups by selector and resolves `:root` variables across the whole set,
 * which is what the browser does with two `<link>`s anyway.
 */
export function readProjectStylesheets(srcDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "engine") continue;       // vendored; not ours and has no stylesheet
        walk(full);
      } else if (name.endsWith(".css")) {
        files.push(full);
      }
    }
  };
  walk(srcDir);
  if (files.length === 0) throw new Error(`no stylesheet found under ${srcDir} — the sweep would pass vacuously`);
  return files.sort().map((f) => readFileSync(f, "utf8")).join("\n");
}

/**
 * A deliberately small CSS reader: comments out, then `selector { prop: value; … }`.
 *
 * It exists so the tests measure **the colours the game actually ships** rather than a copy of them
 * pasted into a test. A test that restates a constant and then asserts the constant proves only
 * that someone can type. This parser is the reason a colour changed in `style.css` changes what the
 * suite measures, in the same commit, without anyone remembering to.
 *
 * It does not implement CSS. It does not need to: `src/style.css` is 250 lines of flat rules with
 * no nesting, no at-rules containing rules, and no selector this has to disambiguate. If that
 * changes, this reader gets a nested-block case and the test that finds nothing to check goes red
 * first — see the "finds rules to check" assertion in the sweep.
 */
export function parseCss(source: string): CssRule[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, " ");
    if (selector.startsWith("@")) continue;
    const declarations = new Map<string, string>();
    for (const decl of match[2]!.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      declarations.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim());
    }
    if (declarations.size > 0) rules.push({ selector, declarations });
  }
  return rules;
}

/** The `:root` custom properties, so `var(--player)` resolves to the colour it actually is. */
export function cssVariables(rules: readonly CssRule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selector !== ":root") continue;
    for (const [prop, value] of rule.declarations) if (prop.startsWith("--")) vars.set(prop, value);
  }
  return vars;
}

/**
 * A declaration's value as a hex colour, or null when it is not an opaque one.
 *
 * `rgba(...)` with alpha returns null on purpose rather than being composited against a guess: the
 * panels stack translucent layers, so "what colour is that actually" depends on what is behind it,
 * and inventing a backdrop would put a number in a test that no pixel on screen ever takes.
 */
export function resolveColor(value: string, vars: ReadonlyMap<string, string>): string | null {
  let v = value.trim();
  for (let depth = 0; depth < 4 && v.startsWith("var("); depth++) {
    const name = v.slice(4, v.indexOf(")")).split(",")[0]!.trim();
    const resolved = vars.get(name);
    if (resolved === undefined) return null;
    v = resolved.trim();
  }
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(v)) return v;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgb) {
    if (rgb[4] !== undefined && Number.parseFloat(rgb[4]) < 1) return null;
    return "#" + [rgb[1]!, rgb[2]!, rgb[3]!]
      .map((c) => Number.parseInt(c, 10).toString(16).padStart(2, "0")).join("");
  }
  return null;
}

/**
 * Properties that can carry a colour, shorthands included.
 *
 * The shorthands are here because `border-left: 3px solid var(--warn)` is the stylesheet's own way
 * of saying "coloured AND shaped", and a sweep that only understood `border-left-color` would read
 * that rule as colour-only and demand a second channel the rule already has.
 */
export const COLOR_PROPERTIES: readonly string[] = [
  "color", "background", "background-color", "border", "border-color",
  "border-top", "border-right", "border-bottom", "border-left",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "outline", "outline-color", "fill", "stroke", "caret-color",
  "text-decoration-color", "column-rule-color", "box-shadow",
];

/** The first opaque colour in a declaration value, so shorthands resolve. Null when there is none. */
export function colorInValue(value: string, vars: ReadonlyMap<string, string>): string | null {
  for (const token of value.split(/\s+/)) {
    const hex = resolveColor(token, vars);
    if (hex !== null) return hex;
  }
  return resolveColor(value, vars);
}
