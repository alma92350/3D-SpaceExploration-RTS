// Relief and surrender — the two ends of losing everything (P5-T07, ADR-0012 §4 and §5).
//
// They are one panel because they are one moment. A player who has just watched their last
// Command Center fall is looking at a galaxy that, by the engine's own rule, has **not** ended:
// `checkEndlessLoss` opens with `if (state.inGalaxy) return;` and `checkGalaxyRescue` answers a
// total wipeout by dispatching a colony ship. The only way to end an Odyssey is to say so.
//
// **The cooldown is the whole legibility problem, and it is P4-T07's again.** `checkGalaxyRescue`
// runs on the galaxy's ~1 Hz scan and does nothing for `RELIEF_COOLDOWN` (20 s) after a drop. A
// player who loses the relief ship in the fight that is still going on then stands in an empty
// galaxy for twenty seconds with no base, no ship and no explanation — which is indistinguishable
// from a game that has quietly given up on them. So this model leads with the clock: how long the
// anti-farm bound is, and how much of it is left. "Nothing is coming" and "something is coming in
// eleven seconds" are different states and only one of them is a fault.
//
// **The cooldown is keyed on the GALAXY clock, and this model must be too.** The engine says why at
// length: a jump swaps the active world, each world's own `state.time` advances independently, and
// comparing `lastReliefTime` (stamped on world A) against world B's clock reads as "elapsed" or
// "never elapses" depending on which way the two drifted. `galaxy.time` is the one monotonic clock
// across a run. A panel that reached for `activeState(galaxy).time` would agree with the engine for
// the whole of a first world and lie from the first jump onward.
//
// **Surrender is irreversible, and the engine will not tell you twice.** P2-T12's doctrine panel
// found that `researchUpgrade`'s refusal is a bare `false`, indistinguishable from "you cannot
// afford it", and had to carry a third value meaning *never*. `surrenderGalaxy` is worse: it
// returns nothing at all, and its refusal (`if (active.over) return;`) is silent — a second click
// on an ended run is byte-identical to a first click that worked. So `SurrenderChoice.state`
// carries three values, and the one that matters is `surrendered`: the run is over by your own
// hand and no click will ever do anything again.
//
// **And the third value has a mirror the doctrine panel did not need.** The moment a player most
// wants this button is the moment they have lost everything — which is exactly the moment the
// engine is about to send them a ship. `reliefWouldFollow` says so, because a player who
// surrenders believing they have already lost has been misinformed by the interface rather than
// beaten by the game.
//
// Nothing here decides a rule. The one thing this module must re-derive is the foothold scan
// itself, because `checkGalaxyRescue` is a mutator with no query beside it — so `test/ui/
// relief-panel.test.ts` validates every `hasFoothold` claim against what the engine then does,
// rather than against a second reading of the same rule.

import { RELIEF_COOLDOWN, activeState, hasColonyShip } from "../engine/index.js";

/**
 * `held` — the player holds something somewhere; relief is not needed and will not be sent.
 * `waiting` — nothing held, and the anti-farm cooldown is the only thing in the way.
 * `due` — nothing held, cooldown elapsed: the next galaxy scan dispatches a ship.
 * `ended` — the run is over (a surrender), so no relief will ever come again.
 */
export type ReliefStatus = "held" | "waiting" | "due" | "ended";

/** A world where the player still holds something the rescue scan counts. */
export interface ReliefFoothold {
  readonly planetId: string;
  /**
   * Player Command Centers, **including still-constructing ones**. That is the engine's own count
   * here and it is not the one `checkGalaxyProgress` uses (which requires `!b.constructing` before
   * it will call a world settled): a half-built base is a foothold for relief and not yet a
   * milestone. A panel that filtered on `constructing` would promise a ship that never arrives.
   */
  readonly commandCenters: number;
  /** How many of those are still going up — the difference above, made visible rather than lost. */
  readonly underConstruction: number;
  /** `hasColonyShip` — an undeployed ship is a foothold on its own, which is why the opening is not a loss. */
  readonly colonyShip: boolean;
}

export type SurrenderState = "available" | "surrendered" | "ended";

export interface SurrenderChoice {
  /**
   * `available` — the click is live. `surrendered` — you already did, and `surrenderGalaxy` will
   * silently do nothing forever. `ended` — the seat is over for some other reason, which in a
   * galaxy should be unreachable, so it is shown rather than folded into the one above it.
   */
  readonly state: SurrenderState;
  readonly canSurrender: boolean;
  /** The seat the ending is recorded on: `surrenderGalaxy` ends the ACTIVE world, wherever you are. */
  readonly seatId: string;
  /**
   * The player holds nothing anywhere and the run is still live — so the engine's answer to this
   * is a relief ship, not a defeat. True at exactly the moment surrender looks obligatory.
   */
  readonly reliefWouldFollow: boolean;
}

export interface ReliefPanelModel {
  /** `galaxy.time` — the clock the cooldown is measured on, and not any one world's. */
  readonly galaxyTime: number;
  /** `RELIEF_COOLDOWN`, the engine's own anti-farm bound, in sim seconds. */
  readonly cooldownSeconds: number;
  /** When the last ship was dispatched, or null when none ever has been. */
  readonly lastReliefTime: number | null;
  /** Galaxy time the cooldown lifts at, or null when nothing is holding it down. */
  readonly eligibleAt: number | null;
  /** Zero once the cooldown has elapsed. Subtracted exactly as the engine subtracts, so the two cannot drift. */
  readonly secondsUntilEligible: number;
  readonly onCooldown: boolean;
  /** Every world the player still holds something on, in the galaxy's own roster order. */
  readonly footholds: readonly ReliefFoothold[];
  readonly hasFoothold: boolean;
  readonly status: ReliefStatus;
  /**
   * `galaxy.reliefNote` — the engine's own toast flag, raised on every dispatch.
   *
   * **It latches.** Upstream's `boot.js` drains it; nothing in this client does, and a panel model
   * may not (writing a galaxy field from `ui/` is exactly what ADR-0008 forbids). So read it as
   * "relief has been sent at least once", never as "a ship just arrived" — a HUD that showed a
   * toast for it would show that toast for the rest of the run. The edge a toast actually wants is
   * `lastReliefTime` changing between two frames.
   */
  readonly reliefFlag: boolean;
  readonly surrender: SurrenderChoice;
}

/**
 * The relief clock, the footholds it is watching, and the one button that ends a run.
 *
 * Pure: it reads the galaxy and writes nothing. `surrenderGalaxy` itself is a command and belongs
 * to the bridge — see the note at the foot of this file.
 */
export function reliefPanelModel(galaxy: Galaxy): ReliefPanelModel {
  const seat = activeState(galaxy);
  const over = seat.over === true;
  const surrendered = flags(galaxy).surrendered === true;

  const footholds = footholdsOf(galaxy);
  const hasFoothold = footholds.length > 0;

  const now = galaxy.time || 0;
  const last = galaxy.lastReliefTime;
  // The engine's own comparison, `now - (lastReliefTime ?? -Infinity) < RELIEF_COOLDOWN`, in the
  // engine's own order of operations. Written as one subtraction rather than as a stored deadline
  // so that this and `checkGalaxyRescue` round the same accumulated float the same way.
  const elapsed = last === undefined ? Infinity : now - last;
  const onCooldown = elapsed < RELIEF_COOLDOWN;

  return {
    galaxyTime: now,
    cooldownSeconds: RELIEF_COOLDOWN,
    lastReliefTime: last ?? null,
    eligibleAt: last === undefined ? null : last + RELIEF_COOLDOWN,
    secondsUntilEligible: onCooldown ? RELIEF_COOLDOWN - elapsed : 0,
    onCooldown,
    footholds,
    hasFoothold,
    // The engine's order: the surrender guard comes before the foothold scan, so an ended run is
    // never described in terms of a cooldown it will never consult again.
    status: over ? "ended" : hasFoothold ? "held" : onCooldown ? "waiting" : "due",
    reliefFlag: flags(galaxy).reliefNote === true,
    surrender: {
      state: !over ? "available" : surrendered ? "surrendered" : "ended",
      canSurrender: !over,
      seatId: galaxy.activeId,
      reliefWouldFollow: !over && !hasFoothold,
    },
  };
}

/**
 * Exactly what `checkGalaxyRescue` walks, kept in its order: every world in the galaxy, a player
 * Command Center of any completeness, or an undeployed colony ship.
 *
 * It returns the whole list where the engine returns on the first hit. That is the point — "you
 * still hold Ferros" is the sentence that stops a player surrendering a run they have not lost.
 */
function footholdsOf(galaxy: Galaxy): ReliefFoothold[] {
  const out: ReliefFoothold[] = [];
  for (const [planetId, state] of galaxy.planets) {
    let commandCenters = 0;
    let underConstruction = 0;
    for (const b of state.buildings.values()) {
      if (b.owner !== "player" || b.type !== "command") continue;
      commandCenters++;
      if (b.constructing) underConstruction++;
    }
    const colonyShip = hasColonyShip(state, "player");
    if (commandCenters > 0 || colonyShip) out.push({ planetId, commandCenters, underConstruction, colonyShip });
  }
  return out;
}

/**
 * Two galaxy fields the vendored declarations do not carry.
 *
 * `src/ui/colony-panel.ts` reads `state.background` the same way and for the same reason: the
 * `.d.ts` files under `src/engine/types/` are the vendored engine's surface (ADR-0003) and this
 * project does not widen them from a panel. Read-only, and named here once rather than cast at
 * each use so the gap is visible instead of scattered.
 */
function flags(galaxy: Galaxy): { surrendered?: boolean; reliefNote?: boolean } {
  return galaxy as unknown as { surrendered?: boolean; reliefNote?: boolean };
}

// A note on the other half of "reachable" (P5-T07's definition of done):
//
// Relief needs no order — the engine dispatches it on its own scan, so a player reaches it by
// being shown it, which is this model. Surrender is a COMMAND, and every command in this project
// goes through `bridge/commands.ts` so that a recorded intent stream replays exactly (P1-T21).
// There is no `surrender` intent yet, and this module deliberately does not call `surrenderGalaxy`
// itself: a panel that issued its own engine command would be a second path into the simulation
// and the first thing a replay would lose.
