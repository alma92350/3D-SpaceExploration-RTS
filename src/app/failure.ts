// What the player is told when something breaks after boot (P6-T05).
//
// `index.html`'s watchdog covers "the script never loaded"; `main.ts`'s `bootOrExplain` covers
// "`boot()` threw". This is the third window and the longest one by a factor of ten thousand: every
// frame after the first. Until this file, a session could end three different ways with the screen
// simply stopping —
//
//   1. **A lost WebGL context.** `webglcontextlost` and `webglcontextrestored` appeared nowhere in
//      `src/`. Worse than a crash, because three.js absorbs it *perfectly*: its own handler calls
//      `preventDefault()`, sets `_isContextLost`, and `WebGLRenderer.render` then returns on its
//      first line for as long as the loss lasts (three r185, `WebGLRenderer.js:1618`). The frame
//      loop keeps advancing, `endFrame()` keeps returning plausible stats, the simulation keeps
//      ticking — and the picture never changes again. There is no exception to catch, which is
//      exactly why the frame guard in `loop.ts` does not cover this and a listener is required.
//      The only trace is one `console.log` ("THREE.WebGLRenderer: Context Lost.") among three.js's
//      other logs.
//   2. **A throw inside a frame.** Now caught in `loop.ts`; this is where it is put into words.
//   3. **A corrupt save that detonates later** — the class `engine/persist.js:88–92` names, which
//      arrives as (2) some number of ticks after the load returned success.
//
// **A blank canvas with no message is the worst failure this app has**, and the reason is historical
// rather than aesthetic: a mis-set GitHub Pages source produced one in Phase 3, the report was
// "still a blank page", and establishing that it was not a code bug cost a round trip. Every message
// here is therefore written to be *quoted* — it names what happened, whether the game is still
// running, and the build, so the next round trip starts from a fact.
//
// The styling is inline. `src/style.css` is not this row's file to change, and a banner that
// depends on a stylesheet is a banner that is invisible in exactly the failure where the stylesheet
// is the thing that did not load.

import { BUILD } from "./build.js";
import { type FrameFailure } from "./loop.js";

/** A button on the banner. There are never more than two; a wall of choices is not a message. */
export interface FailureAction {
  readonly label: string;
  readonly run: () => void;
}

const BANNER_CSS = [
  "position:absolute", "left:50%", "top:24px", "transform:translateX(-50%)",
  "max-width:52ch", "z-index:40", "box-sizing:border-box",
  "padding:14px 18px", "border-radius:8px",
  "background:rgba(14,16,24,0.94)", "border:1px solid #d08b2c", "color:#f2f2f2",
  "font:13px/1.55 system-ui,sans-serif", "letter-spacing:normal", "text-align:left",
  "box-shadow:0 6px 24px rgba(0,0,0,0.55)",
].join(";");

/**
 * The one place after boot that speaks to the player in prose.
 *
 * Deliberately not `HudView.notice`: that is a single transient line, shared with refused orders
 * and cleared by the next thing that happens (P5-T12 found a colony's fall being erased by the next
 * misclick). A failure has to stay on screen until it is read, and it has to survive a HUD that may
 * itself be the thing that is broken — which is why this writes to an element outside `#hud`.
 */
export class FailureBanner {
  private shown: string | null = null;

  constructor(private readonly host: HTMLElement) {}

  /** What the player can currently read. Empty when nothing is shown. */
  get text(): string {
    return this.host.hidden ? "" : (this.host.textContent ?? "");
  }

  /**
   * Show a failure. `key` is what makes this idempotent: re-showing the same failure — which the
   * loop will do on a repeat episode — must not restack the DOM or steal focus from the button the
   * player is reaching for.
   */
  show(key: string, title: string, detail: string, actions: readonly FailureAction[] = []): void {
    if (this.shown === key) return;
    this.shown = key;
    this.host.replaceChildren();
    this.host.style.cssText = BANNER_CSS;
    this.host.hidden = false;
    this.host.setAttribute("role", "alert");

    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.style.cssText = "display:block;margin-bottom:6px;color:#ffcf7a";

    const body = document.createElement("p");
    body.textContent = detail;
    body.style.cssText = "margin:0";

    // The build, on its own line, on every message. A bug report that does not name a build costs
    // the round trip this whole file exists to prevent, and a player will not think to add it.
    const build = document.createElement("p");
    build.textContent = `Build ${BUILD.label}`;
    build.style.cssText = "margin:8px 0 0;opacity:0.65;font-size:11px";

    this.host.append(heading, body, build);

    if (actions.length > 0) {
      const row = document.createElement("div");
      row.style.cssText = "margin-top:10px;display:flex;gap:8px";
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.style.cssText =
          "font:inherit;padding:5px 10px;border-radius:5px;border:1px solid #6a7180;"
          + "background:#232838;color:inherit;cursor:pointer";
        button.addEventListener("click", action.run);
        row.append(button);
      }
      this.host.append(row);
    }
  }

  clear(): void {
    this.shown = null;
    this.host.replaceChildren();
    this.host.hidden = true;
  }
}

/** `TypeError: x is not a function`, or the best available substitute for a thrown non-Error. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string" && error.length > 0) return error;
  return "an error with no message";
}

/**
 * Put a frame failure into words.
 *
 * Separated from the banner so the wording is testable without a DOM, and so the same sentence can
 * be reused by anything else that has to report one.
 */
export function frameFailureMessage(failure: FrameFailure): { key: string; title: string; detail: string } {
  const what = failure.phase === "step" ? "advancing the simulation" : "drawing the picture";
  if (failure.halted) {
    return {
      key: "frame-halted",
      title: "The game has stopped.",
      detail:
        `${failure.consecutive} frames in a row failed while ${what}, all with ${describeError(failure.error)}. `
        + "The game gave up rather than keep burning your battery on work that cannot succeed. "
        + "Reload the page to start again — saved games are stored in this browser and are untouched. "
        + "The console has the full stack trace.",
    };
  }
  return {
    key: `frame-${failure.phase}-${describeError(failure.error)}`,
    title: "The game hit an error and kept running.",
    detail:
      `${describeError(failure.error)}, while ${what}, at tick ${failure.ticks}. `
      + "The game recovered and is still running, so this is safe to dismiss — but if things look "
      + "wrong from here, reload and report that line. The console has the full stack trace.",
  };
}

export interface ContextGuardOptions {
  /** The canvas that holds the WebGL context — `#scene`. */
  readonly canvas: HTMLCanvasElement;
  readonly banner: FailureBanner;
  /** Stop the frame loop. Drawing into a lost context is work that cannot reach a pixel. */
  readonly pause: () => void;
  /** Start it again. Returns false if the session could not be resumed. */
  readonly resume: () => boolean;
  /**
   * Give up on 3D and put the Canvas2D renderer in (ADR-0005's fallback of last resort). Returns
   * false if even that failed. Offered as a button rather than done automatically — see below.
   */
  readonly useFallback: () => boolean;
}

/**
 * Listen for the context going away, and say so.
 *
 * **`preventDefault()` is not optional.** Without it the browser is entitled never to fire
 * `webglcontextrestored` at all, and the automatic recovery below would never happen. three.js's
 * own handler calls it too — this one is registered on the same canvas and both run — but relying
 * on that would make our recovery depend on an implementation detail of a dependency.
 *
 * **Recovery is automatic on restore and manual otherwise.** A browser that gives the context back
 * needs nothing from us: three.js re-initialises its GL state in its own `webglcontextrestored`
 * handler and re-uploads what it holds, so resuming the loop is the whole job. A browser that never
 * fires the event has left us with a permanently dead 3D view, and switching to Canvas2D behind the
 * player's back would silently drop them two graphics tiers with no explanation — so it is a button
 * they press, next to the sentence explaining why.
 *
 * @returns a function that removes both listeners.
 */
export function installContextGuard(opts: ContextGuardOptions): () => void {
  const onLost = (event: Event): void => {
    event.preventDefault();
    opts.pause();
    opts.banner.show(
      "context-lost",
      "The 3D view stopped.",
      "The browser took this page's graphics context away. That is almost always a display-driver "
      + "reset, a laptop switching between its two GPUs, or the tab being suspended while it was in "
      + "the background — not something you did, and not a lost game. The simulation is paused and "
      + "will carry on by itself the moment the browser gives the context back.",
      [{
        label: "Use the compatibility renderer",
        run: () => {
          if (opts.useFallback()) {
            opts.banner.show(
              "context-fallback",
              "Running the compatibility renderer.",
              "The 3D view has been replaced by the 2D one at the lowest graphics tier, and the "
              + "game is running again. Reload the page to try 3D once more.",
            );
          } else {
            opts.banner.show(
              "context-fallback-failed",
              "The game could not be restarted.",
              "Neither the 3D view nor the compatibility renderer could be brought back. Reload the "
              + "page — saved games are stored in this browser and are untouched.",
              [{ label: "Reload", run: () => globalThis.location?.reload() }],
            );
          }
        },
      }],
    );
  };

  const onRestored = (): void => {
    if (opts.resume()) {
      opts.banner.clear();
      return;
    }
    opts.banner.show(
      "context-restored-failed",
      "The 3D view came back, but the game did not.",
      "The browser restored the graphics context and the game could not be resumed on it. Reload "
      + "the page — saved games are stored in this browser and are untouched.",
      [{ label: "Reload", run: () => globalThis.location?.reload() }],
    );
  };

  opts.canvas.addEventListener("webglcontextlost", onLost);
  opts.canvas.addEventListener("webglcontextrestored", onRestored);
  return () => {
    opts.canvas.removeEventListener("webglcontextlost", onLost);
    opts.canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}

/**
 * Everything that throws where nobody is catching — which, after `loop.ts`, is the DOM handlers.
 *
 * `Game` runs every HUD command, every key and every pointer gesture from inside a listener, and a
 * throw in one of those does not reach the frame loop: the browser logs it and the click simply
 * does nothing. That is the shape of the corrupt-save failure a player is most likely to meet —
 * press Load, the payload is wrong in a way nothing anticipated, and the button appears not to
 * work. This turns the whole class into a sentence.
 *
 * **Resource-load errors are not ours.** They arrive on the same event with `target` set to the
 * `<script>` or `<link>` that failed and no `error` property, and `index.html`'s watchdog already
 * owns that case and diagnoses it far better (it is the GitHub Pages misconfiguration). Claiming it
 * here would replace a specific, correct message with a generic one.
 *
 * @returns a function that removes the listeners.
 */
export function installGlobalErrorGuard(banner: FailureBanner, target: EventTarget = globalThis): () => void {
  const show = (error: unknown, kind: "threw" | "rejected"): void => {
    const message = describeError(error);
    banner.show(
      `global-${kind}-${message}`,
      "Something went wrong, and the game is still running.",
      `${message} — from ${kind === "threw" ? "an action that did not complete" : "a background task"}. `
      + "Whatever you just pressed may not have taken effect. The game itself is still running; the "
      + "console has the full stack trace.",
      [{ label: "Dismiss", run: () => banner.clear() }],
    );
  };

  const onError = (event: Event): void => {
    const e = event as ErrorEvent;
    // A failed <script>/<link>: the target is the ELEMENT, and an uncaught exception's target is
    // the window, which has no `tagName`. The same discriminator `index.html`'s watchdog uses, and
    // written as a duck-type rather than `instanceof Element` because these two listeners can
    // legitimately see events from another realm.
    const source = e.target as { tagName?: unknown } | null;
    if (source && typeof source.tagName === "string") return;
    show(e.error ?? e.message, "threw");
  };
  const onRejection = (event: Event): void => {
    show((event as PromiseRejectionEvent).reason, "rejected");
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
