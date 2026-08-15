// P4-T03 — the galaxy is one-dimensional, asserted rather than assumed (ADR-0019's obligation).
//
// **This file is a proof, not a feature**, and it is the one piece of P4-T03 the ADR explicitly
// ordered: "P4-T03 must assert that the galaxy is still one-dimensional… This ADR's premise is a
// fact about vendored data that `scripts/sync-engine.mjs` can change without anyone noticing. The
// test is what makes the supersede trigger below fire instead of rot."
//
// The premise, in the ADR's own words, is two facts:
//
//   1. every `ODYSSEY_WORLDS` entry carries exactly the numeric coordinate `x` and no other, and
//   2. no engine function reads a world position except as `Math.abs(Δx)` — two sites, `jumpCost`
//      (`galaxy.js:975`) and `checkExpansion` (`galaxy.js:605`).
//
// Everything a starmap is turns on those. `view/starmap.ts` lays eleven worlds on a plate and maps
// `x` to one screen axis, and ADR-0019 priced that against a true 3D scene by measuring how often
// each layout ranks jump destinations backwards. **If a world gains a `y`, the plate is no longer
// the honest option — it is the one throwing information away**, and the ADR says so: trigger 1,
// stated in advance, superseded with a re-run of `perf/starmap-probe.mjs`.
//
// Four claims, each mutation-tested against the way it could be wrong (see the closing notes):
//
//   1. DATA        the roster's worlds carry `x`, carry it as a number, and carry no second
//                  coordinate under any spelling — including a key nobody here has classified.
//   2. SOURCE      exactly ONE coordinate accessor exists in the whole vendored engine, it reads
//                  `.x`, and exactly two call sites read it, both inside `Math.abs(Δ)`.
//   3. BEHAVIOUR   `jumpCost` really is monotone in `|Δx|` and symmetric about the seat — which is
//                  what makes claim 2 a fact about live code rather than about dead code.
//   4. BRIDGE      the table this project hands the starmap carries one coordinate column too. A
//                  premise that held upstream and was quietly widened on the way across would be
//                  the same defect with a shorter blast radius.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ODYSSEY_WORLDS, PLANETS, createGalaxy, jumpCost } from "../../src/engine/index.js";

/* =================================================================================================
   1. THE DATA CLAIM — one coordinate, on every world in the roster

   `PLANETS` is vendored data. `scripts/sync-engine.mjs` re-vendors it wholesale, so a `y` arriving
   upstream arrives here in one commit with nothing else to mark it. The runtime objects are what is
   asserted (not the `.d.ts`, which is hand-written by this project and would simply be wrong rather
   than red).
   ================================================================================================= */

/**
 * Every key any roster world carries today, and whether it is a coordinate.
 *
 * The list is exhaustive rather than a denylist of `y` and `z`, and that is the point: a second
 * coordinate does not have to be called `y`. `lat`, `orbit`, `ring`, `sector`, `angle` — all are
 * plausible names for the number that would break this ADR, and none of them would trip a scan
 * looking for two letters. **An unclassified key is a failure**, which costs one deliberate read of
 * this list on the day upstream adds a field and buys the only check that cannot be evaded.
 */
const KNOWN_PLANET_KEYS: Readonly<Record<string, "coordinate" | "identity" | "economy" | "flavour">> = {
  x: "coordinate",
  id: "identity",
  name: "identity",
  tag: "flavour",
  color: "flavour",
  desc: "flavour",
  faction: "identity",
  industry: "economy",
  tech: "economy",
  enforce: "economy",
  deposits: "economy",
  salvage: "economy",
  bounty: "economy",
  // Carried by the frontier/hidden worlds only — off the Odyssey roster, but `PLANETS` is scanned
  // whole below because `planetX` looks up by id across the entire table.
  colonizable: "economy",
  hidden: "economy",
};

/** The roster's own `PlanetDef`s, in roster order. Missing entries are surfaced, never skipped. */
function rosterPlanets(): Array<{ id: string; planet: Record<string, unknown> | undefined }> {
  return ODYSSEY_WORLDS.map((id) => ({
    id,
    planet: PLANETS.find((p) => p.id === id) as unknown as Record<string, unknown> | undefined,
  }));
}

/** Which of a world's keys this file classifies as a coordinate. The whole data claim, as a function. */
function coordinateKeysOf(planet: Record<string, unknown>): string[] {
  return Object.keys(planet).filter((k) => KNOWN_PLANET_KEYS[k] === "coordinate");
}

/** Which of a world's keys nobody has classified at all — a candidate second coordinate. */
function unclassifiedKeysOf(planet: Record<string, unknown>): string[] {
  return Object.keys(planet).filter((k) => KNOWN_PLANET_KEYS[k] === undefined);
}

describe("the galaxy has exactly one coordinate (P4-T03, ADR-0019 premise)", () => {
  it("scans a real, non-empty roster", () => {
    // The guard that keeps everything below from being a test of the empty set. ADR-0019 counted
    // eleven and measured its layouts against those eleven; a roster that shrank to nothing would
    // make every claim in this file green, permanent and worthless.
    expect(ODYSSEY_WORLDS.length, "the Odyssey roster has shrunk below the eleven ADR-0019 measured")
      .toBeGreaterThanOrEqual(11);
    expect(PLANETS.length, "PLANETS is empty or tiny — this scan has nothing to scan")
      .toBeGreaterThanOrEqual(11);
    for (const { id, planet } of rosterPlanets()) {
      expect(planet, `${id} is on the Odyssey roster but has no PLANETS entry — it has no position at all`)
        .toBeDefined();
    }
  });

  it("gives every roster world an x, as a number, and all of them distinct", () => {
    const xs: number[] = [];
    for (const { id, planet } of rosterPlanets()) {
      const x = planet!.x;
      expect(typeof x, `${id}.x is ${typeof x}, not a number — the one load-bearing coordinate is gone`)
        .toBe("number");
      expect(Number.isFinite(x as number), `${id}.x is not finite`).toBe(true);
      xs.push(x as number);
    }
    // Distinctness is not decoration: `plateX` is affine in `x`, so two worlds sharing an `x` would
    // land on top of each other on the plate — and would be told apart only by the stagger, which
    // ADR-0019 forbids from carrying meaning.
    expect(new Set(xs).size, `two roster worlds share an x: ${xs.join(", ")}`).toBe(xs.length);
  });

  it("gives no world a second coordinate, under any spelling", () => {
    const offenders: string[] = [];
    // The whole table, not just the roster: `planetX` resolves by id across all of `PLANETS`, and
    // the roster is a slice of it that upstream has already grown twice.
    for (const planet of PLANETS as unknown as Array<Record<string, unknown>>) {
      const coords = coordinateKeysOf(planet);
      if (coords.length !== 1 || coords[0] !== "x") {
        offenders.push(`${String(planet.id)} carries coordinates [${coords.join(", ")}]`);
      }
      for (const key of unclassifiedKeysOf(planet)) {
        offenders.push(
          `${String(planet.id)} carries an unclassified key "${key}" — if it is a coordinate, ` +
          "ADR-0019's supersede trigger has fired and the plate is now the layout throwing " +
          "information away; if it is not, classify it in KNOWN_PLANET_KEYS",
        );
      }
    }
    expect(offenders, offenders.join("\n  ")).toEqual([]);
  });

  it("would notice a second coordinate if one arrived — including one not called y", () => {
    // The anti-vacuity test for section 1. A key scan is exactly the kind of check that keeps
    // passing after the thing it checks has moved, so it is run against data that DOES break the
    // premise, and against data that merely looks like it might.
    const guilty: Array<[string, Record<string, unknown>]> = [
      ["a plain y", { id: "helix", x: 6, y: 3, industry: 3, tech: 4, deposits: {} }],
      ["a z", { id: "helix", x: 6, z: -2, industry: 3, tech: 4, deposits: {} }],
      ["a latitude", { id: "helix", x: 6, lat: 12, industry: 3, tech: 4, deposits: {} }],
      ["an orbital ring", { id: "helix", x: 6, ring: 2, industry: 3, tech: 4, deposits: {} }],
    ];
    for (const [what, planet] of guilty) {
      const coords = coordinateKeysOf(planet);
      const unknown = unclassifiedKeysOf(planet);
      expect(
        coords.length > 1 || unknown.length > 0,
        `${what} passed the scan — a world can gain a second coordinate without anyone noticing`,
      ).toBe(true);
    }

    // …and stays quiet on a world that is merely rich in non-spatial data, which is what every real
    // entry looks like. A scan that cried wolf on `industry` would be deleted within a week.
    const innocent = { id: "helix", name: "Helix Belt", tag: "Asteroid Belt", color: "#9ca3af", x: 6,
      faction: "miners", industry: 3, tech: 4, enforce: 0.4, salvage: true, desc: "…", deposits: { ore: 1.6 } };
    expect(coordinateKeysOf(innocent)).toEqual(["x"]);
    expect(unclassifiedKeysOf(innocent)).toEqual([]);
  });
});

/* =================================================================================================
   2. THE SOURCE CLAIM — two read-sites, both |Δx|

   Modelled on `test/engine/ai-fog.test.ts` §1, and for its reason: the invariant lives in code this
   project does not own and does not edit (ADR-0003), so the only assertion with a shelf life is one
   made against the source itself.

   The hard part is the same shape too. Three different things have to be told apart:

     • a world's COORDINATE being read                  — the thing under proof
     • a world's `industry`/`tech`/`deposits` being read — legitimate, and there are five of them
     • an ENTITY's `.x`/`.y`                             — ubiquitous; every unit has a position

   The third is why this scan follows PLANETS rather than searching for `.x`. There are hundreds of
   `.x` reads in the engine and all but one of them are about something standing on a map.
   ================================================================================================= */

const ENGINE_DIR = new URL("../../src/engine/engine/", import.meta.url);
const DATA_FILE = new URL("../../src/engine/data.js", import.meta.url);

interface EngineFile { file: string; source: string }

/**
 * The whole vendored engine, DISCOVERED rather than listed, plus `data.js` where `PLANETS` lives.
 *
 * Discovered for ai-fog's reason: a module added upstream tomorrow is scanned the day it lands. The
 * count is asserted below — a glob that silently matches nothing is the classic way a source scan
 * goes green forever.
 */
function engineSources(): EngineFile[] {
  const files: EngineFile[] = readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => ({ file: f, source: readFileSync(new URL(f, ENGINE_DIR), "utf8") }));
  files.push({ file: "data.js", source: readFileSync(DATA_FILE, "utf8") });
  return files;
}

/**
 * Blank out every comment body, preserving newlines so line numbers still match the real file.
 *
 * The load-bearing line, exactly as in `ai-fog.test.ts`. `galaxy.js` alone contains several hundred
 * lines of prose, including the sentence "distance is fixed planet-x" and a comment that spells out
 * `data.js planet x, 0..~18`. A scan over raw text reports those, is red on arrival, and gets
 * deleted by whoever inherits it.
 *
 * Naive by design: it does not understand a `//` inside a string literal. Verified safe across the
 * whole vendored tree — there is no `://` in any of it — and asserted below so that stops being a
 * claim about today.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Coordinate field names. `x` included: the claim is that it is the ONLY one that is ever read. */
const COORDINATE_FIELDS = ["x", "y", "z", "lat", "lon", "latitude", "longitude", "ring", "orbit", "angle"];

interface CoordinateRead { file: string; line: number; fn: string; field: string; text: string }

/**
 * The nearest FUNCTION declaration at or above `line`, so a hit can be judged by WHO does it.
 *
 * "Function" is doing real work in that sentence, and it is `ai-fog.test.ts`'s lesson learned a
 * second time. Both real read-sites sit on lines that begin `const d = …` and `const dist = …`, so
 * a rule that accepted any `const` attributed each of them to its own local variable — reporting
 * `d()` and `dist()` rather than `checkExpansion()` and `jumpCost()`. Attribution that drifts is
 * how a hit lands on the wrong name, and the wrong name is how one gets waved through. Only an
 * assignment whose right-hand side IS a function counts, which is what keeps the module-scope
 * accessor (`const planetX = id => …`) correctly attributed to itself.
 */
function enclosingFunction(codeLines: string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    const l = codeLines[i]!;
    const decl = l.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    if (decl) return decl[1]!;
    const assigned = l.match(
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/,
    );
    if (assigned) return assigned[1]!;
  }
  return "(module scope)";
}

/**
 * Every read of a PLANET's coordinate in one module's *code*, with the function responsible.
 *
 * Follows `PLANETS` rather than hunting for `.x`, in three steps:
 *
 *   1. find each statement that reaches into `PLANETS` (skipping the import lines and the array's
 *      own definition — a literal `x: 6` is data, not a read);
 *   2. work out what a planet is CALLED there: the tail of the lookup itself (`PLANETS.find(…)?.x`),
 *      any arrow parameter in the statement (`PLANETS.map(p => …p.x…)`), and any binding the
 *      statement creates (`const planet = PLANETS.find(…)`);
 *   3. read coordinate fields off exactly those receivers — inside the statement, and for a binding
 *      also through the rest of its enclosing function.
 *
 * Step 3's receiver-awareness is what makes the scan usable at all: `generateMap` binds
 * `const planet = PLANETS.find(…)` and then computes a hundred node positions, so a scan that
 * looked for any `.x` in the enclosing function would report the entire map generator.
 */
function planetCoordinateReads(file: string, source: string): CoordinateRead[] {
  const code = codeOnly(source);
  const lines = code.split("\n");
  const rawLines = source.split("\n");
  const hits: CoordinateRead[] = [];

  for (const m of code.matchAll(/\bPLANETS\b/g)) {
    const lineNo = code.slice(0, m.index).split("\n").length;
    const statement = lines[lineNo - 1]!;
    if (/^\s*import\b/.test(statement)) continue;                 // `import { PLANETS } from …`
    if (/^\s*export\s+const\s+PLANETS\s*=/.test(statement)) continue;   // the array's own definition

    const receivers = new Set<string>();
    for (const arrow of statement.matchAll(/(?:\(\s*([A-Za-z_$][\w$]*)\s*[,)]|\b([A-Za-z_$][\w$]*)\s*)=>/g)) {
      const name = arrow[1] ?? arrow[2];
      if (name) receivers.add(name);
    }
    const bound = statement.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*PLANETS\b/);
    if (bound) receivers.add(bound[1]!);

    const record = (field: string, at: number): void => {
      hits.push({ file, line: at, fn: enclosingFunction(lines, at), field, text: rawLines[at - 1]!.trim() });
    };

    // (a) the lookup's own tail: `PLANETS.find(…)?.x`, `PLANETS[0].y`.
    for (const direct of statement.matchAll(
      /PLANETS\s*(?:\.\s*[A-Za-z_$][\w$]*\s*\([\s\S]*?\)|\[[^\]]*\])\s*\??\.\s*([A-Za-z_$][\w$]*)/g,
    )) {
      if (COORDINATE_FIELDS.includes(direct[1]!)) record(direct[1]!, lineNo);
    }

    // (b) every receiver, inside the statement itself.
    for (const name of receivers) {
      const re = new RegExp(`\\b${name}\\s*\\??\\.\\s*(${COORDINATE_FIELDS.join("|")})\\b`, "g");
      for (const hit of statement.matchAll(re)) record(hit[1]!, lineNo);
    }

    // (c) a binding outlives its statement. Scan forward to the end of the enclosing function —
    // approximated by the next declaration at column 0, which is conservative in the safe
    // direction: it over-scans rather than stopping early.
    if (bound) {
      const name = bound[1]!;
      const re = new RegExp(`\\b${name}\\s*\\??\\.\\s*(${COORDINATE_FIELDS.join("|")})\\b`, "g");
      for (let i = lineNo; i < lines.length; i++) {
        const l = lines[i]!;
        if (/^(?:export\s+)?(?:function|const|let|var|class)\b/.test(l)) break;
        for (const hit of l.matchAll(re)) record(hit[1]!, i + 1);
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.field.localeCompare(b.field));
}

/**
 * The engine's ONE coordinate accessor, pinned by its exact text.
 *
 * Not "galaxy.js may read x" — that would licence a second reader anywhere in a 1 375-line module.
 * The text is pinned because `bridge/galaxy-snapshot.ts` COPIES this line (the engine exports no
 * accessor, so the starmap has no other way to know where a world is), fallback included: `?? 0`
 * means `jumpCost` charges an off-roster destination as though it sat at the origin, and a plate
 * that placed it anywhere else would disagree with the price on screen. The vendored tree is hashed
 * byte for byte (ADR-0003), so upstream touching this line is already a reviewed event.
 */
const ACCESSOR = {
  file: "galaxy.js",
  fn: "planetX",
  text: "const planetX = id => PLANETS.find(p => p.id === id)?.x ?? 0;",
};

/** Every CALL of the accessor, with the line it sits on — the unit the `Math.abs` test judges. */
function accessorCallLines(source: string): Array<{ line: number; fn: string; text: string; calls: number }> {
  const code = codeOnly(source);
  const lines = code.split("\n");
  const out: Array<{ line: number; fn: string; text: string; calls: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const calls = [...lines[i]!.matchAll(new RegExp(`\\b${ACCESSOR.fn}\\s*\\(`, "g"))].length;
    if (calls > 0) out.push({ line: i + 1, fn: enclosingFunction(lines, i + 1), text: lines[i]!.trim(), calls });
  }
  return out;
}

/** `Math.abs(planetX(a) - planetX(b))` and nothing else — no signed delta, no hypot, no second axis. */
const ABS_DELTA = /Math\.abs\(\s*planetX\([^()]*\)\s*-\s*planetX\([^()]*\)\s*\)/;

describe("no engine function reads a world position except as |Δx| (P4-T03, ADR-0019 premise)", () => {
  it("scans the whole vendored engine, and the comment stripper is safe on it", () => {
    const files = engineSources();
    expect(files.length, "the vendored engine tree moved — this scan is now vacuous")
      .toBeGreaterThanOrEqual(40);
    for (const name of ["galaxy.js", "data.js", "map.js", "industry.js", "market.js", "techtree.js"]) {
      expect(files.map((f) => f.file), `${name} is gone — a module that reads PLANETS is not being scanned`)
        .toContain(name);
    }
    // The stripper cannot tell a `//` in a string from a comment. Asserted rather than assumed,
    // because the day a URL lands in the vendored tree the scan starts blanking real code.
    for (const { file, source } of files) {
      expect(source.includes("://"), `${file} contains "://" — codeOnly() would blank code from there on`)
        .toBe(false);
    }
  });

  it("has exactly one coordinate accessor, and it reads x", () => {
    const reads: CoordinateRead[] = [];
    for (const { file, source } of engineSources()) reads.push(...planetCoordinateReads(file, source));

    expect(
      reads.length,
      "more than one place in the engine reads a world's coordinate:\n  " +
      reads.map((r) => `${r.file}:${r.line} in ${r.fn}() reads .${r.field} — ${r.text}`).join("\n  "),
    ).toBe(1);

    const only = reads[0]!;
    expect(only.field, `the engine now reads .${only.field} off a world — ADR-0019's premise is gone`).toBe("x");
    expect(only.file).toBe(ACCESSOR.file);
    expect(only.fn, "the coordinate accessor moved or was renamed").toBe(ACCESSOR.fn);
    expect(only.text, "the accessor's text changed — bridge/galaxy-snapshot.ts copies it verbatim")
      .toBe(ACCESSOR.text);
  });

  it("calls that accessor from exactly two places, both inside Math.abs(Δ)", () => {
    const sites: Array<{ file: string; line: number; fn: string; text: string; calls: number }> = [];
    for (const { file, source } of engineSources()) {
      for (const site of accessorCallLines(source)) sites.push({ file, ...site });
    }

    // ADR-0019 §2's table, as an assertion: "Engine read-sites of a world's position — 2, both
    // Math.abs(Δx)", at galaxy.js:975 (`jumpCost`) and galaxy.js:605 (`checkExpansion`).
    expect(
      sites.map((s) => `${s.file}:${s.line} ${s.fn}()`),
      "the number of places that read a world position has changed:\n  " +
      sites.map((s) => `${s.file}:${s.line} in ${s.fn}() — ${s.text}`).join("\n  "),
    ).toEqual(["galaxy.js:605 checkExpansion()", "galaxy.js:975 jumpCost()"]);

    for (const site of sites) {
      expect(site.calls, `${site.fn}() reads ${site.calls} positions on one line — that is not a Δ`).toBe(2);
      expect(
        ABS_DELTA.test(site.text),
        `${site.file}:${site.line} in ${site.fn}() reads a world position as something other than ` +
        `Math.abs(Δx) — the galaxy has acquired a direction, or a second axis:\n    ${site.text}`,
      ).toBe(true);
    }
  });

  it("would catch a second coordinate in the source, in every shape it could arrive", () => {
    // The anti-vacuity test, and the reason the three above can be trusted at all. The scan is a
    // set of regexes over someone else's source: the way it fails is not by breaking, it is by
    // quietly matching nothing forever. So it is run against sources that DO break the premise.
    const guilty: Array<[string, string, string]> = [
      ["a sibling accessor", "planetY.js", "const planetY = id => PLANETS.find(p => p.id === id)?.y ?? 0;\n"],
      ["a z on the lookup", "z.js", "function depth(id) {\n  return PLANETS.find(p => p.id === id)?.z ?? 0;\n}\n"],
      ["a bracket index", "idx.js", "function first() {\n  return PLANETS[0].y;\n}\n"],
      ["a callback param", "map.js", "const RING = PLANETS.map(p => ({ id: p.id, y: p.y }));\n"],
      [
        "a binding read later in the function",
        "late.js",
        "export function place(id) {\n  const planet = PLANETS.find(p => p.id === id);\n" +
        "  const n = 1;\n  return planet.y * n;\n}\n",
      ],
    ];
    for (const [what, file, src] of guilty) {
      const hits = planetCoordinateReads(file, src);
      expect(hits.length, `the scanner did not flag ${what}:\n${src}`).toBeGreaterThan(0);
      expect(hits.some((h) => h.field !== "x"), `${what} was flagged, but not as a second coordinate`).toBe(true);
    }

    // …and stays quiet on the four things that are not coordinate reads: the five legitimate
    // PLANETS lookups the engine makes, an entity's own position, and prose about planet x.
    const innocent: Array<[string, string]> = [
      ["industry.js", "function industryMult(state) {\n  const i = PLANETS.find(p => p.id === state.planetId)?.industry ?? 5;\n  return i;\n}\n"],
      ["techtree.js", "function techMult(state) {\n  const t = PLANETS.find(p => p.id === state.planetId)?.tech ?? 5;\n  return t;\n}\n"],
      ["data.js", "export const planetName = id => PLANETS.find(p => p.id === id)?.name || id;\n"],
      ["map.js", "export function generateMap(planetId) {\n  const planet = PLANETS.find(p => p.id === planetId);\n  const n = { x: 10, y: 20 };\n  return planet.deposits[n.x] || n.y;\n}\n"],
      ["units.js", "function step(u) {\n  u.x += u.vx;\n  u.y += u.vy;\n}\n"],
      ["prose.js", "// distance is fixed planet-x, and a y would be a second axis\n/* PLANETS carries no y */\n"],
    ];
    for (const [file, src] of innocent) {
      expect(
        planetCoordinateReads(file, src),
        `the scanner cried wolf on legitimate source, which is how this test gets deleted:\n${src}`,
      ).toEqual([]);
    }

    // The call-site half, mutated the three ways a read-site goes wrong: one more of them, a signed
    // delta (a galaxy with a DIRECTION), and a second axis smuggled into the same expression.
    expect(accessorCallLines("const d = Math.abs(planetX(a) - planetX(b));\n")[0]!.calls).toBe(2);
    expect(ABS_DELTA.test("const d = Math.abs(planetX(a) - planetX(b));")).toBe(true);
    expect(ABS_DELTA.test("const d = planetX(a) - planetX(b);"), "a signed delta passed as |Δx|").toBe(false);
    expect(
      ABS_DELTA.test("const d = Math.hypot(planetX(a) - planetX(b), planetY(a) - planetY(b));"),
      "a two-axis distance passed as |Δx|",
    ).toBe(false);
    expect(accessorCallLines("const a = planetX(i);\nconst b = planetX(j);\n").length,
      "two separate call lines read as one site").toBe(2);

    // Attribution has to survive the shape the engine actually writes these in — a regression test
    // rather than a hypothetical. Both real read-sites sit on `const d = …` lines, and the first
    // draft of `enclosingFunction` blamed them on `d()` and `dist()`: a hit attributed to a local
    // variable is a hit that can never be judged by who is responsible for it.
    const attributed = accessorCallLines(
      "export function checkExpansion(g) {\n  const d = Math.abs(planetX(a) - planetX(b));\n  return d;\n}\n",
    );
    expect(attributed.length, "the scanner missed a read-site written the way the engine writes them").toBe(1);
    expect(attributed[0]!.fn, "attribution drifted onto the local variable").toBe("checkExpansion");
  });
});

/* =================================================================================================
   3. THE BEHAVIOURAL CLAIM — |Δx| is the quantity a player ranks

   Sections 1 and 2 are assertions about text. This is what stops them being assertions about DEAD
   text: if `jumpCost` stopped reading `planetX` tomorrow but the line stayed, every scan above
   would still be green. ADR-0019 §2 printed this table from the function rather than from the
   comment above it, and so does this.
   ================================================================================================= */

const SEED = 20260815;
const HOME = "helix";

function planetXOf(id: string): number {
  return PLANETS.find((p) => p.id === id)?.x ?? 0;
}

describe("jumpCost ranks destinations by |Δx| and nothing else (P4-T03)", () => {
  it("is monotone in |Δx|, and pays no attention to direction", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const home = planetXOf(HOME);
    const costs = ODYSSEY_WORLDS
      .filter((id) => id !== HOME)
      .map((id) => ({ id, dx: Math.abs(planetXOf(id) - home), cost: jumpCost(galaxy, id) }))
      .sort((a, b) => a.dx - b.dx || a.id.localeCompare(b.id));

    // The premise: a fresh galaxy has reached only its seat, so every other world is a NEW frontier
    // and actually costs fuel. Without this the whole test is `0 <= 0` eleven times.
    expect(costs.length, "nothing to rank").toBeGreaterThanOrEqual(10);
    for (const c of costs) {
      expect(c.cost, `${c.id} is free — the galaxy thinks it has already been reached`).toBeGreaterThan(0);
    }

    for (let i = 1; i < costs.length; i++) {
      const prev = costs[i - 1]!;
      const here = costs[i]!;
      if (here.dx === prev.dx) {
        // The `abs`, asserted where it actually shows: Verdani sits at x-1 and Pyralis at x+1 from
        // Helix, and the engine charges the same for both. A signed read would separate them.
        expect(
          here.cost,
          `${here.id} and ${prev.id} are both Δx${here.dx} from ${HOME} but cost ` +
          `${here.cost} and ${prev.cost} — jumpCost has acquired a direction`,
        ).toBe(prev.cost);
      } else {
        expect(
          here.cost,
          `${here.id} (Δx${here.dx}) costs ${here.cost} and ${prev.id} (Δx${prev.dx}) costs ` +
          `${prev.cost} — the screen's one honest axis no longer ranks jumps`,
        ).toBeGreaterThan(prev.cost);
      }
    }

    // Both branches above must actually have run: a roster with no ties would never exercise the
    // `abs`, and one with only ties would never exercise monotonicity.
    const ties = costs.filter((c, i) => i > 0 && c.dx === costs[i - 1]!.dx).length;
    expect(ties, "no two destinations are equidistant — the abs was never tested").toBeGreaterThan(0);
    expect(costs[costs.length - 1]!.dx, "every destination is the same distance away").toBeGreaterThan(costs[0]!.dx);
  });
});

/* =================================================================================================
   4. THE BRIDGE CLAIM — one coordinate crosses, too

   ADR-0004's own rule is enforced this way for the battlefield: `test/architecture/layering.test.ts`
   reads `bridge/snapshot.ts` and fails on a `z`. The galaxy's table is new and that scan does not
   know about it, so it gets its own here — same technique, different premise. A `y` added to the
   world table would place worlds off an axis nothing in the engine computes, and every claim
   ADR-0019 makes about fidelity would silently stop being about the thing on screen.
   ================================================================================================= */

describe("the galaxy snapshot carries one coordinate column (P4-T03)", () => {
  it("declares x and no second axis", () => {
    const source = readFileSync(new URL("../../src/bridge/galaxy-snapshot.ts", import.meta.url), "utf8");
    // Comments come out first: this file explains the rule at length, in prose containing the very
    // words being banned. Same reason `layering.test.ts` strips before scanning.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const columns = [...code.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:\s*(?:Float32Array|Float64Array|Int32Array)/gm)]
      .map((m) => m[1]!);
    expect(columns, "the world table has no x column — the plate has nothing to place on").toContain("x");
    for (const banned of ["y", "z", "lat", "lon", "ring", "orbit"]) {
      expect(columns, `the world table grew a "${banned}" column — ADR-0019's trigger has fired`)
        .not.toContain(banned);
    }
  });
});

/* =================================================================================================
   MUTATION LOG — every claim above was watched going red before it was kept.

   DATA        added `y: 3` to Helix Belt in `src/engine/data.js` (restored byte-for-byte, verified
               by hash): "gives no world a second coordinate" fails, naming helix and the key. The
               unclassified-key arm was proved by the `ring` fixture, which no y/z denylist catches.
   SOURCE      copied the vendored tree to a scratch directory and added
               `const planetY = id => PLANETS.find(p => p.id === id)?.y ?? 0;` plus a `Math.hypot`
               read-site in `galaxy.js`: the accessor test reports two reads, and the call-site test
               reports the third site. Both mutations are kept permanently as fixtures in "would
               catch a second coordinate in the source".
   BEHAVIOUR   forced `jumpCost` to return the flat `JUMP_COST` (no distance term) in a scratch
               copy: the monotonicity assertion fails on the first non-tied pair.
   BRIDGE      added `y: Float32Array` to `WorldTable`: the column scan fails and names it.
   ================================================================================================= */
