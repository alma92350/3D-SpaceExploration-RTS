// The score readout, and what can actually end an Odyssey (P5-T08, ADR-0012 §4 and §5).
//
// **The score is the engine's arithmetic and nothing here adds it up.** `scoreBreakdown` is broken
// out into bank / army / structures rather than collapsed into a total, and upstream's own comment
// says why: "so a HUD can show WHY". It also carries the total, computed from those same three
// buckets one line below them, so `playerScore` and the breakdown can never disagree. This model
// therefore reports `breakdown.total` verbatim. Re-adding the components here would look identical
// today and diverge the first time a weight moves — `BANK_WEIGHT` (0.25) and `COMBAT_BONUS` (1.35)
// are module-private upstream and deliberately not exported, so this file shows three numbers and
// their sum and never a percentage, a weight or a normalised share.
//
// **There is no leader, on purpose.** `scoreLeader` — the rule that picks a winner from these
// numbers, including the "first side in `state.owners` takes an exact tie" defender's edge — is
// module-private, and the score-tiebreak victory it serves is ruled OUT for this project
// (ADR-0002; `docs/planning/PARITY.md` row 112). Re-deriving "who is ahead" above the bridge would
// be inventing a second answer to a question the simulation deliberately does not ask here.
//
// **And there is no galaxy total.** The engine scores a WORLD; a galaxy-wide sum is a number it
// never computes and nothing could check this one against. Per-world lines instead.
//
// **The match clock does not exist in the Odyssey, and drawing one would be worse than nothing.**
// `DEFAULT_MATCH_TIME_LIMIT` is 2400 s, and it is `checkWinCondition`'s — the skirmish path.
// `sim.js` dispatches `state.scenario ? … : state.endless ? checkEndlessWin/Loss : checkWinCondition`,
// every galaxy world is created `endless: true` (`engine/galaxy.js`), and ADR-0002 rules skirmish
// and "its victory/score/clock UI" out of this project entirely. So `clock` is null for every
// Odyssey world — a countdown to an ending that never arrives is a promise the game does not keep.
// It is null because this model asked the state, not because it is hardcoded: the skirmish branch
// is live, and `test/ui/score-panel.test.ts` drives both halves — a skirmish state that really does
// end at its limit, and a galaxy world that is still running long past 2400 s.
//
// The same reasoning governs the two endless checks the row names. In a galaxy `checkEndlessLoss`
// returns before it looks at anything, and `checkEndlessWin` treats a completed player Gate as a
// milestone and an AI one as an ascension — never a win, never a defeat. Those are stated here as
// what they are: the answers to "can this run end that way", both false, with the run's one real
// terminal state (a surrender) named by `relief-panel.ts` next door.

import { DEFAULT_MATCH_TIME_LIMIT, activeState, scoreBreakdown } from "../engine/index.js";

/** One side's score on one world, straight off `scoreBreakdown`. */
export interface ScoreLine {
  readonly owner: string;
  /** Unspent resources, already weighted by the engine. Not the raw stockpile. */
  readonly bank: number;
  /** Combat units at built cost, already carrying the engine's own combat bonus. */
  readonly army: number;
  /** Buildings plus every non-combat unit — the engine's own "else" bucket, at raw cost. */
  readonly structures: number;
  /** `scoreBreakdown.total`, which is `playerScore`'s own number. Never re-added here. */
  readonly total: number;
}

export interface WorldScore {
  readonly planetId: string;
  /** The seat the player is sitting on. The other worlds keep scoring while nobody watches. */
  readonly seat: boolean;
  readonly lines: readonly ScoreLine[];
}

export interface MatchClock {
  readonly limitSeconds: number;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
}

/** How this state ended, in the engine's own words. All null while it is still running. */
export interface RunEnding {
  readonly over: boolean;
  /** `state.winner`. In a galaxy the only value this ever takes is the one a surrender writes. */
  readonly winner: string | null;
  /**
   * `state.winReason` — one of `checkWinCondition`'s three branches, and therefore always null
   * here: the endless paths and `surrenderGalaxy` set no reason, because there is no clock and no
   * score tiebreak to explain away.
   */
  readonly reason: string | null;
  /** `galaxy.surrendered`. The difference between "you gave up" and "you were beaten". */
  readonly bySurrender: boolean;
}

/** Which of `sim.js`'s three terminal checks this world runs, and what that means can happen. */
export interface TerminalRules {
  readonly path: "skirmish" | "endless" | "scenario";
  /** `state.endless`. Every galaxy world is created with it set. */
  readonly endless: boolean;
  /** `state.inGalaxy`, the flag `checkEndlessLoss` returns on. */
  readonly inGalaxy: boolean;
  /** Would losing every Command Center end the run? False in a galaxy — relief comes instead. */
  readonly wipeoutEndsRun: boolean;
  /** Would a completed Antimatter Gate end it? False in a galaxy — it is a milestone (P5-T06). */
  readonly gateEndsRun: boolean;
  /** The deadline the engine would actually consult, or null when it consults none. */
  readonly clock: MatchClock | null;
}

export interface ScorePanelModel {
  readonly seatId: string;
  /** The seat's own lines, in `state.owners` order. */
  readonly lines: readonly ScoreLine[];
  /** Every instantiated world, in the galaxy's roster order. */
  readonly worlds: readonly WorldScore[];
  readonly ending: RunEnding;
  readonly rules: TerminalRules;
}

/**
 * Every side's score on one world.
 *
 * `state.owners` rather than `Object.keys(state.players)`: it is the canonical order the engine
 * itself iterates, and the order its tiebreak depends on.
 */
export function scoreLines(state: State): readonly ScoreLine[] {
  return state.owners.map((owner) => {
    const b = scoreBreakdown(state, owner);
    return {
      owner,
      bank: b.bank ?? 0,
      army: b.army ?? 0,
      structures: b.structures ?? 0,
      total: b.total ?? 0,
    };
  });
}

/**
 * The score screen: what every world is worth, and what could end the run.
 *
 * A screen, not a HUD tile — it walks every instantiated world's units and buildings, so it is a
 * function of a galaxy tick at most, in the shape `GalaxyCache` already established for
 * `jumpPanelModel` and `colonyIncomeModel`.
 */
export function scorePanelModel(galaxy: Galaxy): ScorePanelModel {
  const seat = activeState(galaxy);
  const worlds: WorldScore[] = [];
  for (const planetId of galaxy.worlds) {
    const state = galaxy.planets.get(planetId);
    // The roster names every world in the galaxy; only some of them have been brought up. A
    // dormant one has no state to score and is not a blank row — it is a world nobody has met.
    if (!state) continue;
    worlds.push({ planetId, seat: planetId === galaxy.activeId, lines: scoreLines(state) });
  }

  return {
    seatId: galaxy.activeId,
    lines: scoreLines(seat),
    worlds,
    ending: {
      over: seat.over === true,
      winner: extra(seat).winner ?? null,
      reason: extra(seat).winReason ?? null,
      bySurrender: (galaxy as unknown as { surrendered?: boolean }).surrendered === true,
    },
    rules: terminalRules(seat),
  };
}

/**
 * What can end THIS world, which is `sim.js`'s own dispatch read off the state's flags.
 *
 * This is the one rule in this file that is mirrored rather than asked, because there is no query
 * beside it: the three checks are called from inside the tick and each is a mutator that would
 * *end the match* if consulted speculatively — and `checkWinCondition` on a galaxy world would
 * happily declare a winner the engine never asked it about. So the mirror is validated by
 * consequence instead: the test runs a skirmish state into its limit and a galaxy world past it.
 *
 * Exported for that test, and because it is a fact about a world rather than about the seat: the
 * same three flags decide the answer for a colony the player is not standing on.
 */
export function terminalRules(state: State): TerminalRules {
  const scenario = extra(state).scenario !== undefined && extra(state).scenario !== null;
  const endless = state.endless === true;
  const inGalaxy = extra(state).inGalaxy === true;
  const path = scenario ? "scenario" : endless ? "endless" : "skirmish";

  return {
    path,
    endless,
    inGalaxy,
    // Skirmish: losing your last Command Center is elimination. Endless: `checkEndlessLoss`, which
    // a galaxy world returns out of before it looks. Scenario: the scenario settles its own.
    wipeoutEndsRun: path === "skirmish" || (path === "endless" && !inGalaxy),
    // Only `checkEndlessWin` looks at a wonder's charge at all, and only outside a galaxy.
    gateEndsRun: path === "endless" && !inGalaxy,
    clock: path === "skirmish" ? clockOf(state) : null,
  };
}

function clockOf(state: State): MatchClock {
  // `state.matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT`, exactly as `checkWinCondition` resolves it:
  // the field is null unless a match length was deliberately chosen, so the constant is the
  // fallback rather than a copy stored at creation.
  const limitSeconds = extra(state).matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT;
  const elapsedSeconds = state.time;
  return { limitSeconds, elapsedSeconds, remainingSeconds: Math.max(0, limitSeconds - elapsedSeconds) };
}

/**
 * State fields the vendored declarations do not carry, read the way `src/ui/colony-panel.ts` reads
 * `state.background`: the `.d.ts` files are the vendored engine's surface (ADR-0003) and a panel
 * does not widen them. Read-only, named once so the gap stays visible.
 */
function extra(state: State): {
  winner?: string | null;
  winReason?: string | null;
  inGalaxy?: boolean;
  matchTimeLimit?: number | null;
  scenario?: unknown;
} {
  return state as unknown as {
    winner?: string | null;
    winReason?: string | null;
    inGalaxy?: boolean;
    matchTimeLimit?: number | null;
    scenario?: unknown;
  };
}
