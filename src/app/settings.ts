// Player settings. Small, and persisted (ADR-0006: "the override always wins and persists").
//
// `localStorage` is the whole store. No telemetry, no network (N-06), and every read is defensive:
// storage can be disabled outright in the same locked-down environments persona P2 works in, and
// a settings read that throws must not stop the game from starting.

import { type Tier } from "../view/renderer/port.js";
import { TIER_ORDER } from "../view/renderer/tiers.js";
import { type MotionPreference, isMotionPreference, setMotionPreference } from "../view/motion.js";

const KEY = "odyssey3d.settings.v1";

export interface Settings {
  /** A tier the player chose. `null` means "let auto-detection decide". */
  tierOverride: Tier | null;
  edgeScroll: boolean;
  /**
   * How much the interface is allowed to move (P6-T04, N-05).
   *
   * Three states rather than a boolean, and `"auto"` is the default: `prefers-reduced-motion` SEEDS
   * this and never owns it, so a player can disagree with their machine in either direction. What
   * each state actually does to the frame is `view/motion.ts`'s header — it is a decision about
   * decoration versus information, and it belongs beside the effects it governs rather than here.
   */
  motion: MotionPreference;
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

const DEFAULTS: Settings = { tierOverride: null, edgeScroll: true, newGame: null, motion: "auto" };

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
      // Untrusted in the same way, and it matters more than it looks: a stored `"off"` or a stray
      // `true` from an older build must land on `auto` rather than on a state the resolver has no
      // branch for — which would leave the machine's own preference unread AND the player's
      // unhonoured, the one outcome three states exist to prevent.
      motion: isMotionPreference(parsed.motion) ? parsed.motion : DEFAULTS.motion,
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

/**
 * Make the motion preference take effect (P6-T04).
 *
 * Separate from `loadSettings` on purpose: reading a preference and applying one are different
 * jobs, and this one has to run again every time the player changes the row — a load-time-only
 * application would leave the setting looking dead until a reload. The shell calls it in the two
 * places a `Settings` becomes current: when a `Game` is constructed with one, and when a settings
 * button hands it a new one.
 *
 * It is the whole application: the resolved answer reaches the effects through `reducedMotion()`
 * and the stylesheet through `<html data-motion>`, both inside `setMotionPreference`, so there is
 * no second half for a caller to forget.
 */
export function applyMotion(settings: Settings): void {
  setMotionPreference(settings.motion);
}

export function saveSettings(settings: Settings): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage disabled. The setting still applies for this session; losing it on reload is a far
    // better outcome than refusing to change graphics tier at all.
  }
}
