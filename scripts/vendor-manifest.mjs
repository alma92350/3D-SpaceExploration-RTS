// Shared vocabulary for the vendored simulation core (ADR-0003).
//
// Two scripts read this: `sync-engine.mjs`, which pulls a pinned upstream ref and copies files in,
// and `check-vendor.mjs`, which proves nobody has edited them since. Keeping the file list, the
// hashing rule and the layout convention in one module is what makes those two agree — a drift
// check that hashes a different set of files than the sync writes is a check that passes while
// the tree is wrong.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix, relative, sep } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the vendored copy lives. Everything under here is upstream's, byte for byte. */
export const VENDOR_DIR = join(ROOT, "src", "engine");
export const MANIFEST_PATH = join(VENDOR_DIR, "VENDOR.json");

export const UPSTREAM_URL = "https://github.com/alma92350/SpaceExploration-RTS";

// The vendored tree preserves upstream's OWN relative layout (`engine/x.js` imports `../data.js`;
// `test/x.test.js` imports `../engine/x.js`). Reproducing that shape verbatim under src/engine/ is
// what lets the files be copied unmodified — flattening it would mean rewriting import specifiers,
// which is exactly the "patch the vendored code" that ADR-0003 forbids. The cost is one doubled
// path segment, `src/engine/engine/`. That is the whole reason it looks odd.
export const VENDORED_TREES = ["engine", "test"];
export const VENDORED_FILES = ["data.js"];

// Files we add to the vendored directory and therefore must NOT hash as upstream's.
export const OURS = new Set(["VENDOR.json", "engine.d.ts", "index.ts", "README.md"]);

// Which upstream tests come across, decided by rule rather than by taste.
//
// ADR-0003 says the upstream suite runs here unmodified — and it does. What it cannot say is that
// *every* upstream test can run at all: a good third of that suite is about the 2D CLIENT (its
// index.html, its CONTRIBUTING.md, its setup screen, its DOM modules), none of which is vendored,
// because ADR-0003 vendors the simulation and not the client. Those tests do not fail here because
// the simulation is broken; they fail because their subject is absent. Shipping them red would
// train everyone to walk past a red `test:sim`, which is precisely the failure ADR-0006 names.
//
// So the rule is mechanical and has no judgement in it: a test is vendored when EVERY file it
// reaches for — by `import`, by `new URL("../x", import.meta.url)`, or by `join(root, "x")` —
// lands inside the vendored tree. Anything that reaches outside is recorded, with the path that
// disqualified it, in VENDOR.json's `excludedTests`. That way the omission is a reviewable fact
// rather than a maintained opinion, and a test upstream adds tomorrow is classified the day it
// arrives with nothing here to remember to update.

const OUTSIDE = /^(?:\.\.\/(?!engine\/|data\.js$)|\.\.$)/;

/**
 * Every file path a test file reaches for, however it reaches.
 * @param {string} source
 * @returns {string[]}
 */
export function referencedPaths(source) {
  const out = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g)) out.push(m[1]);
  for (const m of source.matchAll(/new URL\(\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of source.matchAll(/(?:join|resolve)\(\s*root\s*,\s*["']([^"']+)["']/g)) out.push("root:" + m[1]);
  return out;
}

/**
 * True when nothing the test reaches for lives outside the vendored tree.
 * @param {string} source
 * @returns {{ ok: true } | { ok: false, path: string }}
 */
export function testIsVendorable(source) {
  for (const p of referencedPaths(source)) {
    if (p.startsWith("node:")) continue;
    if (p.startsWith("root:")) {
      const first = p.slice(5).split("/")[0];
      if (VENDORED_TREES.includes(first) || VENDORED_FILES.includes(first)) continue;
      return { ok: false, path: p.slice(5) };
    }
    if (p.startsWith("./")) continue;                    // a sibling helper in test/, copied alongside
    if (p.startsWith("../engine/") || p === "../data.js") continue;
    if (OUTSIDE.test(p)) return { ok: false, path: p };
  }
  return { ok: true };
}

/** Every vendored path (posix, relative to VENDOR_DIR), sorted — the hash order must be stable. */
export function vendoredPaths(dir = VENDOR_DIR) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join(posix.sep));
    }
  };
  for (const tree of VENDORED_TREES) {
    try { walk(join(dir, tree)); } catch { /* not vendored yet */ }
  }
  for (const f of VENDORED_FILES) {
    try { statSync(join(dir, f)); out.push(f); } catch { /* not vendored yet */ }
  }
  return out.sort();
}

export function hashFile(absPath) {
  // Hash raw bytes, not decoded text: a line-ending or BOM change is drift too.
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}
