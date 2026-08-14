#!/usr/bin/env node
// Pull the simulation core from the source repo and record exactly what arrived (ADR-0003).
//
//   npm run sync:engine              -- sync to the ref already pinned in VENDOR.json
//   npm run sync:engine -- --ref=X   -- sync to upstream ref X and re-pin
//
// Running it on an already-synced tree is a no-op: same ref, same bytes, same manifest. That is
// what makes `npm run check:vendor` (which never touches the network) a trustworthy CI gate — the
// manifest this script writes is the oracle that gate compares against.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_PATH, OURS, UPSTREAM_URL, VENDORED_FILES, VENDORED_TREES, VENDOR_DIR,
  hashFile, testIsVendorable, vendoredPaths,
} from "./vendor-manifest.mjs";

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));

const pinned = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : null;
const ref = args.get("ref") || pinned?.ref || "main";

const work = mkdtempSync(join(tmpdir(), "sf-engine-sync-"));
const git = (...a) => execFileSync("git", a, { cwd: work, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

try {
  console.log(`sync:engine — fetching ${UPSTREAM_URL} @ ${ref}`);
  execFileSync("git", ["init", "-q", work], { stdio: "inherit" });
  git("remote", "add", "origin", UPSTREAM_URL);
  git("fetch", "--depth", "1", "origin", ref);
  git("checkout", "-q", "FETCH_HEAD");
  const commit = git("rev-parse", "HEAD");

  // Clear only the vendored trees; VENDOR.json, engine.d.ts and index.ts are ours and stay.
  for (const tree of VENDORED_TREES) rmSync(join(VENDOR_DIR, tree), { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });

  cpSync(join(work, "engine"), join(VENDOR_DIR, "engine"), { recursive: true });
  for (const f of VENDORED_FILES) cpSync(join(work, f), join(VENDOR_DIR, f));

  // The upstream suite comes across unmodified — every test whose whole subject is vendored here.
  // The rule and its rationale live in vendor-manifest.mjs; every exclusion is recorded in the
  // manifest with the exact path that disqualified it, so the omission is reviewable.
  const testDir = join(VENDOR_DIR, "test");
  mkdirSync(testDir, { recursive: true });
  const skipped = [];
  const helpers = new Set();
  const upstreamTests = readdirSync(join(work, "test")).filter(f => f.endsWith(".js")).sort();
  for (const name of upstreamTests) {
    if (!name.endsWith(".test.js")) continue;                       // helpers are pulled in below, by need
    const src = readFileSync(join(work, "test", name), "utf8");
    const verdict = testIsVendorable(src);
    if (!verdict.ok) { skipped.push({ file: name, reachesOutside: verdict.path }); continue; }
    cpSync(join(work, "test", name), join(testDir, name));
    for (const m of src.matchAll(/from\s*["'](\.\/[^"']+)["']/g)) helpers.add(m[1].slice(2));
  }
  for (const h of helpers) cpSync(join(work, "test", h), join(testDir, h));

  const files = vendoredPaths();
  const manifest = {
    upstream: UPSTREAM_URL,
    ref,
    commit,
    syncedFrom: "scripts/sync-engine.mjs",
    note: "Vendored, unmodified (ADR-0003). Do not edit anything listed here — CI fails on drift. "
        + "Behaviour changes go upstream first, then arrive by bumping `ref` and re-running the sync.",
    excludedTests: skipped,
    files: Object.fromEntries(files.map(f => [f, hashFile(join(VENDOR_DIR, f))])),
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const ours = readdirSync(VENDOR_DIR).filter(f => OURS.has(f));
  console.log(`sync:engine — ${files.length} files at ${commit.slice(0, 12)} (${skipped.length} upstream tests not applicable here)`);
  console.log(`sync:engine — untouched, ours: ${ours.join(", ")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
