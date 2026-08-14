// Browser entry point. Boot order matters and is the whole content of this file.

import { Game } from "./app/game.js";
import { createRenderer } from "./app/renderer-factory.js";
import { loadSettings, saveSettings } from "./app/settings.js";
import { TIERS, TIER_ORDER } from "./view/renderer/tiers.js";
import { type Tier } from "./view/renderer/port.js";
import { MVP_WORLD } from "./bridge/world.js";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

function boot(): void {
  const settings = loadSettings();
  const choice = createRenderer({
    glCanvas: el<HTMLCanvasElement>("scene"),
    overlayCanvas: el<HTMLCanvasElement>("overlay"),
    fallbackCanvas: el<HTMLCanvasElement>("overlay"),
    tierOverride: settings.tierOverride,
  });

  // The Canvas2D path draws the whole world onto the overlay canvas, so the (now unused) GL canvas
  // must get out of the way — otherwise it sits on top as an opaque black rectangle.
  if (choice.renderer.name === "canvas2d") el("scene").style.display = "none";

  // The seed is fixed and the world is Helix Belt (Q-02 / ADR-0010 §2): every playtester sees the
  // same terrain, the same deposits and the same neighbour, so their reports compare. `MVP_WORLD`
  // is the single source of that choice — this comment named Ferros Prime long after the code
  // stopped doing so, which is exactly why it points at the constant instead of repeating it.
  const game = new Game(
    { viewport: el("viewport"), hudRoot: el("hud"), minimapCanvas: el<HTMLCanvasElement>("minimap") },
    choice.renderer,
    choice.tier,
    settings,
    { seed: 20260814, worldId: MVP_WORLD },
  );

  const picker = buildTierPicker(el("tier-picker"), choice.tier, settings, (tier) => game.setTier(tier, true));
  game.onTierChange(picker.select);
  el("boot").remove();
  game.start();

  if (choice.fallbackReason) {
    const notice = el("fallback-notice");
    notice.textContent = choice.fallbackReason;
    notice.classList.add("visible");
  }

  // Expose the running game for the browser smoke test and the perf harness. Read-only in spirit:
  // nothing in the app reads it back, and it is the only way a Playwright test can assert on
  // FrameStats without a debug UI nobody would otherwise want.
  (globalThis as unknown as { __odyssey: unknown }).__odyssey = game;

  // S5's measuring point (§4.2: "`performance` marks"), and the definition of "interactive" this
  // project is willing to defend: the input handlers are attached (the constructor did that) AND
  // the first frame has been drawn. Payload size cannot stand in for it — on a machine with no GPU
  // most of the wall-clock between the last byte and a playable frame is context creation, mesh
  // generation and the first rasterised draw, none of which get faster on a better connection.
  //
  // `game.start()` queued its frame callback before this one, and callbacks registered outside a
  // frame run in registration order, so this fires immediately after the first render returns.
  // It stays out of the render loop deliberately: measurement does not belong in the hot path.
  requestAnimationFrame(() => performance.mark("odyssey:interactive"));
}

function buildTierPicker(
  host: HTMLElement,
  current: Tier,
  settings: ReturnType<typeof loadSettings>,
  onPick: (t: Tier) => void,
): { select: (tier: Tier) => void } {
  const buttons = new Map<Tier, HTMLButtonElement>();
  const select = (tier: Tier): void => {
    for (const [key, button] of buttons) button.classList.toggle("active", key === tier);
  };

  host.replaceChildren(...TIER_ORDER.map((tier) => {
    const b = document.createElement("button");
    b.textContent = tier;
    b.title = TIERS[tier].label;
    b.className = "tier";
    b.addEventListener("click", () => {
      select(tier);
      settings.tierOverride = tier;
      saveSettings(settings);
      onPick(tier);
    });
    buttons.set(tier, b);
    return b;
  }));

  select(current);
  return { select };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
