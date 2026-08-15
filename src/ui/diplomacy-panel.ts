// The neighbour's opinion of you — stances, tribute, gifts and favours (P5-T04, ADR-0012 §4 and §5).
//
// **No threshold is invented in this file.** The −1..1 stance is banded by the engine's own
// `stanceLabel`, the war line is `PEACE_THRESHOLD`, and the offensive ramp is `hostility`. P4-T03
// drew the starmap's stance bar with no bands at all precisely because that banding stopped at the
// engine, and a second opinion above the bridge is the defect ADR-0012 §5 exists to prevent. It
// crosses now, so `bands` below is *derived from `stanceLabel` itself* rather than typed in — see
// `stanceBands`.
//
// Four things a panel over this API gets wrong unless it is told not to, one per lever:
//
// **1. A favour has a deadline, and a deadline nobody can see is indistinguishable from an ask that
// never happened.** `updateDiplomacy` withdraws an unfulfilled request the first tick at which
// `state.time >= request.until` — silently, with no event, and the next one is not rolled until the
// following `FAVOR_INTERVAL` bucket. So `secondsLeft` is the whole point of the favour half of this
// model, and it is the engine's own subtraction rather than a timer this file starts.
//
// **2. `tributeCost` escalates.** Appeasement is deliberately a stopgap: each tribute costs 1.55×
// the last, so a panel showing `TRIBUTE_BASE_COST` would be right for the first payment and wrong
// for every one after it. `TRIBUTE_BASE_COST` is still carried, but as what the *first* one cost —
// the anchor the escalation is read against — never as the price of the next.
//
// **3. "At peace" is not one state.** `GRACE_TIME` floors the drift target at cordial for the
// opening seven minutes, a tribute floors it at the truce line for `APPEASE_TIME`, and a pacified
// world is floored there for good. All three read as "at peace" and only the last one survives
// minute eight, so `peaceRestsOn` names which floor is actually holding — with the clock for the
// two that run out. (`GRACE_TIME` is the STOCK window; a world's own is scaled by its temperament
// and that scaling does not cross the façade. See `graceTime` below, which says so in the model
// rather than only here.)
//
// **4. `hostility` answers 1 for a state with no diplomacy at all.** That is a SKIRMISH answer
// meaning "the AI's offense ramp is not gated here", not a reading of anybody's stance, and
// forwarding it would paint a world with no neighbour as maximally hostile. Hence `known`.
//
// Like `market-panel.ts` this reads engine `State` rather than the snapshot: a stance is read when
// a panel is open, not twenty times a second, and none of it belongs in a fixed-width snapshot.
// Nothing here mutates — `offerTribute`, `offerGift` and `fulfillRequest` all move credits or
// stock, so they belong on the far side of an intent, exactly as `trade` does.

import {
  APPEASE_TIME, FAVOR_GOODWILL, FAVOR_INTERVAL, FAVOR_WINDOW, GOODWILL_CAP, GRACE_TIME,
  PEACE_THRESHOLD, TRIBUTE_BASE_COST,
  atPeace, hostility, provoked, stanceLabel, tributeCost, unitPrice,
} from "../engine/index.js";

/**
 * The neighbour's stance record — `createDiplomacy`'s own object, as this file reads it.
 *
 * Narrowed here rather than declared on the shared `State`, which is the treatment
 * `src/ui/colony-panel.ts` gives `state.background` and for the same reason: declaring it in
 * `types/` would open every field of a mutable sim record to every consumer of `State` for the sake
 * of one panel. Every field is read-only from here — the three levers that write them are the
 * engine's own and are called through an intent.
 */
interface DiplomacyRecord {
  stance: number;
  /** How mined-out the world is, 0..1 — recomputed each tick. The thing the drift target follows. */
  depletion: number;
  /** Tributes already paid. `tributeCost`'s only input. */
  tributes: number;
  goodwill: number;
  /** Sim time of the last ship of theirs you destroyed, or null. Read through `provoked`. */
  provokedAt: number | null;
  /** Sim time the paid truce's target floor decays at. Absent until a tribute is paid. */
  appeaseUntil?: number;
  /** Set by `checkDomination` on a world whose neighbour capital you razed. Never cleared. */
  pacified?: boolean;
  request?: FavorRequest | null;
}

interface FavorRequest {
  com: string;
  qty: number;
  /** Sim time the ask is withdrawn at, unfulfilled. */
  until: number;
  reward: number;
}

const recordOf = (state: State): DiplomacyRecord | null =>
  (state as unknown as { diplomacy?: DiplomacyRecord }).diplomacy ?? null;

/** One of `stanceLabel`'s bands, and where the engine puts its edges. */
export interface StanceBand {
  /** The engine's own word for it. */
  readonly label: string;
  /** Inclusive lower edge. */
  readonly from: number;
  /** Exclusive upper edge — the next band's `from`. */
  readonly to: number;
}

export interface FavorAsk {
  readonly com: string;
  /** Exactly what must be handed over. `fulfillRequest` is all-or-nothing: there is no part credit. */
  readonly qty: number;
  /** What the world's own stockpile holds, floored as the engine floors it. */
  readonly held: number;
  /** How much more is needed. Zero when the ask can be covered. */
  readonly shortfall: number;
  /** `fulfillRequest`'s own preconditions, all of them: stock in full, and the window still open. */
  readonly canFulfill: boolean;
  /** Universal credits it pays — the engine's own number, at a premium over the local sell rate. */
  readonly reward: number;
  /** `FAVOR_GOODWILL`, the stance-pool bump it pays on top of the credits. */
  readonly goodwill: number;
  /**
   * Sim seconds before the ask is withdrawn.
   *
   * Zero is a real reading, not a rounding: `updateDiplomacy` compares `state.time >= until` at the
   * *top* of a tick, so an ask whose clock has run out still exists until the next one runs. It
   * cannot be fulfilled in that gap — `fulfillRequest` tests the same expiry — which is why
   * `canFulfill` goes false here rather than one tick later.
   */
  readonly secondsLeft: number;
  /** …as a fraction of `FAVOR_WINDOW`, 0..1, for a bar. */
  readonly fraction: number;
  /** Sim time it lapses at, for a caller that would rather show a deadline than a countdown. */
  readonly expiresAt: number;
}

/**
 * Which floor is holding the peace right now, in the order `updateDiplomacy` lets them override
 * each other.
 *
 * `"stance"` is the only one that is not a floor at all: the drift target itself is above the war
 * line, which is the one kind of peace that does not have a clock on it.
 *
 * `"grace"` carries `graceTime`'s caveat with it: it means the STOCK opening window is still open,
 * which is this world's own window only where the temperament multipliers compose to ×1.
 */
export type PeaceFooting = "unknown" | "war" | "pacified" | "grace" | "truce" | "stance";

export interface DiplomacyModel {
  readonly planetId: string;
  /**
   * This world has a neighbour with a stance at all.
   *
   * False for a roster world the galaxy has never instantiated, and for any state without
   * `state.diplomacy` — on which the engine's `hostility` answers 1 for a reason that has nothing
   * to do with anybody's opinion of you (see the header). Every reading below is then zeroed; the
   * constants still stand, because they are constants.
   */
  readonly known: boolean;
  /** −1 (hostile) to +1 (allied). */
  readonly stance: number;
  /** `stanceLabel(stance)` — the engine's own word, never this file's. */
  readonly label: string;
  /** Every band and its edges, found by asking `stanceLabel`. What lets a stance bar be banded. */
  readonly bands: readonly StanceBand[];
  /** `atPeace` — the neighbour is holding its fire. */
  readonly atPeace: boolean;
  /** `PEACE_THRESHOLD`: at or below this the neighbour is at war. */
  readonly peaceThreshold: number;
  /** How much stance is left before the war line. Negative once it is crossed. */
  readonly marginToWar: number;
  /**
   * `hostility` — the offensive intensity the AI's own ramp reads, 0..1. Exactly 0 while at peace,
   * so a rising number here is a war getting worse rather than a war starting.
   */
  readonly hostility: number;
  /** `provoked` — you have destroyed their ships, or you are charging a Gate. */
  readonly provoked: boolean;
  /** How mined-out this world is, 0..1. The pressure the stance drifts under. */
  readonly depletion: number;
  readonly peaceRestsOn: PeaceFooting;
  /**
   * `GRACE_TIME` — the STOCK opening window, in sim seconds.
   *
   * This world's own is `GRACE_TIME × graceMult`, composed from its archetype, the match's strategy
   * and its difficulty and bounded at `MIN_GRACE_FRAC`; neither the multiplier nor the bound crosses
   * the façade, so this is the stock window rather than a per-world promise. It is exact for the
   * seat under this client's own settings (a stock archetype on `medium` with no strategy override
   * composes to ×1), and a background world drawn as a Warlord leaves its grace much sooner.
   */
  readonly graceTime: number;
  /** Inside the stock opening window. */
  readonly inGrace: boolean;
  /** Sim seconds of it left, zero once it has closed. */
  readonly graceEndsIn: number;
  /** Tributes already paid here. What `tributeCost` escalates on. */
  readonly tributes: number;
  /**
   * What the NEXT tribute costs — `tributeCost`, asked of the engine.
   *
   * Never `TRIBUTE_BASE_COST`: the price grows geometrically, so the constant is right once and
   * wrong for the rest of the match.
   */
  readonly tributeCost: number;
  /** `TRIBUTE_BASE_COST` — what the FIRST one cost, so the escalation has an anchor. */
  readonly tributeBaseCost: number;
  /** `tributeCost / TRIBUTE_BASE_COST`: the escalation itself, in one number. 1 before any is paid. */
  readonly tributeEscalation: number;
  /** Galaxy credits — tribute spends these, not the local economy. */
  readonly credits: number;
  readonly canAffordTribute: boolean;
  /** `APPEASE_TIME` — how long one tribute holds their fire. */
  readonly appeaseTime: number;
  /** A paid truce is still standing. */
  readonly underTruce: boolean;
  /** Sim seconds left on it, zero when there is none. */
  readonly truceEndsIn: number;
  /** The decaying gift pool. The only lever that can push a stance past Cordial into Allied. */
  readonly goodwill: number;
  /** `GOODWILL_CAP` — where a gifting spree stops paying. */
  readonly goodwillCap: number;
  readonly atGoodwillCap: boolean;
  /** The standing favour, or null when the neighbour is not asking for anything. */
  readonly favor: FavorAsk | null;
  /** `FAVOR_INTERVAL` — how often a fresh ask is rolled for. Not every roll produces one. */
  readonly favorInterval: number;
  /** `FAVOR_WINDOW` — the whole window an ask ever has. */
  readonly favorWindow: number;
  /** `FAVOR_GOODWILL` — what fulfilling one pays into the gift pool. */
  readonly favorGoodwill: number;
}

/**
 * What one world's neighbour thinks of you, and what can be done about it.
 *
 * Addressed by world id rather than by state, like `colonyPolicyModel`: the stance of a world you
 * are *not* standing on is exactly as real, and a roster world the galaxy has never brought up is
 * answered (`known: false`) rather than thrown on.
 */
export function diplomacyPanelModel(galaxy: Galaxy, planetId: string): DiplomacyModel {
  const state = galaxy.planets.get(planetId);
  const dip = state ? recordOf(state) : null;

  if (!state || !dip) return unknownWorld(galaxy, planetId);

  const stance = dip.stance;
  const peace = atPeace(state);
  const truceEndsIn = Math.max(0, (dip.appeaseUntil ?? 0) - state.time);
  const graceEndsIn = Math.max(0, GRACE_TIME - state.time);
  const cost = tributeCost(dip);

  return {
    planetId,
    known: true,
    stance,
    label: stanceLabel(stance),
    bands: STANCE_BANDS,
    atPeace: peace,
    peaceThreshold: PEACE_THRESHOLD,
    marginToWar: stance - PEACE_THRESHOLD,
    hostility: hostility(state),
    provoked: provoked(state),
    depletion: dip.depletion,
    peaceRestsOn: !peace
      ? "war"
      // Pacified first: it is the one floor that never decays, so it outranks anything with a clock.
      // Then grace over a truce — while the opening window is open it is the higher floor of the two
      // (GRACE_FLOOR 0.2 against the truce line's 0.0), so it is the one doing the work; both clocks
      // are on the model regardless, so a caller can show whichever runs out last.
      : dip.pacified ? "pacified"
      : graceEndsIn > 0 ? "grace"
      : truceEndsIn > 0 ? "truce"
      : "stance",
    graceTime: GRACE_TIME,
    inGrace: graceEndsIn > 0,
    graceEndsIn,
    tributes: dip.tributes,
    tributeCost: cost,
    tributeBaseCost: TRIBUTE_BASE_COST,
    tributeEscalation: cost / TRIBUTE_BASE_COST,
    credits: galaxy.credits,
    // `offerTribute`'s own test, and it is a strict `<` on the galaxy's credits: exactly enough buys
    // the truce. Reported rather than approximated, because a button greyed out at the price the
    // player has just saved up for is a bug report.
    canAffordTribute: galaxy.credits >= cost,
    appeaseTime: APPEASE_TIME,
    underTruce: truceEndsIn > 0,
    truceEndsIn,
    goodwill: dip.goodwill,
    goodwillCap: GOODWILL_CAP,
    atGoodwillCap: dip.goodwill >= GOODWILL_CAP,
    favor: favorAsk(state, dip),
    favorInterval: FAVOR_INTERVAL,
    favorWindow: FAVOR_WINDOW,
    favorGoodwill: FAVOR_GOODWILL,
  };
}

function favorAsk(state: State, dip: DiplomacyRecord): FavorAsk | null {
  const req = dip.request;
  if (!req) return null;

  // `fulfillRequest` floors the stockpile before comparing, so a panel that compared the raw float
  // would offer a fulfil the engine refuses on a holding of 74.9999.
  const held = Math.floor(state.players.player.resources[req.com] ?? 0);
  const secondsLeft = Math.max(0, req.until - state.time);
  return {
    com: req.com,
    qty: req.qty,
    held,
    shortfall: Math.max(0, req.qty - held),
    canFulfill: held >= req.qty && secondsLeft > 0,
    reward: req.reward,
    goodwill: FAVOR_GOODWILL,
    secondsLeft,
    fraction: FAVOR_WINDOW > 0 ? secondsLeft / FAVOR_WINDOW : 0,
    expiresAt: req.until,
  };
}

function unknownWorld(galaxy: Galaxy, planetId: string): DiplomacyModel {
  return {
    planetId,
    known: false,
    stance: 0,
    label: "",
    bands: STANCE_BANDS,
    atPeace: false,
    peaceThreshold: PEACE_THRESHOLD,
    marginToWar: 0,
    // NOT `hostility(state)`. See the header: 1 is what that function answers for a skirmish, and
    // it means the offense ramp is ungated, not that somebody hates you.
    hostility: 0,
    provoked: false,
    depletion: 0,
    peaceRestsOn: "unknown",
    graceTime: GRACE_TIME,
    inGrace: false,
    graceEndsIn: 0,
    tributes: 0,
    tributeCost: TRIBUTE_BASE_COST,
    tributeBaseCost: TRIBUTE_BASE_COST,
    tributeEscalation: 1,
    credits: galaxy.credits,
    canAffordTribute: false,
    appeaseTime: APPEASE_TIME,
    underTruce: false,
    truceEndsIn: 0,
    goodwill: 0,
    goodwillCap: GOODWILL_CAP,
    atGoodwillCap: false,
    favor: null,
    favorInterval: FAVOR_INTERVAL,
    favorWindow: FAVOR_WINDOW,
    favorGoodwill: FAVOR_GOODWILL,
  };
}

/* =================================================================================================
   GIFTS

   `offerGift` prices a gift at the FLAT sell price and applies no slippage, which is the opposite of
   the rule `market-panel.ts` exists to enforce — and both are the same rule underneath: ask the
   engine what the thing you are about to do is worth. A gift is not a sale. `sell` walks the order
   in `TRADE_LOT` chunks and slips the price between them; `offerGift` multiplies once and takes
   nothing off, so `quoteSell` would understate a large gift badly (2000 ore quotes 4489 credits and
   gifts as 10000).

   The other half is the clamp. `offerGift` hands over `min(qty, floor(held))` and refuses only when
   that is zero — so asking to gift more than you hold is not an error, it is a smaller gift, and a
   UI that echoed the request back would be lying about what left the stockpile.
   ================================================================================================= */

export interface GiftPreview {
  readonly com: string;
  /** What was asked for, as it was given. */
  readonly requested: number;
  /** What `offerGift` would actually hand over: the holding, floored, when that is less. */
  readonly amount: number;
  readonly held: number;
  /** True when the two differ — the thing a UI has to show rather than silently apply. */
  readonly clamped: boolean;
  /**
   * Local market value of what would leave, at `unitPrice`'s flat sell rate — `offerGift`'s own
   * arithmetic. This is what converts into goodwill; the rate it converts at
   * (`GOODWILL_PER_CREDIT`) does not cross the façade, so no goodwill figure is predicted here.
   */
  readonly value: number;
  /** `offerGift` would do something. False for an empty stockpile, where it refuses outright. */
  readonly wouldHappen: boolean;
}

/**
 * What a gift would cost and what it would be worth, before the intent is sent.
 *
 * Takes the state rather than a world id because that is what a gift reads: local stock and the
 * local price book. No credits are involved on either side of it.
 */
export function giftPreview(state: State, com: string, qty: number): GiftPreview {
  const held = Math.floor(state.players.player.resources[com] ?? 0);
  const amount = Math.min(qty, held);
  const priced = state.market && amount > 0 ? amount * unitPrice(state.market, com, "sell") : 0;
  return {
    com,
    requested: qty,
    amount: Math.max(0, amount),
    held,
    clamped: amount < qty,
    value: priced,
    // `offerGift` needs a market to price against and refuses without one, exactly as it refuses an
    // empty stockpile.
    wouldHappen: amount > 0 && !!state.market,
  };
}

/* =================================================================================================
   THE BANDS

   `stanceLabel` is the engine's banding and its edges are private to it. Typing them in here would
   put a second copy of the rule above the bridge — the exact thing P4-T03 refused to do when it
   left the starmap's stance bar unbanded — so they are FOUND instead: scan the −1..1 range for the
   sample where the label changes, then bisect that interval against `stanceLabel` itself until the
   edge is pinned. Move a band upstream and these move with it; rename one and the label moves too.

   Computed once. It is a function of the engine's constants and of nothing else.
   ================================================================================================= */

/** Samples across −1..1. Any spacing finer than the narrowest band finds every edge; this is 256×. */
const BAND_SAMPLES = 512;
/** How tightly each edge is pinned. Far below anything a stance bar could draw. */
const BAND_EPSILON = 1e-9;

function stanceBands(): readonly StanceBand[] {
  const out: StanceBand[] = [];
  let from = -1;
  let label = stanceLabel(-1);

  for (let i = 1; i <= BAND_SAMPLES; i++) {
    const at = -1 + (2 * i) / BAND_SAMPLES;
    const here = stanceLabel(at);
    if (here === label) continue;
    // The edge is in (previous sample, at]. Bisect: `lo` is always still in the band and `hi` never
    // is, so `hi` converges onto the first stance the band no longer covers.
    let lo = -1 + (2 * (i - 1)) / BAND_SAMPLES;
    let hi = at;
    while (hi - lo > BAND_EPSILON) {
      const mid = (lo + hi) / 2;
      if (stanceLabel(mid) === label) lo = mid;
      else hi = mid;
    }
    out.push({ label, from, to: hi });
    from = hi;
    label = here;
  }

  out.push({ label, from, to: 1 });
  return out;
}

const STANCE_BANDS: readonly StanceBand[] = stanceBands();
