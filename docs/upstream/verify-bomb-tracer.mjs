#!/usr/bin/env node
// Runs the armed-Helium-Bomb defect and its fix side by side, and prints the numbers in
// `docs/upstream/README.md`. Found by P7-T02, from ADR-0023 §158.
//
//   node docs/upstream/verify-bomb-tracer.mjs <path-to-patched-engine>
//
// `<path-to-patched-engine>` is a copy of `src/engine/` with
// `0002-a-shot-that-sets-off-a-helium-bomb-announces-nothing.patch` applied. The vendored tree is
// never touched: ADR-0003 pins it byte-for-byte and CI fails on drift.
//
// Three measurements, because the whole argument for this patch is that it adds one event and
// changes nothing else:
//
//   1. THE DEFECT — a shot at an armed bomb announces no `attackHit`, so every client reading that
//      event draws no tracer for it. Counted on both engines.
//   2. NO OTHER EVENT MOVES — the full event stream of a packed 120-unit fight, tick by tick, type
//      by type and field by field, compared between the two engines. The patch is a hoist above an
//      early return, so every stream that never takes that return must be identical.
//   3. THE ENGINE'S OWN SUITE — run `node --test` over the vendored tests on the patched copy.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OLD = join(ROOT, "src", "engine");
const NEW = process.argv[2] && resolve(process.argv[2]);

if (!NEW || !existsSync(join(NEW, "engine", "combat.js"))) {
  console.error("usage: node docs/upstream/verify-bomb-tracer.mjs <path-to-patched-engine>");
  process.exit(1);
}

const SEED = 20260814;
const STEP = 1 / 20;

async function load(base) {
  return {
    galaxy: await import(`${base}/engine/galaxy.js`),
    state: await import(`${base}/engine/state.js`),
    sim: await import(`${base}/engine/sim.js`),
    entities: await import(`${base}/engine/entities.js`),
  };
}

/** One tick of the engine, draining events the way `WorldBridge.step` does. */
function step(e, state) {
  e.sim.tick(state, STEP);
  const events = state.events.slice();
  state.events.length = 0;
  return events;
}

// ---- 1. The defect: a shot that sets off a doomsday device announces nothing ------------------

function bombScenario(e) {
  const galaxy = e.galaxy.createGalaxy({ seed: SEED, startId: "helix" });
  const state = e.galaxy.activeState(galaxy);
  const base = state.map.bases.player;

  const gun = e.state.makeUnit("lancer", "player", base.x + 50, base.y);
  gun.hp = 1e9;                            // survive its own handiwork
  gun.maxHp = 1e9;
  const bomb = e.state.makeUnit("heliumbomb", "ai", base.x + 90, base.y);
  bomb.armed = true;
  state.units.set(gun.id, gun);
  state.units.set(bomb.id, bomb);

  let fired = 0;
  let hits = 0;
  let deaths = 0;
  let detonations = 0;
  let prev = gun.attackTimer;
  for (let t = 0; t < 90; t++) {
    for (const ev of step(e, state)) {
      if (ev.type === "attackHit") hits++;
      if (ev.type === "entityKilled") deaths++;
      if (ev.type === "bombDetonated") detonations++;
    }
    const now = state.units.get(gun.id)?.attackTimer ?? 0;
    if (now > prev + 1e-9) fired++;         // the cooldown was reset: a shot was spent
    prev = now;
  }
  return { fired, hits, deaths, detonations, bombGone: !state.units.has(bomb.id) };
}

// ---- 2. Everything else: the same fight, event for event --------------------------------------

/** ADR-0023's own `packedFight`, so the two rows can be read against each other. */
function packedFight(e, gap = 60) {
  const galaxy = e.galaxy.createGalaxy({ seed: SEED, startId: "helix" });
  const state = e.galaxy.activeState(galaxy);
  const base = state.map.bases.player;
  const cc = e.state.makeBuilding("command", "player", base.x, base.y);
  state.buildings.set(cc.id, cc);

  const types = Object.keys(e.entities.UNITS);
  for (let i = 0; i < 120; i++) {
    const type = types[i % types.length];
    const owner = (i * 7) % 2 === 0 ? "player" : "ai";     // decorrelated from type
    const side = i < 60 ? -gap : gap;
    const u = e.state.makeUnit(type, owner, base.x + side + ((i * 13) % 60) - 30, base.y + ((i * 29) % 180) - 90);
    state.units.set(u.id, u);
  }

  const stream = [];
  for (let t = 0; t < 400; t++) {
    for (const ev of step(e, state)) {
      // Every field, sorted, so a payload change is a difference and not a reordering.
      stream.push(`${t} ${JSON.stringify(ev, Object.keys(ev).sort())}`);
    }
  }
  return stream;
}

// ---- run --------------------------------------------------------------------------------------

const before = await load(OLD);
const after = await load(NEW);

console.log("1. A SHOT AT AN ARMED HELIUM BOMB (a Lancer, 90 ticks, helix, seed 20260814)\n");
const rows = [["", "shots fired", "attackHit", "entityKilled", "bombDetonated"]];
for (const [label, e] of [["before", before], ["after", after]]) {
  const r = bombScenario(e);
  if (!r.bombGone) throw new Error(`${label}: the bomb never went off — the fuze path was not taken`);
  rows.push([label, r.fired, r.hits, r.deaths, r.detonations].map(String));
}
for (const row of rows) console.log("   " + row.map((c, i) => c.padEnd(i === 0 ? 8 : 15)).join(""));
console.log(`\n   The shot is spent either way — every \`performAttack\` call site resets the shooter's`);
console.log(`   cooldown — so the "before" row is a shot that fired, landed, killed things, and told`);
console.log(`   no client it had happened.\n`);

console.log("2. EVERY OTHER EVENT, on a packed 120-unit fight over 400 ticks\n");
const a = packedFight(before);
const b = packedFight(after);
let diff = 0;
let firstDiff = "";
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    diff++;
    if (!firstDiff) firstDiff = `\n     before: ${a[i] ?? "<end>"}\n     after : ${b[i] ?? "<end>"}`;
  }
}
console.log(`   ${a.length} events before, ${b.length} after, ${diff} differing${firstDiff}`);
console.log(`   (no armed bomb in this scenario, so the patched branch is never taken and the two`);
console.log(`    streams must agree exactly — including field order and payload)\n`);

console.log("3. THE ENGINE'S OWN SUITE, on the patched copy\n");
// The same invocation `npm run test:sim` uses — a directory argument runs a different, narrower
// resolution and reported one synthetic failure instead of the 1 487 real tests.
const files = readdirSync(join(NEW, "test")).filter((f) => f.endsWith(".test.js")).sort()
  .map((f) => join(NEW, "test", f));
const suite = spawnSync("node", ["--test", ...files], { encoding: "utf8" });
const summary = (suite.stdout || "").split("\n").filter((l) => /^# (tests|pass|fail|skipped)/.test(l));
console.log(summary.map((l) => `   ${l}`).join("\n") || `   (no summary; exit ${suite.status})`);
process.exitCode = 0;
