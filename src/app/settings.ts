// Player settings. Small, and persisted (ADR-0006: "the override always wins and persists").
//
// `localStorage` is the whole store. No telemetry, no network (N-06), and every read is defensive:
// storage can be disabled outright in the same locked-down environments persona P2 works in, and
// a settings read that throws must not stop the game from starting.

import { type Tier } from "../view/renderer/port.js";
import { TIER_ORDER } from "../view/renderer/tiers.js";

const KEY = "odyssey3d.settings.v1";

export interface Settings {
  /** A tier the player chose. `null` means "let auto-detection decide". */
  tierOverride: Tier | null;
  edgeScroll: boolean;
  /**
   * The last new-game pick (P5-T16), or null for the engine's own defaults.
   *
   * Stored raw and **never validated here**: `newGameModel` is the thing that knows what the engine
   * accepts, and it treats its input as untrusted precisely because this is where it comes from. A
   * second opinion in this file would be a second answer to a question `DIFFICULTY_OPTIONS` and
   * `PLAYABLE_FACTIONS` already answer — and it would go stale the first time upstream adds one.
   */
  newGame: { difficulty: unknown; playerFaction: unknown } | null;
}

const DEFAULTS: Settings = { tierOverride: null, edgeScroll: true, newGame: null };

export function loadSettings(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      // Settings are untrusted input in exactly the way saves are (N-08): validate, do not trust.
      tierOverride: typeof parsed.tierOverride === "string" && (TIER_ORDER as readonly string[]).includes(parsed.tierOverride)
        ? parsed.tierOverride as Tier
        : null,
      edgeScroll: typeof parsed.edgeScroll === "boolean" ? parsed.edgeScroll : DEFAULTS.edgeScroll,
      // Shape only. What is IN it is `newGameModel`'s question, and it reports what it rejected
      // rather than silently substituting — which is the whole difference from the engine, which
      // stores an unknown difficulty verbatim and plays it as Medium without saying so.
      newGame: parsed.newGame && typeof parsed.newGame === "object"
        ? {
          difficulty: (parsed.newGame as Record<string, unknown>).difficulty,
          playerFaction: (parsed.newGame as Record<string, unknown>).playerFaction,
        }
        : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage disabled. The setting still applies for this session; losing it on reload is a far
    // better outcome than refusing to change graphics tier at all.
  }
}
