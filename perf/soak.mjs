#!/usr/bin/env node
// `npm run soak` — the 20-minute match (P7-T06, PRD §5 Phase 3's own exit criterion).
//
// PRD §5 asks Phase 3 for *"a 20-minute AI-vs-player match runs at budget"*. What `npm run perf`
// gates is a **representative frame at the budgeted counts** — a scripted scene, fixed populations,
// 600 frames. P3-T16 recorded why the two are different tests and left this one undone for four
// phases: entity counts drift as units die, which is exactly the non-determinism the perf harness
// was built to remove, so a soak cannot assert a draw-call count and has to assert other things.
//
// **The things worth asserting are the ones a 600-frame run structurally cannot see.**
//
//   1. **Unbounded growth.** ADR-0006 says zero per-frame allocation, and the perf gate proves it
//      over ten seconds — which is short enough to hide any leak slower than a few hundred bytes a
//      second. Every growable structure in the snapshot is sampled here on a schedule, and the
//      assertion is that nothing keeps growing after the population has stopped growing.
//
//      The specific claim under test is one written into `bridge/snapshot.ts` by the id codec: the
//      opaque-id intern table "only grows, which is deliberate and cheap: a match makes hundreds,
//      not millions". Wreck and crater deposits are minted continuously by combat and interned by
//      name, so a 20-minute fight is the first thing this project has ever run that could falsify
//      that sentence. If it is wrong, this is where it shows.
//
//   2. **The budget over 24 000 ticks rather than 600 frames.** A frame time that creeps is
//      invisible in a short run and obvious here.
//
//   3. **That the match actually happened.** A soak that deadlocks into a stalemate is a soak that
//      passes by simulating nothing, which is the vacuity failure this project has caught in five
//      other places. Units must die, production must run, and the population must move.
//
// It is NOT in CI on every push — it is minutes, not seconds. `npm run soak` is the command, and
// P7-T06's row says when to run it.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));

/** PRD §5's own number: twenty minutes of simulation. */
const MINUTES = Number(args.get("minutes") ?? 20);

const server = await createServer({
  root: ROOT,
  configFile: join(ROOT, "vite.config.ts"),
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const { runSoak } = await server.ssrLoadModule("/perf/soak.ts");
  const report = runSoak({ minutes: MINUTES });

  console.log(`soak — ${MINUTES} sim-minutes, ${report.ticks} ticks, seed ${report.seed}\n`);

  console.log("  the match happened");
  console.log(`    combat lasted    ${report.combatMinutes.toFixed(1)} of ${report.totalMinutes} sim-minutes`);
  console.log(`    units built      ${report.built}`);
  console.log(`    units lost       ${report.killed}`);
  console.log(`    peak population  ${report.peakEntities}`);
  console.log(`    deposits minted  ${report.wreckNodes} wreck/crater`);

  console.log("\n  the budget held");
  console.log(`    frame p50        ${report.p50.toFixed(2)} ms`);
  console.log(`    frame p95        ${report.p95.toFixed(2)} ms   budget ${report.budgetMs} ms`);
  console.log(`    first quarter    p95 ${report.p95First.toFixed(2)} ms`);
  console.log(`    last quarter     p95 ${report.p95Last.toFixed(2)} ms`);

  console.log("\n  nothing grew without bound");
  for (const row of report.growth) {
    const verdict = row.leaked ? "LEAK" : "ok";
    console.log(`    ${row.name.padEnd(18)} ${String(row.first).padStart(7)} → ${String(row.last).padStart(7)}   ${verdict}`);
  }

  for (const n of report.notes) console.log(`\n  note: ${n}`);

  if (report.problems.length) {
    console.error("\nsoak — FAILED:");
    for (const p of report.problems) console.error(`  • ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\nsoak — within budget, nothing unbounded");
  }
} finally {
  await server.close();
}
