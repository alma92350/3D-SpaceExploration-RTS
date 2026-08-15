// P1-T21 / PRD S4 — a recorded seed plus a recorded intent stream replays to a committed end-state
// hash, here, in CI, and on any developer's machine.
//
// This is the test that makes every other reuse claim checkable. If it goes red, either the
// vendored engine changed behaviour (which is upstream's business and should arrive with a ref
// bump), or something above the bridge started writing sim state — and that second case is the one
// nobody would otherwise notice until a save stopped loading.
//
// The fixture is committed data: `fixtures/mvp-replay.json` holds the seed, the world, the intent
// stream and the expected hash. It is PRODUCED by `record.test.ts` — see that file for why a
// hand-written one is a trap — and regenerating it is a deliberate act with a reason, exactly like
// a perf baseline (ADR-0006).
//
// The second half of this file (P3-T17) is the check that keeps the first half honest. A fixture
// can name an order, replay it, and reproduce its hash while the order does nothing at all — and
// that is not hypothetical: six of this fixture's thirty orders were in exactly that state when the
// check was first written, including both formation orders and the attack.
//
// **The digest is the GALAXY's from P4-T11**, not the seat's: the last order in the fixture is a
// jump, so from tick 7241 the seat is Verdani and everything the previous 7 000 ticks built is on
// the world it left. `hashGalaxy` explains what went into it and what deliberately stayed out.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Intent } from "../../src/bridge/commands.js";
import { FIXTURE_PATH, type Fixture, hashGalaxy, replay, replayToGalaxy } from "./replay.js";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

/** Long enough for one replay per recorded order plus a couple over. See the coverage test. */
const COVERAGE_TIMEOUT_MS = 300_000;

/**
 * One replay of the fixture is ~3 seconds of simulation, so vitest's 5-second default is not enough
 * for a test that runs two of them.
 *
 * The number is a consequence of P4-T11, not a slow machine: the fixture went from 2 200 ticks to
 * 7 400 because a jump needs a Spaceport and a Spaceport is four minutes of this world's mining
 * (see `TICKS` in `record.test.ts`), and a late tick is dearer than an early one because both sides
 * have built up by then. Raising the ceiling here rather than shortening the scenario is the
 * deliberate trade: a fixture that stops before the jump costs nothing and proves nothing.
 */
const REPLAY_TIMEOUT_MS = 60_000;

/** The jump's destination, read off the fixture rather than named twice. */
const jumpIntent = fixture.script
  .map(([, intent]) => intent)
  .find((i): i is Extract<Intent, { kind: "jump" }> => i.kind === "jump");

describe("determinism", () => {
  it("replays the committed intent stream to the committed hash (S4)", () => {
    const actual = replay(fixture);
    expect(actual, [
      "The recorded replay no longer reproduces its committed end state.",
      "",
      "If you have just re-run `npm run sync:engine`, upstream changed the rules and the fixture",
      "must be regenerated in its own commit, with the upstream ref in the message.",
      "Otherwise something above the bridge is writing simulation state, which ADR-0008 forbids —",
      "find that before touching this file.",
      "",
      `expected ${fixture.hash}`,
      `actual   ${actual}`,
    ].join("\n")).toBe(fixture.hash);
  }, REPLAY_TIMEOUT_MS);

  it("is stable across repeated runs in the same process", () => {
    expect(replay(fixture)).toBe(replay(fixture));
  }, REPLAY_TIMEOUT_MS);

  it("diverges when the seed changes, so the test is not vacuously green", () => {
    // A determinism test that passes for every seed is testing nothing.
    expect(replay({ ...fixture, seed: fixture.seed + 1 })).not.toBe(fixture.hash);
  }, REPLAY_TIMEOUT_MS);

  // ("diverges when one intent is dropped" used to live here, dropping the first order. The
  // coverage test below drops EVERY order including that one, so it was strictly subsumed — and it
  // cost a full replay to re-prove a single case of what the loop proves thirty times.)

  it("covers enough of the game to be worth trusting", () => {
    const kinds = new Set(fixture.script.map(([, intent]) => intent.kind));
    for (const required of [
      // Phase 1: the demo.
      "deploy", "select", "move", "build", "train",
      // Phase 2: the economy (P2-T19).
      "trade", "logiPriority", "pause", "recycle", "cancelRecycle",
      // Phase 3: combat (P3-T17). `attackMove`, `hold`, `patrol` and `stop` are Phase 1 orders the
      // fixture had never carried; `escort`, `holdFormation` and `moveInFormation` are the new
      // ones. Listing them here is cheap and catches the failure mode where a re-recording quietly
      // drops a beat — the hash would still reproduce, because it would be re-recorded too.
      "attack", "attackMove", "hold", "patrol", "stop",
      "escort", "holdFormation", "moveInFormation",
      // Phase 4: the galaxy (P4-T11). The one order in the stream that changes which world the
      // NEXT order would apply to.
      "jump",
    ]) {
      expect(kinds, `the replay should exercise ${required}`).toContain(required);
    }
    expect(fixture.ticks).toBeGreaterThanOrEqual(600);   // at least 30 sim-seconds
  });
});

describe("every recorded order earns its place (P3-T17)", () => {
  /**
   * Replay the fixture once per recorded order with that order withheld, and require every one of
   * those runs to land on a DIFFERENT hash.
   *
   * This is the whole point of the fixture. Without it, "the replay covers `escort`" means only
   * that the word appears in a JSON file: an intent that stopped reaching the engine — a bridge
   * case deleted, an engine function renamed, a selection filter that now matches nothing — would
   * leave a fixture that still replays to its committed hash, because the fixture would have been
   * re-recorded through the same broken path.
   *
   * P2-T19 established the rule by hand and fixed what it found. Running it as a LOOP, on the
   * Phase 2 fixture it left behind, immediately found four more it had not: two `select` orders
   * that no later order read, and — after all that — a `pause` that still could not move the hash,
   * because `paused` is a flag on a Barracks that nothing reads and the resume at tick 700
   * overwrote it. A hand check is a check of the orders somebody thought to check.
   *
   * P3-T17 then found six of its own, five from ONE cause: the squad arrived at a coordinate
   * written into the script and stood on it, and every order that had shaped the journey — the lone
   * Skiff's move, attack-move and hold, and both formation orders — replayed away to nothing. The
   * sixth was a patrol issued inside the enemy's base, where each leg was interrupted by a target
   * in range before it could start, so the squad never patrolled at all. What each fix was is
   * recorded at the order itself in `record.test.ts`.
   *
   * P4-T11 found none, and that is worth one line rather than silence: it lengthened the fixture
   * from 2 200 ticks to 7 400 and moved the Barracks' last two orders to the new tail, and every
   * one of the original thirty still moves the hash across the longer run.
   *
   * It costs one full replay per order — measured at ~110 seconds for thirty-five of them at 7 400
   * ticks, up from ~12 for thirty at 2 200. The rise is worse than the tick count because a late
   * tick is dearer than an early one: both sides have built up by then, and `stepGalaxy` is
   * carrying four worlds rather than one. P4-T11 paid it rather than shortening the scenario,
   * because the alternative is a fixture that stops before the jump — and the whole file is an
   * argument that a cheap green fixture is worth nothing. If it ever has to come down, the lever is
   * the ECONOMY (a jump needs 545 ore at 1.7 a second), not this loop.
   */
  it("moves the hash when any single order is withheld", () => {
    const full = replay(fixture);
    expect(full, "the fixture does not even reproduce its own hash — fix that first").toBe(fixture.hash);

    const inert: string[] = [];
    fixture.script.forEach(([tick, intent], i) => {
      const galaxy = replayToGalaxy({ ...fixture, script: fixture.script.filter((_, j) => j !== i) });
      if (hashGalaxy(galaxy) === full) inert.push(`  #${i} at tick ${tick}: ${asLine(intent)}`);
      const origin = galaxy.planets.get(fixture.world)!;

      // While that run is in hand, the two orders with a fact attached to them. An `attack` is the
      // easiest order in the game to fool yourself about: the squad auto-acquires anything inside
      // 120 units, so a target picked carelessly dies either way and the hash still moves — through
      // the chase, not through the kill. Asserting the target SURVIVES its own order's absence is
      // what separates those two.
      if (intent.kind === "attack") {
        expect(
          origin.units.get(intent.targetId),
          `the fixture's attack target (${intent.targetId}) died anyway with the attack order `
            + "withheld — something else in the scenario kills it, so the order proves nothing about "
            + "`issueAttack`. Move the target further out (see OUT_OF_AGGRO in record.test.ts).",
        ).toBeDefined();
      }

      // And the jump, which has the same failure mode from the other end: a hash that moved because
      // 5 200 ticks of Phase 4 economy ran differently would look exactly like a hash that moved
      // because the expedition crossed. So this asks the two questions only the jump can answer —
      // is the destination world in the galaxy at all, and are the colonists still standing on the
      // world they were supposed to leave.
      if (intent.kind === "jump") {
        expect(
          galaxy.planets.has(intent.destId),
          `${intent.destId} exists in the galaxy with the jump withheld — something else instantiates `
            + "it, so this order proves nothing about `jumpCapital`",
        ).toBe(false);
        expect(
          [...origin.units.values()].filter((u) => u.owner === "player" && u.type === "worker").length,
          "the colonists left the origin world anyway with the jump withheld — they were not the "
            + "expedition, and the manifest this fixture records is somebody else's",
        ).toBeGreaterThan(0);
        expect(galaxy.activeId, "the seat moved without the jump order").toBe(fixture.world);
      }
    });

    expect(inert, [
      "These recorded orders replayed to the SAME hash with the order withheld, which means the",
      "fixture does not cover them: each could stop reaching the engine tomorrow and this suite",
      "would stay green.",
      "",
      "The fix is the SCENARIO, not this check. Give the order something to do, or move it to where",
      "its effect survives to the final tick — the usual culprit is a later order that ends with the",
      "units standing still on a coordinate the script names, which erases everything before it.",
      "Removing an order and saying why it cannot be covered is also an answer. Deleting this",
      "assertion is not.",
      "",
      ...inert,
    ].join("\n")).toEqual([]);
  }, COVERAGE_TIMEOUT_MS);

  it("leaves the marks in the end state that the combat orders claim", () => {
    // The hash says two runs differ; it never says what happened. These are the facts the combat
    // half of the scenario is written to produce, asserted against the world rather than a digest.
    //
    // Against the ORIGIN world, not the seat: the fixture ends on Verdani, and every one of these
    // claims is about Helix Belt. Asked of `activeState` they would all pass for the wrong reason —
    // `toBeUndefined()` is satisfied very cheaply by looking on the wrong planet.
    const galaxy = replayToGalaxy(fixture);
    const state = galaxy.planets.get(fixture.world)!;
    expect(state, `the world the fixture opens on (${fixture.world}) is not in the galaxy`).toBeDefined();

    const attack = fixture.script.map(([, intent]) => intent).find((i) => i.kind === "attack");
    expect(attack, "the fixture no longer contains an attack order").toBeDefined();
    expect(
      state.units.get((attack as Extract<Intent, { kind: "attack" }>).targetId),
      "the attack order's target is alive at the final tick — the squad never ran it down, and the "
        + "order is decoration however much the hash moves around it",
    ).toBeUndefined();

    // Every Skiff the script trains must still be flying at the end. Counted from the script
    // rather than written as a literal, so a re-recording that changes the squad size updates this
    // with it — and so that a squad which dies to the AI mid-fixture (leaving the tail's orders
    // issued to fewer units than the scenario is written for) is a red test rather than a quiet
    // change in what the last five orders mean.
    const trained = fixture.script
      .filter(([, i]) => i.kind === "train" && (i as Extract<Intent, { kind: "train" }>).unitType === "skiff").length;
    const skiffs = [...state.units.values()].filter((u) => u.owner === "player" && u.type === "skiff");
    expect(
      skiffs.length,
      `the fixture trains ${trained} Skiffs and ${skiffs.length} are alive at the final tick — the `
        + "last orders in it were issued to a squad that no longer exists. Re-record and check the tail.",
    ).toBe(trained);
  }, REPLAY_TIMEOUT_MS);

  it("leaves the marks the jump claims, on both worlds (P4-T11)", () => {
    // A jump is two facts, and a fixture that checked only the first would be satisfied by an order
    // that moved the seat and nothing else. So: the expedition ARRIVED, and the world it left is
    // still standing and still simulating as a colony.
    expect(jumpIntent, "the fixture no longer contains a jump order").toBeDefined();
    const galaxy = replayToGalaxy(fixture);
    const origin = galaxy.planets.get(fixture.world)!;
    const dest = galaxy.planets.get(jumpIntent!.destId);

    expect(galaxy.activeId, "the seat is not the jump's destination").toBe(jumpIntent!.destId);
    expect(dest, `${jumpIntent!.destId} is not in the galaxy — the destination was never built`).toBeDefined();

    const arrived = [...dest!.units.values()].filter((u) => u.owner === "player");
    expect(arrived.length, "no player unit is on the destination — the jump carried nobody, and a "
      + "capacity-capped manifest that lifts nothing is not a manifest").toBeGreaterThan(0);
    expect(
      [...origin.units.values()].filter((u) => u.owner === "player" && u.type === "worker").length,
      "the colonists are still on the world the expedition left as well — riders are MOVED, not "
        + "copied, and a jump that copied them would be a save-corrupting bug the hash alone would "
        + "report only as 'something changed'",
    ).toBe(0);

    // The half of a jump players get wrong: NO base travels. The world you leave keeps every
    // building it had and becomes a background colony — which is also why the squad is still there.
    expect(
      [...origin.buildings.values()].filter((b) => b.owner === "player").length,
      "the origin world lost its buildings — `jumpCapital` relocates units, never a base",
    ).toBeGreaterThan(0);
    expect(origin.tick, "the world we left stopped ticking the moment we left it — the background "
      + "schedule dropped it, and `stepGalaxy` is the whole reason the bridge does not call `tick`")
      .toBeGreaterThan(0);
    expect(dest!.tick, "the destination never ticked, so it is not being simulated at all")
      .toBeGreaterThan(0);
  }, REPLAY_TIMEOUT_MS);

  it("ends on a world that is not the one the scenario happened on — which is why the digest widened", () => {
    // Why `hashGalaxy` exists, as a falsifiable claim rather than a comment.
    //
    // The digest this suite used through Phase 3 was `hashState` of the SEAT, and after tick 7241
    // the seat is Verdani: three colonists standing on a world that did not exist an hour ago.
    // Everything the fixture spent 7 000 ticks building — the Barracks and its flags, the Foundry,
    // the pad, the squad, the corpse — is on the world it left. The old digest would have "covered"
    // the jump beautifully while going blind to all of it in the same instant.
    //
    // Measured rather than argued: running the coverage loop above under a seat-only digest leaves
    // SIX orders inert (the builder select at 140, the sell at 600, `logiPriority`, the attack-move,
    // and both Barracks beats at the tail). It is asserted here as the MECHANISM — the world the
    // scenario happened on is not the world a seat-only digest would hash — because re-proving the
    // six costs another 35 replays, and this is the condition that produces them.
    const galaxy = replayToGalaxy(fixture);
    expect(galaxy.activeId, "the seat is the origin world, so this claim has nothing to say")
      .not.toBe(fixture.world);
    expect(galaxy.planets.size, "the galaxy holds one world, so a galaxy digest is a world digest")
      .toBeGreaterThan(1);
    // And the scenario's own evidence really is on the other world: buildings on the origin, none
    // of them on the seat.
    const origin = galaxy.planets.get(fixture.world)!;
    expect([...origin.buildings.values()].filter((b) => b.owner === "player").length)
      .toBeGreaterThan(0);
    expect([...galaxy.planets.get(galaxy.activeId)!.buildings.values()]
      .filter((b) => b.owner === "player").length,
    "the expedition built a base on the destination, so a seat-only digest would still see "
      + "something — this claim is about a seat that carries none of the scenario").toBe(0);
  }, REPLAY_TIMEOUT_MS);
});

/** One recorded intent as a line a reader can act on, rather than as raw JSON. */
function asLine(intent: Intent): string {
  const { kind, ...rest } = intent as { kind: string } & Record<string, unknown>;
  const args = Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  return args ? `${kind} ${args}` : kind;
}
