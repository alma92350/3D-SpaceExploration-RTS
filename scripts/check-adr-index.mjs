#!/usr/bin/env node
// P0-T09b — an ADR that exists but is not in the index is an ADR nobody will find.
//
// ADR-0001 makes the index the entry point to every architectural decision. An unlisted ADR is
// therefore a decision that is technically recorded and practically lost — which is the exact
// failure the ADR practice exists to prevent, so it is worth a check rather than a habit.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIR = join(ROOT, "docs", "adr");
const INDEX = join(ADR_DIR, "README.md");

const index = readFileSync(INDEX, "utf8");
const files = readdirSync(ADR_DIR)
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .filter((f) => !f.startsWith("0000-"))     // the template is not a decision
  .sort();

const problems = [];

for (const file of files) {
  if (!index.includes(file)) {
    problems.push(`${file} is not listed in docs/adr/README.md`);
    continue;
  }
  // An entry without a status is an entry that does not say whether the decision still holds.
  const line = index.split("\n").find((l) => l.includes(file)) ?? "";
  if (!/\b(Accepted|Proposed|Superseded|Deprecated|Rejected)\b/i.test(line)) {
    problems.push(`${file} is listed without a status (Accepted / Proposed / Superseded / …)`);
  }
}

// The reverse direction too: an index row pointing at a file that was renamed or deleted. The
// template is linked from the index but is not a decision, so it is exempt on both sides.
const onDisk = new Set(readdirSync(ADR_DIR));
for (const m of index.matchAll(/\(([0-9]{4}-[a-z0-9-]+\.md)\)/g)) {
  if (!onDisk.has(m[1])) problems.push(`docs/adr/README.md links ${m[1]}, which does not exist`);
}

if (problems.length) {
  console.error("check:adr — the ADR index is out of date:");
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(`check:adr — ${files.length} ADRs, all indexed with a status`);
