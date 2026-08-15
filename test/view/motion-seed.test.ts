// P6-T04 — the machine's own answer, before anything has applied a setting.
//
// Its own file because it is the one claim that needs a module nobody has touched: `reducedMotion()`
// resolves lazily, so the FIRST read on a machine that asks for reduced motion must already be
// still. Any test that had set a preference first would have hidden the seed behind its own call.
//
// Two things ride on it. A player whose OS asks for reduced motion is honoured on the very first
// frame, before the shell has read storage — and every code path that asks the view whether it may
// animate gets the same answer whether or not the boot sequence has reached it yet.

import { describe, expect, it } from "vitest";
import { reducedMotion } from "../../src/view/motion.js";
import { CombatEffects, TRACER_SECONDS } from "../../src/view/effects.js";

describe("a machine that asks for reduced motion, with nothing wired up", () => {
  it("is obeyed on the first read, and in the first frame the pool draws", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia =
      (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" });

    expect(
      reducedMotion(),
      "nothing had set a preference, so the default `auto` should have asked the machine — a " +
      "setting that only works once somebody remembers to apply it is the failure this seeds around",
    ).toBe(true);

    // …and it is the frame that changes, not just the answer.
    const fx = new CombatEffects();
    fx.ingestTick({
      shots: {
        count: 1, dropped: 0,
        fromX: new Float32Array([0]), fromY: new Float32Array([0]),
        toX: new Float32Array([10]), toY: new Float32Array([10]),
        owner: new Uint8Array([0]),
      },
      deaths: { count: 0, x: new Float32Array(0), y: new Float32Array(0), owner: new Uint8Array(0), isBuilding: new Uint8Array(0) },
      impacts: {
        count: 0, x: new Float32Array(0), y: new Float32Array(0), owner: new Uint8Array(0),
        heavy: new Uint8Array(0), bonus: new Uint8Array(0), splashRadius: new Float32Array(0),
      },
    } as unknown as Parameters<CombatEffects["ingestTick"]>[0]);

    const first = fx.tracerFade(0);
    fx.age(TRACER_SECONDS / 2);
    expect(fx.tracerFade(0), "the tracer faded on a machine that asked it not to").toBe(first);
    expect(first, "a still tracer is drawn at anything but full strength").toBe(1);
  });
});
