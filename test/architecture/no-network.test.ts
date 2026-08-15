// N-06, enforced instead of asserted (P6-T06, ADR-0022).
//
// *"No secrets, no telemetry, no network calls beyond loading the app itself."* Until this file
// that was a sentence in the PRD and a comment in `app/settings.ts`, which is exactly the shape of
// gap this board has now been caught by six times — a rule everybody follows until somebody does
// not, with nothing to notice. ADR-0022 rules the PRD's own contradiction (§5 asks for an update
// check; N-06 forbids the call it needs) in N-06's favour **on the strength of a measured zero**,
// and a measurement that nothing re-takes is a number that was true once.
//
// The vendored tree is scanned too, deliberately. `src/engine/**` ships to the player, so a
// `fetch` arriving there through `npm run sync:engine` is a network call in the built bundle
// whoever wrote it. ADR-0003 forbids editing it — so the correct outcome is a red build naming
// N-06 and forcing a ruling, not a silent arrival.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // Upstream's own test suite is run by `node --test`, never bundled, and is full of harness
      // code. `src/engine/engine/` and `src/engine/data.js` — the parts that ship — are scanned.
      if (full === join(SRC, "engine", "test")) continue;
      walk(full, out);
    } else if ([".ts", ".js"].includes(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments come out first, and this file is the reason why: it and `app/settings.ts`,
 * `app/build.ts` and `app/failure.ts` all *discuss* N-06 in prose that names the very primitives
 * being banned. A scan that reads its own documentation as a violation is a scan people delete.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every way a browser can reach the network, and what each one would be. */
const PRIMITIVES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\bnew\s+EventSource\b/, "EventSource"],
  [/\bsendBeacon\s*\(/, "navigator.sendBeacon()"],
  [/\bnavigator\s*\.\s*serviceWorker\b/, "a service worker"],
  [/\bcaches\s*\.\s*(open|match)\s*\(/, "the Cache API"],
  [/\bimportScripts\s*\(/, "importScripts()"],
];

const SOURCES = walk(SRC).map((path) => ({
  rel: relative(ROOT, path).split(sep).join("/"),
  code: code(readFileSync(path, "utf8")),
}));

describe("N-06: the app makes no network call beyond loading itself (ADR-0022)", () => {
  it("finds the sources it claims to scan", () => {
    // A scan that silently matches nothing is a check everyone believes in and nobody has.
    expect(SOURCES.length).toBeGreaterThan(60);
    expect(SOURCES.some((f) => f.rel.startsWith("src/engine/engine/")), "the vendored tree was skipped")
      .toBe(true);
    expect(SOURCES.some((f) => f.rel === "src/main.ts")).toBe(true);
  });

  it("contains no network primitive at all — the measured zero ADR-0022 was decided on", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const [pattern, what] of PRIMITIVES) {
        if (pattern.test(file.code)) offenders.push(`${file.rel} uses ${what}`);
      }
    }
    expect(
      offenders,
      "N-06 allows no network call beyond loading the app itself, and ADR-0022 declined an update "
      + "check on exactly this measurement. A new one needs an ADR that supersedes it:\n  "
      + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("loads nothing from another origin in the entry document", () => {
    // The build rewrites `/src/main.ts` to a relative `./assets/*.js`; anything absolute here would
    // be a request to somebody else's server on every cold load — a CDN font is the classic one,
    // and it is both an N-06 breach and an N-03 cost measured on someone else's connection.
    const html = readFileSync(join(ROOT, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const remote = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((url) => /^(?:https?:)?\/\//.test(url));
    expect(remote, `index.html loads from another origin: ${remote.join(", ")}`).toEqual([]);
  });

  it("keeps the version stamp out of the network entirely (ADR-0022 §2 of the decision)", () => {
    // The half of "versioning and the update check" that survived N-06: the build injects the
    // version, so "which build am I on?" is answerable with no request. If someone later answers it
    // by fetching a manifest, the primitive scan above catches it — this asserts the thing that
    // replaced it still exists.
    const config = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(config, "the build no longer injects a version, so nothing stamps one")
      .toMatch(/__BUILD_VERSION__/);
    const build = readFileSync(join(SRC, "app", "build.ts"), "utf8");
    expect(build).toMatch(/__BUILD_VERSION__/);
  });
});
