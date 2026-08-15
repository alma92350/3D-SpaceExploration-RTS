// The repair panel's model (P2-T15, the repair half; ADR-0012 §4 and §5).
//
// The board's brief for this row was one sentence and it names the whole problem: the
// `NEEDS_REPAIR`/`HEALED` hysteresis has to be VISIBLE, or menders look indecisive.
//
// The engine attracts a repairer to a friendly only once it drops below `NEEDS_REPAIR` (0.85), and
// once committed keeps it there until `HEALED` (0.985) — so a building nicked by a hair cannot yank
// a repairer back and forth. That gap is deliberate, and it produces a band, 85%–98.5%, where a
// damaged building will simply be **left alone**. A panel that showed one "damaged" state would
// have a player watching a 90% wall that nobody comes to fix and concluding the Menders are broken.
// So the band is a state of its own here, with a name.
//
// Two things this module deliberately does NOT do:
//
//  1. **It never calls `countRepairJobs`.** That function looks exactly like the query this wants
//     and it is a MUTATOR — it walks every unit's order and writes a `repairers` tally onto every
//     building and unit in the game. Calling it from a panel would have the view writing sim state
//     on a frame: an ADR-0008 violation and a determinism bug that would appear only while a panel
//     happened to be open. This is the second time this exact trap has been found in this codebase
//     (`countLogistics`, P2-T13), which is why it is worth a paragraph rather than a line.
//  2. **It does not re-derive the target.** `pickRepairTarget` is pure, so it is asked.

import { HEALED, NEEDS_REPAIR, pickRepairTarget } from "../engine/index.js";

/**
 * Where an entity sits against the two thresholds.
 *
 * `worn` is the one that exists because of the hysteresis, and the one worth reading twice: the
 * entity is damaged, and **nothing is coming**. It will not attract a repairer until it drops below
 * `NEEDS_REPAIR`.
 *
 * There is no "healthy": above `HEALED` the engine has released the entity and nothing will ever be
 * dispatched to it, so it is not in this panel at all. That filter is load-bearing rather than
 * tidy — see `repairPanelModel` on decay.
 */
export type RepairState = "worn" | "needsRepair" | "healing";

export interface RepairEntry {
  readonly id: string;
  readonly type: string;
  readonly kind: "building" | "unit";
  readonly hp: number;
  readonly maxHp: number;
  /** 0..1. */
  readonly fraction: number;
  readonly state: RepairState;
  /** How many repairers are on their way or on site. Counted read-only — see the header. */
  readonly repairers: number;
  /** True for the one entity `pickRepairTarget` would choose for this repairer right now. */
  readonly isNextTarget: boolean;
}

export interface RepairPanelModel {
  /** The engine's own thresholds, so the UI can draw the band rather than describe it. */
  readonly needsRepairAt: number;
  readonly healedAt: number;
  /** Everything damaged, most-worn first — the order `pickRepairTarget` itself prefers. */
  readonly entries: readonly RepairEntry[];
  /** `pickRepairTarget`'s own answer, or null when it would pick nothing. */
  readonly nextTargetId: string | null;
  /** Units currently carrying a repair order. */
  readonly activeRepairers: number;
  /**
   * True when something is damaged and NOTHING will be dispatched to it — every damaged entity is
   * in the hysteresis band. The single most confusing state in the system, stated outright.
   */
  readonly nothingWillBeDispatched: boolean;
}

const EMPTY: RepairPanelModel = {
  needsRepairAt: NEEDS_REPAIR,
  healedAt: HEALED,
  entries: [],
  nextTargetId: null,
  activeRepairers: 0,
  nothingWillBeDispatched: false,
};

/**
 * Everything below the engine's release point, worst first.
 *
 * **The filter is `< HEALED`, not `< maxHp`, and that is not a nicety.** Odyssey structures WEAR
 * OUT: `updateDecay` sheds 0.06% of max HP per second from every completed building, down to a 35%
 * floor (`engine/sim.js`). So `hp < maxHp` is true for every building a player owns, permanently,
 * from the first second of the match — a panel filtering on "damaged" would list the entire base
 * forever and mean nothing.
 *
 * The same decay is why the `worn` band is the *normal* state rather than an edge case: a building
 * takes roughly four minutes to drift from full down to `NEEDS_REPAIR`, and spends all of it
 * visibly damaged with nothing coming. That is precisely the stretch this panel exists to explain.
 *
 * @param from Where the repairer is standing. Targeting is zone-first and distance-tied, so "what
 *   would be repaired next" has no answer without a point to ask from — which is itself worth
 *   surfacing: the answer legitimately differs per Mender.
 */
export function repairPanelModel(
  state: State,
  owner: OwnerId,
  from: { x: number; y: number },
  excludeId?: string,
): RepairPanelModel {
  if (!state.players?.[owner]) return EMPTY;

  const repairersBy = countRepairersReadOnly(state);
  const exclude = excludeId ? getOwned(state, excludeId) : null;

  // Asked, not predicted. `isClaimed` is left at its default: the ≤2-workers-per-target cap is
  // `assignRepair`'s own policy and its constant is module-private upstream, so this reports what
  // `pickRepairTarget` answers rather than a copy of a caller's cap that could drift from it.
  const next = pickRepairTarget(state, owner, from.x, from.y, { exclude });

  const entries: RepairEntry[] = [];
  const consider = (e: Building | Unit, kind: "building" | "unit"): void => {
    if (e.owner !== owner || e.hp <= 0 || e.hp >= e.maxHp) return;
    if (kind === "building" && (e as Building).constructing) return;
    const fraction = e.hp / e.maxHp;
    if (fraction >= HEALED) return;   // released by the engine — see the note on decay above
    const repairers = repairersBy.get(e.id) ?? 0;
    entries.push({
      id: e.id,
      type: e.type,
      kind,
      hp: e.hp,
      maxHp: e.maxHp,
      fraction,
      state: stateFor(fraction, repairers),
      repairers,
      isNextTarget: next !== null && (next as { id: string }).id === e.id,
    });
  };

  for (const b of state.buildings.values()) consider(b, "building");
  for (const u of state.units.values()) consider(u, "unit");

  // Most-worn first, id breaking ties — never Map iteration order, so two identical states produce
  // an identical panel (the same rule the engine's own scans follow).
  entries.sort((a, b) => a.fraction - b.fraction || (a.id < b.id ? -1 : 1));

  const damaged = entries.length > 0;
  return {
    needsRepairAt: NEEDS_REPAIR,
    healedAt: HEALED,
    entries,
    nextTargetId: next ? (next as { id: string }).id : null,
    activeRepairers: [...repairersBy.values()].reduce((a, b) => a + b, 0),
    nothingWillBeDispatched: damaged && next === null && entries.every((e) => e.state !== "healing"),
  };
}

function stateFor(fraction: number, repairers: number): RepairState {
  if (fraction < NEEDS_REPAIR) return "needsRepair";
  // The hysteresis band. Committed work continues through it; nothing new is attracted into it.
  return repairers > 0 ? "healing" : "worn";
}

/**
 * Who is being repaired, by counting repair ORDERS — the read-only half of `countRepairJobs`.
 *
 * Counting an order is observation. Writing the tally onto the entity, which is what the engine's
 * own version does, is simulation, and it belongs in the tick and not in a panel.
 */
function countRepairersReadOnly(state: State): Map<string, number> {
  const byTarget = new Map<string, number>();
  for (const u of state.units.values()) {
    const o = u.order;
    if (o?.type !== "repair" || !o.targetId) continue;
    byTarget.set(o.targetId, (byTarget.get(o.targetId) ?? 0) + 1);
  }
  return byTarget;
}

function getOwned(state: State, id: string): Building | Unit | null {
  return state.buildings.get(id) ?? state.units.get(id) ?? null;
}
