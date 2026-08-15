// Colonies, passive income, and the standing orders that run them (P4-T06, P4-T08, ADR-0012 §4).
//
// Two models over one subject, because a world you have left raises two separate questions: *what
// is it paying me?* and *what is it doing while I am gone?*
//
// **The cap is the reason the income model exists at all.** `sweepColonies` pays
// `COLONY_INCOME_PER_BUILDING` (0.3/s) for each income-earning building on a colony and stops
// counting at `COLONY_INCOME_CAP` (6). A seventh building costs ore, takes ground, and earns
// nothing — so a player who cannot see the cap keeps expanding for income that is not coming. A row
// therefore does not just carry a rate: it carries where this colony stands against the cap and
// what one *more* building would add (`marginalPerSecond`), which is the number the expansion
// decision actually turns on.
//
// **Two rules read off the engine rather than assumed.** A turret is not an economy
// (`incomeBuildingCount` excludes it), and the *seat* earns nothing at all — `sweepColonies` skips
// every world that is not flagged `background`, so a colony starts paying the moment you jump away
// and stops the moment you come back.
//
// **The one thing re-derived here, and what pins it.** `incomeBuildingCount` is module-private in
// `engine/galaxy.js`, so counting is a rule this file has to repeat. It is not repeated on trust:
// `test/ui/colony-panel.test.ts` asserts this model's own per-second total against the credits a
// single `sweepColonies(galaxy, 1)` call actually banks. Let a turret start earning upstream, or
// the cap move, and that goes red here rather than the panel quietly disagreeing with the treasury.
//
// **Nothing in this client drives `sweepColonies` yet.** `stepGalaxy` does not call it (upstream's
// own declaration says so) and `WorldBridge.step` does not either, so today this is a rate the
// galaxy never banks. That is a gap in the app's wiring rather than in this model — recorded in the
// P4-T06 notes, not papered over here.

import {
  COLONY_INCOME_CAP, COLONY_INCOME_PER_BUILDING, COM, MAX_WORKER_TARGET, PACIFIED_INCOME,
  getColonyPolicy, quoteSell, sanitizePolicy,
} from "../engine/index.js";

/**
 * Is this world a background colony — the thing `sweepColonies` pays and `runColonyPolicies` acts
 * on?
 *
 * `background` is not on the shared `State` declaration, and the narrow cast is deliberate rather
 * than an oversight: declaring it in `types/` would open the flag to every consumer of `State` for
 * the sake of one boolean, and this is the same treatment `test/bridge/galaxy-save.test.ts` gives
 * it. Read rather than re-derived as `id !== galaxy.activeId`, because those two are not the same
 * predicate — `addPlanet` can build a world that is neither the seat nor a colony, and the engine
 * pays it nothing.
 */
const isColony = (state: State): boolean => (state as unknown as { background?: boolean }).background === true;

export interface ColonyRow {
  readonly id: string;
  /** True while `sweepColonies` pays this world anything at all. False for the seat. */
  readonly earning: boolean;
  /** Player buildings standing here — turrets included, because they are still a colony. */
  readonly buildings: number;
  /** …of which the income sweep counts: everything but a turret, before the cap. */
  readonly incomeBuildings: number;
  /** …and after it. Never more than `cap`. */
  readonly counted: number;
  /** Income buildings past the cap. Every one is standing, and none of them pays. */
  readonly beyondCap: number;
  readonly atCap: boolean;
  /**
   * What one more income building here would add per second — the rate below the cap, and exactly
   * zero at it. The whole point of the panel: at the cap, expansion has to be worth something other
   * than credits.
   */
  readonly marginalPerSecond: number;
  /** A world whose neighbour's capital you razed. It draws `PACIFIED_INCOME` on top, buildings or not. */
  readonly pacified: boolean;
  readonly perSecond: number;
  readonly perMinute: number;
}

export interface ColonyIncomeModel {
  readonly credits: number;
  /** `COLONY_INCOME_PER_BUILDING` — stated, so the rate is never something a player has to time. */
  readonly perBuilding: number;
  /** `COLONY_INCOME_CAP`. */
  readonly cap: number;
  /** What one colony can ever pay from buildings alone: `perBuilding × cap`. */
  readonly colonyCeiling: number;
  /** `PACIFIED_INCOME` — the occupation dividend, additive and independent of the cap. */
  readonly pacifiedRate: number;
  /** Every world in the galaxy, colony or not, so a world paying nothing says why. */
  readonly rows: readonly ColonyRow[];
  readonly perSecond: number;
  readonly perMinute: number;
}

/**
 * What the colonies are paying, per world and in total.
 *
 * Rows cover *every* instantiated world rather than only the earning ones, because "this world pays
 * nothing" is information — it is the answer to why the treasury stopped moving after a jump home.
 */
export function colonyIncomeModel(galaxy: Galaxy): ColonyIncomeModel {
  const rows: ColonyRow[] = [];
  let perSecond = 0;

  for (const [id, state] of galaxy.planets) {
    const earning = isColony(state);
    let buildings = 0;
    let incomeBuildings = 0;
    for (const b of state.buildings.values()) {
      if (b.owner !== "player") continue;
      buildings++;
      // Upstream counts a building the moment it exists — a half-finished Habitat pays like a
      // finished one, and `constructing` is not part of the test. Mirrored, not corrected.
      if (b.type !== "turret") incomeBuildings++;
    }
    const counted = Math.min(COLONY_INCOME_CAP, incomeBuildings);
    const pacified = galaxy.pacified.has(id);
    const rate = earning
      ? counted * COLONY_INCOME_PER_BUILDING + (pacified ? PACIFIED_INCOME : 0)
      : 0;

    rows.push({
      id,
      earning,
      buildings,
      incomeBuildings,
      counted,
      beyondCap: incomeBuildings - counted,
      atCap: counted >= COLONY_INCOME_CAP,
      marginalPerSecond: earning && counted < COLONY_INCOME_CAP ? COLONY_INCOME_PER_BUILDING : 0,
      pacified,
      perSecond: rate,
      perMinute: rate * 60,
    });
    perSecond += rate;
  }

  return {
    credits: galaxy.credits,
    perBuilding: COLONY_INCOME_PER_BUILDING,
    cap: COLONY_INCOME_CAP,
    colonyCeiling: COLONY_INCOME_PER_BUILDING * COLONY_INCOME_CAP,
    pacifiedRate: PACIFIED_INCOME,
    rows,
    perSecond,
    perMinute: perSecond * 60,
  };
}

/* =================================================================================================
   COLONY STANDING ORDERS (P4-T08)

   `sanitizePolicy` is the engine's validator and `setColonyPolicy` runs it on the way in, so a panel
   has nothing left to validate — but it does have something to SHOW. `MAX_WORKER_TARGET` (20) is a
   clamp, and a UI that let a player type 99 and quietly stored 20 would be lying twice: once at the
   keystroke, and again at every later read. `policyPreview` asks the engine's own validator what a
   request becomes BEFORE the intent is sent, and names each difference.

   The other half is that a standing order can be stored perfectly and still do nothing.
   `runColonyPolicies` acts on BACKGROUND worlds only, so an order set on the world under your feet
   is inert until you leave; auto-sell with no floor set sells nothing; and a worker target on a
   colony with no Command Center can never queue anybody. `inertReason` and `warnings` say which of
   those you are in, because "why is nothing happening" is the only question this panel ever gets.
   ================================================================================================= */

export interface AutoSellRow {
  readonly com: string;
  /** Stock kept back. Everything above this goes to market on the next scan. */
  readonly floor: number;
  /** What the colony holds right now. */
  readonly held: number;
  /** What the next scan will actually put on the market — `runAutoSell`'s own `floor(held − floor)`. */
  readonly surplus: number;
  /**
   * What that sale would earn, from `quoteSell`'s dry run of the real lot walk.
   *
   * Not `unitPrice × surplus`: `sell` walks the order in `TRADE_LOT` chunks and slips the price
   * between them, so a colony dumping a large surplus gets less per unit the more it dumps — which
   * is exactly what a player deciding where to set the floor needs to see.
   */
  readonly proceeds: number;
}

export interface ColonyPolicyModel {
  readonly planetId: string;
  /** The stored policy — `getColonyPolicy`'s own sanitized copy, never the store's live object. */
  readonly policy: ColonyPolicy;
  readonly autoSellEnabled: boolean;
  /** One row per configured floor, in the order `runAutoSell` walks them. */
  readonly floors: readonly AutoSellRow[];
  readonly workerTarget: number;
  /** `MAX_WORKER_TARGET`, stated so the ceiling is visible before it is hit. */
  readonly maxWorkerTarget: number;
  readonly atMaxWorkerTarget: boolean;
  /** Player workers on this colony — what `workerTarget` is measured against. */
  readonly workers: number;
  /** A finished player Command Center, without which no worker can be queued. */
  readonly hasCommandCenter: boolean;
  /** Why this policy will do nothing whatsoever, or null when it will run. */
  readonly inertReason: string | null;
  /** Standing orders that are set but cannot act. Empty when everything set can run. */
  readonly warnings: readonly string[];
}

/**
 * One colony's standing orders, and whether they can actually run.
 *
 * An unknown world is answered rather than refused: `getColonyPolicy` returns the fully-off default
 * for a world it has never heard of, and a panel addressing a world that has gone should say so, not
 * throw on a stale click.
 */
export function colonyPolicyModel(galaxy: Galaxy, planetId: string): ColonyPolicyModel {
  const state = galaxy.planets.get(planetId);
  const policy = getColonyPolicy(galaxy, planetId);
  const floors: AutoSellRow[] = [];
  let workers = 0;
  let hasCommandCenter = false;

  if (state) {
    const held = state.players.player.resources;
    for (const com in policy.autoSell.floors) {
      const floor = policy.autoSell.floors[com]!;
      const stock = held[com] ?? 0;
      const surplus = Math.max(0, Math.floor(stock - floor));
      floors.push({ com, floor, held: stock, surplus, proceeds: quoteSell(state.market, com, surplus) });
    }
    for (const u of state.units.values()) if (u.owner === "player" && u.type === "worker") workers++;
    for (const b of state.buildings.values()) {
      if (b.owner === "player" && b.type === "command" && !b.constructing) hasCommandCenter = true;
    }
  }

  const warnings: string[] = [];
  if (policy.autoSell.enabled && floors.length === 0) {
    warnings.push("Auto-sell is on but no commodity has a floor, so nothing will ever be sold");
  }
  if (policy.workerTarget > 0 && state && !hasCommandCenter) {
    // Precise on purpose: `runWorkerSustain` still re-tasks idle workers to gather without a
    // Command Center. It is only the re-queue half that has nowhere to go.
    warnings.push("No finished Command Center here, so no worker can be queued (idle workers are still sent to gather)");
  }

  return {
    planetId,
    policy,
    autoSellEnabled: policy.autoSell.enabled,
    floors,
    workerTarget: policy.workerTarget,
    maxWorkerTarget: MAX_WORKER_TARGET,
    atMaxWorkerTarget: policy.workerTarget >= MAX_WORKER_TARGET,
    workers,
    hasCommandCenter,
    inertReason: inertReason(galaxy, planetId, state, policy),
    warnings,
  };
}

function inertReason(
  galaxy: Galaxy, planetId: string, state: State | undefined, policy: ColonyPolicy,
): string | null {
  if (!state) return `${planetId} is not a world in this galaxy`;
  if (isColony(state)) {
    return policy.autoSell.enabled || policy.workerTarget > 0
      ? null
      : "Nothing is set — auto-sell is off and the worker target is zero";
  }
  return planetId === galaxy.activeId
    ? "Standing orders run on colonies — this is the world you are standing on"
    : "This world is not a background colony, so the colony scan skips it";
}

export interface PolicyAdjustment {
  /** `"workerTarget"`, or `"autoSell.floors.<com>"`. */
  readonly field: string;
  /** What was asked for, as it was given. */
  readonly requested: string;
  /** What the engine's validator will store — null when it drops the field entirely. */
  readonly accepted: number | null;
  readonly reason: string;
}

export interface PolicyPreview {
  /** `sanitizePolicy`'s verdict on the request. The engine's validator, not a second opinion. */
  readonly policy: ColonyPolicy;
  /** Every field the validator changed or dropped. Empty when the request survives intact. */
  readonly adjustments: readonly PolicyAdjustment[];
}

/**
 * A policy edit as it arrives from a UI — deliberately looser than `ColonyPolicyPatch`.
 *
 * A number field on a form is a string until someone parses it, and "someone parses it" is the bug:
 * `sanitizePolicy` is that parser, it takes `unknown`, and the `colonyPolicy` intent carries a
 * `Record<string, unknown>` for the same reason. Typing this parameter as the sanitized patch would
 * make the invalid cases unreachable in TypeScript and unhandled at runtime.
 */
export interface PolicyRequest {
  autoSell?: { enabled?: unknown; floors?: Record<string, unknown> };
  workerTarget?: unknown;
}

/**
 * What the engine will make of a policy edit, before the intent is sent (P4-T08).
 *
 * The verdict is `sanitizePolicy`'s own — this function never decides, it *reports*. That matters
 * beyond tidiness: `MAX_WORKER_TARGET` is a clamp, and the failure this exists to prevent is a UI
 * that accepts 99, stores 20 and shows 99 until the next read.
 *
 * It describes the REQUEST, not the resulting policy: `setColonyPolicy` merges `autoSell.floors`
 * into the floors already stored (editing one commodity's floor must not blow away the rest), so a
 * preview of one edited floor is a preview of that edit, not of the whole standing order.
 */
export function policyPreview(patch: PolicyRequest): PolicyPreview {
  const policy = sanitizePolicy(patch);
  const adjustments: PolicyAdjustment[] = [];

  if (patch.workerTarget !== undefined) {
    const raw = patch.workerTarget;
    const n = Number(raw);
    const accepted = policy.workerTarget;
    if (!Number.isFinite(n)) {
      adjustments.push({
        field: "workerTarget", requested: String(raw), accepted,
        reason: "Not a number — read as no sustain target",
      });
    } else if (n > MAX_WORKER_TARGET) {
      adjustments.push({
        field: "workerTarget", requested: String(raw), accepted,
        reason: `Above the ${MAX_WORKER_TARGET}-worker ceiling — stored as ${MAX_WORKER_TARGET}`,
      });
    } else if (n < 0) {
      adjustments.push({
        field: "workerTarget", requested: String(raw), accepted,
        reason: "Below zero — stored as no sustain target",
      });
    } else if (n !== accepted) {
      adjustments.push({
        field: "workerTarget", requested: String(raw), accepted,
        reason: `Rounded to ${accepted} whole workers`,
      });
    }
  }

  const requestedFloors = patch.autoSell?.floors ?? {};
  for (const com in requestedFloors) {
    const raw = requestedFloors[com];
    const accepted = policy.autoSell.floors[com];
    if (accepted !== undefined) continue;                       // taken as asked
    const n = Number(raw);
    adjustments.push({
      field: `autoSell.floors.${com}`,
      requested: String(raw),
      accepted: null,
      // `COM` is the engine's own commodity table — the same one `sanitizePolicy` checks against,
      // so this classification cannot disagree with the drop it is explaining.
      reason: !COM[com]
        ? `${com} is not a commodity`
        : Number.isFinite(n) ? "A floor cannot be negative" : "Not a number",
    });
  }

  return { policy, adjustments };
}
