// @vitest-environment jsdom
//
// P6-T02, the second half of PRD N-05: **no information conveyed by colour alone.**
//
// Before this file, that clause was held by eight source comments and nothing else. Each of them
// was correct — `building-panel.ts` carries a severity the HUD renders as a glyph, `minimap.ts`
// distinguishes buildings from units by size, `style.css` dims an unaffordable button *and* strikes
// its cost through — and not one of them could fail. A convention held by comments is a convention
// that holds until the first person who does not read them, and this board has now been caught by
// that exact shape five times.
//
// ── Why this is a sweep and not a list ────────────────────────────────────────────────────────
// The obvious test enumerates the five known-good cases and asserts them. It passes forever, it is
// green the day somebody adds a sixth state carried by hue alone, and it is worth almost nothing.
// So the unit here is not "a case somebody remembered" but **a state group derived from the
// stylesheet**: every set of rules that assigns different colours to different states of the same
// element. The set is computed on every run, so a new state class enters the sweep by existing.
//
// ── What "not colour alone" is taken to mean ─────────────────────────────────────────────────
// The strict reading, because it is the only one that is checkable: the distinction must survive
// colour being **removed entirely**, not merely survive dichromacy. A dichromat can still see hue,
// just less of it; a greyscale screenshot, a monochrome display and an achromatopsic player cannot.
// Only lightness survives that, so a group passes on colour alone only if its L* values are far
// enough apart on their own (`MIN_LIGHTNESS_STEP`).
//
// A group that cannot pass on lightness must carry its difference somewhere else, and there are
// exactly two places that can be: another CSS property, or the DOM. The second is what the register
// at the bottom of the first describe block is for — and being on that register is not an
// exemption, because each entry names a proof function that this file **executes**. An entry
// without a working proof fails; a proof that stops proving fails; an entry whose group has gone
// fails as stale. The register cannot become the rubber stamp it would otherwise be.
//
// ── Exactly how far the sweep reaches, checked by mutation ───────────────────────────────────
// Worth stating precisely, because "a new hue-only state enters the sweep by existing" is true of
// the DERIVATION and not of every consequence, and an overstated guard is one the next reader
// trusts too far:
//
//   • **Caught.** Removing the status glyph. Declaring a fifth severity in `BuildingPanelModel`'s
//     union without styling or glyphing it — that fails naming the severity. A register entry going
//     stale, or its proof ceasing to prove.
//   • **NOT caught.** A new state added to a stylesheet ALONE, inside a group already discharged by
//     a DOM channel — `.hud-status.stale` or a fifth `.dot`. Both were mutated in and both stay
//     green. That is the right answer rather than a hole, and the reason is worth having in
//     writing: the model side is swept exhaustively and the CSS side only for states the model can
//     actually produce, so CSS for a state nothing emits is **dead CSS, not an accessibility
//     defect**. The moment anything can emit it, the union sweep above fails.
//
// The other blind spots are listed at the foot of this file.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HudView, hudModel } from "../../src/ui/hud.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { type BuildingPanelModel } from "../../src/ui/building-panel.js";
import {
  COLOR_PROPERTIES, MIN_LIGHTNESS_STEP,
  colorInValue, cssVariables, lightness, parseCss, readProjectStylesheets,
} from "../view/palette.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PANEL_SOURCE = readFileSync(join(ROOT, "src", "ui", "building-panel.ts"), "utf8");
const RULES = parseCss(readProjectStylesheets(join(ROOT, "src")));
const VARS = cssVariables(RULES);
const SEED = 20260814;

/* =================================================================================================
   Deriving the state groups
   ================================================================================================= */

/**
 * A compound selector split into the element it targets and the state that qualifies it.
 *
 * `.hud-status[data-severity="ok"]` → `.hud-status` + `[data-severity="ok"]`.
 * `.hud-res.blocked b`              → `.hud-res b`  + `.blocked`.
 * `.dot.ore`                        → `.dot`        + `.ore`.
 *
 * The qualifier is stripped from **every** compound, not just the last: `.hud-res.blocked b` is the
 * blocked state of `.hud-res b`, and a splitter that only looked at the final compound would file
 * it under a base of its own and never notice it is one of two states of the same text.
 */
const COMPOUND = /^(\*|[a-z]+|\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+)((?:\[[^\]]+\]|:{1,2}[a-z-]+(?:\([^)]*\))?|\.[A-Za-z0-9_-]+)*)$/;

function splitState(selector: string): { base: string; state: string | null } {
  const bases: string[] = [];
  const states: string[] = [];
  for (const part of selector.trim().split(/\s+/)) {
    if (part === ">" || part === "+" || part === "~") { bases.push(part); continue; }
    const m = COMPOUND.exec(part);
    if (!m) { bases.push(part); continue; }
    bases.push(m[1]!);
    if (m[2]) states.push(m[2]);
  }
  return { base: bases.join(" "), state: states.length > 0 ? states.join("") : null };
}

/**
 * Pointer-transient pseudo-classes, excluded with a reason rather than by accident.
 *
 * `:hover` and `:active` describe where a mouse already is. A player who cannot see the hover
 * highlight has not lost information, because the cursor is sitting on the thing; the highlight is
 * an affordance, not a message. `:focus` is deliberately NOT excluded — a focus ring is the only
 * thing telling a keyboard user where they are, and losing it loses everything. It does not appear
 * in this stylesheet yet, which is P6-T03's row, and this sweep will be waiting when it does.
 */
const TRANSIENT = /:(hover|active)\b/;

/**
 * Non-colour properties that actually encode a visible difference.
 *
 * An explicit list rather than "anything that is not a colour", because `margin-top: 3px` on a state
 * rule would satisfy the looser version while telling a player nothing. It goes stale in the SAFE
 * direction: a genuine new channel that is not listed makes the sweep **fail**, and a human adds it
 * here having thought about whether it really is one.
 */
const SECOND_CHANNEL_PROPERTIES: readonly string[] = [
  "opacity", "visibility", "display", "content", "transform", "filter",
  "text-decoration", "text-decoration-line", "text-decoration-style",
  "font-weight", "font-style", "font-size", "font-variant", "text-transform", "letter-spacing",
  "border", "border-width", "border-style", "border-left", "border-right", "border-top",
  "border-bottom", "border-left-width", "border-top-width", "border-right-width",
  "border-bottom-width", "border-radius", "outline", "outline-width", "outline-style",
  "outline-offset", "box-shadow", "text-shadow",
];

interface StateGroup {
  /** `.hud-status ⟨color⟩` — the element and the property whose value the states disagree about. */
  readonly key: string;
  /** state qualifier (or `(base)`) → the opaque colour it sets. */
  readonly colors: ReadonlyMap<string, string>;
  /** Non-colour properties any of the STATES sets. The base's own styling is not a distinction. */
  readonly otherChannels: ReadonlySet<string>;
}

function stateGroups(): StateGroup[] {
  const colors = new Map<string, Map<string, string>>();
  const channels = new Map<string, Set<string>>();
  const bases = new Map<string, Set<string>>();

  for (const rule of RULES) {
    for (const selector of rule.selector.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (TRANSIENT.test(selector)) continue;
      const { base, state } = splitState(selector);
      for (const prop of COLOR_PROPERTIES) {
        const raw = rule.declarations.get(prop);
        if (raw === undefined) continue;
        const hex = colorInValue(raw, VARS);
        // A translucent value is skipped rather than composited: what colour it really is depends
        // on what is behind it, and inventing a backdrop puts a number in a test that no pixel on
        // screen ever takes. Recorded as a blind spot in "what this cannot catch", below.
        if (hex === null) continue;
        const key = `${base} ⟨${prop}⟩`;
        if (!colors.has(key)) colors.set(key, new Map());
        colors.get(key)!.set(state ?? "(base)", hex);
        if (!bases.has(base)) bases.set(base, new Set());
      }
      if (state === null) continue;
      for (const prop of rule.declarations.keys()) {
        if (!SECOND_CHANNEL_PROPERTIES.includes(prop)) continue;
        if (!channels.has(base)) channels.set(base, new Set());
        channels.get(base)!.add(prop);
      }
    }
  }

  const groups: StateGroup[] = [];
  for (const [key, members] of colors) {
    if (new Set(members.values()).size < 2) continue;
    const base = key.slice(0, key.lastIndexOf(" ⟨"));
    groups.push({ key, colors: members, otherChannels: channels.get(base) ?? new Set() });
  }
  return groups;
}

const GROUPS = stateGroups();

/* =================================================================================================
   The register — groups whose second channel lives in the DOM, each with a proof this file runs
   ================================================================================================= */

/** A real world with a base down, so `hudModel` has something to describe. */
function opened(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
  const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
  bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  bridge.enqueue({ kind: "deploy" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

function mountedHud(): { root: HTMLElement; view: HudView; bridge: WorldBridge } {
  const root = document.createElement("div");
  document.body.append(root);
  return { root, view: new HudView(root, { onCommand: () => {} }), bridge: opened() };
}

/**
 * The severity vocabulary, read out of the union that declares it rather than copied.
 *
 * This is what makes the glyph proof a sweep. Add `"critical"` to `BuildingPanelModel["severity"]`
 * and it is enumerated here on the next run; `hud.ts`'s glyph chain ends in a bare `else` that
 * would hand it the same `■` as `bad`, and the proof fails naming both. A hand-written list of the
 * four severities that exist today would have gone green.
 */
function declaredSeverities(): string[] {
  const decl = /readonly severity:\s*([^;]+);/.exec(PANEL_SOURCE);
  if (!decl) throw new Error("BuildingPanelModel no longer declares `severity` as a union — this sweep is blind");
  return [...decl[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
}

/** The glyph the HUD puts in front of the status line, for one severity. */
function statusTextFor(severity: string): string {
  const { root, view, bridge } = mountedHud();
  const base = hudModel(bridge.snapshot);
  const detail: BuildingPanelModel = {
    ...base.buildingDetail,
    building: { id: "b1", label: "Smelter", type: "smelter" },
    // The same sentence for every severity on purpose: whatever separates the four rendered strings
    // is then the badge and nothing else. Sharing the words is what isolates the channel.
    statusText: "the same words for every severity",
    severity: severity as BuildingPanelModel["severity"],
  };
  view.render({ ...base, buildingDetail: detail });
  const status = root.querySelector<HTMLElement>('[data-hud="status"]');
  return status?.textContent ?? "";
}

function proveStatusGlyph(): void {
  const severities = declaredSeverities();
  expect(severities.length, "no severities were parsed out of BuildingPanelModel").toBeGreaterThanOrEqual(4);

  const rendered = new Map<string, string>();
  for (const severity of severities) rendered.set(severity, statusTextFor(severity));

  for (const [severity, text] of rendered) {
    expect(text, `severity "${severity}" rendered no status text at all`).not.toBe("");
    const glyph = text.replace("the same words for every severity", "").trim();
    expect(
      glyph,
      `severity "${severity}" renders no glyph — its status is a colour and nothing else (N-05)`,
    ).not.toBe("");
    // A letter would be a second channel too, but it would also be a word, and the HUD's own claim
    // is that the badge is a SYMBOL. Asserting that keeps "W" for warn from passing as a glyph.
    expect(/[A-Za-z0-9]/.test(glyph), `severity "${severity}" uses "${glyph}" as its badge; a letter is text, not a badge`).toBe(false);
  }

  const collisions: string[] = [];
  const seen = new Map<string, string>();
  for (const [severity, text] of rendered) {
    const previous = seen.get(text);
    if (previous !== undefined) collisions.push(`"${previous}" and "${severity}" render identically`);
    seen.set(text, severity);
  }
  expect(collisions, [
    "Two building severities are distinguishable only by their colour (PRD N-05).",
    "`hud.ts` picks the glyph with a ternary chain ending in a bare else, so a severity added to",
    "`BuildingPanelModel` without a branch silently inherits another one's badge.",
    ...collisions.map((c) => `  ${c}`),
  ].join("\n")).toEqual([]);
}

function proveResourceLabel(): void {
  const { root, view, bridge } = mountedHud();
  view.render(hudModel(bridge.snapshot));

  const dots = [...root.querySelectorAll<HTMLElement>("i.dot")];
  expect(dots.length, "the top bar renders no resource dots — this proof is measuring nothing").toBeGreaterThanOrEqual(4);

  const unlabelled: string[] = [];
  for (const dot of dots) {
    // The commodity name has to be in the text NEXT TO the dot, not merely somewhere on the page:
    // a word elsewhere in the HUD would not tell a player which dot is which.
    const commodity = [...dot.classList].find((c) => c !== "dot");
    const beside = dot.parentElement?.textContent ?? "";
    if (commodity === undefined || !beside.includes(commodity)) {
      unlabelled.push(`${commodity ?? "?"} — the readout beside it reads ${JSON.stringify(beside)}`);
    }
  }
  expect(unlabelled, [
    "A resource dot's colour is the only thing saying which commodity it counts (PRD N-05).",
    "The label is why this register entry is legitimate rather than a note someone wrote to",
    "silence a test — and it was load-bearing for about an hour: `radioactives` (#a6ff8f) and",
    "`credits` (#ffd479) measured ΔE00 3.4 apart under deuteranopia, as close as this repo's own",
    "textbook red/green control, so for that player the two dots WERE the same dot and the word",
    "beside them was the only thing telling them apart. The dot is now #fd6eb0 and the pair",
    "measures 22.0, so the label is a second channel again rather than the only one.",
    ...unlabelled.map((u) => `  ${u}`),
  ].join("\n")).toEqual([]);
}

/**
 * Groups that carry their difference in the DOM rather than in CSS.
 *
 * Each entry names the channel and the proof. The sweep **calls** the proof, so an entry cannot be
 * a note somebody wrote to make a test pass: adding one means writing something that drives the
 * real HUD and shows the channel is there.
 */
const DOM_SECOND_CHANNELS: ReadonlyMap<string, { readonly channel: string; readonly prove: () => void }> = new Map([
  [".hud-status ⟨color⟩", {
    channel: "a glyph prefixed to the status text by hud.ts (▶ ❙❙ ▲ ■)",
    prove: proveStatusGlyph,
  }],
  [".dot ⟨background⟩", {
    channel: "the commodity's name printed beside the dot in the top bar",
    prove: proveResourceLabel,
  }],
]);

/* =================================================================================================
   The sweep
   ================================================================================================= */

describe("no information is conveyed by colour alone (PRD N-05, second clause)", () => {
  it("finds state groups to check", () => {
    // A sweep that silently matched nothing would be the most convincing green in the repo, and
    // this one is a regex over a stylesheet that a reformat could quietly defeat.
    expect(RULES.length, "the stylesheet parsed to nothing").toBeGreaterThan(30);
    expect(GROUPS.length, "no state group was derived — the selector splitter has stopped matching").toBeGreaterThanOrEqual(4);
    expect(GROUPS.map((g) => g.key)).toContain(".hud-status ⟨color⟩");
    expect(GROUPS.map((g) => g.key)).toContain(".dot ⟨background⟩");
  });

  it("carries every colour-coded state on a second channel, and names the ones that do not", () => {
    const failures: string[] = [];
    const measured: string[] = [];

    for (const group of GROUPS) {
      const entries = [...group.colors.entries()];
      let narrowest = Infinity;
      let narrowestPair = "";
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const step = Math.abs(lightness(entries[i]![1]) - lightness(entries[j]![1]));
          if (step < narrowest) {
            narrowest = step;
            narrowestPair = `${entries[i]![0]} / ${entries[j]![0]}`;
          }
        }
      }
      const registered = DOM_SECOND_CHANNELS.get(group.key);
      const verdict = narrowest >= MIN_LIGHTNESS_STEP ? "lightness"
        : group.otherChannels.size > 0 ? `css:${[...group.otherChannels].join("+")}`
          : registered ? "dom" : "NONE";
      measured.push(
        `${group.key.padEnd(30)} ${String(entries.length).padStart(2)} states, narrowest ΔL* `
        + `${narrowest.toFixed(1).padStart(5)} (${narrowestPair}) → ${verdict}`,
      );

      if (verdict !== "NONE") {
        // Being on the register is a debt, and this is where it is collected: the proof runs here,
        // in the sweep, so the entry and the evidence cannot drift apart.
        if (verdict === "dom") registered!.prove();
        continue;
      }
      failures.push(
        `${group.key} separates ${entries.length} states by colour only. Its narrowest pair `
        + `(${narrowestPair}) differs by ΔL* ${narrowest.toFixed(1)}, under the ${MIN_LIGHTNESS_STEP} `
        + `a distinction needs to survive colour being removed, and no state in the group sets a `
        + `non-colour property. Give it a shape, a weight, a border or a glyph — or, if the cue is `
        + `already in the DOM, add it to DOM_SECOND_CHANNELS with a proof.`,
      );
    }

    expect(failures, [
      "A state of the UI is signalled by hue and nothing else (PRD N-05).",
      "",
      ...failures.map((f) => `  ${f}`),
      "",
      "Every state group, measured:",
      ...measured.map((m) => `  ${m}`),
    ].join("\n")).toEqual([]);
  });

  it("keeps the register honest: no entry survives the group it was written for", () => {
    // The failure mode of every exemption list ever written. An entry whose group has been renamed
    // or deleted stops meaning anything and starts hiding whatever inherits its key.
    const keys = new Set(GROUPS.map((g) => g.key));
    const stale = [...DOM_SECOND_CHANNELS.keys()].filter((k) => !keys.has(k));
    expect(stale, `these DOM_SECOND_CHANNELS entries name groups that no longer exist:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});

/* =================================================================================================
   The two DOM channels, on their own, so a failure says which one broke
   ================================================================================================= */

describe("the second channels the register depends on", () => {
  it("gives every declared building severity a badge of its own, not just a colour", () => {
    proveStatusGlyph();
  });

  it("prints each commodity's name beside its dot", () => {
    proveResourceLabel();
  });

  it("styles every severity the model can produce, so none renders unstyled", () => {
    // The other half of the same coupling: `building-panel.ts` declares the vocabulary and
    // `style.css` colours it. A severity added to one and not the other renders in the inherited
    // body colour, which is `--text` — the same as an ordinary line, so the status stops reading as
    // a status at all. Neither file imports the other; this is the only thing holding them together.
    const styled = new Set(
      RULES.flatMap((r) => [...r.selector.matchAll(/\[data-severity="([a-z]+)"\]/g)].map((m) => m[1]!)),
    );
    const missing = declaredSeverities().filter((s) => !styled.has(s));
    expect(missing, `BuildingPanelModel declares severities that src/style.css never styles: ${missing.join(", ")}`).toEqual([]);
  });
});
