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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Intent } from "../../src/bridge/commands.js";
import { FIXTURE_PATH, type Fixture, hashState, replay, replayToState } from "./replay.js";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

/** Long enough for one replay per recorded order plus a couple over. See the coverage test. */
const COVERAGE_TIMEOUT_MS = 180_000;

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
  });

  it("is stable across repeated runs in the same process", () => {
    expect(replay(fixture)).toBe(replay(fixture));
  });

  it("diverges when the seed changes, so the test is not vacuously green", () => {
    // A determinism test that passes for every seed is testing nothing.
    expect(replay({ ...fixture, seed: fixture.seed + 1 })).not.toBe(fixture.hash);
  });

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
   * It costs one full replay per order (~12 seconds for thirty of them at 2200 ticks). That is the
   * price of the claim, and the claim is the reason the fixture exists.
   */
  it("moves the hash when any single order is withheld", () => {
    const full = replay(fixture);
    expect(full, "the fixture does not even reproduce its own hash — fix that first").toBe(fixture.hash);

    const inert: string[] = [];
    fixture.script.forEach(([tick, intent], i) => {
      const state = replayToState({ ...fixture, script: fixture.script.filter((_, j) => j !== i) });
      if (hashState(state) === full) inert.push(`  #${i} at tick ${tick}: ${asLine(intent)}`);

      // While that run is in hand, the one order with a fact attached to it. An `attack` is the
      // easiest order in the game to fool yourself about: the squad auto-acquires anything inside
      // 120 units, so a target picked carelessly dies either way and the hash still moves — through
      // the chase, not through the kill. Asserting the target SURVIVES its own order's absence is
      // what separates those two.
      if (intent.kind === "attack") {
        expect(
          state.units.get(intent.targetId),
          `the fixture's attack target (${intent.targetId}) died anyway with the attack order `
            + "withheld — something else in the scenario kills it, so the order proves nothing about "
            + "`issueAttack`. Move the target further out (see OUT_OF_AGGRO in record.test.ts).",
        ).toBeDefined();
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
    const state = replayToState(fixture);

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
  });
});

/** One recorded intent as a line a reader can act on, rather than as raw JSON. */
function asLine(intent: Intent): string {
  const { kind, ...rest } = intent as { kind: string } & Record<string, unknown>;
  const args = Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  return args ? `${kind} ${args}` : kind;
}
