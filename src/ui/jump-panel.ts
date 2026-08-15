// The jump panel's model (P4-T04, ADR-0012 §4 and §5).
//
// **Not one rule of the jump is decided in this file.** Whether a destination can be reached is
// `canJumpTo`'s answer, what it costs is `jumpCost`'s, who rides is `jumpManifest`'s, and what a
// pad can lift is `SPACEPORT_CAPACITY` indexed by `spaceportTier`. This module reads those and
// arranges them; it never re-derives one, and three of them have a plausible re-derivation that is
// WRONG in a way a player would only discover after committing:
//
//   • **`jumpCost` is not `JUMP_COST`.** `FUEL_DISCOUNT_BY_TIER` cuts the fuel by 15% at Tier 2 and
//     30% at Tier 3, and the bill also scales with the distance across the frontier — so the
//     constant is right for exactly one case (a Tier-1 pad, at one particular distance) and wrong
//     for every upgraded port. A panel showing 400 credits beside a jump the engine will charge 271
//     for is not a rounding difference; it is a player not taking a jump they can afford.
//   • **`canJumpTo` is not "do I have a Spaceport".** Without a pad here you can still FALL BACK to
//     any world where you still hold a Command Center or an undeployed colony ship. That rule is
//     what stops a portless world being a trap — hop an army over, forget the colony ship, and the
//     way home is this clause — so a panel that greyed those destinations out would be hiding the
//     player's only escape. The two branches read differently to a player, which is why `fallback`
//     is on every destination rather than left implicit: falling back carries NO units, because
//     with no pad there is nothing to load a fleet from.
//   • **`stagedRiders` is not "my units near the pad".** A freighter crewed onto a Freight Lane is
//     parked at the pad as standing infrastructure and is deliberately skipped, so it is not on the
//     manifest and not in the overflow either — it is not leaving, and the panel must not imply it
//     is queued to.
//
// The manifest is reported whole, riders AND overflow, and that is the point of the row rather than
// completeness for its own sake: `jumpManifest` fills the hold closest-to-the-pad first and SKIPS a
// unit that does not fit rather than stopping at it, so which ship gets left is not "the last one"
// and cannot be guessed from a total. A panel that showed only who is going is the one where a
// player finds out about the Dreadnought still standing on the pad after the jump.
//
// Reads engine `State` through the galaxy rather than the snapshot, the same exception
// `market-panel.ts` documents: none of this is in the snapshot, and it is read when a panel is open
// rather than twenty times a second.

import {
  FUEL_DISCOUNT_BY_TIER, JUMP_LOAD_RADIUS, PLANETS, SPACEPORT_CAPACITY, SPACEPORT_MAX_TIER,
  SPACEPORT_UPGRADE_COST, UNITS, activeState, canAfford, canJump, canJumpTo, jumpCapacity,
  jumpCost, jumpManifest, jumpManifestAll, playerSpaceports, spaceportTier, stagedRiders,
} from "../engine/index.js";

/**
 * What `jumpManifest`/`jumpManifestAll` return, named once so the two call sites below read the
 * same way.
 *
 * The declaration is worth a word because it was wrong when this file was written: it advertised
 * `{ riders, supply, capacity, left }`, and the engine returns `{ riders, capacity, used,
 * stagedSupply, staged, leftBehind }` — no `supply`, no `left`, and `staged`/`leftBehind` are
 * COUNTS rather than rosters. A panel built on the old shape typechecked, ran, and showed every
 * player `undefined` staged supply beside an empty overflow list. The declaration has since been
 * corrected; `test/ui/jump-panel.test.ts` pins the runtime keys against the vendored engine,
 * because a hand-written `.d.ts` is an assertion about JavaScript that nothing else checks.
 */
type EngineManifest = ReturnType<typeof jumpManifest>;

/** One unit on (or off) the manifest, as a panel needs to name it. */
export interface ManifestUnit {
  readonly id: string;
  readonly type: string;
  /**
   * The engine's own `UNITS[type].supplyCost` — the units capacity is measured in.
   *
   * Per unit, never summed here. The totals below are the manifest's own, so a panel can show why
   * a heavy ship was passed over without ever computing a number the engine might disagree with.
   */
  readonly supply: number;
}

export interface JumpManifestModel {
  /** Who lifts off, in the engine's own boarding order — closest to the pad first. */
  readonly riders: readonly ManifestUnit[];
  /**
   * Who is staged and does NOT lift off.
   *
   * The engine reports this as a COUNT (`leftBehind`); the identities here are the difference
   * between two engine answers — everything `stagedRiders` names, minus everyone `jumpManifest`
   * boarded — and never a re-run of the fill rule. `left.length` and `leftBehind` are asserted
   * equal in the panel's tests, so a divergence is a red test and not a wrong list.
   */
  readonly left: readonly ManifestUnit[];
  /** Supply aboard, out of `capacity`. */
  readonly supply: number;
  /** Supply of the whole staging ring — bigger than `supply` exactly when something is left. */
  readonly stagedSupply: number;
  /** The pad's tier capacity. What "tier capacity is visible before committing" means. */
  readonly capacity: number;
  /** The engine's own count of what stays. Authoritative; `left` is its roster. */
  readonly leftBehind: number;
  /** True when the ring holds more than the pad can lift this trip. */
  readonly overCapacity: boolean;
}

export interface SpaceportRow {
  readonly id: string;
  readonly tier: number;
  readonly capacity: number;
  readonly atMaxTier: boolean;
  /** The tier an upgrade would buy, or null at the ceiling. */
  readonly nextTier: number | null;
  /** What that tier would lift — the number that makes an upgrade a decision. */
  readonly nextCapacity: number | null;
  /** The engine's own escalating price for it, or null at the ceiling. */
  readonly upgradeCost: Readonly<Record<string, number>> | null;
  /**
   * Whether the upgrade would be accepted right now.
   *
   * `canAfford` and `SPACEPORT_UPGRADE_COST` are the engine's own — the same pair `upgradeSpaceport`
   * spends through — so this predicts its answer rather than inventing a second cost check. The
   * bridge still asks the engine: `upgradeSpaceport` validates and spends, and this only decides
   * whether a button looks pressable.
   */
  readonly canUpgrade: boolean;
  /**
   * The fuel multiplier this tier earns (`FUEL_DISCOUNT_BY_TIER`).
   *
   * Reported so the panel can say WHY an upgrade changes the price list, not so anything multiplies
   * by it — every price in `destinations` is `jumpCost`'s own, discount already applied.
   */
  readonly fuelDiscount: number;
  /** This pad's own staging ring and what it would lift. */
  readonly manifest: JumpManifestModel;
}

export interface JumpDestination {
  readonly id: string;
  readonly name: string;
  /** `jumpCost`'s answer, in credits. Zero for a world already reached. */
  readonly cost: number;
  /** `canJumpTo`'s answer. Never re-derived from "is there a pad here". */
  readonly reachable: boolean;
  /** Whether the treasury covers `cost` — the same comparison the bridge's refusal makes. */
  readonly affordable: boolean;
  /** Already in `galaxy.discovered`: the reason a return trip is free. */
  readonly reached: boolean;
  /**
   * Reachable ONLY because the player holds a foothold there — there is no pad on this world.
   *
   * A fall-back is a control switch, not a launch: `jumpCapital` moves no unit at all without a
   * Spaceport to load from. A panel that offered it as an ordinary jump would be promising a ferry
   * that does not exist.
   */
  readonly fallback: boolean;
}

export interface JumpPanelModel {
  /** The world being launched from. */
  readonly originId: string;
  /** Galaxy credits, unrounded — the balance the engine compares against. Format for display. */
  readonly credits: number;
  /** `canJump`: a completed pad stands here, so a jump can carry an expedition. */
  readonly canLaunch: boolean;
  /** The ring a unit has to be standing in to ride. */
  readonly stagingRadius: number;
  readonly pads: readonly SpaceportRow[];
  /**
   * What one jump from this world would actually lift, across every pad (`jumpManifestAll`).
   *
   * Not the sum of the rows above when two pads' catchments overlap: each unit boards through its
   * NEAREST pad and each pad fills its own capacity, so a ship that does not fit at its nearest pad
   * is left behind rather than spilling into another's spare room. `jumpCapital` calls this one, so
   * this is the number a player is committing to.
   */
  readonly launch: JumpManifestModel;
  /** Every world in the roster except the one under your feet, in roster order. */
  readonly destinations: readonly JumpDestination[];
}

export function jumpPanelModel(galaxy: Galaxy): JumpPanelModel {
  // `activeState`, not a `State` handed in: the seat is the galaxy's own answer, and a panel that
  // accepted a world argument could be told about one the player is no longer standing on — which
  // is precisely what a jump does to a caller holding a stale reference.
  const state = activeState(galaxy);
  const pads = playerSpaceports(state);
  const hasPad = canJump(state);

  const rows: SpaceportRow[] = pads.map((pad) => {
    const tier = spaceportTier(pad);
    const next = tier < SPACEPORT_MAX_TIER ? tier + 1 : null;
    const cost = next === null ? null : SPACEPORT_UPGRADE_COST[next] ?? null;
    return {
      id: pad.id,
      tier,
      capacity: jumpCapacity(pad),
      atMaxTier: next === null,
      nextTier: next,
      nextCapacity: next === null ? null : SPACEPORT_CAPACITY[next] ?? null,
      upgradeCost: cost,
      // `playerSpaceports` has already excluded a pad still under construction, which is
      // `upgradeSpaceport`'s other refusal — so affordability is all that is left to predict.
      canUpgrade: cost !== null && canAfford(state.players.player.resources, cost),
      fuelDiscount: FUEL_DISCOUNT_BY_TIER[tier] ?? 1,
      manifest: manifestModel(jumpManifest(state, pad), stagedRiders(state, pad)),
    };
  });

  // Every unit in ANY pad's catchment, de-duplicated: two overlapping rings would otherwise name
  // the same ship twice, and `jumpManifestAll` counts it once (it boards through its nearest pad).
  const stagedAnywhere = new Map<string, Unit>();
  for (const pad of pads) for (const u of stagedRiders(state, pad)) stagedAnywhere.set(u.id, u);

  return {
    originId: galaxy.activeId,
    credits: galaxy.credits,
    canLaunch: hasPad,
    stagingRadius: JUMP_LOAD_RADIUS,
    pads: rows,
    launch: manifestModel(jumpManifestAll(state), [...stagedAnywhere.values()]),
    destinations: galaxy.worlds
      .filter((id) => id !== galaxy.activeId)
      .map((id) => {
        const cost = jumpCost(galaxy, id);
        const reachable = canJumpTo(galaxy, id);
        return {
          id,
          name: PLANETS.find((p) => p.id === id)?.name ?? id,
          cost,
          reachable,
          affordable: galaxy.credits >= cost,
          reached: galaxy.discovered.has(id),
          fallback: reachable && !hasPad,
        };
      }),
  };
}

function manifestModel(manifest: EngineManifest, staged: readonly Unit[]): JumpManifestModel {
  const aboard = new Set(manifest.riders.map((u) => u.id));
  return {
    riders: manifest.riders.map(unitModel),
    left: staged.filter((u) => !aboard.has(u.id)).map(unitModel),
    supply: manifest.used,
    stagedSupply: manifest.stagedSupply,
    capacity: manifest.capacity,
    leftBehind: manifest.leftBehind,
    overCapacity: manifest.leftBehind > 0,
  };
}

function unitModel(u: Unit): ManifestUnit {
  return { id: u.id, type: u.type, supply: UNITS[u.type]?.supplyCost ?? 0 };
}
