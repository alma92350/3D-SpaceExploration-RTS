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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_PATH, type Fixture, replay } from "./replay.js";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

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

  it("diverges when one intent is dropped", () => {
    expect(replay({ ...fixture, script: fixture.script.slice(1) })).not.toBe(fixture.hash);
  });

  it("covers enough of the game to be worth trusting", () => {
    const kinds = new Set(fixture.script.map(([, intent]) => intent.kind));
    for (const required of ["deploy", "select", "move", "build", "train"]) {
      expect(kinds, `the replay should exercise ${required}`).toContain(required);
    }
    expect(fixture.ticks).toBeGreaterThanOrEqual(600);   // at least 30 sim-seconds
  });
});
