// @vitest-environment jsdom
//
// P4-T01 — the last mile: a real `Game`, a real HUD in a real DOM, and a key press or a click that
// has to come out the other side as an intent on the bridge.
//
// The models are tested next door and the input translation is tested in `test/input/`. What
// neither of those can see is the WIRING between them — `Game.runCommand`, the positional row the
// shell concatenates, the board toggle — and that wiring is exactly where this project's recurring
// defect lives: Phase 3's orders were implemented and tested at both ends and unreachable in the
// middle. So this drives the shell itself.
//
// The renderer is the recording fake the perf harness uses; the 2D contexts the minimap wants are
// stubbed, because jsdom ships no canvas backend and the minimap is not what is under test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Game } from "../../src/app/game.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { makeBuilding } from "../../src/engine/index.js";

const SEED = 20260814;

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

describe("the HUD's controls reach the bridge", () => {
  let restore: () => void;
  let game: Game;
  let hudRoot: HTMLElement;

  beforeEach(() => {
    restore = stubCanvas();
    const els = elements();
    hudRoot = els.hudRoot;
    game = new Game(els, new RecordingRenderer(), "T0", { tierOverride: null, edgeScroll: false },
      { seed: SEED, worldId: "helix" });
  });

  afterEach(() => {
    game.stop();
    document.body.replaceChildren();
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

  function buttons(): HTMLButtonElement[] {
    return [...hudRoot.querySelectorAll("button")];
  }

  function press(key: string): void {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  function selectA(type: string): Building {
    const b = makeBuilding(type, "player", 620, 620);
    game.bridge.state.buildings.set(b.id, b);
    game.bridge.enqueue({ kind: "select", ids: [b.id], additive: false });
    step();
    return b;
  }

  it("turns a click on an economy button into an enqueued intent, not a direct engine call", () => {
    const smelter = selectA("smelter");
    expect(smelter.paused ?? false).toBe(false);

    const pause = buttons().find((b) => b.textContent?.startsWith("Pause"));
    expect(pause, "the selected factory showed no Pause button in the real DOM").toBeDefined();
    pause!.click();

    // Still false: an intent is QUEUED, never applied on the click. That is what keeps an order on
    // a tick boundary and what makes a recorded intent stream replay (see `WorldBridge.step`).
    expect(smelter.paused ?? false, "the click wrote sim state directly instead of enqueuing").toBe(false);
    game.bridge.step();
    expect(smelter.paused, "the enqueued intent never reached the engine").toBe(true);
  });

  it("fires the Nth button on the Nth positional key", () => {
    const smelter = selectA("smelter");
    const labels = buttons().map((b) => b.querySelector(".hud-button-label")!.textContent);
    const index = labels.findIndex((l) => l === "Pause");
    expect(index, "Pause is not in the positional row").toBeGreaterThanOrEqual(0);

    press(["z", "c", "v", "b", "n"][index]!);
    game.bridge.step();
    expect(smelter.paused, "the positional key did not reach the button it was over").toBe(true);
  });

  it("opens a board on its key and closes it on the same key", () => {
    const economy = () => hudRoot.querySelector('[data-hud="economy"]')!;
    frame();
    expect(economy().textContent).not.toMatch(/Market/);

    press("m");
    frame();
    expect(economy().textContent, "M did not open the market").toMatch(/Market/);

    press("m");
    frame();
    expect(economy().textContent, "M did not close the market it opened").not.toMatch(/Market/);
  });

  it("routes a trade through the bridge and moves the engine's own credits", () => {
    game.bridge.state.players.player.resources.ore = 400;
    press("m");
    step();

    const before = game.bridge.galaxyCredits;
    const sell = buttons().find((b) => b.textContent?.startsWith("Sell ore"));
    expect(sell, "the market board offered no way to sell ore").toBeDefined();
    sell!.click();
    game.bridge.step();
    expect(game.bridge.galaxyCredits, "selling changed no credits").toBeGreaterThan(before);
  });

  it("surfaces the engine's refusal in the HUD's own notice", () => {
    // A doctrine on a Refinery with nothing to pay for it. The engine refuses, the bridge phrases
    // it, and the notice is where a player actually reads it.
    selectA("refinery");
    game.bridge.state.players.player.resources.crystals = 0;
    game.bridge.state.players.player.resources.radioactives = 0;
    step();

    const doctrine = buttons().find((b) => (b.textContent ?? "").includes("not enough"));
    expect(doctrine, "no unaffordable doctrine was on offer to refuse").toBeDefined();
    doctrine!.click();
    step();                                       // the intent drains, the refusal comes back
    frame();                                      // …and the next frame writes it into the notice

    const notice = hudRoot.querySelector('[data-hud="notice"]')!;
    expect(notice.textContent, "a refused economy order said nothing to the player").toBeTruthy();
    expect(notice.classList.contains("visible")).toBe(true);
  });

  it("arms the build ghost rather than enqueuing anything, for a build button", () => {
    // The one command that is NOT an intent: a structure is not ordered until the ground is picked.
    // The Odyssey opening seeds a colony ship, so the worker only exists once the base is down.
    const ship = [...game.bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    game.bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    game.bridge.enqueue({ kind: "deploy" });
    step();
    const worker = [...game.bridge.state.units.values()].find((u) => u.type === "worker" && u.owner === "player")!;
    game.bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    step();

    const buildings = game.bridge.state.buildings.size;
    const build = buttons().find((b) => /turret/i.test(b.textContent ?? ""));
    expect(build, "a selected worker offered no build menu").toBeDefined();
    build!.click();
    step();

    // Three assertions, because "nothing was built" alone proves nothing: an enqueued build order
    // that the engine REFUSED would also leave the count untouched, and that is the bug this is
    // meant to catch. So the ghost has to be up, and the bridge has to have nothing to complain
    // about — a refusal here would mean an order was issued for ground nobody picked.
    const ghost = (game as unknown as { ghost: { active: boolean } | null }).ghost;
    expect(ghost, "the build button did not arm the placement ghost").not.toBeNull();
    expect(ghost!.active).toBe(true);
    expect(game.bridge.takeCommandError(), "a build order was issued with no ground picked").toBeNull();
    expect(game.bridge.state.buildings.size, "a build button placed a structure with no ground picked")
      .toBe(buildings);
  });
});
