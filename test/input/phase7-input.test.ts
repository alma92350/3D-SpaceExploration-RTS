// The two controls that were still pointer-only, the pure half (P7-T03 — PRD N-05, PRD §5).
//
// P6-T11 made the game playable with no mouse and named its own remainder: **the wheel was the only
// zoom control in the app**, and the approach screen's landing mark took screen pixels. Only the
// first of those two costs this module anything — the mark is placed by keys that were already
// bound (`K`, and the pan set) and simply had never been pointed at that screen, which is
// `test/ui/keyboard-play.test.ts`'s business because it is a fact about the shell.
//
// So what is asserted here is a key budget as much as a binding. The claims are arranged around the
// one thing that could go wrong on a board P6-T11 left with no bare letter at all:
//
//   • `+`/`-` do what they say, including through the two ways a keyboard produces them — `=` and
//     `+` are one physical key without and with Shift, and `-` and `_` are the other;
//   • **no letter anywhere on the board acquired a camera action**, which is the whole claim of the
//     choice: zoom was added and the letters are exactly where P6-T11 left them;
//   • the brackets stayed unbound, because they were the alternative and a rejected alternative is
//     only a decision if something holds it;
//   • and the two keys P6-T03 has to own — Enter and Space — still have no world meaning.

import { describe, expect, it } from "vitest";
import {
  type KeyResult, type PendingMode, physicalLetter, translateKey,
} from "../../src/input/intents.js";

const NONE: PendingMode = { kind: "none" };

function key(k: string, mode: PendingMode = NONE, mods: { shift?: boolean; ctrl?: boolean } = {}): KeyResult {
  return translateKey({ key: k, shift: mods.shift ?? false, ctrl: mods.ctrl ?? false }, mode);
}

/**
 * Every key this module could plausibly be handed, as `KeyboardEvent.key`.
 *
 * The letters, the digits, the named keys this file owns, and **every unshifted punctuation key on
 * a US board plus the shifted halves of the two the zoom uses**. The punctuation is the point: it
 * is the only part of the board with anything left on it, so it is the only part where a binding
 * could quietly appear.
 */
const WHOLE_BOARD: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  ..."`-=[]\\;',./",
  ..."~!@#$%^&*()_+{}|:\"<>?",
  "delete", "escape", " ", "home", "end", "tab", "enter", "backspace",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown",
];

/** What each key asks the camera to do. Anything absent asks for nothing. */
const CAMERA_KEYS: Readonly<Record<string, string>> = {
  " ": "focusAlert",
  home: "focusBase",
  ",": "rotateLeft",
  ".": "rotateRight",
  "+": "zoomIn",
  "=": "zoomIn",
  "-": "zoomOut",
  _: "zoomOut",
};

describe("zoom — the one camera control that had no key at all (P7-T03)", () => {
  it("asks the shell to zoom, and asks for nothing else", () => {
    // A camera action and nothing more. The camera is not sim state (ADR-0012 §5), so this module
    // has nothing to write and says only WHICH WAY — exactly as `rotateLeft` beside it does, and
    // for the same reason `group` and `crosshair` are directions rather than results.
    expect(key("+")).toEqual({ intent: null, mode: null, camera: "zoomIn", cancel: false });
    expect(key("-")).toEqual({ intent: null, mode: null, camera: "zoomOut", cancel: false });
  });

  it("takes both halves of both keys, so zoom is the one control that needs no modifier", () => {
    // `+` IS Shift+`=` on a US layout and `_` IS Shift+`-`. Binding only the shifted halves would
    // make a player hold Shift to zoom in and not to zoom out — an asymmetry they would find by
    // pressing the key capped `+` and getting nothing. The numeric keypad emits `+`/`-` directly,
    // with no modifier at all, which is the third way in and needs no separate binding.
    expect(key("=").camera, "= is not the unshifted +").toBe("zoomIn");
    expect(key("+", NONE, { shift: true }).camera, "+ with the Shift that produces it is dead")
      .toBe("zoomIn");
    expect(key("_").camera, "_ is not the shifted -").toBe("zoomOut");
    expect(key("-", NONE, { shift: true }).camera, "- stopped working while Shift was down")
      .toBe("zoomOut");
    // …and the two directions are genuinely two. A pair that collapsed would leave a player able to
    // zoom one way only, which is the state this row found the keyboard in.
    expect(key("+").camera, "the two directions are the same action").not.toBe(key("-").camera);
  });

  it("leaves a pending mode and the selection alone, on every mode in the union", () => {
    // Zoom is a look, not an act. Arming a build, zooming out to find the spot and then placing it
    // is one sequence, and a camera key that disarmed it would be this file cancelling an order the
    // player never cancelled. `mode: null` is "the caller keeps what it has".
    for (const mode of [NONE, { kind: "build", buildingType: "turret" } as PendingMode]) {
      for (const k of ["+", "=", "-", "_"]) {
        const r = key(k, mode);
        expect(r.mode, `${k} disarmed ${mode.kind}`).toBeNull();
        expect(r.intent, `${k} produced an intent`).toBeNull();
        expect(r.cancel, `${k} cancelled`).toBe(false);
        expect(r.crosshair, `${k} acquired the crosshair`).toBeUndefined();
        expect(r.select, `${k} acquired the selection cycle`).toBeUndefined();
        expect(r.action, `${k} acquired a positional slot`).toBeUndefined();
      }
    }
  });

  it("is not the bracket keys, which were the alternative and stay unbound", () => {
    // `[`/`]` is a real convention and a different one — brush size in an image editor, previous
    // and next in a media player, nothing whatever in an RTS — and neither bracket says which way
    // is closer. Recorded as a check rather than only as a paragraph, because the next row to want
    // a punctuation key will find this before it finds the header.
    for (const k of ["[", "]", "{", "}"]) {
      expect(key(k), `${k} acquired a binding; the header says why it should not have`)
        .toEqual({ intent: null, mode: null, camera: null, cancel: false });
    }
  });
});

describe("the key budget after P7-T03 (PRD N-05)", () => {
  it("spends no letter — every camera action in the app is on a key that is not one", () => {
    // **The claim the choice was made for.** P6-T11 spent the last two bare letters and wrote that
    // the board was full; this row added a control anyway. Sweeping the whole board for camera
    // actions is what proves it did so without taking one — a zoom that had landed on a letter
    // would fail here by name, and so would a letter that quietly acquired any camera action later.
    const bound: string[] = [];
    for (const k of WHOLE_BOARD) {
      for (const shift of [false, true]) {
        for (const mode of [NONE, { kind: "build", buildingType: "turret" } as PendingMode]) {
          const camera = key(k, mode, { shift }).camera;
          if (camera === null) {
            expect(CAMERA_KEYS[k], `${k} stopped being the ${CAMERA_KEYS[k]} key`).toBeUndefined();
            continue;
          }
          expect(camera, `${shift ? "Shift+" : ""}${k} moves the camera and should not`)
            .toBe(CAMERA_KEYS[k]);
          if (!bound.includes(k)) bound.push(k);
        }
      }
    }
    expect(bound.sort(), "the set of camera keys is not the set this row left behind")
      .toEqual(Object.keys(CAMERA_KEYS).sort());
    expect(bound.filter((k) => /^[a-z]$/.test(k)),
      "a camera action landed on a LETTER — the board had none left to spend").toEqual([]);
  });

  it("keeps J unbound, because the guard is worth more than the letter", () => {
    // Re-stated here as P6-T11 re-stated it: J is the whole of the reserve, and it is the only
    // thing that would notice a key quietly acquiring a binding. A row that added a control without
    // spending a letter is exactly the row that must not have nudged this one.
    expect(key("j")).toEqual({ intent: null, mode: null, camera: null, cancel: false });
    expect(key("j", NONE, { shift: true })).toEqual({ intent: null, mode: null, camera: null, cancel: false });
  });

  it("keeps Enter and Space out of the world, which P6-T03 owns and this row does not reopen", () => {
    // The obvious keys for "zoom" are not these, but the obvious keys for anything are, and the
    // hazard is the same one every time: `ui/hud-focus.ts` must own Enter and Space while the ring
    // holds focus, so a world meaning on either would be one press firing two commands, decided by
    // whether something invisible has focus.
    expect(key("Enter"), "Enter took a world meaning")
      .toEqual({ intent: null, mode: null, camera: null, cancel: false });
    expect(key(" ").camera, "Space stopped being the alert key").toBe("focusAlert");
    expect(key(" ").crosshair, "Space took the crosshair").toBeUndefined();
  });

  it("leaves P6-T11's own two keys exactly as it found them", () => {
    // This row reused `K` on a second screen and changed nothing about what `K` ASKS for — the
    // difference is entirely in `app/game.ts`, which is where the screen lives. If that had leaked
    // back into this module the crosshair would have grown a screen it cannot see.
    expect(key("q")).toEqual({
      intent: null, mode: null, camera: null, cancel: false, select: { scope: "type" },
    });
    expect(key("k")).toEqual({
      intent: null, mode: null, camera: null, cancel: false,
      crosshair: { button: "right", shift: false },
    });
    expect(key("k", { kind: "build", buildingType: "turret" }).crosshair,
      "the crosshair stopped reading the pending mode").toEqual({ button: "left", shift: false });
  });
});

/* =================================================================================================
   MUTATION LOG — every claim in this row was made to fail before it was kept.

   Twenty-eight mutations across `src/input/intents.ts`, `src/app/game.ts`, `src/ui/onboarding.ts`,
   `index.html` and — because the trap this row was filed with is decided there rather than here —
   `src/ui/landing-panel.ts`. Each was applied, run against this file plus
   `test/ui/keyboard-play.test.ts`, `test/ui/onboarding.test.ts` and the Phase 3/4/6 input suites,
   then reverted with the source hashed before and after to prove the restore was byte-for-byte.
   **One survived and is written up at the bottom, with what it turned out to be measuring.**

   THE KEY, in `src/input/intents.ts`:
     • `=` dropped from the zoom-in case            -> 3 red, incl. "zoom is the one control that
                                                       needs no modifier"
     • `_` dropped from the zoom-out case           -> 3 red
     • the two directions swapped                   -> 7 red
     • zoom unbound entirely                        -> 9 red
     • zoom also bound to `J`                       -> 3 red, incl. both J guards — the letter board
                                                       is the thing this row promised not to spend
     • zoom also bound to `[` and `]`               -> 2 red: the rejected alternative is held
     • `,` re-pointed from rotate to zoom           -> 1 red: the camera-key set is pinned as a SET,
                                                       so a binding cannot move house unnoticed

   THE SHELL, in `src/app/game.ts`:
     • the key's direction inverted                 -> 4 red
     • the WHEEL's direction inverted               -> 2 red — the wheel had no test in this
                                                       repository at all until this row shared a call
                                                       with it
     • the key step made three notches              -> 2 red: "one press is not one wheel notch"
     • zoom never reaches the approach rig          -> 2 red
     • zoom reaches the starmap plate               -> 1 red (ADR-0019 §3: one authored distance)
     • the shell ignores the translated zoom        -> 4 red
     • the pan keys dropped from the picker         -> 3 red — the state this row found
     • the picker's pan keys drive the battlefield  -> 3 red
     • edge scrolling allowed on the picker         -> 1 red
     • `allowEdgeScroll` ignored                    -> 1 red
     • `rig.pan` → `this.camera.pan`                -> 4 red
     • `K` marks nothing on the approach screen     -> 4 red — the row's whole subject
     • the mark placed at pixel 0,0                 -> 2 red
     • the mark placed at the (never-moved) pointer -> 2 red
     • the mark ray-marched through the BATTLEFIELD
       camera rather than the picker's              -> 1 red: the colony ship lands elsewhere
     • the selection cycle allowed on the picker    -> 1 red

   THE TRAP, in `src/ui/landing-panel.ts` — not this row's file, mutated because a control that
   obeys a panel is only as honest as the panel:
     • the pad case ships the pick after all        -> 2 red, incl. this row's own padded-world test
     • the intent carries the SNAPPED point         -> 2 red

   THE PROSE, which is the only thing here a compiler never reads:
     • the card names a key nothing binds           -> 1 red, by name
     • the sidebar advertises `[` as a zoom key     -> 1 red, by name

     • SURVIVED, then fixed (1): `markLanding` clearing the mark before placing the new one. Every
       press in every test resolved, so clearing first was invisible — the two differ only when
       `pointAt` REFUSES, which it does when the centre ray leaves the world. That looked unreachable
       from a crosshair (the ray is the rig's own look-at line and the rig's target is clamped into
       the map) and is not: at the northern and southern edges the ray approaches from the south and
       can cross out before it meets the ground. Fixed with a boundary sweep asserting the INVARIANT
       — a chosen mark survives every press, everywhere — rather than a coordinate at one edge, since
       whether a given edge refuses turns on the sign of a sub-thousandth float against that world's
       terrain, and a test pinned to that would be pinning a coin flip.
   ================================================================================================= */

/* =================================================================================================
   AZERTY: THE PAN DIAMOND IS A POSITION, NOT FOUR LETTERS (PT-02)

   The first playtester was on a French machine and asked for layout detection. The finding was
   worse than "the keys are in the wrong place": every binding read `event.key`, so on AZERTY the
   physical W and A positions emit `z` and `q` — which are not merely dead, they are BOUND TO OTHER
   COMMANDS. `z` is the first positional action button (Deploy, on a selected colony ship) and `q`
   cycles the selection and flies the camera to it. Panning up would have deployed your colony ship.

   The split this pins: controls that are a SHAPE UNDER THE HAND read `event.code` (the pan diamond,
   and the Z C V B N action row, which upstream's own naming calls positional); controls that are a
   MNEMONIC read `event.key`, because `A` for attack-move should follow the letter a player reads.
   ================================================================================================= */

describe("keyboard layout (PT-02)", () => {
  /** What an AZERTY keyboard sends for the four physical positions QWERTY calls W, A, S, D. */
  const AZERTY_PAN = [
    { code: "KeyW", key: "z" },
    { code: "KeyA", key: "q" },
    { code: "KeyS", key: "s" },
    { code: "KeyD", key: "d" },
  ] as const;

  it("reads a letter's physical position from its code, on any layout", () => {
    expect(physicalLetter("KeyW")).toBe("w");
    expect(physicalLetter("KeyZ")).toBe("z");
    // Not a letter key: the digit row is a mnemonic (control group 1), not a position.
    expect(physicalLetter("Digit1")).toBeNull();
    expect(physicalLetter("ArrowLeft")).toBeNull();
    // No code at all falls back to the label, which is what keeps synthetic events working.
    expect(physicalLetter(undefined)).toBeNull();
    expect(physicalLetter("")).toBeNull();
  });

  it("does not fire the action row when an AZERTY player pans", () => {
    // The defect, stated exactly: `z` IS the first positional button, and on AZERTY it is what the
    // physical W position emits. Without the code, panning up deploys the colony ship.
    for (const { code, key } of AZERTY_PAN) {
      const result = translateKey({ key, code, shift: false, ctrl: false });
      expect(
        result.action ?? null,
        `the physical ${code} position fired action row button ${result.action?.index} on AZERTY — `
        + "a player panning the camera would be pressing a HUD button",
      ).toBeNull();
    }
  });

  it("still fires the action row from the physical Z C V B N positions on AZERTY", () => {
    // The other half: the row has to remain reachable. On AZERTY `KeyZ` is labelled W.
    const positions = ["KeyZ", "KeyC", "KeyV", "KeyB", "KeyN"];
    positions.forEach((code, index) => {
      // The label AZERTY sends for KeyZ is "w"; the rest are unchanged. Either way the code decides.
      const key = code === "KeyZ" ? "w" : code[3]!.toLowerCase();
      const result = translateKey({ key, code, shift: false, ctrl: false });
      expect(result.action?.index, `the physical ${code} position did not reach action ${index}`)
        .toBe(index);
    });
  });

  it("keeps mnemonic orders on the letter a player reads, not on a position", () => {
    // `A` is attack-move because the word is "attack", so it follows the LABEL. On AZERTY the key
    // labelled A sits at the physical Q position, and it must still mean attack-move there.
    const azertyLabelledA = translateKey({ key: "a", code: "KeyQ", shift: false, ctrl: false });
    expect(azertyLabelledA.mode, "the key labelled A stopped meaning attack-move on AZERTY")
      .toEqual({ kind: "attackMove" });
  });

  it("changes nothing at all on QWERTY, where code and label agree", () => {
    // The regression guard for the majority case: every pan position still reports its own letter,
    // and the action row still answers to z c v b n.
    for (const letter of ["w", "a", "s", "d"]) {
      expect(physicalLetter(`Key${letter.toUpperCase()}`)).toBe(letter);
    }
    ["z", "c", "v", "b", "n"].forEach((letter, index) => {
      const withCode = translateKey({ key: letter, code: `Key${letter.toUpperCase()}`, shift: false, ctrl: false });
      const without = translateKey({ key: letter, shift: false, ctrl: false });
      expect(withCode.action?.index).toBe(index);
      expect(without.action?.index, "dropping the code changed the QWERTY answer").toBe(index);
    });
  });
});
