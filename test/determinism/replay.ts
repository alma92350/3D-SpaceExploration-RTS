// The replay machinery, shared by the determinism test and the fixture recorder.
//
// Kept out of a `.test.ts` file so both can import it without vitest collecting it twice.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { type Intent } from "../../src/bridge/commands.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

export const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mvp-replay.json");

export interface Fixture {
  seed: number;
  world: string;
  ticks: number;
  /** [tickNumber, intent] pairs, applied before that tick runs. */
  script: Array<[number, Intent]>;
  hash: string;
  note: string;
}

/**
 * A hash of everything the simulation decided. Deliberately fine-grained — positions to six
 * decimals — because a determinism test that rounds is a determinism test that passes while the
 * two runs slowly diverge.
 */
export function hashState(state: State): string {
  const h = createHash("sha256");
  h.update(`tick=${state.tick};time=${state.time.toFixed(6)}\n`);
  for (const owner of state.owners) {
    const r = state.players[owner].resources;
    h.update(`${owner}:${Object.keys(r).sort().map((k) => `${k}=${(r[k] ?? 0).toFixed(6)}`).join(",")}\n`);
  }
  for (const u of [...state.units.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    h.update(`u ${u.id} ${u.type} ${u.owner} ${u.x.toFixed(6)} ${u.y.toFixed(6)} ${u.hp.toFixed(6)} ${u.order?.type ?? "-"}\n`);
  }
  for (const b of [...state.buildings.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    // The economy fields are hashed as well as the physical ones, and that is not thoroughness for
    // its own sake. `logiPriority`, `paused` and `recycling` are what Phase 2's new orders CHANGE,
    // and a hash that ignored them would not move if one of those orders quietly stopped reaching
    // the engine — leaving a green fixture that proves nothing about the commands it issues. That
    // is the same failure the recorder itself was built to prevent (see record.test.ts), one layer
    // down. The buffers are included for the same reason: they are what a factory's whole
    // production loop moves.
    h.update(`b ${b.id} ${b.type} ${b.owner} ${b.x.toFixed(6)} ${b.y.toFixed(6)} ${b.hp.toFixed(6)} ${b.buildProgress.toFixed(6)} ${b.queue.length}`);
    h.update(` p=${b.paused ? 1 : 0} e=${b.electrified ? 1 : 0} lp=${b.logiPriority ?? "-"} rc=${b.recycling ? b.recycling.progress.toFixed(6) : "-"}`);
    h.update(` in=${buf(b.input)} out=${buf(b.store)}\n`);
  }
  return h.digest("hex");
}

/** A commodity buffer as a stable string — sorted, so key order can never change the hash. */
function buf(b: Resources | undefined): string {
  if (!b) return "-";
  return Object.keys(b).sort().map((k) => `${k}=${(b[k] ?? 0).toFixed(6)}`).join("|") || "-";
}

/** Run the fixture's script and return the end-state hash. */
export function replay(fixture: Fixture): string {
  const bridge = new WorldBridge({ seed: fixture.seed, worldId: fixture.world });
  const byTick = new Map<number, Intent[]>();
  for (const [tick, intent] of fixture.script) {
    const list = byTick.get(tick) ?? [];
    list.push(intent);
    byTick.set(tick, list);
  }
  for (let tick = 0; tick < fixture.ticks; tick++) {
    for (const intent of byTick.get(tick) ?? []) bridge.enqueue(intent);
    bridge.step(STEP_SECONDS);
  }
  return hashState(bridge.state);
}
