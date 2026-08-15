// Browser entry point. Boot order matters and is the whole content of this file.

import { Game } from "./app/game.js";
import { BUILD, stampBuild } from "./app/build.js";
import {
  FailureBanner, frameFailureMessage, installContextGuard, installGlobalErrorGuard,
} from "./app/failure.js";
import { reportFrameFailuresTo } from "./app/loop.js";
import { compatibilityRenderer, createRenderer } from "./app/renderer-factory.js";
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
  const banner = new FailureBanner(el("failure"));
  const glCanvas = el<HTMLCanvasElement>("scene");
  const overlayCanvas = el<HTMLCanvasElement>("overlay");
  const choice = createRenderer({
    glCanvas,
    overlayCanvas,
    fallbackCanvas: overlayCanvas,
    tierOverride: settings.tierOverride,
  });

  // The Canvas2D path draws the whole world onto the overlay canvas, so the (now unused) GL canvas
  // must get out of the way — otherwise it sits on top as an opaque black rectangle.
  if (choice.renderer.name === "canvas2d") glCanvas.style.display = "none";

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

  // --- P6-T05: the three failures that used to end a session in silence ------------------------
  //
  // All three land on the same banner deliberately. A player who has to learn which of three
  // different surfaces carries which kind of bad news has been handed our architecture as a
  // feature; there is one place to look, and the message says which thing broke.

  // 1. A lost WebGL context. See `installContextGuard` — three.js absorbs this so completely that
  //    nothing throws, so a listener is the only way to know it happened.
  installContextGuard({
    canvas: glCanvas,
    banner,
    pause: () => game.stop(),
    resume: () => {
      try {
        game.start();
        return true;
      } catch (err) {
        console.error("[odyssey] the game could not be resumed after the context came back", err);
        return false;
      }
    },
    useFallback: () => {
      try {
        // Exactly what `createRenderer` does when the probe fails, and for the same reason: the 3D
        // view is unavailable and the game must still run (ADR-0005's fallback of last resort).
        const fallback = compatibilityRenderer(overlayCanvas, "");
        game.setRenderer(fallback.renderer, fallback.tier);
        glCanvas.style.display = "none";
        picker.select(fallback.tier);
        game.start();
        return true;
      } catch (err) {
        console.error("[odyssey] the compatibility renderer could not be started either", err);
        return false;
      }
    },
  });

  // 2. A throw inside a frame. `loop.ts` catches it, keeps the loop alive and always logs the
  //    stack; this is the half that puts it in front of the person who has to report it.
  reportFrameFailuresTo((failure) => {
    const { key, title, detail } = frameFailureMessage(failure);
    banner.show(key, title, detail, failure.halted
      ? [{ label: "Reload", run: () => globalThis.location?.reload() }]
      : [{ label: "Dismiss", run: () => banner.clear() }]);
  });

  // 3. A corrupt save, and everything else that throws inside a DOM handler. `WorldBridge.load()`
  //    already refuses a payload it cannot read (N-08, and upstream's own hardening does most of
  //    that work) — this is the backstop for the case nothing anticipated, where a click would
  //    otherwise appear simply not to work.
  installGlobalErrorGuard(banner);

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
  // First, and outside the try: a build that fails to start still has to say WHICH build failed,
  // and `stampBuild` is written so that it cannot itself be the reason one does (P6-T06).
  stampBuild();
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
    // The build, on the one screen where "it does not work" is most likely to be reported without
    // one. Every playtest script asks for it and until P6-T06 there was nothing to give.
    const build = document.createElement("p");
    build.textContent = `Build ${BUILD.label}`;
    build.style.cssText = "opacity:0.6;font-size:11px;letter-spacing:normal";
    boot0.append(title, detail, build);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootOrExplain);
else bootOrExplain();
