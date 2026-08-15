// @vitest-environment jsdom
//
// P6-T05 — the three failures that used to end a session in silence, each one FIRED rather than
// asserted-about.
//
// The bar this file is written to: *an error-handling test that asserts a handler is registered
// proves nothing.* So every test here produces the real failure against a real `Game` in a real
// DOM — a dispatched `webglcontextlost`, a renderer that actually throws mid-frame, a corrupt
// payload actually written to `localStorage` and actually loaded through the button a player
// presses — and then asserts on the words the player can read and quote.
//
// jsdom will not lose a WebGL context for us, so the event is dispatched. That is the one
// concession, and it is the right one: `webglcontextlost` is a plain `Event` the browser fires on
// the canvas, `installContextGuard` is a plain listener on it, and the code path from the event to
// the sentence on screen is identical either way. The behaviour that CANNOT be faked — the loop
// stopping and starting again — is driven through the real `Game.start`/`Game.stop` and observed on
// a renderer that counts frames.
//
// The harness is `test/ui/phase5-wiring.test.ts`'s (a real `Game`, `RecordingRenderer`, a stubbed
// 2D context because jsdom ships no canvas backend), kept as a separate file so that P6-T03's
// keyboard work and this can land without touching each other.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game } from "../../src/app/game.js";
import { BUILD, stampBuild } from "../../src/app/build.js";
import {
  FailureBanner, describeError, frameFailureMessage, installContextGuard, installGlobalErrorGuard,
} from "../../src/app/failure.js";
import { type FrameFailure, reportFrameFailuresTo } from "../../src/app/loop.js";
import { compatibilityRenderer } from "../../src/app/renderer-factory.js";
import { loadSettings } from "../../src/app/settings.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { ODYSSEY_WORLDS, deserializeGalaxy } from "../../src/engine/index.js";
import { SAVE_PREFIX } from "../../src/ui/save-panel.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { type CameraState } from "../../src/view/renderer/port.js";

const SEED = 20260815;

// Node's `fs` rejects jsdom's `URL`, which shadows the global one in this environment — so the two
// file reads below go through plain paths rather than `new URL(…, import.meta.url)`.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A no-op 2D context. Every property answers, nothing draws. (`phase5-wiring.test.ts`'s.) */
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

/**
 * The recording fake, plus the two things this file needs it to do: count frames that actually
 * reached the renderer, and throw on demand.
 *
 * The throw is raised BEFORE `super.beginFrame`, so no frame is left open and the port's call-order
 * contract is intact on the next attempt — which is the whole point of asserting that the loop
 * recovers rather than merely survives.
 */
class FaultyRenderer extends RecordingRenderer {
  drawn = 0;
  explode: Error | null = null;

  override beginFrame(camera: CameraState): void {
    if (this.explode) throw this.explode;
    this.drawn++;
    super.beginFrame(camera);
  }
}

/** A hand-driven `requestAnimationFrame`, so "is the loop running?" is a fact and not a timeout. */
function manualFrames(): { pump: (ms: number) => void; restore: () => void } {
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  let pending: FrameRequestCallback | null = null;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { pending = cb; return 1; }) as typeof raf;
  globalThis.cancelAnimationFrame = (() => { pending = null; }) as typeof caf;
  return {
    pump: (ms: number) => { const cb = pending; pending = null; cb?.(ms); },
    restore: () => { globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = caf; },
  };
}

interface Fixture {
  game: Game;
  renderer: FaultyRenderer;
  banner: FailureBanner;
  bannerHost: HTMLElement;
  glCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  hudRoot: HTMLElement;
}

function build(): Fixture {
  const viewport = document.createElement("div");
  const hudRoot = document.createElement("div");
  const minimapCanvas = document.createElement("canvas");
  const glCanvas = document.createElement("canvas");
  const overlayCanvas = document.createElement("canvas");
  const bannerHost = document.createElement("div");
  bannerHost.hidden = true;
  viewport.append(glCanvas, overlayCanvas, bannerHost);
  document.body.append(viewport, hudRoot, minimapCanvas);

  const renderer = new FaultyRenderer();
  const game = new Game(
    { viewport, hudRoot, minimapCanvas },
    renderer,
    "T0",
    // Read through `loadSettings` rather than written as a literal: `Settings` is gaining a field
    // in this very phase (P6-T04's reduced-motion flag), and a literal here would go red on it.
    { ...loadSettings(), edgeScroll: false },
    { seed: SEED, worldId: "helix" },
  );
  return { game, renderer, banner: new FailureBanner(bannerHost), bannerHost, glCanvas, overlayCanvas, hudRoot };
}

/** Exactly what `main.ts` wires, so the test exercises the production arrangement. */
function guard(f: Fixture): () => void {
  return installContextGuard({
    canvas: f.glCanvas,
    banner: f.banner,
    pause: () => f.game.stop(),
    resume: () => { f.game.start(); return true; },
    useFallback: () => {
      const fallback = compatibilityRenderer(f.overlayCanvas, "");
      f.game.setRenderer(fallback.renderer, fallback.tier);
      f.glCanvas.style.display = "none";
      f.game.start();
      return true;
    },
  });
}

describe("a lost WebGL context (P6-T05)", () => {
  let restoreCanvas: () => void;
  let frames: ReturnType<typeof manualFrames>;
  let f: Fixture;
  let detach: () => void;

  beforeEach(() => {
    restoreCanvas = stubCanvas();
    frames = manualFrames();
    localStorage.clear();
    f = build();
    detach = guard(f);
  });

  afterEach(() => {
    detach();
    f.game.stop();
    frames.restore();
    document.body.replaceChildren();
    localStorage.clear();
    restoreCanvas();
  });

  /** The event the browser fires. Cancelable, because `preventDefault` on it is load-bearing. */
  function lose(): Event {
    const event = new Event("webglcontextlost", { cancelable: true });
    f.glCanvas.dispatchEvent(event);
    return event;
  }

  it("stops the session, and says what happened in words a player can report", () => {
    f.game.start();
    frames.pump(0);
    frames.pump(16);
    expect(f.renderer.drawn, "the fixture never rendered anything").toBeGreaterThan(0);

    lose();
    const drawnAtLoss = f.renderer.drawn;
    frames.pump(32);
    frames.pump(48);
    expect(f.renderer.drawn, "the game kept drawing into a context it no longer has")
      .toBe(drawnAtLoss);

    const text = f.banner.text;
    expect(text, "a lost context is still a blank canvas with no message").not.toBe("");
    expect(text).toMatch(/3D view stopped/i);
    // The three causes, named — because "not something you did" is the sentence that stops a
    // player filing a bug about their own hardware, and the sentence that lets them file a
    // useful one when it IS ours.
    expect(text).toMatch(/driver/i);
    expect(text).toMatch(/suspended|background/i);
    // Every message carries the build, because a player will not think to add it (P6-T06).
    expect(text, "the message a player quotes does not say which build it came from")
      .toContain(BUILD.label);
  });

  it("calls preventDefault, without which the context can never come back", () => {
    // Not a style point: the spec lets the browser skip `webglcontextrestored` entirely unless the
    // lost event was cancelled, so the automatic recovery below depends on this one line.
    expect(lose().defaultPrevented).toBe(true);
  });

  it("starts the session again by itself when the browser restores the context", () => {
    f.game.start();
    frames.pump(0);
    lose();
    const drawnAtLoss = f.renderer.drawn;

    f.glCanvas.dispatchEvent(new Event("webglcontextrestored"));
    frames.pump(100);
    frames.pump(116);
    expect(f.renderer.drawn, "the context came back and the game did not").toBeGreaterThan(drawnAtLoss);
    expect(f.banner.text, "the panic message stayed up after the game recovered").toBe("");
  });

  it("offers the compatibility renderer for a context that never comes back", () => {
    f.game.start();
    frames.pump(0);
    lose();

    const button = [...f.bannerHost.querySelectorAll("button")]
      .find((b) => /compatibility/i.test(b.textContent ?? ""));
    expect(button, "a permanently dead 3D view leaves the player nothing to press").toBeDefined();

    button!.click();
    expect(f.game.currentTier, "the fallback did not drop to the tier Canvas2D actually draws")
      .toBe("T0");
    expect(f.glCanvas.style.display, "the dead GL canvas is still on top as a black rectangle")
      .toBe("none");
    expect(f.banner.text).toMatch(/compatibility renderer/i);
    // And it is running again — the point of the button.
    frames.pump(200);
    frames.pump(216);
    expect(f.banner.text).not.toMatch(/could not be restarted/i);
  });

  it("does not leave the listeners behind when the guard is removed", () => {
    detach();
    detach = () => {};
    f.game.start();
    frames.pump(0);
    lose();
    frames.pump(16);
    expect(f.banner.text).toBe("");
  });
});

describe("a throw inside a frame, in the real shell (P6-T05)", () => {
  let restoreCanvas: () => void;
  let frames: ReturnType<typeof manualFrames>;
  let errors: ReturnType<typeof vi.spyOn>;
  let previous: ((f: FrameFailure) => void) | null;
  let f: Fixture;

  beforeEach(() => {
    restoreCanvas = stubCanvas();
    frames = manualFrames();
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.clear();
    f = build();
    // The wiring `main.ts` installs, verbatim.
    previous = reportFrameFailuresTo((failure) => {
      const { key, title, detail } = frameFailureMessage(failure);
      f.banner.show(key, title, detail);
    });
  });

  afterEach(() => {
    reportFrameFailuresTo(previous);
    f.game.stop();
    frames.restore();
    errors.mockRestore();
    document.body.replaceChildren();
    localStorage.clear();
    restoreCanvas();
  });

  it("keeps the game running and tells the player, instead of freezing in silence", () => {
    f.game.start();
    frames.pump(0);
    const drawnBefore = f.renderer.drawn;

    // A real throw from inside the real render path — `SceneComposer` calls `beginFrame`.
    f.renderer.explode = new TypeError("cannot read properties of undefined (reading 'yaw')");
    frames.pump(50);
    expect(f.banner.text, "a thrown frame said nothing at all").not.toBe("");
    expect(f.banner.text).toMatch(/hit an error and kept running/i);
    expect(f.banner.text, "the message does not name the error a player has to quote")
      .toContain("cannot read properties of undefined");
    expect(f.banner.text).toContain(BUILD.label);

    // Recovered, and still running — which the old code could not do at all, because the rAF chain
    // re-arms inside the callback and a throw out of it was the end of the session.
    f.renderer.explode = null;
    frames.pump(100);
    frames.pump(150);
    expect(f.renderer.drawn, "the frame loop died on the first throw").toBeGreaterThan(drawnBefore);
    expect(errors, "the exception was swallowed instead of logged").toHaveBeenCalled();
  });

  it("keeps simulating while the picture is broken", () => {
    // The two halves of a frame fail independently on purpose: a render that throws must not stop
    // the clock, or a transient drawing bug would silently rewind the player's session.
    f.game.start();
    frames.pump(0);
    f.renderer.explode = new Error("broken");
    const tickBefore = f.game.bridge.state.tick;
    for (let i = 1; i <= 20; i++) frames.pump(i * 50);
    expect(f.game.bridge.state.tick, "the simulation stopped because the picture did")
      .toBeGreaterThan(tickBefore);
  });
});

describe("a corrupt save (N-08, P6-T05)", () => {
  let restoreCanvas: () => void;
  let frames: ReturnType<typeof manualFrames>;
  let f: Fixture;

  beforeEach(() => {
    restoreCanvas = stubCanvas();
    frames = manualFrames();
    localStorage.clear();
    f = build();
  });

  afterEach(() => {
    f.game.stop();
    frames.restore();
    document.body.replaceChildren();
    localStorage.clear();
    restoreCanvas();
  });

  function render(): void {
    (f.game as unknown as { renderFrame(alpha: number, frameMs: number): void }).renderFrame(0, 16);
  }

  function buttons(): HTMLButtonElement[] {
    return [...f.hudRoot.querySelectorAll("button")];
  }

  function labelled(text: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.textContent?.includes(text));
  }

  function notice(): string {
    return f.hudRoot.querySelector('[data-hud="notice"]')?.textContent ?? "";
  }

  /**
   * A payload that PARSES and is structurally wrong: a real save whose seat names a world the file
   * carries no planet for.
   *
   * Chosen because it is the one shape that gets furthest through the gates — `describeSave` reads
   * a valid `v`, a non-empty `planets` array and a real world id, so the panel offers a live Load
   * button — and `deserializeGalaxy` only refuses it at its very last structural check. It is also
   * what a half-written file or a hand-edited one actually looks like.
   */
  function structurallyWrongSave(): Record<string, unknown> {
    const donor = new WorldBridge({ seed: SEED, worldId: "helix" });
    for (let i = 0; i < 5; i++) donor.step();
    const payload = donor.save();
    const carried = new Set((payload.planets as Array<{ planetId: string }>).map((p) => p.planetId));
    // Derived rather than hardcoded: a fresh galaxy instantiates the seat and its neighbours only
    // (helix, korrath, ferros, glacius today), and naming one of the other seven by hand would
    // silently stop testing anything the day the roster or the neighbour rule changes.
    const orphan = (ODYSSEY_WORLDS as readonly string[]).find((id) => !carried.has(id));
    expect(orphan, "every roster world is in a fresh save, so this corruption is unreachable")
      .toBeDefined();
    payload.activeId = orphan;                 // a real world, with no planet block in this file
    return payload;
  }

  it("refuses the load, says so, and leaves the session standing", () => {
    localStorage.setItem(SAVE_PREFIX + "corrupt", JSON.stringify({
      name: "half a file", savedAt: Date.now(), save: structurallyWrongSave(),
    }));

    render();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    render();
    labelled("Saves & settings")!.click();
    render();

    const load = buttons().find((b) => b.textContent?.startsWith("Load"));
    expect(load, "the corrupt save was not even offered, so nothing is under test").toBeDefined();
    expect(load!.disabled, "the panel rejected it on listing, so the load path is not exercised")
      .toBe(false);

    const worldBefore = f.game.bridge.worldId;
    const tickBefore = f.game.bridge.state.tick;
    load!.click();

    expect(notice(), "a load that failed said nothing").toMatch(/could not be loaded/i);
    // The session is INTACT: same seat, same clock, and it still draws. A load that half-applied a
    // bad file and then threw would have swapped the galaxy and left the shell pointing at it.
    expect(f.game.bridge.worldId).toBe(worldBefore);
    expect(f.game.bridge.state.tick).toBe(tickBefore);
    f.game.bridge.step();
    expect(() => render(), "the session did not survive a refused load").not.toThrow();
  });

  it("survives every shape of nonsense a slot can hold", () => {
    // Fired, not reasoned about: each of these is loaded through the same call the button makes.
    const donor = new WorldBridge({ seed: SEED, worldId: "helix" });
    const good = donor.save();
    const payloads: Array<[string, unknown]> = [
      ["not an object", "garbage"],
      ["null", null],
      ["an empty object", {}],
      ["a newer save version", { ...good, v: 99 }],
      ["no planets", { ...good, planets: [] }],
      ["a seat with no planet", structurallyWrongSave()],
      ["a prototype-polluting key", JSON.parse('{"v":1,"__proto__":{"x":1}}')],
      ["a planet with no players block", (() => {
        const s = JSON.parse(JSON.stringify(good)) as { planets: Array<Record<string, unknown>> };
        delete s.planets[0]!.players;
        return s;
      })()],
    ];
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const before = bridge.worldId;
    for (const [name, payload] of payloads) {
      expect(() => bridge.load(payload), `${name} threw out of load()`).not.toThrow();
      expect(bridge.load(payload), `${name} was accepted`).toBe(false);
      expect(bridge.worldId, `${name} moved the seat before being refused`).toBe(before);
    }
  });

  it("keeps the reason upstream took the trouble to write, and distinguishes the causes", () => {
    // **Written the other way up.** This pinned an open defect: `load()`'s bare
    // `catch { return false }` reduced eight distinguishable, quotable causes to one bit and logged
    // none of them — "a caught exception that logs nothing is worse than a crash, because the crash
    // at least has a stack". It was fixed in the same pass and inverted rather than deleted.
    //
    // The pin as first written would NOT have noticed the fix: it asserted only that `load` returns
    // false, which is true either way. That is the failure mode of a pin whose assertions describe
    // the surroundings instead of the defect — so the assertion now is that the messages ARRIVE and
    // that they DIFFER, which is the whole point of keeping them.
    expect(() => deserializeGalaxy(structurallyWrongSave())).toThrow(/no active planet/);
    expect(() => deserializeGalaxy({ v: 99 })).toThrow(/unsupported galaxy save version/);
    expect(() => deserializeGalaxy(JSON.parse('{"v":1,"__proto__":{"x":1}}'))).toThrow(/forbidden key/);

    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const reasons: string[] = [];
    for (const payload of [structurallyWrongSave(), { v: 99 }, JSON.parse('{"v":1,"__proto__":{"x":1}}')]) {
      expect(bridge.load(payload)).toBe(false);
      const why = bridge.takeLoadError();
      expect(why, "a refusal arrived with no reason at all").not.toBeNull();
      reasons.push(why!);
    }
    expect(reasons[0]).toMatch(/no active planet/);
    expect(reasons[1]).toMatch(/unsupported galaxy save version/);
    expect(reasons[2]).toMatch(/forbidden key/);
    // Three causes, three sentences. A fix that kept ONE message for all of them would pass every
    // assertion above this line.
    expect(new Set(reasons).size, "the causes collapsed back to one message").toBe(3);
    // Drained on read, like `takeCommandError` — otherwise a stale reason outlives its refusal and
    // gets attached to the next one.
    expect(bridge.takeLoadError(), "the reason was not drained").toBeNull();
  });
});

describe("the global error guard (P6-T05)", () => {
  let restoreCanvas: () => void;
  let host: HTMLElement;
  let banner: FailureBanner;
  let detach: () => void;

  beforeEach(() => {
    restoreCanvas = stubCanvas();
    host = document.createElement("div");
    host.hidden = true;
    document.body.append(host);
    banner = new FailureBanner(host);
    detach = installGlobalErrorGuard(banner);
  });

  afterEach(() => {
    detach();
    document.body.replaceChildren();
    restoreCanvas();
  });

  it("turns a click that threw into a sentence, instead of a button that does nothing", () => {
    const button = document.createElement("button");
    button.addEventListener("click", () => { throw new TypeError("save.payload is not an object"); });
    document.body.append(button);

    // A real click on a real listener that really throws. jsdom routes the uncaught exception to
    // `window`'s error event exactly as a browser does, which is the seam the guard listens on.
    const onError = vi.fn();
    globalThis.addEventListener("error", onError);
    button.click();
    globalThis.removeEventListener("error", onError);

    expect(onError, "jsdom did not surface the throw, so nothing was fired").toHaveBeenCalled();
    expect(banner.text, "a click that threw still says nothing").not.toBe("");
    expect(banner.text).toContain("save.payload is not an object");
    expect(banner.text).toMatch(/may not have taken effect/i);
    expect(banner.text).toContain(BUILD.label);
  });

  it("leaves a failed script or stylesheet to the boot watchdog, which diagnoses it properly", () => {
    // The watchdog in index.html knows this case is almost certainly the GitHub Pages source
    // setting and says so. Replacing that with a generic message would lose the diagnosis that
    // cost a round trip to establish in Phase 3.
    const script = document.createElement("script");
    document.body.append(script);
    const event = new Event("error", { bubbles: true });
    Object.defineProperty(event, "target", { value: script });
    globalThis.dispatchEvent(event);
    expect(banner.text).toBe("");
  });

  it("can be dismissed, because the game is still running", () => {
    globalThis.dispatchEvent(new ErrorEvent("error", { error: new Error("transient") }));
    expect(banner.text).not.toBe("");
    const dismiss = [...host.querySelectorAll("button")].find((b) => /dismiss/i.test(b.textContent ?? ""));
    expect(dismiss).toBeDefined();
    dismiss!.click();
    expect(banner.text).toBe("");
  });

  it("falls back to the message when there is no error object to read", () => {
    // A cross-origin script strips `error` and leaves only `message`. Reading one and not the other
    // is how a guard ends up showing a blank banner in exactly the case it was written for.
    globalThis.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    expect(banner.text).toContain("Script error.");
  });

  it("catches a rejected promise, which nothing else in this app would", () => {
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    Object.defineProperty(event, "reason", { value: new Error("a background task gave up") });
    globalThis.dispatchEvent(event);
    expect(banner.text, "an unhandled rejection is still a silent failure").toContain("a background task gave up");
    expect(banner.text).toMatch(/background task/i);
  });
});

describe("the banner itself", () => {
  it("does not restack when the same failure is shown again", () => {
    const host = document.createElement("div");
    const banner = new FailureBanner(host);
    banner.show("k", "Title", "Detail", [{ label: "Go", run: () => {} }]);
    const first = host.firstElementChild;
    banner.show("k", "Title", "Detail", [{ label: "Go", run: () => {} }]);
    expect(host.firstElementChild, "the banner rebuilt itself under the player's cursor").toBe(first);
  });

  it("is hidden and empty until there is something to say", () => {
    const host = document.createElement("div");
    const banner = new FailureBanner(host);
    expect(banner.text).toBe("");
    banner.show("k", "Title", "Detail");
    expect(host.hidden).toBe(false);
    banner.clear();
    expect(host.hidden).toBe(true);
    expect(banner.text).toBe("");
  });

  it("describes a thrown non-Error without producing '[object Object]'", () => {
    expect(describeError(new TypeError("x"))).toBe("TypeError: x");
    expect(describeError("a bare string")).toBe("a bare string");
    expect(describeError({})).toBe("an error with no message");
    expect(describeError(undefined)).toBe("an error with no message");
  });

  it("says something different, and actionable, when the loop has given up", () => {
    // The two are not the same news and must not read the same. One is "carry on"; the other is
    // "the game is not running any more", and a player who cannot tell them apart will sit in
    // front of a frozen picture waiting for it to recover.
    const running = frameFailureMessage({
      phase: "render", error: new TypeError("bad"), consecutive: 1, halted: false, ticks: 12, frames: 30,
    });
    const stopped = frameFailureMessage({
      phase: "step", error: new TypeError("bad"), consecutive: 60, halted: true, ticks: 12, frames: 90,
    });

    expect(running.title).toMatch(/kept running/i);
    expect(running.detail).toMatch(/tick 12/);
    expect(stopped.title).toMatch(/has stopped/i);
    expect(stopped.detail).toMatch(/60 frames/);
    expect(stopped.detail, "a player told the game stopped is not told what to do").toMatch(/reload/i);
    expect(stopped.detail, "and not told whether their saves survived").toMatch(/saved games/i);
    expect(stopped.key).not.toBe(running.key);
  });
});

describe("the build stamp (P6-T06)", () => {
  it("puts a version a player can read and quote on the page", () => {
    const el = document.createElement("p");
    el.id = "build";
    document.body.append(el);
    stampBuild(document);

    expect(el.textContent, "the sidebar still says nothing about which build this is")
      .toBe(`Build ${BUILD.label}`);
    expect(document.documentElement.dataset.build).toBe(BUILD.label);
    document.body.replaceChildren();
  });

  it("carries the version from package.json, not a hand-typed string", () => {
    // The point of P6-T06: the build injects it, from the one place it is written. Compared against
    // `package.json` itself rather than against a literal, so this goes red the day someone types
    // the number into a second file instead of lying for a phase.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };
    expect(BUILD.version).toBe(pkg.version);
    expect(BUILD.label).toBe(`${BUILD.version} · ${BUILD.commit}`);
  });

  it("carries a commit this repository actually has, wherever there is a git to ask", () => {
    // `unknown` is a legitimate answer in a source tarball with no `.git`, and the build must not
    // fail there — but permitting it unconditionally would let the commit quietly stop being
    // injected at all. So the expectation is derived from the checkout the test runs in.
    //
    // The assertion is "git knows this object", NOT "this equals HEAD". A stamp is taken when the
    // bundle is BUILT and HEAD moves afterwards — that is the whole reason a build carries one, and
    // ADR-0022 says so in as many words. Comparing against HEAD would make this test fail whenever
    // a commit lands between the config load and the assertion, which is a lie about the code.
    const git = (args: string[]): string | null => {
      try {
        return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    };

    if (git(["rev-parse", "--git-dir"]) === null) {
      expect(BUILD.commit, "no git, so the stamp must say so rather than invent one").toBe("unknown");
      return;
    }
    expect(BUILD.commit, "the build stopped stamping a commit").not.toBe("unknown");
    expect(git(["rev-parse", "--verify", "--quiet", `${BUILD.commit}^{commit}`]),
      `the stamped commit ${BUILD.commit} is not an object in this repository`).not.toBeNull();
  });

  it("never throws, whatever the document is", () => {
    // It runs before `boot()` precisely so that a build which fails to start still says which build
    // failed. It must never be the reason one does.
    expect(() => stampBuild(null as unknown as Document)).not.toThrow();
  });
});
