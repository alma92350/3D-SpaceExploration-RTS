// The new-game screen: faction and difficulty (PARITY row 104).
//
// `WorldOptions` has accepted `difficulty` and `playerFaction` since Phase 1 and `main.ts` passes
// neither, so **every session this client has ever run has been Medium / Frontier** — not by anyone's
// decision, but because two optional fields were never filled in. There is no new-game screen at
// all. This is the model one would be built from.
//
// ================================================================================================
// A DIFFICULTY IS A NAME FOR A TUNING TABLE, AND THE ENGINE OWNS THE TABLE
// ================================================================================================
//
// `DIFFICULTY_OPTIONS` is three entries carrying thirteen tuning fields between them — `aiApm`,
// `workerTargetMult`, `graceMult`, `grievanceMult`, `researchPaceMult`, `forgiveness`, `counterEvery`,
// `adaptivity`, `strategicCeiling`, `marketAccess`, `economicEdge`, `rusherGraduates`, `aiMicro` —
// and upstream's own header calls it "the ONE list of valid difficulty keys". Nothing here decides
// what any of them means. The rows below are `DIFFICULTY_OPTIONS` itself, mapped: an entry added or
// a field re-tuned upstream shows up without this file being touched, which is the same contract
// `ui/milestones-panel.ts` has with `MILESTONE_IDS`.
//
// **The trap is Medium, and it is a trap in the shape of an empty column.** Medium carries none of
// the tuning fields at all — upstream says so explicitly, "byte-identical to unset ... the baseline
// every dial is relative to". So a picker that printed the same dozen rows for each difficulty would
// print blanks down the middle column, and the obvious repair — fill an absent field with 1 — is
// **wrong**: every dial is read at its own use site with its own default, and `counterEvery`'s is
// `COUNTER_EVERY` (3), not 1. Easy's explicit `counterEvery: 0` and Medium's *absent* one are three
// units apart, and a model that guessed would have said they were the same. So `DialLine.present`
// says whether this difficulty names the dial, and `value` is null exactly when it does not.
//
// **The pick applies to the seat.** `buildPlanetState` gives `galaxy.settings`' difficulty to the
// world whose id is `galaxy.activeId` and resolves every other world through `neighbourAiProfile`,
// which draws its own entry out of this same list. Picking Hard is not "the galaxy is hard"; it is
// "the neighbour on your starting world is". That is the engine's rule, it is reported rather than
// re-derived, and `test/ui/new-game.test.ts` proves it by building two galaxies from one seed at two
// difficulties and holding every other world's dials against each other.
//
// ================================================================================================
// A FACTION IS A BUNDLE OF MULTIPLIERS, AND `factionTrait` IS THE ONLY THING THAT MAY RESOLVE ONE
// ================================================================================================
//
// The engine reads a faction's edge through `factionTrait(state, owner, key)`, folded into
// `map.js`'s `sideMod`, so a trait is not a number in a table — it is whatever that function answers.
// This file therefore ASKS it, with a one-field state (`{ players: { player: { faction } } }`), which
// is a use upstream's own comment provides for ("no players on the state (map-less test stubs)").
// Reading `FACTIONS[id].traits[key]` directly would agree today and would stop agreeing the moment
// the resolution grows a rule — a stacking cap, a per-key floor — which is exactly ADR-0012 §5.
//
// **There is deliberately no "is this good" flag.** `factionTrait` answers a bare multiplier with no
// polarity, and the polarity is not a property of the faction: Miners' `buildTimeMult: 0.90` is an
// improvement (things take less time) while Syndicate's `gatherMult: 0.92` is a penalty. Which way a
// dial cuts is a fact about the engine's USE SITE, so a good/bad table in `ui/` would be a second
// opinion about `sideMod`'s consumers that nothing would keep in sync. What is reported instead is
// the engine's own number, the same number as a percentage, and the engine's own `blurb` — which is
// upstream's own sentence about what the faction is for, and is where the polarity actually lives.
//
// ================================================================================================
// THE ENGINE ACCEPTS BOTH FIELDS WITHOUT VALIDATING EITHER, AND FAILS SILENTLY IN TWO DIFFERENT WAYS
// ================================================================================================
//
// This is the row's `chargingWonderOf` — the distinction the engine does not draw, added here
// because a screen is the last place that can:
//
//   • **An unrecognised difficulty is played as Medium and nothing says so.** `createGalaxy` stores
//     the string verbatim; `difficultyFor` resolves it with `|| DIFFICULTY_OPTIONS.find(o => o.mult
//     === "medium")`. Upstream's own header records this as a bug it already fixed once ("which used
//     to let a mismatched difficulty silently downgrade to Medium instead of erroring") — and the
//     fix was to make this array the single list, not to make the lookup refuse.
//   • **An unrecognised faction is stored and confers nothing.** `createGameState` writes
//     `faction: opts.playerFaction || "neutral"` unchecked, and `factionTrait` then answers 1 for
//     every key. The save says "syndicat"; the player has no bonuses and no message.
//
// Both were confirmed by running them, not by reading them: a galaxy built at `"bogus"` difficulty
// is byte-for-byte a Medium galaxy (no `hardEdge` on the AI), and one built at `"bogus"` faction
// answers 1 to every `factionTrait`. So `newGameModel` sanitises before anything reaches
// `createGalaxy`, and `problems` names what it rejected and what the engine would have done instead.
//
// ================================================================================================
// AND IT CANNOT TAKE A GALAXY
// ================================================================================================
//
// A new-game screen decides what a galaxy will be built FROM, so there is no galaxy to read and no
// bridge to ask. Every other panel model in this directory takes a `Galaxy`; this one takes the
// untrusted remains of a previous choice and returns the `WorldOptions` the shell should construct
// with. It persists nothing: `app/settings.ts` is the one module that touches storage (it already
// guards a `localStorage` that throws outright, which is persona P2's browser), and a model that
// reached around it would be a second store with a second set of failure modes.

import { DIFFICULTY_OPTIONS, FACTIONS, PLAYABLE_FACTIONS, factionTrait } from "../engine/index.js";
import type { WorldOptions } from "../bridge/world.js";

/**
 * What the engine picks when a caller passes nothing — and therefore what every session of this
 * client has run at since Phase 1.
 *
 * These are `createGalaxy`'s own parameter defaults, which are not exported and cannot be imported.
 * They are pinned instead: `test/ui/new-game.test.ts` builds a galaxy with neither field set and
 * asserts `galaxy.settings` matches these two strings, so a default that moves upstream goes red
 * here rather than quietly changing what "no choice" means.
 */
export const ENGINE_DEFAULT_DIFFICULTY = "medium";
export const ENGINE_DEFAULT_FACTION = "frontier";

/** The two fields `WorldOptions` has been accepting and never receiving. */
export interface NewGameChoice {
  /** A `DIFFICULTY_OPTIONS` entry's `mult` — the engine's own key, not its `label`. */
  readonly difficulty: string;
  /** A `PLAYABLE_FACTIONS` id. `neutral` is a real faction and is NOT one of them — see below. */
  readonly playerFaction: string;
}

export interface TraitLine {
  /** The key `sideMod` looks up — `speedMult`, `gatherMult`, `buildTimeMult`, … */
  readonly key: string;
  readonly label: string;
  /** `factionTrait`'s own answer for this faction and this key. Never `FACTIONS[id].traits[key]`. */
  readonly multiplier: number;
  /** The same number as a signed percentage: `1.08` → `"+8%"`, `0.9` → `"-10%"`. Arithmetic, not judgement. */
  readonly percent: string;
  /** The faction leaves this dial alone — `factionTrait` answered exactly 1. */
  readonly stock: boolean;
}

export interface FactionOption {
  readonly id: string;
  /** `FACTIONS[id].name` — "Frontier Coalition". */
  readonly name: string;
  /** `FACTIONS[id].short` — what fits on a button. */
  readonly short: string;
  /** `FACTIONS[id].blurb` — upstream's own sentence, and the only place a trait's polarity is stated. */
  readonly blurb: string;
  /**
   * One line per trait key ANY playable faction touches, so three factions read as three comparable
   * columns. A faction that does not touch a key still gets its line, with `stock: true` — the
   * difference between "no bonus here" and "this dial does not exist" is a difference a picker needs.
   */
  readonly traits: readonly TraitLine[];
  readonly selected: boolean;
  /** This is what a client that passes nothing gets — the status quo, marked as such. */
  readonly preselected: boolean;
}

export interface DialLine {
  readonly key: string;
  readonly label: string;
  /**
   * Whether THIS difficulty names the dial at all.
   *
   * False is not zero and is not one. An absent field composes as whatever its own use site defaults
   * to — `?? COUNTER_EVERY` (3) for `counterEvery`, `?? 1` for `adaptivity`, `|| 1` for the
   * multipliers, falsy for the flags — and the client may not guess which.
   */
  readonly present: boolean;
  /** The engine's value, verbatim. Null exactly when `present` is false. */
  readonly value: string | number | boolean | null;
}

export interface DifficultyOption {
  /** The entry's `mult` — the string that goes into `WorldOptions.difficulty`. */
  readonly key: string;
  /** The entry's `label` — "Easy", "Medium", "Hard". */
  readonly label: string;
  /** The entry's `note` — "a fair fight". Upstream wrote it for its own menu. */
  readonly note: string;
  /** Every tuning field any difficulty carries, in the engine's own first-seen order. */
  readonly dials: readonly DialLine[];
  /** How many of those this difficulty actually names. Medium's is zero, on purpose. */
  readonly dialsSet: number;
  readonly selected: boolean;
  readonly preselected: boolean;
}

export interface NewGameModel {
  /** `PLAYABLE_FACTIONS`, mapped, in the engine's own setup-screen order. Never `Object.keys(FACTIONS)`. */
  readonly factions: readonly FactionOption[];
  /** `DIFFICULTY_OPTIONS`, mapped, in the engine's own order — which is also easiest-first. */
  readonly difficulties: readonly DifficultyOption[];
  /** The sanitised choice: what the shell should hand to `WorldOptions`, and what is marked selected. */
  readonly choice: NewGameChoice;
  /**
   * What was rejected and what the engine would have done with it, one sentence each. Empty when the
   * request was clean or absent.
   */
  readonly problems: readonly string[];
  /** The choice is the pair every session of this client has silently run at. */
  readonly isDefault: boolean;
  /** What the difficulty pick reaches, in one line. See this file's header — it is the seat, not the galaxy. */
  readonly difficultyScope: string;
}

export interface NewGameInput {
  /**
   * Whatever the shell has of a previous choice — a parsed settings blob, a query string, nothing.
   * Fully untrusted, in `loadSettings`' sense: validated, never believed.
   */
  readonly requested: unknown;
}

export const DIFFICULTY_SCOPE =
  "This sets the opponent on your starting world. Every other world in the galaxy draws its own.";

/**
 * The whole screen, from an untrusted request.
 *
 * Pure, and it takes no galaxy — there is not one yet. Running it twice on the same input produces
 * two equal models and touches nothing.
 */
export function newGameModel(input: NewGameInput): NewGameModel {
  const requested = asRecord(input.requested);
  const problems: string[] = [];

  const difficulty = resolveDifficulty(requested?.difficulty, problems);
  const playerFaction = resolveFaction(requested?.playerFaction, problems);

  const traitKeys = traitKeysOf();
  const dialKeys = dialKeysOf();

  return {
    factions: PLAYABLE_FACTIONS.map((id) => factionOption(id, traitKeys, playerFaction)),
    difficulties: DIFFICULTY_OPTIONS
      .filter((o) => typeof o.mult === "string")
      .map((o) => difficultyOption(o, dialKeys, difficulty)),
    choice: { difficulty, playerFaction },
    problems,
    isDefault: difficulty === ENGINE_DEFAULT_DIFFICULTY && playerFaction === ENGINE_DEFAULT_FACTION,
    difficultyScope: DIFFICULTY_SCOPE,
  };
}

/**
 * The choice, as the two fields `WorldBridge` has been ignoring.
 *
 * `base` carries whatever the shell had already decided — today `main.ts` passes a fixed seed and
 * `MVP_WORLD`, which is ADR-0010 §2's ruling and not this screen's to overturn. Spread first so the
 * two fields this row owns are the two fields it sets.
 */
export function worldOptionsFor(choice: NewGameChoice, base: WorldOptions = {}): WorldOptions {
  return { ...base, difficulty: choice.difficulty, playerFaction: choice.playerFaction };
}

/* =================================================================================================
   RESOLUTION — the two silent failures, made loud
   ================================================================================================= */

function resolveDifficulty(raw: unknown, problems: string[]): string {
  if (raw === undefined || raw === null) return ENGINE_DEFAULT_DIFFICULTY;
  const found = typeof raw === "string" && DIFFICULTY_OPTIONS.some((o) => o.mult === raw);
  if (found) return raw as string;
  problems.push(
    `"${describe(raw)}" is not a difficulty the engine knows. It would have been played as `
    + `${labelOf(ENGINE_DEFAULT_DIFFICULTY)} without saying so, so ${labelOf(ENGINE_DEFAULT_DIFFICULTY)} `
    + `is what is selected.`,
  );
  return ENGINE_DEFAULT_DIFFICULTY;
}

function resolveFaction(raw: unknown, problems: string[]): string {
  if (raw === undefined || raw === null) return ENGINE_DEFAULT_FACTION;
  // `PLAYABLE_FACTIONS` and not `FACTIONS`: `neutral` is a real, engine-accepted faction with an
  // empty trait bag, and upstream's own comment says it is "internal only". Offering it would be
  // offering "no bonuses" as a fourth choice the setup screen was never meant to have.
  if (typeof raw === "string" && PLAYABLE_FACTIONS.includes(raw)) return raw;
  problems.push(
    `"${describe(raw)}" is not a playable faction. The engine would have accepted it and granted no `
    + `bonuses at all, so ${nameOf(ENGINE_DEFAULT_FACTION)} is what is selected.`,
  );
  return ENGINE_DEFAULT_FACTION;
}

/* =================================================================================================
   THE ROWS
   ================================================================================================= */

function factionOption(id: string, traitKeys: readonly string[], selected: string): FactionOption {
  const entry = FACTIONS[id];
  return {
    id,
    name: str(entry?.name) ?? id,
    short: str(entry?.short) ?? str(entry?.name) ?? id,
    blurb: str(entry?.blurb) ?? "",
    traits: traitKeys.map((key) => {
      const multiplier = traitOf(id, key);
      return { key, label: traitLabel(key), multiplier, percent: percent(multiplier), stock: multiplier === 1 };
    }),
    selected: id === selected,
    preselected: id === ENGINE_DEFAULT_FACTION,
  };
}

function difficultyOption(
  entry: Readonly<Record<string, unknown>>, dialKeys: readonly string[], selected: string,
): DifficultyOption {
  const key = entry.mult as string;
  const dials = dialKeys.map((k): DialLine => {
    // `in` rather than `!== undefined`: a dial explicitly set to `false` or `0` is SET, and
    // `counterEvery: 0` on Easy is the one where the difference is three units of behaviour.
    const present = k in entry;
    const value = present ? entry[k] : undefined;
    return {
      key: k,
      label: dialLabel(k),
      present,
      value: present && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        ? value
        : null,
    };
  });
  return {
    key,
    label: str(entry.label) ?? key,
    note: str(entry.note) ?? "",
    dials,
    dialsSet: dials.filter((d) => d.present).length,
    selected: key === selected,
    preselected: key === ENGINE_DEFAULT_DIFFICULTY,
  };
}

/* =================================================================================================
   ASKING THE ENGINE
   ================================================================================================= */

/**
 * One faction's multiplier for one key, resolved by the engine.
 *
 * The state is a stub with exactly the one field `factionTrait` reads, because at new-game time
 * there is no state and no galaxy — see the header. Anything but a finite number comes back as 1,
 * which is `factionTrait`'s own documented answer for a key a faction does not carry.
 */
function traitOf(factionId: string, key: string): number {
  const stub = { players: { player: { faction: factionId } } } as unknown as State;
  const v = factionTrait(stub, "player", key);
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/**
 * Every trait key any playable faction touches, in the engine's own order.
 *
 * Read out of `FACTIONS[id].traits` because that is the only enumeration of them — `factionTrait`
 * answers for a key, it cannot list them — and then every VALUE is resolved back through
 * `factionTrait`. A key added upstream becomes a row here with no edit.
 */
function traitKeysOf(): string[] {
  const keys: string[] = [];
  for (const id of PLAYABLE_FACTIONS) {
    const traits = FACTIONS[id]?.traits;
    if (typeof traits !== "object" || traits === null) continue;
    for (const key of Object.keys(traits)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Every tuning field any difficulty carries, in the engine's own first-seen order.
 *
 * `label`, `mult` and `note` are the entry's own presentation — the button's text, its key, and the
 * sentence under it — and are shown as those rather than as dials.
 */
const PRESENTATION: readonly string[] = ["label", "mult", "note"];

function dialKeysOf(): string[] {
  const keys: string[] = [];
  for (const entry of DIFFICULTY_OPTIONS) {
    for (const key of Object.keys(entry)) {
      if (PRESENTATION.includes(key) || keys.includes(key)) continue;
      keys.push(key);
    }
  }
  return keys;
}

/* =================================================================================================
   WORDS

   `milestoneLabel`'s rule, twice over: a name for every key including ones this file has never heard
   of, so a dial added upstream appears with its own key for a name rather than as a blank row.
   ================================================================================================= */

const TRAIT_LABELS: Readonly<Record<string, string>> = {
  speedMult: "Movement speed",
  sightMult: "Vision range",
  gatherMult: "Resource yield",
  buildTimeMult: "Build and train time",
  damageDealtMult: "Damage dealt",
};

const DIAL_LABELS: Readonly<Record<string, string>> = {
  aiApm: "Opponent actions per minute",
  aiMicro: "Opponent micro-manages its army",
  workerTargetMult: "Opponent worker target",
  graceMult: "Opponent grace before war",
  grievanceMult: "Opponent grievance build-up",
  researchPaceMult: "Opponent research pace",
  forgiveness: "Opponent forgiveness",
  counterEvery: "Opponent counter-picks every Nth unit",
  strategicCeiling: "Opponent stops below the Strategic tier",
  adaptivity: "Opponent adapts to your army",
  marketAccess: "Opponent trades on the market",
  economicEdge: "Opponent economic edge",
  rusherGraduates: "Opponent graduates to deep industry",
};

export function traitLabel(key: string): string {
  return TRAIT_LABELS[key] ?? key;
}

export function dialLabel(key: string): string {
  return DIAL_LABELS[key] ?? key;
}

/** A faction's engine name, for a message about one that is not being used. */
function nameOf(id: string): string {
  return str(FACTIONS[id]?.name) ?? id;
}

/** A difficulty's engine label, for the same. */
function labelOf(key: string): string {
  return str(DIFFICULTY_OPTIONS.find((o) => o.mult === key)?.label) ?? key;
}

/**
 * `1.08` → `"+8%"`, `0.9` → `"-10%"`, `1` → `"±0%"`.
 *
 * One decimal place, rounded — `(1.08 - 1) * 100` is `8.000000000000007` in binary floating point,
 * and a picker that printed that would be reporting the IEEE representation rather than the trait.
 */
function percent(multiplier: number): string {
  const delta = Math.round((multiplier - 1) * 1000) / 10;
  if (delta === 0) return "±0%";
  return `${delta > 0 ? "+" : "-"}${Math.abs(delta)}%`;
}

/** A rejected value, short enough for one line and never the whole object. */
function describe(raw: unknown): string {
  if (typeof raw === "string") return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
  return typeof raw;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

// A note on the other half of "reachable" (PARITY §8's first condition):
//
// A model is not a screen. Row 104 needs the shell to show these two lists before a `WorldBridge`
// exists, hold the pick, and pass `worldOptionsFor(choice, { seed, worldId: MVP_WORLD })` into the
// `Game` constructor's last argument — the position `main.ts` currently fills with a two-field object
// literal. Nothing here reads or writes storage; if the pick is to survive a reload it belongs in
// `app/settings.ts`, which already guards a `localStorage` that throws.
