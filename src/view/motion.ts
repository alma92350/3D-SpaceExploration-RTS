// Reduced motion (P6-T04, PRD N-05) — what the view is allowed to animate, and who decides.
//
// ================================================================================================
// WHAT "REDUCED MOTION" MEANS HERE
// ================================================================================================
//
// Not "turn the effects off". Every combat cue in this client carries a FACT the player cannot get
// anywhere else — a tracer says you are being shot at and from where, a death mark says something
// died here and whose it was, an impact mark says the hit that landed was heavy, countered, or
// splashed and how far. Deleting any of those would remove information, not motion, and would make
// the game less playable for exactly the player the setting exists for.
//
// So the rule is a distinction rather than a switch: **every effect keeps its fact and loses its
// animation.** Each cue in `view/effects.ts` is drawn from two things — the fact (where, whose,
// which flags, what radius) and a clock that makes it move. Reduced motion freezes the clock at one
// representative value and leaves the fact untouched:
//
//   • TRACER — a line from shooter to target. The line is the fact. Its fade is decoration, and it
//     is frozen at full strength: the most legible value, and the one that stops a firefight
//     reading as a flicker at 20 Hz.
//   • DEATH MARK — an expanding, fading ring with a cross through it. The position, the owner and
//     the size step (a building's mark is twice a unit's) are facts; the expansion and the fade are
//     the decoration, and the renderer's own comment says so: "motion is the cue". Frozen at a
//     third of its life, where ring size and opacity — which pull in opposite directions — put the
//     most ink on screen the animation ever manages.
//   • IMPACT MARK — a dashed splash ring at the weapon's true radius, plus up to two screen glyphs.
//     The ring never animated (its size is a measurement, P5-T15), the glyphs swell as they fade.
//     Frozen at zero: full opacity, glyphs at their base size, the ring at exactly its radius.
//
// What reduced motion deliberately does NOT touch:
//
//   • **Lifetimes.** A tracer still lasts 0.15 s and a death mark 0.5 s. The lifetime is a clock,
//     not motion, and stretching it would change how much combat a player sees — the one thing this
//     setting promised not to do.
//   • **Unit interpolation** (`view/interpolate.ts`). That is the simulation moving, not the
//     interface; a unit that teleported between ticks would be less readable, not more restful.
//   • **The camera.** There is nothing to reduce: `focusOn` is a hard cut and yaw snaps in eight
//     steps (ADR-0010), so "focus base" and "focus last alert" already behave the way a
//     reduced-motion setting would ask them to. Edge scrolling is the one camera behaviour that
//     moves without being asked, and it has had its OWN setting since Phase 1 (`Settings.edgeScroll`)
//     — folding it in here would silently overrule a control the player already set.
//   • **The bomb fuse.** It is drawn as a swept arc rather than a blink "so that how long have I got
//     is readable in a still frame" (`overlays2d.ts`) — already a still-frame cue.
//
// ================================================================================================
// WHO DECIDES: THREE STATES, NOT A BOOLEAN
// ================================================================================================
//
// `prefers-reduced-motion` SEEDS the preference and never owns it. A player who wants motion on a
// machine whose OS asks for less is not an error, and neither is a player who wants less on a
// machine that never asked — a shared login, a borrowed laptop, a browser that reports the default
// because nobody ever opened the accessibility pane. A boolean that the OS overwrote on every load
// could not express either, so the preference has three states and "auto" is a real answer, exactly
// as `ui/onboarding.ts`'s tier row made Auto a real answer rather than a shrug.
//
// The OS is read ONCE per `setMotionPreference` call rather than per frame: `matchMedia` allocates
// a `MediaQueryList`, and `reducedMotion()` is asked once per live effect per frame (ADR-0006). A
// change to the OS setting mid-session is therefore picked up on the next reload or the next time
// the player touches the row — deliberately, rather than by holding a media-query listener open for
// the life of the tab.
//
// The read is defensive in exactly the way `app/settings.ts` is defensive about `localStorage`, and
// for the same persona (P2): `matchMedia` is absent in jsdom and can be blocked or throw in a
// locked-down browser, and a preference read that throws must not stop the game from starting.

/** What the player chose. `auto` defers to the OS; the other two overrule it, in both directions. */
export type MotionPreference = "auto" | "full" | "reduced";

/** The order the settings row offers them in. Data, so a test can walk it rather than list it. */
export const MOTION_PREFERENCES: readonly MotionPreference[] = ["auto", "full", "reduced"];

export function isMotionPreference(value: unknown): value is MotionPreference {
  return value === "auto" || value === "full" || value === "reduced";
}

/** The media query behind "auto". Named so a test can assert the string rather than trust it. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Does this machine ask for less motion?
 *
 * `false` when nothing can answer — no `matchMedia`, a `matchMedia` that throws, no window at all
 * (this module is imported in Node tests and by the perf runner). "Nobody asked" is the honest
 * reading of an absent answer, and it is the safe one: it leaves the game as it has always been.
 */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

let preference: MotionPreference = "auto";
/** The resolved answer. `null` until something asks, so the OS is read at most once per change. */
let resolved: boolean | null = null;

/**
 * Set the preference and resolve it now.
 *
 * Resolution happens HERE rather than on every read, so the hot path is a boolean load. It also
 * publishes the answer to the stylesheet (`<html data-motion="reduced|full">`), because a setting
 * that reached the JavaScript and not the CSS would be half a setting — see `src/a11y.css`.
 */
export function setMotionPreference(next: MotionPreference): void {
  const reduced = next === "auto" ? prefersReducedMotion() : next === "reduced";
  preference = next;
  resolved = reduced;
  publish(reduced);
}

/** What is currently chosen — the player's answer, not the resolved one. */
export function motionPreference(): MotionPreference {
  return preference;
}

/**
 * The one question the view asks: should this frame stand still?
 *
 * Seeded from the OS on first use, so a machine that asks for reduced motion is honoured even
 * before anything in the shell has loaded a setting — the failure mode of a preference that only
 * works once somebody remembers to wire it.
 */
export function reducedMotion(): boolean {
  const known = resolved;
  if (known !== null) return known;
  // First use, and nothing has set a preference: the default is `auto`, so the machine answers.
  // It does not publish an attribute — until a preference has actually been applied, `a11y.css`'s
  // own media query is the honest description of what is going on, and it says the same thing.
  const seeded = prefersReducedMotion();
  resolved = seeded;
  return seeded;
}

/**
 * Publish the resolved answer to the document, for the CSS half of the setting.
 *
 * The RESOLVED answer rather than the preference: a stylesheet cannot resolve "auto" against a
 * player's override, and `a11y.css` is written so that the attribute — once present — is the only
 * thing that decides. Guarded because there is no document in Node, and best-effort because a
 * stylesheet hook is not worth failing a boot over.
 */
function publish(reduced: boolean): void {
  try {
    const root = globalThis.document?.documentElement;
    if (root) root.dataset.motion = reduced ? "reduced" : "full";
  } catch {
    // No document, or a hostile one. The JavaScript half still applies for this session.
  }
}
