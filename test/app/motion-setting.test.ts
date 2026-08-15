// @vitest-environment jsdom
//
// P6-T04, the settings half: the preference is stored, is untrusted on the way back in, and reaches
// BOTH halves of the client when it is applied — the effect pool through `reducedMotion()` and the
// stylesheet through `<html data-motion>`.
//
// The attribute carries the RESOLVED answer rather than the preference, and that is the assertion
// worth having: CSS cannot resolve "auto" against a player's override, so a stylesheet handed the
// word "auto" would have to fall back to the media query and would then overrule a player who asked
// for motion on a machine that asks for less. Everything here is checked through `loadSettings` and
// `applyMotion` — the two functions the shell actually calls.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMotion, loadSettings, saveSettings, type Settings } from "../../src/app/settings.js";
import { reducedMotion, setMotionPreference } from "../../src/view/motion.js";

const KEY = "odyssey3d.settings.v1";

/** The literal, not the exported constant: see `test/view/reduced-motion.test.ts`'s `OS_QUERY`. */
const OS_QUERY = "(prefers-reduced-motion: reduce)";

function stubMatchMedia(reduce: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia =
    (query: string) => ({ matches: reduce && query === OS_QUERY });
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { tierOverride: null, edgeScroll: true, newGame: null, motion: "auto", ...patch };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.motion;
});

afterEach(() => {
  localStorage.clear();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  setMotionPreference("auto");
});

describe("the motion preference as a stored setting", () => {
  it("defaults to auto, so a fresh player is whatever their machine says", () => {
    expect(loadSettings().motion).toBe("auto");
  });

  it("round-trips an explicit choice", () => {
    for (const motion of ["full", "reduced", "auto"] as const) {
      saveSettings(settings({ motion }));
      expect(loadSettings().motion).toBe(motion);
    }
  });

  it("treats a stored value as untrusted and lands on auto, never on nothing", () => {
    // The failure this guards is specific: an unrecognised value that survived would resolve to
    // neither the machine's answer nor the player's, and the frame would obey whichever branch it
    // happened to fall through — which is the state three honest states exist to prevent.
    for (const junk of [true, "off", "on", 1, null, {}]) {
      localStorage.setItem(KEY, JSON.stringify({ motion: junk }));
      expect(loadSettings().motion, `${JSON.stringify(junk)} was stored and read back verbatim`).toBe("auto");
    }
  });

  it("keeps reading the rest of the settings when storage is empty or broken", () => {
    localStorage.setItem(KEY, "{ not json");
    expect(loadSettings().motion).toBe("auto");
  });
});

describe("applying it", () => {
  it("publishes the RESOLVED answer to the document, not the preference", () => {
    stubMatchMedia(true);
    applyMotion(settings({ motion: "auto" }));
    expect(
      document.documentElement.dataset.motion,
      "auto reached the stylesheet as the word `auto`, which no stylesheet can resolve",
    ).toBe("reduced");
    expect(reducedMotion()).toBe(true);

    applyMotion(settings({ motion: "full" }));
    expect(document.documentElement.dataset.motion, "the player's override never reached the CSS").toBe("full");
    expect(reducedMotion()).toBe(false);
  });

  it("stamps reduced for a player who chose it on a machine that never asked", () => {
    stubMatchMedia(false);
    applyMotion(settings({ motion: "reduced" }));
    expect(document.documentElement.dataset.motion).toBe("reduced");
    expect(reducedMotion()).toBe(true);
  });

  it("survives a browser that refuses the media query", () => {
    // Persona P2 again. `applyMotion` runs on the boot path, so a throw here is a game that does
    // not start — the same reason every `localStorage` read in `settings.ts` is wrapped.
    (globalThis as { matchMedia?: unknown }).matchMedia = () => { throw new Error("blocked"); };
    expect(() => applyMotion(settings({ motion: "auto" }))).not.toThrow();
    expect(document.documentElement.dataset.motion).toBe("full");
    expect(reducedMotion()).toBe(false);
  });
});
