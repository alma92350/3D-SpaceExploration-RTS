#!/usr/bin/env node
// Fail the build if anyone has edited the vendored simulation (ADR-0003, P0-T04).
//
// Deliberately offline: it compares the tree against the hashes `sync-engine.mjs` recorded, so it
// gives the same verdict on a CI runner with no network as on a laptop. A check that needs the
// internet is a check that gets skipped the first time the internet is having a day.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_PATH, VENDOR_DIR, hashFile, vendoredPaths } from "./vendor-manifest.mjs";

/**
 * @param {string} dir           vendored directory to verify
 * @param {string} manifestPath  the VENDOR.json that describes it
 * @returns {string[]} human-readable problems; empty means in sync
 */
export function checkVendor(dir = VENDOR_DIR, manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return [`${manifestPath} is missing — run \`npm run sync:engine\``];

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  const onDisk = new Set(vendoredPaths(dir));
  const recorded = new Set(Object.keys(manifest.files));

  for (const f of recorded) {
    if (!onDisk.has(f)) { problems.push(`vendored file deleted: ${f}`); continue; }
    if (hashFile(join(dir, f)) !== manifest.files[f])
      problems.push(`vendored file edited: ${f} — the engine is upstream's (ADR-0003); make the change there and re-sync`);
  }
  for (const f of onDisk) if (!recorded.has(f)) problems.push(`untracked file inside the vendored tree: ${f}`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkVendor();
  if (problems.length) {
    console.error("check:vendor — the vendored simulation has drifted:");
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  const { commit, ref, files } = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  console.log(`check:vendor — in sync: ${Object.keys(files).length} files at ${ref}@${commit.slice(0, 12)}`);
}
