// Settings, and the card that tells a first-time player what to press (P5-T10, ADR-0012 §4).
//
// **The onboarding half exists because five playtest scripts asked for it and none could test it.**
// `docs/playtests/mvp.md` opens with "Have a look around" and "Find your colony ship and put a base
// down", and forbids the facilitator from answering "where do I click" — every question a tester
// asks is recorded as a finding. S6 (the build menu, found unaided) is a Phase 1 gate criterion.
// The interface's whole answer so far has been a paragraph of `<b>` tags in the sidebar.
//
// **Which raises the question this file had to settle: does a card duplicate that hint line?** The
// answer here is no, and it is not a compromise:
//
//   • The hint line is a REFERENCE — twenty-four bindings, always on screen, in one paragraph. A
//     first-time player does not read it (that is the finding the playtests keep producing), and a
//     returning one does not need most of it.
//   • This card is the FIRST SIXTY SECONDS — six things, in the order the playtest tasks fail in,
//     shown once and dismissed forever.
//
// So the card takes the first-run job the hint line has been failing at, and the hint line stays as
// the reference for everything the card leaves out (formations, control groups, the bomb, the power
// grid, Escape). What is NOT tolerable is the state the hint line is in: it is hand-written, nothing
// checks it, and **it is already wrong** — it advertises `WASD` to pan, and `S` is bound to nothing
// at all (`app/game.ts` `applyContinuousPan` reads `arrowdown` and never `s`). Which is exactly why
// every key named below is DATA, checked against `translateKey` by `test/ui/onboarding.test.ts`: a
// control list that is 75% right is worse than a shorter one that is true, and the card names the
// arrow keys for precisely that reason.
//
// **The trap on the other side is a card that cannot be dismissed, or that comes back.** Both are
// worse than no card. Dismissal is therefore permanent (`markOnboardingSeen`), and there is a
// second, independent retirement: the card does not show at all once the player HAS a base, so a
// player whose storage is blocked — the same persona `app/settings.ts` guards for — is not taught
// the controls again every reload of a campaign they are ten hours into.
//
// The settings half is a model, not a store: it returns the whole `Settings` a choice would produce
// and the shell persists it with `saveSettings`. `app/settings.ts` already guards a `localStorage`
// that *throws* rather than one that is merely absent, and re-deriving that guard here would be a
// second, weaker copy of it. One thing the model adds that the current tier picker does not have:
// **Auto is an option.** `main.ts` builds one button per tier and nothing that clears the override,
// so a player who has ever forced a tier cannot get automatic detection back without clearing site
// data.

import { type Settings } from "../app/settings.js";
import { type Tier } from "../view/renderer/port.js";
import { TIERS, TIER_ORDER } from "../view/renderer/tiers.js";
import { FLAG_BUILDING_KIND, type Snapshot } from "../bridge/snapshot.js";

/* =================================================================================================
   ONBOARDING
   ================================================================================================= */

/**
 * A step's completion, where the snapshot can honestly answer it.
 *
 * `null` means "nothing in the snapshot answers this" — the camera moving and the ground being
 * right-clicked leave no trace in a snapshot, and they are not going to be added to one for a
 * tutorial. A renderer must draw `null` as neither done nor undone: an empty checkbox against a
 * step the player has in fact completed is the interface calling them a failure.
 */
export type StepState = boolean | null;

export interface OnboardingStep {
  readonly id: string;
  /** What to do, in one sentence, in the second person. */
  readonly text: string;
  /**
   * The keys this step names, as `KeyboardEvent.key` in lower case.
   *
   * Data rather than prose so it can be CHECKED. `test/ui/onboarding.test.ts` puts every one of
   * these through `translateKey` (or the pan set) and fails by name on a key that does nothing —
   * the failure mode the sidebar hint has been in since Phase 1.
   */
  readonly keys: readonly string[];
  /** Mouse buttons this step names, if any — checked the same way, through `translatePointer`. */
  readonly buttons: readonly ("left" | "right")[];
  readonly done: StepState;
}

export interface OnboardingModel {
  /** False once dismissed, and false once the player has a base — see the header. */
  readonly visible: boolean;
  readonly title: string;
  readonly steps: readonly OnboardingStep[];
  /** The first step not known to be done: what the card leads with. Null when all are done. */
  readonly nextStepId: string | null;
  readonly dismissLabel: string;
  /** Why the card is not showing. Null when it is. Exists so a test can tell the two reasons apart. */
  readonly hiddenReason: "dismissed" | "under-way" | null;
}

export interface OnboardingInput {
  readonly snap: Snapshot;
  /** Whether this player has dismissed the card before — `loadOnboardingSeen()`. */
  readonly seen: boolean;
}

/**
 * The card.
 *
 * Six steps, in the order `docs/playtests/mvp.md` tasks 1–4 and `docs/playtests/galaxy.md` task 1
 * fail in. Not eleven: the point of the card is that it is short enough to be read by someone who
 * has already decided not to read anything.
 */
export function onboardingModel(input: OnboardingInput): OnboardingModel {
  const snap = input.snap;
  const hasBase = ownsBuilding(snap, (type) => type === COMMAND_CENTER);
  const hasOtherBuilding = ownsBuilding(snap, (type) => type !== COMMAND_CENTER);

  const steps: OnboardingStep[] = [
    {
      id: "look",
      // The arrow keys, NOT "WASD": `S` pans nowhere (see the header). Four keys that all work beat
      // a mnemonic where one of them is silently dead.
      text: "Look around: the arrow keys pan, the mouse wheel zooms.",
      keys: ["arrowup", "arrowdown", "arrowleft", "arrowright"],
      buttons: [],
      done: null,
    },
    {
      id: "select",
      text: "Left-click your colony ship to select it. Drag a box to take several units at once.",
      keys: [],
      buttons: ["left"],
      done: snap.selection.length > 0,
    },
    {
      id: "deploy",
      // Z rather than "the Deploy button" alone, because they are the same control: `Z` fires the
      // first button the HUD is showing, and Deploy is first at t=0 (`hud.ts`, `translateKey`).
      text: "With it selected, press Z — or the first button on the bar — to found your base.",
      keys: ["z"],
      buttons: [],
      done: hasBase,
    },
    {
      id: "order",
      text: "Right-click the ground to send whatever you have selected there.",
      keys: [],
      buttons: ["right"],
      done: null,
    },
    {
      id: "build",
      // S6, the Phase 1 gate criterion three of five testers must pass unaided.
      text: "Select a worker and the buildings it can put up appear on the bar.",
      keys: [],
      buttons: ["left"],
      done: hasOtherBuilding,
    },
    {
      id: "map",
      text: "Y opens the starmap — the rest of the galaxy is out there.",
      keys: ["y"],
      buttons: [],
      done: null,
    },
  ];

  const hiddenReason = input.seen ? "dismissed" : hasBase ? "under-way" : null;
  return {
    visible: hiddenReason === null,
    title: "Getting started",
    steps,
    nextStepId: steps.find((s) => s.done !== true)?.id ?? null,
    dismissLabel: "Got it",
    hiddenReason,
  };
}

/** The engine's own type id for a Command Center — `hudModel` reads the same string for `hasBase`. */
const COMMAND_CENTER = "command";

/** Does the player own a building whose type passes `match`? Read from the snapshot, never engine state. */
function ownsBuilding(snap: Snapshot, match: (type: string) => boolean): boolean {
  const e = snap.entities;
  for (let i = 0; i < e.count; i++) {
    if (e.owner[i] !== 0) continue;
    if ((e.flags[i]! & FLAG_BUILDING_KIND) === 0) continue;
    if (match(snap.typeNames[e.typeIndex[i]!]!)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------------------------
   Dismissal, which has to outlive the tab.

   Its own key rather than a field on `Settings`, and the reason is a distinction rather than a
   convenience: seen-ness is PROGRESS, written once by the game, while everything in `Settings` is a
   preference the player chose. A player who clears their settings to escape a graphics problem
   should not be taught the controls again as a side effect.

   The write is best-effort in exactly the way `saveSettings` is — a browser that refuses storage
   costs the player a card they have already read, and the `hasBase` retirement above means a
   campaign in progress never shows it anyway.
   ------------------------------------------------------------------------------------------- */

export const ONBOARDING_KEY = "odyssey3d.onboarding.v1";

export function loadOnboardingSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(ONBOARDING_KEY) === "seen";
  } catch {
    return false;
  }
}

export function markOnboardingSeen(): void {
  try {
    globalThis.localStorage?.setItem(ONBOARDING_KEY, "seen");
  } catch {
    // Storage is blocked. The dismissal still holds for this session; the card is retired by the
    // player having a base long before a reload could bring it back.
  }
}

/* =================================================================================================
   SETTINGS

   A model, not a store. Every option carries the WHOLE `Settings` it would produce, so the shell's
   job is `saveSettings(option.settings)` and there is no patch-merging anywhere for a bug to live
   in. Data rather than a callback, for the reason `HudCommand` gives: a closure cannot be asserted
   on without a DOM.
   ================================================================================================= */

export interface SettingOption {
  readonly id: string;
  readonly label: string;
  /** What choosing it means, when the label alone does not say. */
  readonly detail: string;
  readonly active: boolean;
  /** The settings object to persist and apply. Complete, never a patch. */
  readonly settings: Settings;
}

export interface SettingRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly options: readonly SettingOption[];
}

export interface SettingsModel {
  readonly rows: readonly SettingRow[];
}

export interface SettingsInput {
  readonly settings: Settings;
  /** The tier actually running, which is what makes "Auto" a readable choice rather than a shrug. */
  readonly currentTier: Tier;
}

export function settingsModel(input: SettingsInput): SettingsModel {
  const s = input.settings;
  return {
    rows: [
      {
        id: "tier",
        label: "Graphics tier",
        // **The row says what is CHOSEN and what is RUNNING, because they are different things.**
        // Measured correction can drop a tier mid-session and never raises one
        // (`view/renderer/tiers.ts`), and `Game.setTier(tier, manual=false)` deliberately does not
        // write that drop to settings. So a player can have forced T2 and be looking at T0. A row
        // that highlighted the running tier would tell them they chose T0; one that showed only the
        // choice would deny that the drop happened. It needs both.
        detail: `Detection may drop a tier if frames are slow; it never raises one. Running now: ${input.currentTier} (${TIERS[input.currentTier].label}).`,
        options: [
          {
            id: "auto",
            label: "Auto",
            detail: "let the machine decide",
            active: s.tierOverride === null,
            settings: { ...s, tierOverride: null },
          },
          ...TIER_ORDER.map((tier): SettingOption => ({
            id: tier,
            label: tier,
            detail: TIERS[tier].label,
            active: s.tierOverride === tier,
            settings: { ...s, tierOverride: tier },
          })),
        ],
      },
      {
        id: "edgeScroll",
        label: "Edge scrolling",
        detail: "Pan when the pointer rests against the edge of the window.",
        options: [
          {
            id: "on",
            label: "On",
            detail: "",
            active: s.edgeScroll,
            settings: { ...s, edgeScroll: true },
          },
          {
            id: "off",
            label: "Off",
            detail: "keyboard and minimap only",
            active: !s.edgeScroll,
            settings: { ...s, edgeScroll: false },
          },
        ],
      },
      {
        id: "motion",
        label: "Motion",
        // Three options rather than two, for the reason the tier row above gives for Auto:
        // `prefers-reduced-motion` SEEDS this and never owns it, so the player can disagree with
        // their machine in either direction. What each choice does to a frame is `view/motion.ts`'s
        // header — every combat cue keeps its fact and loses its animation, and none is deleted.
        detail: "Holds the moving cues still — tracers, death marks, impact marks — without removing "
          + "any of them.",
        options: [
          {
            id: "auto",
            label: "Auto",
            detail: "follow this machine's own accessibility setting",
            active: s.motion === "auto",
            settings: { ...s, motion: "auto" },
          },
          {
            id: "full",
            label: "Full",
            detail: "animate the combat cues",
            active: s.motion === "full",
            settings: { ...s, motion: "full" },
          },
          {
            id: "reduced",
            label: "Reduced",
            detail: "the same cues, held still",
            active: s.motion === "reduced",
            settings: { ...s, motion: "reduced" },
          },
        ],
      },
    ],
  };
}
