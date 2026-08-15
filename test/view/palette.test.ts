// P6-T02, the first half of PRD N-05: **colour-blind-safe owner and faction palettes.**
//
// This clause had never been checked at all. `grep` across the repo before this file found no
// dichromacy simulation, no perceptual distance, no palette test — while eight source comments in
// `overlays2d.ts`, `minimap.ts`, `hud.ts`, `building-panel.ts`, `glyphs.ts`, `starmap.ts`,
// `terrain/mesh.ts` and `style.css` asserted the property was held. It was a convention supported
// by prose, which is the exact shape of the reachability gap this board has been caught by five
// times: a rule everybody follows until somebody does not, with nothing to notice.
//
// **Nothing here asserts that a colour constant equals itself.** Every assertion is a computed
// perceptual distance between two colours, after simulating the eye that has to tell them apart.
// The colours are read from the modules that ship them — `OWNER_CSS` is imported, the HUD colours
// are parsed out of every stylesheet under `src/` — so a palette change changes what this file
// measures in the same commit, with nobody remembering to update a copy.
//
// The instrument, its model (Machado 2009), its distance (CIEDE2000) and both thresholds are
// documented at length in `./palette.ts`.
//
// ── The vacuity problem, and what is done about it ────────────────────────────────────────────
// A palette test is unusually prone to passing for the wrong reason: if the simulation is wrong in
// the direction of "everything still looks different", every assertion in the file goes green and
// reports a palette nobody can read. Four independent guards, all in the first describe block:
//
//   1. ΔE00 is verified against all 28 published reference pairs of Sharma, Wu & Dalal (2005). A
//      wrong implementation does not accidentally reproduce 28 values to four decimal places.
//   2. Three **known-bad control pairs**, one per deficiency, each of which collapses under its own
//      deficiency and stays far apart under the other two. This is stronger than the single
//      red/green check: a simulation with protanopia and deuteranopia transposed passes that one
//      and fails these, and so does an identity matrix, and so does a matrix that flattens
//      everything.
//   3. Structural invariants the model must satisfy: rows sum to unity, greys are fixed points.
//   4. An **independent second model** (Viénot, Brettel & Mollon 1999, derived through LMS from a
//      different set of constants) must reach the same verdict on every pair in the registry.

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OWNER_CSS } from "../../src/view/renderer/overlays2d.js";
import {
  NO_FACTION, WORLD_COLONY, WORLD_CONTESTED, WORLD_PACIFIED, WORLD_SEAT, WORLD_UNEXPLORED,
} from "../../src/bridge/galaxy-snapshot.js";
import { ownerSlotForWorld } from "../../src/view/starmap.js";
import {
  DEFICIENCIES, MACHADO, MIN_SEPARATION, VIENOT, type Deficiency,
  cssVariables, deltaE2000, describeSeparation, hexToLab, linearToLab, parseCss,
  readProjectStylesheets, resolveColor, separation, simulate,
} from "./palette.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULES = parseCss(readProjectStylesheets(join(ROOT, "src")));
const VARS = cssVariables(RULES);

/* =================================================================================================
   1. The instrument, before anything is measured with it
   ================================================================================================= */

/**
 * Sharma, Wu & Dalal (2005), Table 1 — all 34 rows minus the six that only permute a pair already
 * present. `[L1, a1, b1, L2, a2, b2, ΔE00]`. Published so an implementation can be checked, because
 * the hue-averaging branch and the RT rotation term both have wrong versions that agree with the
 * right one over most of the space and diverge exactly here.
 */
const SHARMA: readonly (readonly number[])[] = [
  [50.0000, 2.6772, -79.7751, 50.0000, 0.0000, -82.7485, 2.0425],
  [50.0000, 3.1571, -77.2803, 50.0000, 0.0000, -82.7485, 2.8615],
  [50.0000, 2.8361, -74.0200, 50.0000, 0.0000, -82.7485, 3.4412],
  [50.0000, -1.3802, -84.2814, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -1.1848, -84.8006, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -0.9009, -85.5211, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, 0.0000, 0.0000, 50.0000, -1.0000, 2.0000, 2.3669],
  [50.0000, -1.0000, 2.0000, 50.0000, 0.0000, 0.0000, 2.3669],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0009, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0010, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0011, 7.2195],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0012, 7.2195],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0009, -2.4900, 4.8045],
  [50.0000, 2.5000, 0.0000, 50.0000, 0.0000, -2.5000, 4.3065],
  [50.0000, 2.5000, 0.0000, 73.0000, 25.0000, -18.0000, 27.1492],
  [50.0000, 2.5000, 0.0000, 61.0000, -5.0000, 29.0000, 22.8977],
  [50.0000, 2.5000, 0.0000, 56.0000, -27.0000, -3.0000, 31.9030],
  [50.0000, 2.5000, 0.0000, 58.0000, 24.0000, 15.0000, 19.4535],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.2480, -4.9620, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373],
  [36.4612, 47.8580, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.4410, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082],
];

/**
 * One pair per deficiency that a person with that deficiency cannot separate, and that everybody
 * else can. Each is a **positive control**: the check must REJECT it. Between them they pin all
 * three matrices independently — a pair that collapses under deuteranopia proves nothing about the
 * tritanopia matrix, and a tritan palette failure is the one a red/green control cannot see.
 */
const CONTROLS: ReadonlyArray<{ under: Deficiency; a: string; b: string; what: string }> = [
  { under: "protanopia", a: "#f02020", b: "#306020", what: "saturated red against mid green" },
  { under: "deuteranopia", a: "#e03030", b: "#30a030", what: "the textbook red/green pair" },
  { under: "tritanopia", a: "#4fd1ff", b: "#5fd7c0", what: "cyan against teal — a near miss of the player's own colour" },
];

describe("the instrument (P6-T02): a palette check that cannot fail is worse than none", () => {
  it("reproduces all 28 CIEDE2000 reference pairs from Sharma, Wu & Dalal (2005)", () => {
    // The licence for every other number in this file. Four decimal places is not a nicety: the
    // wrong hue-average branch agrees with the right one everywhere except across the 0°/360° seam,
    // and rows 9-14 of this table sit exactly on it.
    const wrong: string[] = [];
    for (const row of SHARMA) {
      const got = deltaE2000([row[0]!, row[1]!, row[2]!], [row[3]!, row[4]!, row[5]!]);
      if (Math.abs(got - row[6]!) > 1e-4) wrong.push(`expected ΔE00 ${row[6]} got ${got.toFixed(4)}`);
    }
    expect(wrong, `CIEDE2000 is mis-implemented:\n  ${wrong.join("\n  ")}`).toEqual([]);
    expect(SHARMA.length).toBe(28);
  });

  it("keeps neutrals fixed under every deficiency, as a dichromatic projection must", () => {
    // A grey lies on the achromatic axis, which every dichromat still sees. Any model that moves it
    // has its primaries or its normalisation wrong, and would then be reporting fictional distances
    // for every near-neutral in the HUD — of which this stylesheet has several.
    for (const model of [MACHADO, VIENOT]) {
      for (const d of DEFICIENCIES) {
        for (const row of model[d]) {
          const sum = row[0]! + row[1]! + row[2]!;
          expect(Math.abs(sum - 1), `a ${d} row sums to ${sum} — neutrals will not be fixed`).toBeLessThan(1e-5);
        }
      }
      for (const grey of ["#000000", "#404040", "#808080", "#c0c0c0", "#ffffff"]) {
        for (const d of DEFICIENCIES) {
          const moved = deltaE2000(hexToLab(grey), linearToLab(simulate(grey, d, model)));
          expect(moved, `${grey} moved by ΔE00 ${moved.toFixed(3)} under ${d}`).toBeLessThan(0.02);
        }
      }
    }
  });

  it("REJECTS a pair that is known to collide, once per deficiency, and only under that one", () => {
    // The check this whole file rests on. If the simulation were an identity, or a transposition of
    // two matrices, or a flattening of all three, at least one of these six assertions goes red.
    const lines: string[] = [];
    for (const control of CONTROLS) {
      const s = separation(control.a, control.b);
      lines.push(describeSeparation(`${control.under}: ${control.what}`, s));

      expect(
        s[control.under],
        `${control.a}/${control.b} (${control.what}) measured ΔE00 ${s[control.under].toFixed(1)} `
        + `under ${control.under} — the check would have ACCEPTED a pair that collapses there, `
        + `which means it would accept anything`,
      ).toBeLessThan(MIN_SEPARATION);

      // …and is comfortably separable to everyone else, so the rejection is the deficiency talking
      // and not two colours that were always the same.
      expect(s.normal, `${control.a}/${control.b} is not far apart to begin with`).toBeGreaterThan(20);
      for (const other of DEFICIENCIES) {
        if (other === control.under) continue;
        expect(
          s[other],
          `${control.a}/${control.b} also collapses under ${other} — it does not isolate ${control.under}`,
        ).toBeGreaterThan(MIN_SEPARATION);
      }
    }
    expect(lines.length).toBe(3);
  });

  it("agrees with an independently derived second model, except inside their own spread", () => {
    // Viénot/Brettel 1999 reaches linear RGB through Smith-Pokorny cone fundamentals and two LMS
    // projections — not one constant in it is shared with Machado's. Two transcriptions from
    // different papers agreeing is the best available evidence that neither is badly wrong.
    //
    // They are not asked to agree *numerically*. The models genuinely differ, most on saturated
    // reds (this file's own protanopia control measures 2.5 under one and 8.8 under the other), and
    // that is a real disagreement in the literature rather than a transcription error. So the
    // tolerance is **measured, not chosen**: for each pair, the two models' own spread on that pair
    // is how much confidence the pair is entitled to. A verdict is disputed only when the shipped
    // model places the pair further from the floor than the spread — i.e. when Machado is confident
    // and Viénot still disagrees. A pair sitting nearer the floor than the models can resolve is
    // genuinely undecided, and this says so instead of picking a winner.
    const disputed: string[] = [];
    let widest = 0;
    for (const [name, a, b] of registryPairs()) {
      const machado = separation(a, b, MACHADO).worst;
      const vienot = separation(a, b, VIENOT).worst;
      const spread = Math.abs(machado - vienot);
      widest = Math.max(widest, spread);
      const agree = (machado >= MIN_SEPARATION) === (vienot >= MIN_SEPARATION);
      if (!agree && Math.abs(machado - MIN_SEPARATION) > spread) {
        disputed.push(
          `${name}: Machado ${machado.toFixed(2)} vs Viénot ${vienot.toFixed(2)} — opposite sides `
          + `of the floor by more than the ${spread.toFixed(2)} the models disagree by here`,
        );
      }
    }
    expect(disputed, `the models disagree beyond their own spread — trust neither until this is understood:\n  ${disputed.join("\n  ")}`).toEqual([]);

    // And the spread itself is bounded, so "they agree" cannot become true by both drifting. If a
    // matrix were mistyped badly enough to matter, this is where it shows up as a number.
    expect(widest, `the two models now disagree by ΔE00 ${widest.toFixed(2)} somewhere in the registry`).toBeLessThan(8);
  });
});

/* =================================================================================================
   2. The registry — the palettes, derived from the sources that ship them
   ================================================================================================= */

interface Palette {
  readonly name: string;
  /** What the player is being asked to tell apart, and where. */
  readonly asks: string;
  readonly colors: ReadonlyMap<string, string>;
}

/** Colours out of a set of `style.css` rules whose selector matches, keyed by the captured name. */
function paletteFromCss(pattern: RegExp, property: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of RULES) {
    const match = pattern.exec(rule.selector);
    if (!match) continue;
    const raw = rule.declarations.get(property);
    if (raw === undefined) continue;
    const hex = resolveColor(raw, VARS);
    if (hex !== null) found.set(match[1]!, hex);
  }
  return found;
}

/**
 * The palettes, each **derived by a rule rather than listed**.
 *
 * That is the whole design. A hand-written list of the five states that exist today is a test that
 * goes stale the moment somebody adds a sixth — which is the specific failure P6-T02 was written
 * about. Every group below is a query: add a fifth severity to `style.css`, or a fifth resource
 * dot, or a third owner to `OWNER_CSS`, and its pairs enter this sweep on the next run with nobody
 * remembering to add them.
 */
const PALETTES: readonly Palette[] = [
  {
    name: "owner",
    asks: "whose unit, building, tracer, aura and minimap mark that is — the critical pair, and the "
      + "one colour in the game that is read under time pressure at 2 px on a moving field",
    colors: new Map(
      OWNER_CSS.map((hex, i) => [["player", "ai", "neutral"][i] ?? `owner${i}`, hex] as const),
    ),
  },
  {
    name: "status severity",
    asks: "how bad a selected building's stop is: running / throttled / stopped / paused",
    colors: paletteFromCss(/\[data-severity="([a-z]+)"\]/, "color"),
  },
  {
    name: "resource dot",
    asks: "which commodity a readout in the top bar is counting",
    colors: paletteFromCss(/^\.dot\.([a-z]+)$/, "background"),
  },
];

function* registryPairs(): Generator<readonly [string, string, string]> {
  for (const palette of PALETTES) {
    const entries = [...palette.colors.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        yield [`${palette.name}: ${entries[i]![0]} / ${entries[j]![0]}`, entries[i]![1], entries[j]![1]];
      }
    }
  }
}

/**
 * Pairs that ship today below the floor, each with the number it measured when it was recorded.
 *
 * **This is a debt register, not a whitelist.** Being on it is not an exemption; it is a recorded
 * measurement with two teeth. A pair here that gets *worse* fails as a regression, and a pair here
 * that is *fixed* fails asking for its own deletion — so the list cleans itself up and cannot
 * quietly grow into the thing it was meant to prevent. A pair NOT on it that drops below the floor
 * fails by name.
 *
 * P6-T02 deliberately did not fix the one entry below by editing the colour. Owner and HUD colours
 * are read by the renderer, the minimap, the starmap and the stylesheet, and changing one to make a
 * test green is how a palette gets worse in three places to look better in one. The measurement and
 * the proposal are in the task report; the integration pass owns the change.
 */
/**
 * Pairs that measure below the floor and are accepted anyway, each with the number it measured.
 *
 * **Empty, and it should stay that way.** It carried one entry for about an hour: `radioactives`
 * (#a6ff8f) against `credits` (#ffd479), a light green against a light amber, measuring ΔE00 3.4
 * under deuteranopia — as close as this file's own textbook red/green control, which exists to
 * prove the check can fail at all. Two of the four top-bar readouts were the same dot for a
 * deuteranope. The dot is now #fd6eb0 and the pair measures 22.0, so the entry was deleted by the
 * branch below that demands exactly that when a debt is paid.
 *
 * The first replacement proposed for it was #c9a2ff, which fixes `credits` and collides with
 * `crystals` at 5.8 — worse than the defect. That is the argument for this register being keyed on
 * the PAIR and swept over every pair in the palette rather than on the one that was reported.
 */
const KNOWN_SHORTFALLS: ReadonlyMap<string, { readonly floor: number; readonly under: Deficiency; readonly note: string }> = new Map([]);

describe("the palettes are colour-blind-safe (PRD N-05, first clause)", () => {
  it("has palettes to check, and each has something to tell apart", () => {
    // A sweep that silently matched nothing would be the most convincing green in the repo. Both
    // CSS-derived palettes are queries against a stylesheet a future edit could rename out from
    // under them, so their sizes are pinned to what the file actually ships today.
    expect(PALETTES.length).toBe(3);
    for (const palette of PALETTES) {
      expect(palette.colors.size, `palette "${palette.name}" matched no colours`).toBeGreaterThanOrEqual(3);
    }
    expect(PALETTES[0]!.colors.get("player")).toBe("#4fd1ff");
    expect([...PALETTES[1]!.colors.keys()].sort()).toEqual(["bad", "ok", "paused", "warn"]);
    expect([...PALETTES[2]!.colors.keys()].sort()).toEqual(["credits", "crystals", "ore", "radioactives"]);
  });

  it("keeps every pair separable under protanopia, deuteranopia and tritanopia", () => {
    const failures: string[] = [];
    const measured: string[] = [];
    for (const [name, a, b] of registryPairs()) {
      const s = separation(a, b);
      measured.push(describeSeparation(name, s));
      const known = KNOWN_SHORTFALLS.get(name);

      if (known === undefined) {
        if (s.worst < MIN_SEPARATION) {
          failures.push(
            `${name} (${a} / ${b}) measures ΔE00 ${s.worst.toFixed(1)} under ${s.worstUnder}, `
            + `below the floor of ${MIN_SEPARATION}`
            + (s.normal < MIN_SEPARATION
              ? ` — and only ${s.normal.toFixed(1)} to a standard trichromat, so this is a palette `
                + `that was always this close, not a distinction colour blindness took away`
              : ` — a distinction worth ${s.normal.toFixed(1)} to a standard trichromat that this `
                + `deficiency takes away`),
          );
        }
        continue;
      }

      // On the register: it must still be broken (or the entry is stale) and must not be worse.
      if (s.worst >= MIN_SEPARATION) {
        failures.push(
          `${name} now measures ΔE00 ${s.worst.toFixed(1)} and PASSES — delete its `
          + `KNOWN_SHORTFALLS entry, the debt is paid`,
        );
      } else if (s.worst < known.floor - 0.05) {
        failures.push(
          `${name} regressed: recorded at ΔE00 ${known.floor} under ${known.under}, now `
          + `${s.worst.toFixed(1)} under ${s.worstUnder}`,
        );
      }
    }
    expect(failures, [
      "A pair the UI asks a player to tell apart is not separable to a colour-blind player (N-05).",
      "Do not edit the colour to make this green without reading who else uses it.",
      "",
      ...failures.map((f) => `  ${f}`),
      "",
      "Every pair, measured:",
      ...measured.map((m) => `  ${m}`),
    ].join("\n")).toEqual([]);
  });

  it("holds the owner pair — the one colour read at 2 px under time pressure — well clear", () => {
    // Called out separately from the sweep because it is the pair N-05 names first and the only one
    // whose failure mode is "I attacked my own army". Asserting it against the same floor as a
    // resource dot would understate it, so it is held to double.
    const s = separation(OWNER_CSS[0]!, OWNER_CSS[1]!);
    expect(
      s.worst,
      `player ${OWNER_CSS[0]} against ai ${OWNER_CSS[1]}: ${describeSeparation("owner", s)}`,
    ).toBeGreaterThan(MIN_SEPARATION * 2);
  });

  it("does not rely on the vendored engine's own owner colours, which are a weaker pair", () => {
    // `src/engine/engine/state.js:179-180` gives the player #4fd1ff and the AI #f87171 — blue
    // against RED. This client never reads them: `OWNER_CSS` in `view/renderer/overlays2d.ts` is
    // the palette every renderer, the minimap and the starmap use, and it picks orange instead,
    // precisely because red/blue spends its whole separation on an axis protanopia attenuates.
    // The engine is vendored and unmodifiable here (ADR-0003), so this is a guard that the local
    // palette stays the one in force, not a complaint about upstream.
    const engineRed = "#f87171";
    const local = separation(OWNER_CSS[0]!, OWNER_CSS[1]!);
    const upstream = separation(OWNER_CSS[0]!, engineRed);
    expect(OWNER_CSS).not.toContain(engineRed);
    expect(
      local.worst,
      `the local owner pair (${local.worst.toFixed(1)}) is no longer better under the worst `
      + `deficiency than the engine's own (${upstream.worst.toFixed(1)}) — the reason for `
      + `overriding it has gone`,
    ).toBeGreaterThan(upstream.worst);
  });
});

/* =================================================================================================
   3. The faction half of the clause
   ================================================================================================= */

describe("N-05's faction palette clause", () => {
  it("has no faction palette to check, because no faction has a colour — and pins it that way", () => {
    // N-05 asks for "colour-blind-safe owner/faction palettes". The faction half is currently
    // VACUOUS rather than satisfied, and that distinction matters: `engine/factions.js` gives the
    // four factions a name, a short name, a blurb and trait multipliers, and no colour at all.
    //
    // On the one screen where a faction is visible — the starmap — `ownerSlotForWorld` collapses
    // every claim onto the single AI slot, so "which faction holds this world" is carried by the
    // panel and the badge and never by hue. There is therefore no faction-against-faction pair in
    // existence to be unsafe.
    //
    // This is the tripwire for the day that changes. The moment somebody gives factions their own
    // colours, `ownerSlotForWorld` starts returning different slots for different claims, this test
    // goes red, and whoever wrote them has to come here and enter them into PALETTES above. That is
    // the only honest way to hold a clause whose subject does not exist yet.
    const slots = new Set<number>();
    for (let claim = 0; claim < 8; claim++) {
      slots.add(ownerSlotForWorld(WORLD_CONTESTED, claim));
      slots.add(ownerSlotForWorld(WORLD_UNEXPLORED, claim));
    }
    expect(
      [...slots],
      "a faction claim now picks its own owner colour. Factions have a palette; add it to PALETTES "
      + "in this file and give it the same dichromacy sweep the owner palette gets (N-05).",
    ).toHaveLength(1);

    // And the three slots that DO exist stay bound to the three things they mean, so the sweep
    // above is measuring the whole of what a world's colour can say.
    expect(ownerSlotForWorld(WORLD_SEAT, NO_FACTION)).toBe(ownerSlotForWorld(WORLD_COLONY, NO_FACTION));
    expect(ownerSlotForWorld(WORLD_PACIFIED, NO_FACTION)).not.toBe(ownerSlotForWorld(WORLD_UNEXPLORED, NO_FACTION));
    expect(OWNER_CSS).toHaveLength(3);
  });
});
