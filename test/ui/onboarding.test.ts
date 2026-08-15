// @vitest-environment jsdom
//
// P5-T10 — settings, and the card that tells a first-time player what to press.
//
// **Onboarding is the one thing on this board that every playtest script has asked for and none has
// been able to test.** `docs/playtests/mvp.md` forbids the facilitator from answering "where do I
// click" and records every such question as a finding; S6 — the build menu found unaided — is a
// Phase 1 gate criterion. What has answered it so far is a paragraph of `<b>` tags in the sidebar
// that nothing checks. So the claims here are arranged around the two ways a card can be worse than
// nothing, plus the one that is already true of the paragraph it stands beside:
//
//   1. IT MUST DIE     a card that cannot be dismissed, or that comes back, is worse than none. It
//                      is dismissed permanently, AND retires itself once the player has a base — the
//                      second one is what covers a browser that stores nothing.
//   2. IT MUST BE TRUE every key it names is put through the app's own `translateKey`, and the pan
//                      keys through a REAL `Game` in a real DOM. A control list nothing checks is
//                      how the sidebar came to advertise a key that does nothing.
//   3. THE SIDEBAR IS  and that is pinned below rather than assumed: `S` is in `index.html`'s
//      ALREADY WRONG   "WASD pan" and is bound to nothing anywhere in the app.
//
// The settings half is smaller and its claim is the row's: a choice made in the model survives
// `saveSettings` → `loadSettings`, including in the browser where storage throws.
//
// The mutation log is at the bottom.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Game } from "../../src/app/game.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { type Settings, loadSettings, saveSettings } from "../../src/app/settings.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { type KeyResult, translateKey } from "../../src/input/intents.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { TIERS, TIER_ORDER } from "../../src/view/renderer/tiers.js";
import { deployColonyShip, makeBuilding } from "../../src/engine/index.js";
import {
  ONBOARDING_KEY, loadOnboardingSeen, markOnboardingSeen, onboardingModel, settingsModel,
} from "../../src/ui/onboarding.js";

const SEED = 20260814;
const SEAT = "helix";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* =================================================================================================
   THE CARD SHOWS, AND THEN NEVER AGAIN
   ================================================================================================= */

/** A bridge with a snapshot, at the opening: one colony ship, nothing selected, no base. */
function opening(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  bridge.step(STEP_SECONDS);
  return bridge;
}

const card = (bridge: WorldBridge, seen = false) => onboardingModel({ snap: bridge.snapshot, seen });

describe("the onboarding card (P5-T10)", () => {
  it("shows at the opening, when the player has nothing but a ship", () => {
    const model = card(opening());
    expect(model.visible, "a first-time player is shown nothing").toBe(true);
    expect(model.hiddenReason).toBeNull();
    expect(model.steps.length, "the card is either empty or a manual").toBeGreaterThanOrEqual(4);
    expect(model.steps.length, "the card is too long to be read by someone who reads nothing")
      .toBeLessThanOrEqual(8);
    expect(model.dismissLabel.length, "there is no way to dismiss it").toBeGreaterThan(0);
  });

  it("never comes back once dismissed", () => {
    // The first of the two failure modes this row must avoid. Dismissal is a decision, not a
    // per-session preference.
    const bridge = opening();
    expect(card(bridge, true).visible, "a dismissed card came back on the same session").toBe(false);
    expect(card(bridge, true).hiddenReason).toBe("dismissed");
  });

  it("retires itself once the player has a base, dismissed or not", () => {
    // The second, independent retirement — and the one that matters in a browser that stores
    // nothing (persona P2). Without it, a player ten hours into a campaign would be taught the
    // controls again on every reload, which is precisely the "comes back" failure.
    const bridge = opening();
    expect(card(bridge).visible, "the card was not showing before the base went down").toBe(true);

    const ship = [...bridge.state.units.values()].find((u) => u.owner === "player" && u.type === "colonyship")!;
    expect(deployColonyShip(bridge.state, ship.id), "the colony ship would not deploy").toBeTruthy();
    bridge.step(STEP_SECONDS);

    const model = card(bridge);
    expect(model.visible, "the card is still teaching the controls to someone with a base").toBe(false);
    expect(model.hiddenReason).toBe("under-way");
  });

  it("ticks off only what the snapshot can honestly answer", () => {
    // A step that reports `false` for something the interface cannot observe is the interface
    // telling the player they have failed at something nobody measured. `null` is that distinction,
    // and it is why the camera and the right-click steps carry one.
    const bridge = opening();
    const before = card(bridge);
    const step = (id: string, model = before) => model.steps.find((s) => s.id === id)!;

    expect(step("look").done, "the camera step claims to know whether the camera has moved").toBeNull();
    expect(step("order").done, "the right-click step claims to know an order was given").toBeNull();
    expect(step("select").done, "something was selected at the opening").toBe(false);
    expect(step("deploy").done, "a base already exists at the opening").toBe(false);
    expect(step("build").done, "a building already exists at the opening").toBe(false);
    expect(before.nextStepId, "the card does not lead with the first thing left to do").toBe("look");

    // Select the ship through the same intent a click produces.
    const ship = [...bridge.state.units.values()].find((u) => u.owner === "player" && u.type === "colonyship")!;
    expect(bridge.apply({ kind: "select", ids: [ship.id], additive: false })).toBeNull();
    bridge.step(STEP_SECONDS);
    expect(step("select", card(bridge)).done, "selecting a unit did not tick the selection step")
      .toBe(true);

    // …and a building that is not a Command Center is what S6 is actually about. The base alone
    // must NOT tick it: "found your base" and "find the build menu" are two different playtest
    // tasks, and the second is the Phase 1 gate criterion.
    expect(deployColonyShip(bridge.state, ship.id), "the colony ship would not deploy").toBeTruthy();
    bridge.step(STEP_SECONDS);
    const deployed = onboardingModel({ snap: bridge.snapshot, seen: false });
    expect(step("deploy", deployed).done, "the base does not tick the deploy step").toBe(true);
    expect(step("build", deployed).done, "the Command Center was counted as using the build menu")
      .toBe(false);

    const base = bridge.state.map.bases.player;
    const hut = makeBuilding("habitat", "player", base.x + 60, base.y + 60);
    hut.constructing = false;
    hut.buildProgress = 1;
    bridge.state.buildings.set(hut.id, hut);
    bridge.step(STEP_SECONDS);

    const built = onboardingModel({ snap: bridge.snapshot, seen: false });
    expect(step("deploy", built).done, "the base does not tick the deploy step").toBe(true);
    expect(step("build", built).done, "a finished Habitat does not tick the build step").toBe(true);
    expect(built.nextStepId, "a card with everything observable done still leads with a done step")
      .toBe("look");
  });

  it("does not mistake the neighbour's base for the player's", () => {
    // The steps read a snapshot, and a snapshot carries both sides. An owner test that was dropped
    // would retire the card the moment the player laid eyes on the enemy's Command Center — which
    // is roughly when they need it most. Placed in the open beside the player's own base so it is
    // genuinely VISIBLE: an AI building inside unexplored fog is not in the snapshot at all, and a
    // test that used one would prove nothing.
    const bridge = opening();
    const base = bridge.state.map.bases.player;
    const theirs = makeBuilding("command", "ai", base.x + 90, base.y + 90);
    theirs.constructing = false;
    theirs.buildProgress = 1;
    bridge.state.buildings.set(theirs.id, theirs);
    bridge.step(STEP_SECONDS);

    expect(bridge.snapshot.selection, "this scenario accidentally selected something").toEqual([]);
    const model = card(bridge);
    expect(model.steps.find((s) => s.id === "deploy")!.done, "the enemy base ticked the deploy step")
      .toBe(false);
    expect(model.steps.find((s) => s.id === "build")!.done, "the enemy base ticked the build step")
      .toBe(false);
    expect(model.visible, "the card retired itself because the ENEMY has a base").toBe(true);
  });

  it("is a pure function of the snapshot and the flag", () => {
    const bridge = opening();
    expect(card(bridge)).toEqual(card(bridge));
  });
});

describe("dismissal outlives the tab (P5-T10)", () => {
  afterEach(() => {
    restoreStorage();
    globalThis.localStorage?.clear();
  });

  it("is remembered across a reload", () => {
    expect(loadOnboardingSeen(), "a fresh browser already thinks the card was dismissed").toBe(false);
    markOnboardingSeen();
    expect(globalThis.localStorage.getItem(ONBOARDING_KEY), "nothing was written to storage")
      .toBeTruthy();
    expect(loadOnboardingSeen(), "the dismissal did not survive").toBe(true);
  });

  it("does not read a dismissal out of somebody else's key, or write over one", () => {
    // The store is one origin-wide namespace and `saveSettings` shares it. A dismissal that landed
    // on the settings key would not merely mis-read — it would replace a player's graphics choice
    // with the word "seen", which `loadSettings` then throws away as unparsable.
    saveSettings({ tierOverride: "T1", edgeScroll: false, newGame: null, motion: "auto" });
    expect(loadOnboardingSeen(), "the settings key was read as a dismissal").toBe(false);

    markOnboardingSeen();
    expect(loadSettings(), "dismissing the card destroyed the player's settings")
      .toEqual({ tierOverride: "T1", edgeScroll: false, newGame: null, motion: "auto" });
  });

  it("survives a browser that refuses storage entirely", () => {
    // Persona P2's locked-down browser, where the property ACCESS throws — the case
    // `app/settings.ts` is written around. Losing the flag here is acceptable and the `under-way`
    // retirement covers it; throwing out of the boot path is not.
    throwingStorage();
    expect(() => markOnboardingSeen(), "dismissing the card threw").not.toThrow();
    expect(loadOnboardingSeen(), "a throwing store reported a dismissal").toBe(false);
  });
});

/* =================================================================================================
   EVERY KEY IT NAMES IS LIVE

   Two mechanisms, because the app has two: `translateKey` owns the letters, and `game.ts`'s
   `applyContinuousPan` owns the pan keys by reading a held-key set directly. Both are checked
   through the real thing.
   ================================================================================================= */

/**
 * Does `translateKey` do ANYTHING with this key?
 *
 * Read off the RESULT rather than from a list of field names, and that is a correction: the hand
 * written list said "every field of `KeyResult`, so nothing is missed" and could only ever be every
 * field on the day it was written. P6-T11 added two (`select`, `crosshair`), and a check that
 * quietly stops covering a new binding is the same failure as the sidebar paragraph it guards.
 *
 * `NO_KEY` is `{ intent: null, mode: null, camera: null, cancel: false }` — so a key this module
 * does not own has nothing but nulls and a false, and anything else means it is bound.
 */
function translated(key: string): boolean {
  const r: KeyResult = translateKey({ key, shift: false, ctrl: false });
  return Object.values(r).some((v) => v !== null && v !== undefined && v !== false);
}

const VIEW_W = 1280;
const VIEW_H = 720;

/** jsdom ships no canvas backend — the same stub `test/input/phase4-input.test.ts` uses. */
function stubCanvas(): () => void {
  const original = HTMLCanvasElement.prototype.getContext;
  const ctx: unknown = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "canvas") return { width: 1, height: 1 };
      if (prop === "createImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as typeof original;
  return () => { HTMLCanvasElement.prototype.getContext = original; };
}

function elements() {
  const viewport = document.createElement("div");
  const hudRoot = document.createElement("div");
  const minimapCanvas = document.createElement("canvas");
  document.body.append(viewport, hudRoot, minimapCanvas);
  viewport.getBoundingClientRect = () => ({
    width: VIEW_W, height: VIEW_H, left: 0, top: 0, right: VIEW_W, bottom: VIEW_H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return { viewport, hudRoot, minimapCanvas };
}

describe("the card names controls the app actually has (P5-T10)", () => {
  let restore: () => void;
  let game: Game;

  beforeEach(() => {
    restore = stubCanvas();
    game = new Game(elements(), new RecordingRenderer(), "T0", { tierOverride: null, edgeScroll: false, newGame: null, motion: "auto" },
      { seed: SEED, worldId: SEAT });
  });

  afterEach(() => {
    game.stop();
    document.body.replaceChildren();
    restore();
  });

  /** Hold `key` for one frame in the real app and report which way the camera went. */
  function pan(key: string): { dx: number; dy: number } {
    // From the middle of the map, so the rig's own clamp cannot swallow the movement.
    game.camera.focusOn(800, 500);
    const from = { x: game.camera.targetX, y: game.camera.targetY };
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    (game as unknown as { renderFrame(alpha: number, frameMs: number): void }).renderFrame(0, 16);
    window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    return { dx: game.camera.targetX - from.x, dy: game.camera.targetY - from.y };
  }

  const moves = (key: string): boolean => {
    const { dx, dy } = pan(key);
    return dx !== 0 || dy !== 0;
  };

  it("gives every key on the card something to do", () => {
    // The claim the sidebar paragraph cannot make. Driven through the app's own translator and the
    // app's own pan loop, so deleting a binding fails here with the key in the message.
    const model = onboardingModel({ snap: opening().snapshot, seen: false });
    const named = model.steps.flatMap((s) => s.keys);
    expect(named.length, "the card names no keys at all").toBeGreaterThan(3);

    const dead = named.filter((key) => !translated(key) && !moves(key));
    expect(dead, `the card names keys that do nothing in this build: ${dead.join(", ")}`).toEqual([]);
  });

  it("names the four arrow keys because all four of them pan", () => {
    // Not decoration: this is why the card says "arrow keys" where the sidebar says "WASD" — see
    // the pin below. Each direction is asserted separately, so half a pan is still a failure.
    expect(pan("ArrowLeft").dx, "left arrow does not pan left").toBeLessThan(0);
    expect(pan("ArrowRight").dx, "right arrow does not pan right").toBeGreaterThan(0);
    expect(pan("ArrowUp").dy, "up arrow does not pan up").toBeLessThan(0);
    expect(pan("ArrowDown").dy, "down arrow does not pan down").toBeGreaterThan(0);
  });

  it("names buttons the pointer translator actually binds", () => {
    // The other half of a control list: three of the six steps are mouse gestures, and a card that
    // said "middle-click" would be exactly as wrong as a dead key.
    const model = onboardingModel({ snap: opening().snapshot, seen: false });
    const buttons = new Set(model.steps.flatMap((s) => s.buttons));
    expect([...buttons].sort(), "the card names a button the app does not bind")
      .toEqual(["left", "right"]);
  });

  /* -------------------------------------------------------------------------------------------
     THE PIN, INVERTED — every key the sidebar advertises is live.

     This was written the other way up, asserting `["s"]`. `index.html`'s hint paragraph advertised
     `WASD` to pan while `applyContinuousPan` read `arrowleft`/`a`, `arrowright`/`d`, `arrowup`/`w`
     and `arrowdown` — **`s` was bound to nothing, anywhere, from Phase 1 until this row found it.**
     A player who learned to pan with WASD found three of the four directions worked and concluded
     the camera was broken. Pinned as an equality rather than fixed here, because the fix was one
     line in `src/app/game.ts` and that file was not this row's.

     It was then fixed, this went red saying to empty the list, and it is inverted rather than
     deleted — because the interesting assertion was never "`s` is dead". It is **"the hint and the
     app agree"**, which is a property worth holding for the next twenty-four bindings and the next
     five phases. The hint is hand-written prose in an HTML file that no compiler reads; this is the
     only thing in the project that can tell when it starts lying.
     ------------------------------------------------------------------------------------------- */
  it("finds no key in the sidebar hint that the app does not bind", () => {
    const hint = readFileSync(join(ROOT, "index.html"), "utf8");
    const paragraphs = [...hint.matchAll(/<p class="hint">([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
    expect(paragraphs.length, "index.html no longer has a hint paragraph to check").toBeGreaterThan(0);

    const tokens = paragraphs.flatMap((p) => [...p.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]!.trim()));
    expect(tokens.length, "the hint paragraph names no controls at all").toBeGreaterThan(10);

    const dead: string[] = [];
    for (const token of tokens) {
      for (const key of keysOf(token)) {
        if (!translated(key) && !moves(key)) dead.push(key);
      }
    }
    expect(
      dead,
      "The sidebar hint advertises a key the app does not bind. Either the binding was removed and " +
      "the hint was not updated, or the hint gained a control that was never wired. `s` was the " +
      "original offender — index.html said WASD pans and `applyContinuousPan` never read it.",
    ).toEqual([]);
  });

  /* THE OTHER DIRECTION, WHICH IS THE ONE THAT WAS MISSING (PT-03).
   *
   * The test above asks "is every key the hint NAMES real?". For five phases that was the only
   * question asked, and it cannot fail when a binding is added and never advertised — so a control
   * list could be arbitrarily incomplete and stay green. It was: P5-T13 bound ten orders to keys and
   * updated neither place that teaches them, and the first tester reported the Ranger's scout mode
   * as a MISSING FEATURE. It was `E`, and nothing on screen said so.
   *
   * This asks "is every key the app BINDS named?", which is the direction that catches that. The
   * candidate set is swept rather than listed, so a binding on a key nobody thought of is still
   * caught. */
  it("finds no key the app binds that the sidebar hint never names", () => {
    const hint = readFileSync(join(ROOT, "index.html"), "utf8");
    const paragraphs = [...hint.matchAll(/<p class="hint">([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
    const named = new Set(
      paragraphs
        .flatMap((p) => [...p.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]!.trim()))
        .flatMap((t) => keysOf(t)),
    );

    // `=` IS Shift+`=` on a US layout and `_` is Shift+`-`, so they are the same two controls the
    // hint names as `+` and `-` (P7-T03's reasoning, recorded there). Naming all four would teach a
    // player two keys that do one thing.
    const ALIASED: Record<string, string> = { "=": "+", _: "-" };

    const candidates = [
      ..."abcdefghijklmnopqrstuvwxyz",
      ..."0123456789",
      "escape", "home", "delete", " ", "+", "-", "=", "_", ",", ".",
      "arrowup", "arrowdown", "arrowleft", "arrowright",
    ];

    const unadvertised = candidates
      .filter((key) => translated(key) || moves(key))
      .filter((key) => !named.has(key) && !named.has(ALIASED[key] ?? "\u0000"));

    expect(
      unadvertised,
      "The app binds a key the sidebar hint never names, so the only way a player finds it is by " +
      "reading the source. This is how the Ranger's scout mode (`E`) and the rally point (`U`) " +
      "were reported as missing features by the first person to play the game.",
    ).toEqual([]);
  });
});

/**
 * One `<b>` token from the sidebar hint, as `KeyboardEvent.key` values. Non-key tokens map to none.
 *
 * The mouse gestures, the digit range and the positional row are spelled out rather than parsed,
 * because a parser that guessed would quietly return `[]` for a token it did not understand — and a
 * check that silently skips what it cannot read is not a check.
 */
function keysOf(token: string): string[] {
  // `ZQSD` is prose about a LAYOUT, not four more bindings (PT-02): those are the labels an AZERTY
  // keyboard puts on the same four physical positions `WASD` names here, and this check reasons
  // about `event.key` values on one layout at a time. The positions themselves are covered by
  // `test/input/phase7-input.test.ts` and by the real-`Game` sweep in `keyboard-play.test.ts`.
  const NOT_KEYS = ["LMB", "RMB", "drag", "click a world", "move", "ZQSD"];
  if (NOT_KEYS.includes(token)) return [];
  const NAMED: Record<string, string[]> = {
    WASD: ["w", "a", "s", "d"],
    // All ten, not the two endpoints. The reverse check below asks whether every BOUND key is
    // named, and `["0", "9"]` would have reported 1–8 as unadvertised — a mapper that under-reports
    // what the hint covers turns a correct hint into a failure.
    "0-9": ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    arrows: ["arrowup", "arrowdown", "arrowleft", "arrowright"],
    Delete: ["delete"],
    // Shift is a modifier, not a key this check can press on its own. The Shift+letter orders are
    // named in the hint as `Shift` + their letters, and each letter is separately bound unshifted.
    Shift: [],
    "Z C V B N": ["z", "c", "v", "b", "n"],
    Space: [" "],
    Home: ["home"],
    Esc: ["escape"],
  };
  if (NAMED[token]) return NAMED[token]!;
  if (token.length === 1) return [token.toLowerCase()];
  throw new Error(`the hint names "${token}" and this check does not know what key that is`);
}

/* =================================================================================================
   SETTINGS — the row's own claim: they persist through loadSettings/saveSettings
   ================================================================================================= */

const T2: Settings = { tierOverride: "T2", edgeScroll: true, newGame: null, motion: "auto" };

describe("the settings model (P5-T10)", () => {
  afterEach(() => {
    restoreStorage();
    globalThis.localStorage?.clear();
  });

  it("offers every tier the renderer has, plus Auto", () => {
    const rows = settingsModel({ settings: loadSettings(), currentTier: "T2" }).rows;
    const tier = rows.find((r) => r.id === "tier")!;
    expect(tier.options.map((o) => o.id), "the tier row does not match the renderer's own table")
      .toEqual(["auto", ...TIER_ORDER]);
    // **Auto is the option `main.ts`'s picker does not have.** It builds one button per tier and
    // nothing that clears the override, so today a player who has ever forced a tier cannot get
    // detection back without clearing site data.
    expect(tier.options[0]!.settings.tierOverride, "choosing Auto does not clear the override")
      .toBeNull();
    expect(tier.options.find((o) => o.id === "T0")!.detail, "a tier is offered without its meaning")
      .toBe(TIERS.T0.label);
  });

  it("marks exactly one option per row as active, and it is the one in force", () => {
    const model = settingsModel({ settings: T2, currentTier: "T2" });
    for (const row of model.rows) {
      const active = row.options.filter((o) => o.active);
      expect(active.length, `${row.id} has ${active.length} active options`).toBe(1);
    }
    expect(model.rows.find((r) => r.id === "tier")!.options.find((o) => o.active)!.id).toBe("T2");
    expect(model.rows.find((r) => r.id === "edgeScroll")!.options.find((o) => o.active)!.id).toBe("on");

    // Auto is active only when nothing is forced — the state the fresh install is in.
    const auto = settingsModel({ settings: { tierOverride: null, edgeScroll: true, newGame: null, motion: "auto" }, currentTier: "T1" });
    expect(auto.rows[0]!.options.filter((o) => o.active).map((o) => o.id)).toEqual(["auto"]);
  });

  it("separates the tier a player CHOSE from the tier that is running", () => {
    // The state measured correction can put a machine in: the player forced T2, the frame budget
    // was missed, and `setTier(tier, manual = false)` dropped to T0 WITHOUT writing that to
    // settings. A row that highlighted T0 would tell them they chose it; one that never mentioned
    // T0 would deny the drop. So the highlight is the choice and the row says what is running.
    const dropped = settingsModel({ settings: { tierOverride: "T2", edgeScroll: true, newGame: null, motion: "auto" }, currentTier: "T0" });
    const tier = dropped.rows.find((r) => r.id === "tier")!;

    expect(tier.options.filter((o) => o.active).map((o) => o.id),
      "the highlight followed the running tier instead of the player's choice").toEqual(["T2"]);
    expect(tier.detail, "the row never says which tier is actually running").toContain("T0");
    expect(tier.detail, "the row does not say what the running tier means")
      .toContain(TIERS.T0.label);
  });

  it("carries a whole Settings, never a patch", () => {
    // The property that makes the shell's job `saveSettings(option.settings)` with no merging: a
    // patch would need a merge, and a merge is where a setting quietly reverts.
    const model = settingsModel({ settings: { tierOverride: "T3", edgeScroll: false, newGame: null, motion: "auto" }, currentTier: "T3" });
    const off = model.rows.find((r) => r.id === "edgeScroll")!.options.find((o) => o.id === "on")!;
    expect(off.settings, "changing edge scrolling dropped the tier override")
      .toEqual({ tierOverride: "T3", edgeScroll: true, newGame: null, motion: "auto" });
  });

  it("persists a choice through loadSettings/saveSettings", () => {
    // The row's definition of done, driven end to end through the real store.
    const chosen = settingsModel({ settings: loadSettings(), currentTier: "T3" })
      .rows.find((r) => r.id === "tier")!.options.find((o) => o.id === "T1")!;
    saveSettings(chosen.settings);

    const reloaded = loadSettings();
    expect(reloaded.tierOverride, "the tier choice did not survive a reload").toBe("T1");
    expect(settingsModel({ settings: reloaded, currentTier: "T1" }).rows[0]!.options.find((o) => o.active)!.id,
      "the reloaded settings do not show the choice as active").toBe("T1");

    // …and back to Auto, which is the trip that has no control today.
    const auto = settingsModel({ settings: reloaded, currentTier: "T1" })
      .rows[0]!.options.find((o) => o.id === "auto")!;
    saveSettings(auto.settings);
    expect(loadSettings().tierOverride, "Auto did not survive a reload").toBeNull();
  });

  it("still applies a choice in a browser that stores nothing", () => {
    // `saveSettings` swallows the failure by design ("the setting still applies for this session"),
    // and the model must not care: it is a pure function of the settings handed to it.
    throwingStorage();
    const chosen = settingsModel({ settings: { tierOverride: null, edgeScroll: true, newGame: null, motion: "auto" }, currentTier: "T0" })
      .rows.find((r) => r.id === "edgeScroll")!.options.find((o) => o.id === "off")!;
    expect(() => saveSettings(chosen.settings), "a blocked store threw out of the settings write")
      .not.toThrow();
    expect(loadSettings(), "a blocked store did not fall back to the defaults")
      .toEqual({ tierOverride: null, edgeScroll: true, newGame: null, motion: "auto" });
    expect(settingsModel({ settings: chosen.settings, currentTier: "T0" })
      .rows.find((r) => r.id === "edgeScroll")!.options.find((o) => o.active)!.id,
    "the session's own choice was lost as well as the stored one").toBe("off");
  });
});

/* -------------------------------------------------------------------------------------------
   A `localStorage` that throws on every access — jsdom's is real and has to be replaced.
   ------------------------------------------------------------------------------------------- */

let savedDescriptor: PropertyDescriptor | undefined;

function throwingStorage(): void {
  savedDescriptor ??= Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
}

function restoreStorage(): void {
  if (!savedDescriptor) return;
  Object.defineProperty(globalThis, "localStorage", savedDescriptor);
  savedDescriptor = undefined;
}

/* =================================================================================================
   MUTATION LOG — every claim above was made to fail before it was kept.

   Nineteen mutations against `src/ui/onboarding.ts`, plus two against this file's own pan harness,
   each run and then reverted (the source is byte-compared against a backup afterwards). Three
   SURVIVED and are written up at the end: a surviving mutation means the test was wrong.

     • `visible: true` regardless of `seen`            -> 1 red: "a dismissed card came back"
     • drop the `hasBase` retirement                   -> 1 red: "still teaching the controls to
                                                          someone with a base" — the failure a
                                                          blocked store would otherwise produce
     • `done: false` where the honest answer is `null` -> 1 red: the two unobservable steps
     • the select step ticks unconditionally           -> 1 red
     • `nextStepId` is the last step, not the first
       one left to do                                  -> 1 red
     • `markOnboardingSeen` writes nothing             -> 1 red: the dismissal does not survive
     • `ONBOARDING_KEY` is the SETTINGS key            -> 1 red: dismissing the card would replace
                                                          the player's graphics choice with "seen"
     • rename the card's arrow keys to `w a s d`
       (i.e. believe the sidebar)                      -> 1 red, naming `s` — the whole argument for
                                                          the card carrying DATA rather than prose
     • name a key nothing binds (`k`)                  -> 1 red, naming `k`
     • name the middle mouse button                    -> 1 red
     • `settingsModel` drops the `auto` option         -> 3 red, incl. the round trip back to Auto
     • the tier list is hand-written, not `TIER_ORDER` -> 1 red
     • an option carries a patch instead of the whole
       `Settings`                                      -> 1 red: "changing edge scrolling dropped
                                                          the tier override"
     • the edge-scroll row is inverted                 -> 2 red
     • the tier row stops naming the RUNNING tier      -> 1 red
     • `ownsBuilding` counts units as buildings        -> 2 red
     • THE HARNESS ITSELF: `moves()` hard-wired to
       true, then to false                             -> 1 red then 2 red. Both directions, which
                                                          is what proves the pan probe can tell a
                                                          live key from a dead one rather than
                                                          agreeing with whatever it is asked.

     • SURVIVED (1): `active` following the RUNNING tier instead of the stored override. Every case
       passed both tiers the same value, so the two could not be told apart. Fixed by modelling the
       state that separates them — an automatic drop, where the choice is T2 and the run is T0 —
       which also turned out to be a real gap in the model: the row now names both.
     • SURVIVED (2): the build step counting the Command Center. The base and the Habitat went down
       in the same breath, so the intermediate state was never asserted. Fixed by checking that a
       base alone does NOT tick the build step — which is the difference between two playtest tasks.
     • SURVIVED (3): `ownsBuilding` ignoring the owner. The enemy's base sits in unexplored fog at
       the opening and is not in the snapshot at all, so an owner test that had been deleted made no
       difference. Fixed with a VISIBLE enemy Command Center beside the player's own base.
   ================================================================================================= */
