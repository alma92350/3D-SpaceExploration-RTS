// P1-T13 — the two architectural rules that hold this codebase together, enforced rather than
// documented. Both are rules a reviewer would have to notice by eye; a source scan never forgets.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // The vendored tree is upstream's and is checked by `npm run check:vendor`, not by us.
      if (full === join(SRC, "engine")) continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g)].map((m) => m[1]!);
}

const FILES = walk(SRC).map((path) => ({
  path,
  rel: relative(ROOT, path).split(sep).join("/"),
  source: readFileSync(path, "utf8"),
}));

describe("layering", () => {
  it("finds source files to check", () => {
    // A scan that silently matches nothing is a check everyone believes in and nobody has.
    expect(FILES.length).toBeGreaterThan(15);
    expect(FILES.some((f) => f.rel.startsWith("src/view/"))).toBe(true);
  });

  it("no module under view/ imports the engine (ADR-0008)", () => {
    // This is what lets the sim move into a Worker later without touching the renderer, and what
    // guarantees the renderer cannot write a sim field: it holds no reference to one.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!file.rel.startsWith("src/view/")) continue;
      for (const spec of importsOf(file.source)) {
        if (spec.includes("engine/index") || spec.includes("@engine/") || /\/engine\/[a-z]+\.js$/.test(spec)) {
          offenders.push(`${file.rel} → ${spec}`);
        }
      }
    }
    expect(offenders, `view/ must consume snapshots, not engine state:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no module under input/ or ui/ imports the engine's command functions directly", () => {
    // Orders go through bridge/commands.ts so a recorded intent stream replays exactly (P1-T21).
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!file.rel.startsWith("src/input/") && !file.rel.startsWith("src/ui/")) continue;
      for (const spec of importsOf(file.source)) {
        if (spec.includes("@engine/engine/commands") || spec.includes("engine/engine/commands")) {
          offenders.push(`${file.rel} → ${spec}`);
        }
      }
    }
    expect(offenders, `intent must flow through the bridge:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("only src/engine/index.ts imports vendored JavaScript", () => {
    const offenders = FILES
      .filter((f) => f.rel !== "src/engine/index.ts")
      .filter((f) => importsOf(f.source).some((s) => s.startsWith("@engine/")))
      .map((f) => f.rel);
    expect(offenders, `the JS/TS seam is one file wide (ADR-0003):\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("nothing that crosses the bridge carries a z, height or elevation field (ADR-0004)", () => {
    // The simulation is 2D and stays 2D. A `z` on a snapshot type is the first step toward a
    // second source of truth for position — and toward a renderer that can move a unit.
    const snapshot = readFileSync(join(SRC, "bridge", "snapshot.ts"), "utf8");
    // Two things are stripped before scanning, both because they would produce false positives
    // that teach people to weaken the check:
    //   • Comments — this file EXPLAINS the rule at length, in prose that contains the words.
    //   • The `map:` block — a map's `width`/`height` are its PLANAR extent, the same two numbers
    //     the 2D client has always had. It is the per-entity fields that must never gain a third
    //     axis, and those are what remain after the strip.
    const code = snapshot
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\bmap:\s*\{[^}]*\}/g, "map: {}");
    const forbidden = /^\s*(?:readonly\s+)?(z|height|elevation|altitude)\s*[?:]/gm;
    const hits = [...code.matchAll(forbidden)].map((m) => m[1]!);
    expect(hits, `the snapshot must stay planar; found: ${hits.join(", ")}`).toEqual([]);
  });

  it("the renderer port never exposes a way to write simulation state", () => {
    const port = readFileSync(join(SRC, "view", "renderer", "port.ts"), "utf8");
    expect(port).not.toMatch(/\bState\b/);
    expect(port).not.toMatch(/\bUnit\b|\bBuilding\b/);
  });
});

describe("allocation discipline", () => {
  it("only constructors and ensure* helpers allocate typed arrays in the render path", () => {
    // ADR-0006 forbids allocation in a steady-state frame, and the render path is where that is
    // both easiest to violate and hardest to see. The rule enforced here is a naming convention
    // strong enough to check mechanically: a `new Float32Array` may appear in a constructor (once,
    // at setup) or in a method whose name starts with `ensure` (the power-of-two growth path,
    // which by contract runs off-frame). Anywhere else it is a per-frame allocation.
    const HOT_FILES = [
      "src/view/scene.ts", "src/view/interpolate.ts", "src/bridge/snapshot.ts",
      // P3-T06's effect pool. It is the newest place a per-frame allocation could hide, because
      // `age` runs every frame and compacting a list is the one loop a reviewer would naturally
      // write with `filter` or a fresh array.
      "src/view/effects.ts",
      // P3-T14's alert feed, for the same reason and one more: `retire` compacts by swap-remove on
      // every tick, and its first version had the classic off-by-one — the entry swapped down was
      // never re-checked. That survived thirteen mutations before a compaction test caught it, so
      // this file gets the scan too.
      "src/view/alerts.ts",
    ];
    const METHOD = /^\s{2}(?:private\s+|protected\s+|public\s+|static\s+|override\s+|readonly\s+|get\s+|\*)*([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\(/gm;

    const offenders: string[] = [];
    for (const rel of HOT_FILES) {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, `${rel} is in the hot-path list but was not found`).toBeDefined();
      // Comments come out first. These files document the allocation rule in prose that quotes the
      // very constructor being banned, and a scan that reads its own documentation as a violation
      // is a scan people delete.
      const source = file!.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

      const methods = [...source.matchAll(METHOD)].map((m) => ({ name: m[1]!, at: m.index! }));
      for (const m of source.matchAll(/new (?:Float32Array|Float64Array|Int32Array|Uint8Array|Uint32Array)/g)) {
        const line = source.slice(source.lastIndexOf("\n", m.index!) + 1, source.indexOf("\n", m.index!));
        // A class-FIELD initialiser runs once, with the constructor, even though it sits textually
        // after some other method. Allowed for the same reason a constructor is.
        if (/^\s{2}(?:private |protected |public |readonly |static )*[A-Za-z_]\w*(?:\s*:[^=]+)?\s*=\s*new /.test(line)) continue;
        const owner = [...methods].reverse().find((x) => x.at < m.index!);
        const name = owner?.name ?? "<module scope>";
        if (name === "constructor" || name.startsWith("ensure") || name === "<module scope>") continue;
        offenders.push(`${rel}: ${name}() allocates ${m[0]}`);
      }
    }
    expect(offenders, `move the allocation into an ensure* helper:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
