// Browser entry point. Boot order matters and is the whole content of this file.

import { Game } from "./app/game.js";
import { createRenderer } from "./app/renderer-factory.js";
import { loadSettings, saveSettings } from "./app/settings.js";
import { TIERS, TIER_ORDER } from "./view/renderer/tiers.js";
import { type Tier } from "./view/renderer/port.js";
import { MVP_WORLD } from "./bridge/world.js";
import { newGameModel, worldOptionsFor } from "./ui/new-game.js";

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
  // The difficulty and the faction (P5-T16, PARITY row 104). `WorldOptions` has accepted both since
  // Phase 1 and this line passed neither, so **every session ever played has been medium /
  // frontier** — including every measurement in `perf/` and every scenario in the four playtest
  // scripts. `worldOptionsFor` spreads over the base, so ADR-0010 §2's fixed seed and world survive.
  //
  // The model treats the stored pick as untrusted and reports what it rejected, because the engine
  // does not: an unknown difficulty is stored verbatim and played as Medium, and an unknown faction
  // is stored while conferring nothing at all. Both fail silently, which is why they are resolved
  // here rather than handed straight through.
  const newGame = newGameModel({ requested: settings.newGame });
  const game = new Game(
    { viewport: el("viewport"), hudRoot: el("hud"), minimapCanvas: el<HTMLCanvasElement>("minimap") },
    choice.renderer,
    choice.tier,
    settings,
    worldOptionsFor(newGame.choice, { seed: 20260814, worldId: MVP_WORLD }),
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

/**
 * Boot, and say so when it fails.
 *
 * `boot` removes `#boot` on its LAST line, so anything that throws before then leaves the loading
 * message on screen permanently — a page that looks blank, with the reason only in the console.
 * That is not hypothetical: it is what a mis-set GitHub Pages source looked like from the outside,
 * and the absence of this handler is why diagnosing it needed the browser's network log.
 *
 * The message shows the real error text rather than a friendly substitute. Whoever is looking at
 * this screen is the person who has to fix it, and "something went wrong" would waste their time.
 * The watchdog in `index.html` covers the other half — a failure so early that this never runs.
 */
function bootOrExplain(): void {
  try {
    boot();
  } catch (err) {
    console.error(err);
    const boot0 = document.getElementById("boot");
    if (!boot0) throw err;                     // it got far enough to clear the notice; not ours
    boot0.textContent = "";
    const title = document.createElement("strong");
    title.textContent = "The game failed to start.";
    const detail = document.createElement("p");
    detail.textContent = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    detail.style.cssText = "max-width:46ch;text-align:center;line-height:1.5;letter-spacing:normal";
    boot0.append(title, detail);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootOrExplain);
else bootOrExplain();
