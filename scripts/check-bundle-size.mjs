#!/usr/bin/env node
// Payload budget + import-surface guard (ADR-0007, P0-T07, PRD N-03).
//
// Two checks, both cheap, both about the same failure: a change that quietly doubles what persona
// P2 has to download on a 10 Mbit line before the game starts.
//
//   1. **Size.** The initial payload — the entry HTML plus everything it eagerly pulls in —
//      gzipped, must stay under 3 MB (N-03).
//   2. **Import surface.** `three/examples/**` is the classic way a tree-shaken 150 kB three.js
//      becomes an un-shakeable 600 kB one: one addon import pulls a whole subtree. ADR-0005 §2
//      says named, tree-shakeable imports only, and this is what makes that enforceable.
//
// Run after `npm run build`.

import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SRC = join(ROOT, "src");

/** PRD N-03: ≤ 3 MB gzipped initial payload. */
const BUDGET_BYTES = 3 * 1024 * 1024;

/** ADR-0005 §2: no addon imports. Each of these drags in a subtree tree-shaking cannot remove. */
const FORBIDDEN_IMPORTS = [
  /from\s+["']three\/examples\//,
  /from\s+["']three\/addons/,
  /import\s+["']three\/examples\//,
];

const problems = [];

// ---- 1. Import surface (source, so it fails before the build even runs) ----

for (const file of walk(SRC, [".ts"])) {
  const source = readFileSync(file, "utf8");
  for (const pattern of FORBIDDEN_IMPORTS) {
    if (pattern.test(source)) {
      problems.push(
        `${relative(ROOT, file)} imports a three.js addon. ADR-0005 allows tree-shakeable named `
        + `imports from "three" only; adding an addon needs an ADR and a new budget line.`,
      );
    }
  }
}

// ---- 2. Payload size ----

if (!existsSync(DIST)) {
  console.error("check:size — no dist/. Run `npm run build` first.");
  process.exit(1);
}

const html = join(DIST, "index.html");
if (!existsSync(html)) {
  console.error("check:size — dist/index.html is missing; the build did not produce an entry.");
  process.exit(1);
}

// The initial payload is the entry document plus every asset it references directly. Lazily
// imported chunks are deliberately NOT counted: they are not what the player waits for.
const entry = readFileSync(html, "utf8");
const referenced = new Set(["index.html"]);
// Normalised to a dist-relative path, and the `./` is the whole reason this exists.
//
// **This gate double-counted every JS chunk from Phase 0 until Phase 5.** Vite emits the entry's
// references as `./assets/x.js` (ADR-0007's `base: "./"` — relative URLs, so one build works from
// any path). The old pattern stripped only a LEADING SLASH, so `referenced` held `./assets/x.js`
// while the `walk(DIST)` pass below yields `assets/x.js`; `referenced.has()` missed, the
// transitive-chunk branch counted the same file a second time, and the reported total was exactly
// double — 435.8 kB against a true 219.6 kB.
//
// It never fired wrongly, because the error is conservative and the budget has ~14x headroom. It
// was still worth fixing the moment it was confirmed: P5-T02 was told to weigh audio against this
// number, and a measurement that is wrong by 2x is one a future decision gets wrong by 2x.
for (const m of entry.matchAll(/(?:src|href)="([^"]+)"/g)) {
  referenced.add(m[1].replace(/^\.?\//, ""));
}

let total = 0;
const rows = [];
for (const name of referenced) {
  const path = join(DIST, name);
  if (!existsSync(path) || statSync(path).isDirectory()) continue;
  const gz = gzipSync(readFileSync(path)).length;
  total += gz;
  rows.push([name, gz]);
}

// Every eagerly-imported chunk counts too: Vite splits `three` out, and the entry pulls it in.
for (const file of walk(DIST, [".js"])) {
  const name = relative(DIST, file).split(sep).join("/");
  if (referenced.has(name) || name.startsWith("harness")) continue;
  // A chunk the entry imports transitively. Conservative: count anything the entry chunk names.
  const entryChunks = [...referenced].filter((r) => r.endsWith(".js"));
  const named = entryChunks.some((chunk) => {
    const chunkPath = join(DIST, chunk);
    return existsSync(chunkPath) && readFileSync(chunkPath, "utf8").includes(name.split("/").pop());
  });
  if (!named) continue;
  const gz = gzipSync(readFileSync(file)).length;
  total += gz;
  rows.push([name, gz]);
}

rows.sort((a, b) => b[1] - a[1]);
console.log("check:size — initial payload, gzipped:");
for (const [name, gz] of rows) console.log(`  ${kb(gz).padStart(9)}  ${name}`);
console.log(`  ${kb(total).padStart(9)}  TOTAL   (budget ${kb(BUDGET_BYTES)})`);

if (total > BUDGET_BYTES) {
  problems.push(`initial payload ${kb(total)} exceeds the ${kb(BUDGET_BYTES)} budget (PRD N-03)`);
}

if (problems.length) {
  console.error("\ncheck:size — FAILED:");
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

function walk(dir, extensions, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // The vendored engine is upstream's JavaScript; it has no addon imports to guard and it is
      // not ours to lint (ADR-0003).
      if (full === join(SRC, "engine")) continue;
      walk(full, extensions, out);
    } else if (extensions.includes(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}
