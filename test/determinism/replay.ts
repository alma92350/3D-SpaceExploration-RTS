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
 * A hash of everything the simulation decided ON ONE WORLD. Deliberately fine-grained — positions
 * to six decimals — because a determinism test that rounds is a determinism test that passes while
 * the two runs slowly diverge.
 *
 * This is no longer the fixture's digest on its own — see `hashGalaxy` — but it stays a world
 * digest rather than growing galaxy fields, because a world is what its other caller has:
 * `test/ui/hud-economy.test.ts` hashes `bridge.state` before and after composing a panel to prove
 * the panel moved nothing.
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

/**
 * The fixture's digest: the SEAT, and every world the galaxy is simulating (P4-T11).
 *
 * Through Phase 3 the fixture hashed one world, because the client only ever had one. A jump ends
 * that: `jumpCapital` moves `galaxy.activeId`, lifts the staged expedition off the origin, drops it
 * on the destination, and demotes the world you left to a background colony that keeps ticking on
 * `stepGalaxy`'s coarser schedule. A one-world digest would have seen *less* after the jump than
 * before it — the seat is the destination, so every order the scenario spent 7 000 ticks issuing on
 * Helix Belt would have fallen straight out of the hash and out of the per-order coverage check
 * with it. So the widening is not an enhancement bolted onto this row; without it the row's own
 * fixture cannot hold its predecessors' claims.
 *
 * WHAT WENT IN, and what each field needs a real order to move:
 *
 *   • every world in `galaxy.planets`, each through `hashState`. This is what makes the jump
 *     provable from both ends: the riders LEAVE the origin (units gone from its digest) and ARRIVE
 *     on the destination (units in a world that, for a dormant destination, did not exist in the
 *     galaxy at all until `jumpCapital` called `addPlanet`). It also closes a hole the bridge's own
 *     header advertises and the fixture could not see: `WorldBridge.step` calls `stepGalaxy` rather
 *     than `tick` *specifically* so the background worlds keep simulating — and until this row,
 *     nothing in the determinism suite would have noticed if they had all silently frozen.
 *
 *     MEASURED, by running the per-order coverage loop under both digests: the seat-only digest
 *     leaves SIX of the fixture's thirty-five orders inert — the builder `select` at 140, the sell
 *     at 600, `logiPriority` at 620, the `attackMove` at 1080, and the Barracks' `pause` and
 *     `recycle` at the tail. Every one of them is an order whose only surviving mark is on the
 *     world the expedition leaves, which is precisely the set a seat-only digest stops being able
 *     to see at tick 7241. Under this digest, none.
 *   • `galaxy.activeId`. Not for the jump's sake — measured the same way, removing it leaves all
 *     thirty-five orders still moving the hash, the jump included — but because it is a simulation
 *     INPUT: `stepGalaxy` runs the seat at full rate and everything else at `BG_STEP` cadence, so
 *     two galaxies with identical worlds and different seats diverge on the very next tick. A
 *     digest that could not tell them apart would be under-specified. It earns its line by being
 *     part of the state, not by being part of the coverage.
 *
 * WHAT STAYED OUT, and why each exclusion is a decision rather than an oversight:
 *
 *   • `galaxy.credits`. Hashing them would make BOTH `trade` and `jump` trivially covered: the
 *     fuel leaves the treasury whether or not a single unit moved, and a sell that never delivered
 *     its ore would still shift the balance. This is P3-T17's `state.selection` argument exactly —
 *     credits are state that only reaches the simulation THROUGH a later order, and the coverage
 *     check is worth more than the extra fidelity. `record.test.ts` has said so at the buy order
 *     since Phase 2: the coverage comes from the ore that arrives.
 *   • `galaxy.discovered`. Same class: it is read by `jumpCost` (a reached world is a free return)
 *     and by nothing else, so hashing it would hand `jump` a second free pass.
 *   • `galaxy.tick` / `galaxy.time`. Pure functions of how many steps were run — identical in every
 *     replay of a fixture, including every withheld-order variant. Noise, not coverage. Each
 *     world's OWN `tick`/`time` are already hashed, and those do move: a world that stopped being
 *     the seat drops to the background cadence, which is how `from.background = true` is witnessed
 *     without hashing the flag itself.
 *   • lanes, colony policies, the roster. Nothing in this fixture moves them. The discipline is
 *     P2-T19's: a field enters the hash in the row that records an order which moves it, so the
 *     hash never grows a field no test can falsify. `test/bridge/galaxy-save.test.ts` covers them
 *     from the other direction, and deliberately with its own digest.
 *
 * THE ONE HONEST CAVEAT. Entity ids are minted from a module-global counter shared by every world
 * (`engine/state.js`, and `bumpEntityCounterPastGalaxy` in `engine/galaxy.js`), so an order that
 * changes WHEN something is minted on the seat renumbers entities on worlds the player has never
 * visited. Measured on the Phase 3 fixture: withholding the opening `select` or a `train` moved all
 * four worlds' digests, while withholding `cancelRecycle`, `holdFormation`, `stop` or a positional
 * `select` moved only the seat's. So the delicate orders — the ones P3-T17 had to fix the scenario
 * for — are unaffected, but a future order whose only surviving effect is a shifted mint would now
 * be "covered" through worlds it never touched. Where that is a risk, the answer is the one this
 * suite already uses: a named end-state assertion beside the hash (see the attack target and the
 * jump's riders in `replay.test.ts`), not a bigger hash.
 */
export function hashGalaxy(galaxy: Galaxy): string {
  const h = createHash("sha256");
  h.update(`seat=${galaxy.activeId}\n`);
  // Map order, not sorted. `galaxy.planets` is insertion-ordered — the start world, the seeded
  // background draw, then any world a jump instantiated — and that order is the one `sweepColonies`
  // and `runColonyPolicies` iterate, which both engine headers name as the basis of their own
  // determinism. Sorting here would hide a reordering that the simulation itself would notice.
  for (const [id, state] of galaxy.planets) h.update(`world ${id} ${hashState(state)}\n`);
  return h.digest("hex");
}

/** A commodity buffer as a stable string — sorted, so key order can never change the hash. */
function buf(b: Resources | undefined): string {
  if (!b) return "-";
  return Object.keys(b).sort().map((k) => `${k}=${(b[k] ?? 0).toFixed(6)}`).join("|") || "-";
}

/** Run the fixture's script and return the end-state hash. */
export function replay(fixture: Fixture): string {
  return hashGalaxy(replayToGalaxy(fixture));
}

/**
 * The same run, handing back the whole galaxy instead of a digest.
 *
 * Here because a hash can say two runs differ and never say what the fixture actually DID. P3-T17
 * needs both: the coverage check compares hashes, and then asks the end state whether the orders
 * left the marks they claim to (`replay.test.ts`). An attack whose target is alive at the end is
 * decoration no matter how much the hash moved around it, and after P4-T11 the same is true of a
 * jump whose riders never left the world they launched from.
 *
 * It returns the GALAXY rather than the seat because after a jump the seat is not where the
 * scenario happened: the squad, the Barracks and the attack's corpse are all on the world the
 * expedition left, and a check that only ever saw `bridge.state` would be asserting about the
 * wrong planet — vacuously, in the case of `expect(...).toBeUndefined()`.
 */
export function replayToGalaxy(fixture: Fixture): Galaxy {
  return galaxyOf(runFixture(fixture));
}

/** The seat at the end of the run — the world `activeId` names. */
export function replayToState(fixture: Fixture): State {
  return runFixture(fixture).state;
}

function runFixture(fixture: Fixture): WorldBridge {
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
  return bridge;
}

/**
 * The bridge's galaxy, reached through its own field.
 *
 * `WorldBridge` exposes `state` — the seat — with the note that only the bridge and its own tests
 * may hold it, and exposes nothing at all for the worlds AROUND the seat. That was right while the
 * client had one world; from P4-T11 the determinism harness needs the others, because that is where
 * a jump's evidence lives.
 *
 * **The honest fix is a `get galaxy()` accessor on `WorldBridge`, beside `get state()`,** and this
 * cast is a stand-in for it because `src/bridge/` was outside this task's file scope — it is
 * recorded here rather than left as a silent reach-in. `private` is a compile-time marking with no
 * runtime effect, so this reads the same object the accessor would return; the guard is what keeps
 * a rename from silently hashing `undefined` and reporting it as a determinism failure.
 */
export function galaxyOf(bridge: WorldBridge): Galaxy {
  const galaxy = (bridge as unknown as { galaxy?: Galaxy }).galaxy;
  if (!galaxy?.planets) {
    throw new Error(
      "WorldBridge no longer holds its galaxy on `.galaxy` — the determinism harness reads it there "
      + "to hash every world (P4-T11). Give the class a `get galaxy()` and use it here.",
    );
  }
  return galaxy;
}
