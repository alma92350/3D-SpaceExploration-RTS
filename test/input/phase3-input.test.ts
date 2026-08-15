// Phase 3's orders, reachable by a player.
//
// **This file exists because of a finding, not because of a board row.** Writing the Phase 3
// playtest script (P3-T18) turned up that `ControlGroups` was referenced nowhere outside its own
// module and that no key or click produced a formation, an escort, or a bomb command — the intents
// were implemented at the bridge, tested at the bridge, and unreachable. Three rows read DONE for
// work a player could not do.
//
// That is a systemic shape in this project rather than a Phase 3 slip: panels here are pure MODELS
// by an explicit decision (Q-10, ADR-0012 §4), and only Phase 1's own gestures were ever wired.
// The rest of the gap is recorded on the board; what this file covers is Phase 3's half, and the
// last test is the one that stops it recurring — it fails when an intent has no way in.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEADER_POS, FORMATION_KEY_SHAPES, type PendingMode, translateKey, translatePointer,
} from "../../src/input/intents.js";
import { FORMATION_SHAPES, LEADER_POSITIONS } from "../../src/engine/index.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const NONE: PendingMode = { kind: "none" };

function key(k: string, mode: PendingMode = NONE, mods: { shift?: boolean; ctrl?: boolean } = {}) {
  return translateKey({ key: k, shift: mods.shift ?? false, ctrl: mods.ctrl ?? false }, mode);
}

/** A snapshot to hand `translatePointer`. It only ever reads it, so a real empty one will do. */
function snap() {
  const bridge = new WorldBridge({ seed: 20260814, worldId: "helix" });
  bridge.step(STEP_SECONDS);
  return bridge.snapshot;
}

describe("formations reach the engine (P3-T11)", () => {
  it("offers exactly the shapes the engine knows, so no key is silently refused", () => {
    // `input/` may not import the engine (ADR-0008), so the shape list is a copy — and a copy that
    // drifts is a key press that reaches `applyIntent`, fails its validation, and returns "Unknown
    // formation" to nobody. This is the assertion that keeps the copy honest.
    expect([...FORMATION_KEY_SHAPES]).toEqual([...FORMATION_SHAPES]);
    expect(LEADER_POSITIONS, "the default leader position is not one the engine accepts")
      .toContain(DEFAULT_LEADER_POS);
  });

  it("arms a formation move and cycles the shape on a repeat press", () => {
    // Cycling and arming are one gesture on purpose: the shape rides on the mode, so the player can
    // see what they are about to get before they spend the click.
    let mode = key("f").mode!;
    expect(mode).toEqual({ kind: "formation", shape: "grid", leaderPos: DEFAULT_LEADER_POS });

    const seen = [(mode as { shape: string }).shape];
    for (let i = 0; i < FORMATION_KEY_SHAPES.length; i++) {
      mode = key("f", mode).mode!;
      seen.push((mode as { shape: string }).shape);
    }
    expect(seen.slice(0, -1), "F did not walk the shape list").toEqual([...FORMATION_KEY_SHAPES]);
    expect(seen[seen.length - 1], "the cycle did not wrap").toBe(FORMATION_KEY_SHAPES[0]);
  });

  it("turns the next left click into a formation move carrying that shape", () => {
    const mode = key("f", key("f").mode!).mode!;          // grid → line
    const r = translatePointer(
      { type: "click", button: "left", worldX: 400, worldY: 250, shift: false, ctrl: false },
      mode, snap(),
    );
    expect(r.intent).toEqual({
      kind: "moveInFormation", x: 400, y: 250, shape: "line", leaderPos: DEFAULT_LEADER_POS, queue: false,
    });
    expect(r.mode, "the mode stuck, so every later click would also be a formation move").toEqual(NONE);
  });

  it("holds a formation on T, reusing the shape F last armed", () => {
    const armed = key("f", key("f").mode!).mode!;         // line
    expect(key("t", armed).intent)
      .toEqual({ kind: "holdFormation", shape: "line", leaderPos: DEFAULT_LEADER_POS });
    // …and works on its own, with no formation armed, rather than doing nothing.
    expect(key("t").intent)
      .toEqual({ kind: "holdFormation", shape: FORMATION_KEY_SHAPES[0], leaderPos: DEFAULT_LEADER_POS });
  });
});

describe("escorts reach the engine (P3-T12)", () => {
  it("arms on P and takes the ship under the next click", () => {
    const mode = key("p").mode!;
    expect(mode).toEqual({ kind: "escort" });
    const r = translatePointer(
      { type: "click", button: "left", worldX: 10, worldY: 10, entityId: "u7", shift: true, ctrl: false },
      mode, snap(),
    );
    expect(r.intent).toEqual({ kind: "escort", targetId: "u7", queue: true });
  });

  it("cancels on empty ground instead of swallowing the click", () => {
    // An escort needs a ship. Issuing nothing AND staying armed is the worst outcome: the player
    // clicks again, and the second click escorts whatever they happened to hit.
    const r = translatePointer(
      { type: "click", button: "left", worldX: 10, worldY: 10, entityId: null, shift: false, ctrl: false },
      key("p").mode!, snap(),
    );
    expect(r.intent).toBeNull();
    expect(r.mode, "the escort mode survived a miss").toEqual(NONE);
  });
});

describe("control groups reach the digit row (P3-T13)", () => {
  it("assigns on ctrl, appends on shift, recalls bare", () => {
    expect(key("3", NONE, { ctrl: true }).group).toEqual({ n: 3, op: "assign" });
    expect(key("3", NONE, { shift: true }).group).toEqual({ n: 3, op: "append" });
    expect(key("3").group).toEqual({ n: 3, op: "recall" });
    expect(key("0").group, "zero is a group, not a falsy nothing").toEqual({ n: 0, op: "recall" });
  });

  it("never produces an intent, which is the constraint the whole task is about", () => {
    // A control group that reached `applyIntent` from here would be this module deciding what the
    // selection is. The recall becomes a `select` intent one layer up, where the group and the
    // snapshot both live — see `Game.applyGroup`.
    for (let n = 0; n <= 9; n++) {
      for (const mods of [{}, { ctrl: true }, { shift: true }]) {
        expect(key(String(n), NONE, mods).intent, `digit ${n} produced an intent`).toBeNull();
      }
    }
  });

  it("leaves the letters alone", () => {
    // Guards the digit test above: a regex that matched too much would swallow every key on the
    // board and this suite would still be green.
    expect(key("x").group).toBeUndefined();
    expect(key("x").intent).toEqual({ kind: "stop" });
  });

  it("does not read the spacebar as group zero", () => {
    // The trap this binding actually has, and it is not hypothetical: `Number(" ")` is **0**, as is
    // `Number("")`. The obvious implementation — parse the key, treat a finite result as a digit —
    // turns the spacebar into a control-group recall, and the spacebar is bound to focus-base. It
    // was caught by the pre-existing camera test when tried, which is luck; pinned here on purpose.
    expect(key(" ").group, "the spacebar became a control group").toBeUndefined();
    expect(key(" ").camera).toBe("focusAlert");
    expect(key("").group, "an empty key name became group zero").toBeUndefined();
  });
});

describe("alerts reach a key (P3-T14)", () => {
  it("gives PRD §4's 'focus last alert' the spacebar, and keeps Home on the base", () => {
    // Space and Home were one binding until the alert board existed to jump to. Space is the alert
    // key across the genre; Home stays the base, so the older behaviour is not lost.
    expect(key(" ").camera).toBe("focusAlert");
    expect(key("home").camera).toBe("focusBase");
    expect(key(" ").intent, "a camera move entered the command stream").toBeNull();
  });
});

describe("the Helium Bomb reaches a key (P3-T10)", () => {
  it("toggles arming on O and detonates on shift-O", () => {
    expect(key("o").bomb).toBe("toggleArm");
    expect(key("o", NONE, { shift: true }).bomb).toBe("detonate");
    expect(key("o").intent, "the key produced an intent without knowing which bomb").toBeNull();
  });

  it("stays off upstream's positional action keys", () => {
    // Z/C/V/B/N fire the Nth button the HUD is showing. Binding a fixed order to one of them breaks
    // that rule the moment the HUD has buttons, which is why a bomb is on O and not on B.
    for (const k of ["c", "v", "b", "n"]) {
      const r = key(k);
      expect(r.intent, `${k} took a positional action key`).toBeNull();
      expect(r.bomb, `${k} took a positional action key`).toBeUndefined();
      expect(r.mode, `${k} took a positional action key`).toBeNull();
    }
  });
});

describe("no Phase 3 order is left unreachable", () => {
  it("gives every Phase 3 intent a way in", () => {
    // The test that would have caught the original finding. Each Phase 3 intent kind is listed with
    // the gesture that produces it; a new intent with no entry fails here rather than shipping as a
    // DONE row nobody can use.
    //
    // `armBomb` and `detonate` appear as `bomb` requests rather than intents because they address
    // one unit by id and this layer cannot see the selection — the caller fans them out.
    const reached = new Set<string>();
    const record = (i: { kind: string } | null | undefined) => { if (i) reached.add(i.kind); };

    record(translatePointer(
      { type: "click", button: "left", worldX: 1, worldY: 1, shift: false, ctrl: false },
      key("f").mode!, snap(),
    ).intent);
    record(translatePointer(
      { type: "click", button: "left", worldX: 1, worldY: 1, entityId: "u1", shift: false, ctrl: false },
      key("p").mode!, snap(),
    ).intent);
    record(key("t").intent);
    if (key("o").bomb === "toggleArm") reached.add("armBomb");
    if (key("o", NONE, { shift: true }).bomb === "detonate") reached.add("detonate");
    if (key("1").group) reached.add("select");

    const PHASE_3_INTENTS = [
      "moveInFormation", "holdFormation", "escort", "armBomb", "detonate", "select",
    ];
    const missing = PHASE_3_INTENTS.filter((k) => !reached.has(k));
    expect(missing, `no gesture produces: ${missing.join(", ")} — implemented but unreachable`)
      .toEqual([]);
  });
});
