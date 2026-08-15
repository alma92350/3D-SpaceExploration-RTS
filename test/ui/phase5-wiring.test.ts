// @vitest-environment jsdom
//
// P5-T12 — the last mile for the long game: a real `Game`, a real HUD in a real DOM, and a click
// that has to come out the other side as an intent on the bridge or a write to storage.
//
// This is `hud-wiring.test.ts`'s job one phase on, and it exists because the hole it guards has now
// been dug three times. Phase 2 shipped six of seven panel models imported by nothing. Phase 4 did
// it again with five. Phase 5's four parallel agents produced seven more in one afternoon, every
// one of them tested to the hilt and reachable by nobody. P4-T13's import scan catches the graph;
// what it cannot see is whether a human can get there — so this drives the shell itself:
//
//   • the campaign board buttons exist on the starmap and toggle,
//   • each board's sections actually appear when it is opened,
//   • the diplomacy and surrender buttons enqueue the intents `applyIntent` handles,
//   • the onboarding card is on screen at t=0 and stays gone once dismissed,
//   • Save writes a slot this build can list and load.
//
// The renderer is the recording fake the perf harness uses; the 2D contexts the minimap wants are
// stubbed, because jsdom ships no canvas backend and the minimap is not what is under test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Game } from "../../src/app/game.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { ONBOARDING_KEY } from "../../src/ui/onboarding.js";
import { SAVE_PREFIX } from "../../src/ui/save-panel.js";

const SEED = 20260815;

/** A no-op 2D context. Every property answers, nothing draws. */
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

describe("every Phase 5 panel is reachable from a control (P5-T12)", () => {
  let restore: () => void;
  let game: Game;
  let hudRoot: HTMLElement;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    const els = elements();
    hudRoot = els.hudRoot;
    game = new Game(els, new RecordingRenderer(), "T0", { tierOverride: null, edgeScroll: false, newGame: null },
      { seed: SEED, worldId: "helix" });
  });

  afterEach(() => {
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  /** One rendered frame, without the animation loop — the render path is what builds the HUD. */
  function frame(): void {
    (game as unknown as { renderFrame(alpha: number, frameMs: number): void }).renderFrame(0, 16);
  }

  function step(): void {
    game.bridge.step();
    frame();
  }

  function press(key: string): void {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  function buttons(): HTMLButtonElement[] {
    return [...hudRoot.querySelectorAll("button")];
  }

  function labelled(text: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.textContent?.includes(text));
  }

  /**
   * A button whose LABEL is exactly this.
   *
   * Needed because "Save" is a prefix of "Saves & settings", and a substring match on it found the
   * board button and closed the board instead of saving — which is a real hazard in a drawer this
   * dense, not just a test detail.
   */
  function exactly(label: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.querySelector(".hud-button-label")?.textContent === label);
  }

  function drawerText(): string {
    return hudRoot.querySelector('[data-hud="economy"]')?.textContent ?? "";
  }

  /** Open the starmap the way a player does — the key the shell binds, not a private setter. */
  function starmap(): void {
    press("y");
    frame();
    expect(drawerText(), "the starmap key did not open the galaxy drawer").toMatch(/Campaign/);
  }

  it("puts all four campaign boards on the starmap, and each one toggles", () => {
    starmap();
    for (const label of ["Diplomacy", "Antimatter Gate", "Records", "Saves & settings"]) {
      expect(labelled(label), `${label} has no button on the starmap`).toBeDefined();
    }

    // Opening marks its own button and closing is the SAME button — the rule M and L follow on the
    // battlefield. A board that needs a second control to close is one a player leaves open.
    labelled("Records")!.click();
    frame();
    expect(drawerText(), "the Records board did not open").toMatch(/Milestones/);
    expect(labelled("▾ Records"), "the open board is not marked as open").toBeDefined();

    labelled("▾ Records")!.click();
    frame();
    expect(drawerText(), "the board's own button did not close it").not.toMatch(/Milestones/);
  });

  it("shows each board's panels, and only while that board is open", () => {
    starmap();
    const boards: readonly (readonly [string, RegExp])[] = [
      ["Diplomacy", /Diplomacy/],
      ["Antimatter Gate", /Antimatter Gate/],
      ["Records", /Milestones[\s\S]*Score/],
      ["Saves & settings", /Saved games[\s\S]*Settings/],
    ];
    for (const [label, shown] of boards) {
      labelled(label)!.click();
      frame();
      expect(drawerText(), `${label} opened without showing its panel`).toMatch(shown);
      // Close it again, so the next assertion cannot pass on the last board's leftovers — which is
      // how a "every panel appears" test passes while only one of them works.
      labelled(`▾ ${label}`)!.click();
      frame();
    }
  });

  it("turns the surrender button into an enqueued intent, not a direct engine call", () => {
    starmap();
    labelled("Records")!.click();
    frame();

    const surrender = labelled("Surrender the run");
    expect(surrender, "the run cannot be ended from anywhere in the interface").toBeDefined();
    expect(surrender!.disabled, "surrender is disabled on a live run").toBe(false);

    surrender!.click();
    // Still running: an intent is QUEUED, never applied on the click. That is what keeps an order on
    // a tick boundary and what makes a recorded intent stream replay.
    expect(game.bridge.state.over ?? false, "the click wrote sim state directly").toBe(false);
    game.bridge.step();
    expect(game.bridge.state.over, "the enqueued surrender never reached the engine").toBe(true);
    // `surrendered` is not on the vendored `Galaxy` declaration, so it is read the way
    // `src/ui/relief-panel.ts` reads it.
    expect(
      (game.bridge.galaxy as unknown as { surrendered?: boolean }).surrendered,
      "the seat ended without the galaxy recording a surrender",
    ).toBe(true);

    // And a second press has to SAY something, which is the half that needs a control rather than a
    // comment. This HUD deliberately keeps a struck-through button clickable — "the engine's own
    // refusal is what explains it" (`HudAction`) — and for this one command the engine explains
    // nothing: `surrenderGalaxy` returns no value at all and refuses silently on a seat that is
    // already over. So the button is struck through AND the second press produces a message.
    frame();
    const again = exactly("Surrender the run");
    expect(again, "the surrender button vanished instead of going quiet").toBeDefined();
    expect(again!.classList.contains("unaffordable"), "surrender still reads as available")
      .toBe(true);

    again!.click();
    game.bridge.step();
    frame();
    expect(hudRoot.querySelector('[data-hud="notice"]')?.textContent, "a dead click said nothing")
      .toMatch(/already ended/i);
  });

  it("carries the diplomacy lever's world id, so it appeases the seat and not a default", () => {
    starmap();
    labelled("Diplomacy")!.click();
    frame();

    const tribute = labelled("Offer tribute");
    expect(tribute, "there is no way to offer tribute").toBeDefined();

    // Paid for, so the button is live and the engine's own refusal is not what is under test.
    game.bridge.galaxy.credits = 20_000;
    const before = game.bridge.galaxy.credits;
    step();
    labelled("Offer tribute")!.click();
    game.bridge.step();

    expect(game.bridge.galaxy.credits, "tribute spent nothing, so it never reached the engine")
      .toBeLessThan(before);
    const dip = (game.bridge.state as unknown as { diplomacy?: { tributes?: number } }).diplomacy;
    expect(dip?.tributes, "the tribute was paid against some other world's record").toBe(1);
  });

  it("shows the onboarding card at t=0 and never again once dismissed", () => {
    frame();
    expect(drawerText(), "a first-time player is shown no card at all").toMatch(/Getting started/);

    const dismiss = buttons().find((b) => b.textContent?.match(/got it|dismiss|hide/i));
    expect(dismiss, "the card cannot be dismissed").toBeDefined();
    dismiss!.click();
    frame();

    const after = drawerText();
    expect(localStorage.getItem(ONBOARDING_KEY), "dismissal was not written to storage").not.toBeNull();

    // A fresh Game reads the same storage: dismissal is permanent, which is the whole difference
    // between a card and a nag. Rebuilt rather than re-rendered, because the shell reads the flag
    // once at construction and a re-render would prove nothing.
    game.stop();
    const els = elements();
    hudRoot = els.hudRoot;
    game = new Game(els, new RecordingRenderer(), "T0", { tierOverride: null, edgeScroll: false, newGame: null },
      { seed: SEED, worldId: "helix" });
    frame();
    expect(drawerText(), "the card came back for a player who dismissed it")
      .not.toMatch(/Getting started/);
    expect(after).toBe(drawerText());
  });

  it("writes a save the panel can then list and load", () => {
    step();
    for (let i = 0; i < 20; i++) game.bridge.step();
    frame();
    starmap();
    labelled("Saves & settings")!.click();
    frame();
    expect(drawerText(), "a fresh browser is not reported as empty").toMatch(/No saved games/);

    exactly("Save")!.click();
    frame();

    const keys = Object.keys(localStorage).filter((k) => k.startsWith(SAVE_PREFIX));
    expect(keys, "the Save button wrote nothing to storage").toHaveLength(1);
    expect(drawerText(), "the save was written but the list did not refresh")
      .not.toMatch(/No saved games/);

    const load = buttons().find((b) => b.textContent?.startsWith("Load"));
    expect(load, "a written save has no Load button").toBeDefined();
    expect(load!.disabled, "this build cannot load the save it just wrote").toBe(false);

    // Loading returns to the battlefield, which is the shell's own rule: a load that left the
    // player on the starmap would be a load with no visible effect.
    load!.click();
    frame();
    expect(drawerText(), "loading a save left the galaxy drawer up").not.toMatch(/Saved games/);
  });

  it("hands the tier back to auto-detection, which used to be a one-way door", () => {
    starmap();
    labelled("Saves & settings")!.click();
    frame();

    const forced = buttons().find((b) => b.textContent?.includes("T2"));
    expect(forced, "there is no way to force a graphics tier").toBeDefined();
    forced!.click();
    frame();
    expect(game.currentTier, "forcing a tier did nothing").toBe("T2");

    // The row a player who has forced a tier needs and did not have: before P5-T10 the only way
    // back to measurement was clearing the site's storage.
    const auto = buttons().find((b) => b.textContent?.includes("Auto"));
    expect(auto, "a forced tier cannot be handed back to detection").toBeDefined();
    expect(auto!.disabled, "Auto is offered but not clickable").toBe(false);
    auto!.click();
    frame();

    const monitor = (game as unknown as { tierMonitor: { sample(ms: number): { dropped: boolean } } }).tierMonitor;
    // Measurement is live again: a manual monitor returns `dropped: false` however bad the frames
    // are, so a drop under sustained over-budget frames is the observable proof.
    let dropped = false;
    for (let i = 0; i < 400 && !dropped; i++) dropped = monitor.sample(120).dropped;
    expect(dropped, "the tier monitor is still pinned to the manual choice").toBe(true);
  });
});
