// The Plasma Rig's survey and yield models (P2-T16, ADR-0012 §4 and §5).
//
// The Rig is the one building whose value depends on WHERE it is put, so half of this is a
// placement-time model that has to be readable while the build ghost is up (P1-T18) — not a panel
// you open after committing 200 ore to a spot.
//
// The engine's `rigSurvey` takes a node list as an argument, and that argument is the whole design:
//
//   > Pure over the given node list, so the sim can survey ALL nodes (deterministic) while the UI
//   > surveys only the ones the player can see (an honest guess — a hidden cache stays a surprise).
//
// Handing it `state.map.nodes` would compile, run, and quietly turn the placement reading into a
// preview of the sim's own answer, leaking every undiscovered deposit on the map through a UI
// affordance. So this passes the fog-discovered nodes and nothing else, and the reading it produces
// is deliberately allowed to be WRONG — which is what `confidence` is for.
//
// The yield half is the opposite discipline: `lastTier` is a rolled result, and the roll is
// `rollTier`'s (rig id + dig counter, biased by richness). It is reported verbatim. Deriving a tier
// from `lastYield` would be arithmetic on a balance number that happens to agree today and stops
// agreeing the first time a multiplier moves.

import {
  SURVEY_RADIUS, YIELD_TIERS, type RigInfo, type RigSurvey, isNodeDiscovered, rigInfo, rigSurvey,
} from "../engine/index.js";

export interface SurveyModel {
  /** The most likely vein below, or null for a blind spot — no discovered deposit is in range. */
  readonly likelyVein: string | null;
  /**
   * 0..1 — the winning vein's share of nearby weight.
   *
   * NOT the probability the guess is right, and the difference matters: the sim picks the vein from
   * ALL nodes, including ones this reading could not see. A confident-looking blind spot is a real
   * outcome, which is why `blind` is reported separately rather than inferred from a low number.
   */
  readonly confidence: number;
  readonly richness: number;
  /** The engine's own word for the richness — "poor" … "mother lode". Never re-bucketed here. */
  readonly richLabel: string;
  /** True when nothing discovered is in range at all. */
  readonly blind: boolean;
  /** The radius the reading covers, so the ghost can draw it rather than guess at it. */
  readonly radius: number;
  /** Discovered deposits inside the radius, nearest first — what the reading is actually built on. */
  readonly seen: readonly { readonly com: string; readonly x: number; readonly y: number; readonly distance: number }[];
  /** Every tier a dig here could strike, with the engine's own multipliers. */
  readonly tiers: readonly { readonly name: string; readonly mult: number }[];
}

export interface RigYieldModel {
  readonly vein: string;
  readonly richness: number;
  readonly richLabel: string;
  readonly progress: number;
  /** The ROLLED tier name from `rigInfo`, or null before the first dig. Never re-derived. */
  readonly lastTier: string | null;
  /** That tier's multiplier, looked up in `YIELD_TIERS` by name — not computed from the yield. */
  readonly lastTierMult: number | null;
  readonly lastYield: number;
  readonly stored: number;
  readonly storeCap: number;
  /**
   * Why it is not digging right now, in the order the engine itself gates: no nuclear fuel, then a
   * dead grid, then a full buffer. Null while it is digging.
   */
  readonly stoppedBy: "noFuel" | "noPower" | "bufferFull" | null;
  /** 0..1 — the owner-wide power throttle. Below 1 the dig is slow rather than stopped. */
  readonly throttle: number;
}

/**
 * What the ground at (x, y) reads like to THIS player, right now.
 *
 * @param owner Whose fog decides what the survey may see. Passing the wrong side here is the same
 *   bug as passing all nodes, one step quieter.
 */
export function rigSurveyModel(state: State, owner: OwnerId, x: number, y: number): SurveyModel {
  const fog = owner === "player" ? state.fog : state.fogAI;
  const all = state.map?.nodes ?? [];

  // Fog-gated, exactly as `rigSurvey`'s own doc comment instructs. This is the line that keeps a
  // placement reading from being a map hack.
  const discovered = all.filter((n) => isNodeDiscovered(fog, n));
  const survey: RigSurvey = rigSurvey(discovered, state.planetId, x, y);

  const seen = discovered
    .map((n) => ({ com: n.com, x: n.x, y: n.y, distance: Math.hypot(n.x - x, n.y - y) }))
    // `surfaceSurvey` cuts at SURVEY_RADIUS with a strict `>=`, so this matches it exactly rather
    // than showing a deposit on the line that contributed nothing to the number beside it.
    .filter((n) => n.distance < SURVEY_RADIUS)
    .sort((a, b) => a.distance - b.distance || (a.com < b.com ? -1 : 1));

  return {
    likelyVein: survey.likelyVein,
    confidence: survey.confidence,
    richness: survey.richness,
    richLabel: survey.richLabel,
    // A blind spot is "no vein weight at all", which is what the engine signals with a null vein —
    // not "confidence is low". A single deposit in range gives confidence 1 and is still a guess.
    blind: survey.likelyVein === null,
    radius: SURVEY_RADIUS,
    seen,
    tiers: YIELD_TIERS.map((t) => ({ name: t.name, mult: t.mult })),
  };
}

export function rigYieldModel(state: State, buildingId: string): RigYieldModel | null {
  const building = state.buildings.get(buildingId);
  if (!building) return null;
  // `rigInfo` returns null for anything without a `rig` def, which is the same check a panel would
  // otherwise write itself and get wrong for the next rig-like building.
  const info: RigInfo | null = rigInfo(state, building);
  if (!info) return null;

  return {
    vein: info.vein,
    richness: info.richness,
    richLabel: info.richLabel,
    progress: info.progress,
    lastTier: info.lastTier,
    lastTierMult: multFor(info.lastTier),
    lastYield: info.lastYield,
    stored: info.stored,
    storeCap: info.storeCap,
    stoppedBy: stoppedBy(info),
    throttle: info.throttle,
  };
}

/**
 * The multiplier for a tier NAME, from `YIELD_TIERS`.
 *
 * A lookup, never a division. `lastYield / baseYield` would give the same answer today and diverge
 * the first time an upgrade or a planet scale touches the yield — and it would diverge silently,
 * showing a plausible tier that the rig did not roll.
 */
function multFor(name: string | null): number | null {
  if (!name) return null;
  return YIELD_TIERS.find((t) => t.name === name)?.mult ?? null;
}

/**
 * Why it is stopped, in the engine's own gating order (`updatePlasmaRig`, `buildingConcern`).
 *
 * Order is the entire content of this function. A rig with no fuel AND a full buffer is stopped by
 * the fuel first, and telling the player to haul away the output would send them to do work that
 * changes nothing.
 */
function stoppedBy(info: RigInfo): "noFuel" | "noPower" | "bufferFull" | null {
  if (!info.nuclearOk) return "noFuel";
  if (info.throttle <= 0) return "noPower";
  if (info.storeFull) return "bufferFull";
  return null;
}
