// @vitest-environment jsdom
//
// P6-T03 — the whole HUD reachable without a mouse, proven by DRIVING KEYS at a real `Game`.
//
// `phase5-wiring.test.ts` is the harness this extends and it is the right one: a real shell, a real
// HUD in a real DOM, and a control that has to come out the other side as an intent on the bridge
// or a write to view state. What is added here is the keyboard, and the standard is deliberately
// higher than "an attribute exists" — every claim below is made by dispatching a `KeyboardEvent`
// and looking at what the interface did:
//
//   • Tab reaches EVERY control on screen, not the five the positional row addresses.
//   • Enter and Space press the focused control, and produce exactly what the mouse produces.
//   • Space is still "focus last alert" when nothing is focused — the collision that made a ring
//     necessary rather than a stylesheet.
//   • Focus survives the HUD rebuilding its buttons, and lands on the same ACTION rather than on
//     whatever now occupies the slot.
//
// The three lines under "WIRING" are the integration `src/app/game.ts` is getting: the ring in
// front of the shell's own key handling, and one `sync` per frame. They are written here rather
// than assumed so that this file drives the real thing today — the ring, the real HudView, the real
// commands — and so that the shell's version can be checked against something that already works.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Game } from "../../src/app/game.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { FOCUS_CLASS, HudFocus } from "../../src/ui/hud-focus.js";
import { type HudAction } from "../../src/ui/hud.js";

const SEED = 20260815;

/** A no-op 2D context, as every DOM test here uses: jsdom ships no canvas backend. */
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
  return { viewport, hudRoot, minimapCanvas };
}

describe("the HUD is navigable by keyboard alone (P6-T03)", () => {
  let restore: () => void;
  let game: Game;
  let hudRoot: HTMLElement;
  let focus: HudFocus;
  let onKey: (e: KeyboardEvent) => void;
  /**
   * Every key that got past the ring, in order.
   *
   * Registered on `window` in the BUBBLE phase, which is where `Game.onKeyDown` lives — so this
   * records exactly what the shell would have seen. It is how "the ring consumed it" is asserted as
   * a fact about the app rather than as a return value nobody checks.
   */
  let reachedShell: string[];
  let spy: (e: KeyboardEvent) => void;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    const els = elements();
    hudRoot = els.hudRoot;
    game = new Game(els, new RecordingRenderer(), "T0",
      { tierOverride: null, edgeScroll: false, newGame: null, motion: "auto" },
      { seed: SEED, worldId: "helix" });

    // --- WIRING (see the header) ------------------------------------------------------------
    // Capture phase, so the ring is asked before `Game.onKeyDown` — which is exactly what the
    // shell's own `if (this.hudFocus.handleKey(e)) return;` will do, one dispatch earlier.
    focus = new HudFocus(hudRoot);
    onKey = (e: KeyboardEvent): void => { if (focus.handleKey(e)) e.stopImmediatePropagation(); };
    window.addEventListener("keydown", onKey, true);

    reachedShell = [];
    spy = (e: KeyboardEvent): void => { reachedShell.push(e.key); };
    window.addEventListener("keydown", spy);
  });

  afterEach(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keydown", spy);
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  /** The ordered action row the shell holds — what the positional keys index into. */
  function actions(): readonly HudAction[] {
    return (game as unknown as { actions: readonly HudAction[] }).actions;
  }

  /** One rendered frame, plus the one line the shell adds after it sets `this.actions`. */
  function frame(): void {
    (game as unknown as { renderFrame(alpha: number, frameMs: number): void }).renderFrame(0, 16);
    focus.sync(actions());
  }

  function step(): void {
    game.bridge.step();
    frame();
  }

  /**
   * Press a key the way a browser delivers one: at the focused element, bubbling.
   *
   * Dispatching on `window` — which is what the older tests do — would be the one case where a
   * capturing listener does NOT run first, so it would test an ordering the real app never has.
   */
  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const target: EventTarget = document.activeElement ?? document.body;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  function buttons(): HTMLButtonElement[] {
    return [...hudRoot.querySelectorAll("button")];
  }

  function labelOf(button: Element | null): string {
    return button?.querySelector(".hud-button-label")?.textContent ?? "";
  }

  function focused(): HTMLButtonElement | null {
    const active = document.activeElement;
    return active instanceof HTMLButtonElement && hudRoot.contains(active) ? active : null;
  }

  function drawerText(): string {
    return hudRoot.querySelector('[data-hud="economy"]')?.textContent ?? "";
  }

  function labelled(text: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.textContent?.includes(text));
  }

  /** Open the starmap the way a player does, and open the board with the most controls behind it. */
  function starmapWithBoard(label: string): void {
    press("y");
    frame();
    expect(drawerText(), "the starmap key did not open the galaxy drawer").toMatch(/Campaign/);
    labelled(label)!.click();
    frame();
  }

  it("draws exactly the buttons the shell believes are on screen, in that order", () => {
    // The invariant the ring rides on — and the positional row already did. Z/C/V/B/N fire
    // `actions[0..4]` by index into a DOM they never look at, so if these two lists could disagree,
    // both controls would press the wrong thing and nothing would say so.
    const check = (where: string): void => {
      const drawn = buttons();
      expect(drawn.length, `${where}: the HUD drew ${drawn.length} buttons for ${actions().length} actions`)
        .toBe(actions().length);
      drawn.forEach((b, i) => {
        expect(labelOf(b), `${where}: button ${i} is not action ${i}`).toBe(actions()[i]!.label);
      });
    };

    frame();
    check("the battlefield at t=0");
    press("m");                                     // the market board, on the world screen
    frame();
    check("with the market open");
    starmapWithBoard("Saves & settings");
    check("the starmap with a campaign board open");
  });

  it("reaches every control on screen with Tab, not just the five the positional row addresses", () => {
    starmapWithBoard("Saves & settings");
    const all = buttons();
    // The row this task exists for: nine sections deep, and Z/C/V/B/N reach five of them.
    expect(all.length, "this screen has to be deeper than the positional row for the test to mean anything")
      .toBeGreaterThan(5);

    const seen = new Set<Element>();
    for (let i = 0; i < all.length; i++) {
      press("Tab");
      const node = focused();
      expect(node, `Tab press ${i + 1} of ${all.length} focused nothing at all`).not.toBeNull();
      expect(seen.has(node!), `Tab press ${i + 1} went back to a control it had already reached`).toBe(false);
      seen.add(node!);
    }
    expect(seen.size, "Tab did not reach every control the mouse can").toBe(all.length);

    // …and it wraps rather than dropping the player out of the interface.
    press("Tab");
    expect(focused(), "Tab past the last control did not come back to the first").toBe(all[0]);

    // Backwards, too — Shift+Tab from the first control is the last one.
    press("Tab", { shiftKey: true });
    expect(focused(), "Shift+Tab from the first control did not wrap to the last").toBe(all[all.length - 1]);
    press("Tab", { shiftKey: true });
    expect(focused(), "Shift+Tab walks forwards").toBe(all[all.length - 2]);
  });

  it("takes Tab away from the shell and from the browser, and gives back everything else", () => {
    // The contract the integration is built on: `if (this.hudFocus.handleKey(e)) return;`. A ring
    // that moved focus without CONSUMING the key would leave the browser to advance its own focus
    // as well — two steps per press, every other control skipped — and would leave "tab" sitting in
    // the shell's held-key set, where it makes an edge scroll pan at key speed.
    starmapWithBoard("Records");
    const tab = press("Tab");
    expect(tab.defaultPrevented, "Tab was not consumed, so the browser will move focus as well").toBe(true);
    expect(reachedShell, "Tab reached the shell's own key handling").not.toContain("Tab");

    // …and the keys it does not own arrive untouched. A ring that swallowed the keyboard would be
    // a mode rather than a navigation aid.
    const letter = press("y");
    expect(reachedShell, "a letter key was swallowed by the ring").toContain("y");
    expect(letter.defaultPrevented, "the ring cancelled a key it does not own").toBe(false);
  });

  it("leaves Ctrl+Tab to the browser", () => {
    // Modified keys are not ours. A page that eats Ctrl+Tab has taken tab-switching off the user,
    // which is a worse accessibility failure than the one this row set out to fix.
    starmapWithBoard("Records");
    const all = buttons();
    const event = press("Tab", { ctrlKey: true });
    expect(focused(), "Ctrl+Tab moved the ring's focus").toBeNull();
    expect(event.defaultPrevented, "Ctrl+Tab was cancelled, so the browser cannot act on it").toBe(false);
    expect(reachedShell).toContain("Tab");
    expect(all.length, "this screen has no controls, so the check above is vacuous").toBeGreaterThan(0);
  });

  it("continues from wherever the browser left focus, not from its own memory", () => {
    // A browser's own Tab into the page, or a click on a control, lands focus somewhere the ring
    // never put it. The DOM is the position of record — otherwise the next Tab jumps back to a
    // control the player cannot see any reason for.
    starmapWithBoard("Records");
    const all = buttons();
    expect(all.length, "not enough controls to tell one position from another").toBeGreaterThan(4);

    all[3]!.focus();
    press("Tab");
    expect(focused(), "the ring ignored where focus actually was and started from its own idea")
      .toBe(all[4]);

    // The same from inside the ring: move it, then move focus behind its back.
    press("Tab");
    all[0]!.focus();
    press("Tab");
    expect(focused(), "the ring carried on from its remembered slot rather than from the DOM").toBe(all[1]);
  });

  it("lets go when the player moves focus away, and never steals it back", () => {
    // The other half of surviving a rebuild. `sync` puts focus back when the HUD destroys the node
    // it was on — so it must be able to tell that from a player who has simply gone back to the
    // battlefield, or the interface yanks the keyboard out of the world on the next rebuild.
    press("m");
    frame();
    press("Tab");
    press("Tab");
    expect(focused(), "nothing was focused, so this proves nothing").not.toBeNull();

    const left = focused()!;
    left.blur();                                    // what clicking the world does to a focused button

    // Asked BEFORE the next frame, deliberately: the ring must answer from where focus actually is
    // rather than from what it last did, because a player is between frames for 16 ms every time
    // they click. Getting this wrong is not cosmetic — someone who tabbed to "Surrender the run",
    // clicked back to the battlefield and then pressed Space for the last alert would surrender.
    const base = game.bridge.state.map.bases.player;
    game.camera.focusOn(base.x + 300, base.y + 200);
    press(" ");
    expect(game.camera.targetX, "Space still went to a control the player had already left")
      .toBeCloseTo(base.x, 1);

    frame();
    press("m");                                     // close the board: the whole drawer is rebuilt
    frame();
    expect(focused(), "the HUD stole focus back from the game after the player had left it").toBeNull();
    expect(hudRoot.querySelectorAll(`.${FOCUS_CLASS}`).length, "a focus mark outlived the focus").toBe(0);
  });

  it("marks the focused control, and marks only one", () => {
    // Visible focus, as far as a DOM test can see it: the class `src/a11y.css` paints an outline on
    // (no stylesheet is loaded in jsdom), and real focus underneath it rather than a class alone.
    starmapWithBoard("Records");
    press("Tab");
    press("Tab");
    const node = focused()!;
    expect(node.classList.contains(FOCUS_CLASS), "the focused control carries no focus mark").toBe(true);
    expect(hudRoot.querySelectorAll(`.${FOCUS_CLASS}`).length, "two controls are showing focus at once").toBe(1);

    press("Tab");
    expect(node.classList.contains(FOCUS_CLASS), "the mark was left behind on the previous control").toBe(false);
    expect(hudRoot.querySelectorAll(`.${FOCUS_CLASS}`).length).toBe(1);
  });

  it("presses the focused control with Enter, and the press reaches the engine", () => {
    starmapWithBoard("Records");
    // Walk to the one command on this screen that ends the run, the way a player would: Tab until
    // it is the focused control, then Enter. Nothing here clicks anything.
    let steps = 0;
    while (labelOf(focused()) !== "Surrender the run" && steps < buttons().length + 1) {
      press("Tab");
      steps++;
    }
    expect(labelOf(focused()), "Tab never reached the surrender control").toBe("Surrender the run");

    press("Enter");
    // Queued, not applied: a keyboard press takes the same path a click does, and that path ends at
    // `bridge.enqueue` so the order lands on a tick boundary and a recorded stream still replays.
    expect(game.bridge.state.over ?? false, "Enter wrote sim state directly").toBe(false);
    game.bridge.step();
    expect(game.bridge.state.over, "Enter on the focused control produced nothing").toBe(true);
  });

  it("opens a board with Space while the ring holds focus", () => {
    press("y");
    frame();
    press("Tab");
    while (labelOf(focused()) !== "Diplomacy" && focused()) press("Tab");
    expect(labelOf(focused())).toBe("Diplomacy");

    press(" ");
    frame();
    expect(drawerText(), "Space on the focused board button did not open it").toMatch(/Diplomacy/);
  });

  it("leaves Space alone when nothing is focused, so it is still the alert key", () => {
    // The collision that makes this a ring rather than a stylesheet. With a HUD button focused a
    // browser activates it on Space; the shell ALSO reads Space as "focus last alert". Whichever
    // way that races, one keystroke runs two commands — and the dangerous half is the one that
    // presses whatever control the player happens to be on.
    frame();
    const base = game.bridge.state.map.bases.player;
    game.camera.focusOn(base.x + 300, base.y + 200);
    expect(game.camera.targetX, "the camera was already at the base, so this proves nothing")
      .not.toBeCloseTo(base.x, 1);

    press(" ");
    expect(game.camera.targetX, "Space was swallowed while nothing was focused — the alert key is dead")
      .toBeCloseTo(base.x, 1);
    expect(game.camera.targetY).toBeCloseTo(base.y, 1);

    // …and with focus in the ring the same key must NOT move the camera, or a player pressing Space
    // to confirm a button would also be thrown across the map.
    press("Tab");
    expect(focused(), "nothing focused, so the second half of this test is vacuous").not.toBeNull();
    game.camera.focusOn(base.x + 300, base.y + 200);
    press(" ");
    expect(game.camera.targetX, "Space reached the camera through a focused control").toBeCloseTo(base.x + 300, 1);
  });

  it("keeps the game's own keys working while the ring holds focus", () => {
    // The ring claims four keys and nothing else. A player stepping through the drawer can still
    // pan, still order, and still use the positional row — which is what stops "keyboard access"
    // from meaning "a mode you have to leave to play".
    press("m");
    frame();
    expect(drawerText(), "the market board did not open").toMatch(/Market/);
    press("Tab");
    press("Tab");
    expect(focused(), "the ring is not holding anything, so this proves nothing").not.toBeNull();

    press("m");                                     // the same key closes it, focus or no focus
    frame();
    expect(drawerText(), "a letter key was swallowed because a control had focus").not.toMatch(/Market/);
  });

  it("gives Escape back to the shell, and lets go of the control", () => {
    starmapWithBoard("Records");
    press("Tab");
    expect(focused(), "nothing was focused before Escape").not.toBeNull();

    press("Escape");
    frame();
    expect(focused(), "Escape left the ring holding a control").toBeNull();
    expect(hudRoot.querySelectorAll(`.${FOCUS_CLASS}`).length, "the focus mark outlived the focus").toBe(0);
    // The shell's own meaning survives: Escape backs out one screen. A ring that consumed it would
    // cost every player a keystroke to do what one press has always done.
    expect(drawerText(), "Escape was eaten by the ring instead of closing the starmap").not.toMatch(/Campaign/);
  });

  it("holds the player's place when the HUD rebuilds its buttons under them", () => {
    // The bug a naive ring ships with. `HudView` replaces whole rows of nodes when the button SET
    // changes, and the focused node goes with them — so a keyboard player is silently returned to
    // the top of a forty-button list, mid-interaction, by something they did not do.
    press("m");
    frame();
    for (let i = 0; i < 4; i++) press("Tab");
    const before = labelOf(focused());
    const slotBefore = buttons().indexOf(focused()!);
    expect(before, "the market board has no controls to stand on").not.toBe("");

    // Deploy the base, with the keyboard, from where the player is standing: Z fires the first
    // control on screen, which at t=0 is Deploy. Founding a Command Center retires the onboarding
    // card (`onboardingModel`'s "under-way"), so the section ABOVE the market disappears and every
    // button below it moves up — a real rebuild, caused by a real command, not a poke at the view.
    press("z");
    for (let i = 0; i < 8; i++) step();

    expect(drawerText(), "the onboarding card did not retire, so nothing above the focus changed")
      .not.toMatch(/Getting started/);
    const slotAfter = buttons().indexOf(focused()!);
    expect(slotAfter, "the row did not actually move, so the anchoring is untested").not.toBe(slotBefore);
    expect(labelOf(focused()), "the rebuild left the player focused on a different control").toBe(before);
    expect(focused()?.classList.contains(FOCUS_CLASS), "focus was restored without its mark").toBe(true);

    // And it is REAL focus, not a class: the next Enter has to press the control the mark is on.
    expect(document.activeElement, "the restored control is marked but not focused").toBe(focused());
  });

  it("keeps the player in the row when the control they were on disappears", () => {
    // The other half: the action itself is gone, so there is no id to anchor on. The honest
    // fallback is the place in the row — never nothing, and never silently the wrong control.
    press("m");
    frame();
    for (let i = 0; i < 3; i++) press("Tab");
    const slot = buttons().indexOf(focused()!);
    expect(slot, "nothing was focused").toBeGreaterThanOrEqual(0);

    press("m");                                     // close the market: every one of its buttons goes
    frame();
    expect(drawerText()).not.toMatch(/Market/);
    const node = focused();
    expect(node, "closing the section the player was in dropped focus out of the interface").not.toBeNull();
    expect(buttons().indexOf(node!), "focus landed past the end of a shorter row")
      .toBeLessThan(buttons().length);
  });
});
