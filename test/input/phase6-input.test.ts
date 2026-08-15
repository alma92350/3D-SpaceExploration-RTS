// Keyboard-only PLAY, the pure half (P6-T11 — PRD §5's Phase 6 scope, N-05).
//
// P6-T03 made the HUD navigable and left the GAME mouse-only, and this module is where that was
// true: `translateKey` produced no `select` of any kind, so nothing on the keyboard could pick a
// worker, a Command Center or an army, and the only thing that ever completed one of the twelve
// pending modes was a click. Two keys close it — `Q` for *which thing* and `K` for *where* — and
// this file holds the claims that can be made without a DOM:
//
//   • what each key asks for, exactly, including that neither of them produces an intent or moves
//     the camera from here (both are the caller's to resolve, as `group` and `action` are);
//   • that **every** mode in the `PendingMode` union is completable from the keyboard, swept out of
//     the source rather than listed by hand — the check P4-T13 wrote for the `Intent` union, aimed
//     at the other union this module owns;
//   • that no OTHER key on a full board quietly acquired either behaviour.
//
// What a player can actually do with them is not assertable here and is not asserted here:
// `test/ui/keyboard-play.test.ts` drives a real `Game` from a cold start with no pointer event of
// any kind and asks the simulation what happened.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type KeyResult, type PendingMode, translateKey } from "../../src/input/intents.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(ROOT, "src/input/intents.ts");
const NONE: PendingMode = { kind: "none" };

function key(k: string, mode: PendingMode = NONE, mods: { shift?: boolean; ctrl?: boolean } = {}): KeyResult {
  return translateKey({ key: k, shift: mods.shift ?? false, ctrl: mods.ctrl ?? false }, mode);
}

/**
 * One sample of every `PendingMode`, so the sweep below can arm each of them for real.
 *
 * Kept honest by `covers the whole PendingMode union` — a mode added to the union without a line
 * here fails by name, which is the only way this sweep can mean "every mode" a year from now.
 */
const MODE_SAMPLES: Readonly<Record<string, PendingMode>> = {
  none: { kind: "none" },
  attackMove: { kind: "attackMove" },
  patrol: { kind: "patrol" },
  build: { kind: "build", buildingType: "turret" },
  formation: { kind: "formation", shape: "grid", leaderPos: "front" },
  escort: { kind: "escort" },
  rally: { kind: "rally" },
  repair: { kind: "repair" },
  service: { kind: "service" },
  assist: { kind: "assist" },
  ferry: { kind: "ferry" },
  homeBase: { kind: "homeBase" },
};

/**
 * Every `kind` in the `PendingMode` union, read out of the source.
 *
 * `intentKindsIn`'s method (`test/input/phase5-input.test.ts`) and for its reason: comments are
 * stripped first, and the block is walked by brace depth rather than to the first `;`, because the
 * members are object types full of semicolons and "the next semicolon" ends inside the first one.
 */
function pendingModeKindsIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const start = code.indexOf("export type PendingMode =");
  if (start < 0) throw new Error("the PendingMode union is not where this scan looks for it");
  let depth = 0;
  let end = -1;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ";" && depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("the PendingMode union does not terminate");
  return [...code.slice(start, end).matchAll(/\bkind:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("Q — the keyboard's answer to WHICH THING (P6-T11)", () => {
  it("asks for the next type, and for the next member with Shift", () => {
    // A DIRECTION and nothing else. `state.selection` is simulation state (ADR-0012 §5) and this
    // module has no engine, no snapshot and nothing to write it with — so what comes out is a step
    // for the caller to resolve, exactly as a control group press is.
    expect(key("q")).toEqual({
      intent: null, mode: null, camera: null, cancel: false, select: { scope: "type" },
    });
    expect(key("q", NONE, { shift: true })).toEqual({
      intent: null, mode: null, camera: null, cancel: false, select: { scope: "member" },
    });
  });

  it("is upstream's letter, so caps lock does not cost a player their army", () => {
    expect(key("Q").select, "an upper-case Q selects nothing").toEqual({ scope: "type" });
  });

  it("leaves a pending mode armed rather than cancelling it", () => {
    // Picking WHO does a job must not disarm the job: arming a build, choosing which worker puts it
    // up and then placing it is one sequence. `mode: null` is "the caller keeps what it has";
    // `{ kind: "none" }` would be this module quietly cancelling.
    for (const mode of Object.values(MODE_SAMPLES)) {
      expect(key("q", mode).mode, `Q disarmed ${mode.kind}`).toBeNull();
      expect(key("q", mode, { shift: true }).mode, `Shift+Q disarmed ${mode.kind}`).toBeNull();
    }
  });
});

describe("K — the keyboard's answer to WHERE (P6-T11)", () => {
  it("completes every mode in the union, and orders when none is armed", () => {
    // **The sweep, and it is the point of the key.** Twelve modes were reachable from the keyboard
    // and completable only by a mouse; a thirteenth added later must not quietly join them. Armed is
    // a click already promised, so K is that mode's LEFT click; nothing armed is the context order's
    // right click, which is how a keyboard says move / attack / gather at all.
    const kinds = pendingModeKindsIn(readFileSync(SOURCE, "utf8"));
    expect(kinds.length, "the PendingMode scan found almost nothing, so it is not scanning")
      .toBeGreaterThan(10);

    for (const kind of kinds) {
      const mode = MODE_SAMPLES[kind]!;
      const result = key("k", mode);
      expect(result.crosshair, `K does nothing with ${kind} armed`).toBeDefined();
      expect(result.crosshair!.button, `K sent the wrong button for ${kind}`)
        .toBe(kind === "none" ? "right" : "left");
    }
  });

  it("covers the whole PendingMode union, so the sweep above cannot go stale", () => {
    // The other direction, `REACHED_BY_A_CONTROL`'s move: a sample left behind after its mode was
    // renamed would silently excuse whatever took its place, and a mode added without a sample would
    // make the sweep smaller without making it fail.
    const kinds = pendingModeKindsIn(readFileSync(SOURCE, "utf8"));
    expect([...kinds].sort(), "the mode samples and the union disagree — see the message in the diff")
      .toEqual(Object.keys(MODE_SAMPLES).sort());
  });

  it("hands the shift modifier through with the meaning it has under the mouse", () => {
    // It IS the same gesture — the caller puts it back through `translatePointer` — so shift keeps
    // being "queue this order behind the last" and "keep the build mode alive for a second turret".
    expect(key("k", NONE, { shift: true }).crosshair).toEqual({ button: "right", shift: true });
    expect(key("k", MODE_SAMPLES.build!, { shift: true }).crosshair)
      .toEqual({ button: "left", shift: true });
    expect(key("k").crosshair, "K invented a modifier nobody pressed")
      .toEqual({ button: "right", shift: false });
  });

  it("writes no intent and moves no camera from here", () => {
    // The crosshair resolves against the camera and the snapshot, neither of which this module can
    // see. A `move` intent built here would be one built from a position it had to guess.
    for (const mode of Object.values(MODE_SAMPLES)) {
      const r = key("k", mode);
      expect(r.intent, `K produced an intent with ${mode.kind} armed`).toBeNull();
      expect(r.camera, `K moved the camera with ${mode.kind} armed`).toBeNull();
      expect(r.mode, `K decided the next mode, which is the pointer translator's answer`).toBeNull();
      expect(r.cancel).toBe(false);
    }
    expect(key("K").crosshair, "an upper-case K is a dead key").toBeDefined();
  });
});

describe("the two keys are the only two (P6-T11)", () => {
  it("leaves every other key on the board alone", () => {
    // A full board: every letter, both modifiers, the digits and the named keys this module owns.
    // Q and K were the last two free letters, so a binding that spread would be taking one that is
    // already spent — and `J` stays unbound, which is `intents.test.ts`'s guard against exactly that.
    const keys = [
      ..."abcdefghijklmnopqrstuvwxyz".split(""),
      ..."0123456789".split(""),
      "delete", "escape", " ", "home", ",", ".", "Tab", "Enter",
    ].filter((k) => k !== "q" && k !== "k");

    for (const k of keys) {
      for (const shift of [false, true]) {
        for (const mode of [NONE, MODE_SAMPLES.build!]) {
          const r = key(k, mode, { shift });
          const name = `${shift ? "Shift+" : ""}${k}`;
          expect(r.select, `${name} acquired the selection cycle`).toBeUndefined();
          expect(r.crosshair, `${name} acquired the crosshair`).toBeUndefined();
        }
      }
    }
  });

  it("keeps J unbound, because the guard is worth more than the letter", () => {
    // Re-stated here rather than only in `intents.test.ts`: this row spent the last two bare
    // letters, so J is now the whole of the reserve and the only thing that would notice a key
    // quietly acquiring a binding.
    expect(key("j")).toEqual({ intent: null, mode: null, camera: null, cancel: false });
    expect(key("j", NONE, { shift: true })).toEqual({ intent: null, mode: null, camera: null, cancel: false });
  });

  it("keeps Enter and Space out of the world, which is P6-T03's hazard and not this row's to reopen", () => {
    // The obvious keys for "do it here" are the two `ui/hud-focus.ts` has to own while the ring
    // holds focus, because a browser fires a focused button on Space while `translateKey` reads
    // Space as focus-last-alert. Giving either a world meaning would rebuild that on purpose: one
    // press, two commands, decided by whether something invisible has focus.
    expect(key("Enter"), "Enter took a world meaning")
      .toEqual({ intent: null, mode: null, camera: null, cancel: false });
    expect(key(" ").crosshair, "Space took the crosshair").toBeUndefined();
    expect(key(" ").select, "Space took the selection cycle").toBeUndefined();
    expect(key(" ").camera, "Space stopped being the alert key").toBe("focusAlert");
  });
});
