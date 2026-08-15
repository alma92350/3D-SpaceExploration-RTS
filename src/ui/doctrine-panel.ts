// The Refinery doctrine panel's model (P2-T12, ADR-0012 §4 and §5).
//
// Same shape as the research panel and for the same reason (Q-10): a pure model, tested without a
// DOM, composed rather than grown into `hudModel`. Availability is **asked, not predicted** — a dry
// run of `researchUpgrade` itself, because its gating has a rule nobody would think to copy, and it
// is the OPPOSITE of the tech tree's:
//
//   `researchTech` counts a prerequisite as met if it is queued ahead on the same Datacenter.
//   `researchUpgrade` does NOT — a Refinery job queued ahead does not satisfy its successor.
//
// Two panels, two contradictory rules, one function name apart. Copying either into a predicate
// here would produce a panel that is right about one path and wrong about the other.
//
// What makes this panel different from the research panel is not the gating, it is the
// **irreversibility**. Researching a tech spends resources. Committing to a doctrine spends the
// other two doctrines, for the rest of the match, on a single click — and the engine's own answer
// for a locked-out upgrade is a bare `false`, indistinguishable from "you cannot afford it". So the
// model states the commitment before it happens, which is the trade-off P2-T12 asks for.

import {
  UPGRADES, type UpgradeDef, canAfford, committedDoctrine, prereqsMet, researchUpgrade,
} from "../engine/index.js";

export type DoctrineId = "assault" | "bulwark" | "logistics";
export type UpgradeState = "done" | "queued" | "available" | "blocked";

/**
 * One numeric effect, straight off the engine's def.
 *
 * `value` is the engine's raw multiplier, not a percentage: 1.15, not "+15%". Converting here would
 * be this module doing arithmetic on a balance number, which is exactly what ADR-0012 §5 forbids —
 * and a sign error in that conversion is invisible until someone counts damage in a real fight.
 * The sentence a player reads is `desc`, which is the engine's own words about its own numbers.
 */
export interface UpgradeEffect {
  readonly field: string;
  readonly value: number;
}

export interface UpgradeEntry {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly tier: number;
  readonly costText: string;
  readonly timeSeconds: number;
  readonly state: UpgradeState;
  readonly canStart: boolean;
  /** Why not. `"doctrine"` is the one that is permanent. */
  readonly blockedBy: "cost" | "prereq" | "doctrine" | null;
  readonly effects: readonly UpgradeEffect[];
}

export interface DoctrinePath {
  readonly doctrine: DoctrineId;
  readonly upgrades: readonly UpgradeEntry[];
  /** The player committed elsewhere; nothing on this path can ever be researched this match. */
  readonly lockedOut: boolean;
}

export interface DoctrineQueueEntry {
  readonly id: string;
  readonly name: string;
  readonly progress: number;
}

export interface DoctrinePanelModel {
  readonly paths: readonly DoctrinePath[];
  readonly queue: readonly DoctrineQueueEntry[];
  /** The doctrine this owner is locked into, or null while all three are still open. */
  readonly committed: DoctrineId | null;
  /**
   * True only while NOTHING has been committed. The one moment the choice is live, and the only
   * moment a warning about permanence is worth showing.
   */
  readonly choiceIsOpen: boolean;
}

const EMPTY: DoctrinePanelModel = { paths: [], queue: [], committed: null, choiceIsOpen: false };

const DOCTRINES: readonly DoctrineId[] = ["assault", "bulwark", "logistics"];

/** Effect fields are anything numeric that is not bookkeeping. Listed, not guessed at by suffix. */
const NON_EFFECT_KEYS = new Set(["tier", "time"]);

export function doctrinePanelModel(state: State, buildingId: string): DoctrinePanelModel {
  const building = state.buildings.get(buildingId);
  // Doctrines are researched at a Refinery and nowhere else — `researchUpgrade` refuses anything
  // else outright, so a panel elsewhere would offer buttons the engine silently ignores (F-07).
  if (!building || building.type !== "refinery") return EMPTY;

  const owner = building.owner;
  const player = state.players[owner];
  const queue = building.researchQueue ?? [];
  const queuedIds = new Set(queue.map((j) => j.techId));
  const committed = (committedDoctrine(state, owner) ?? null) as DoctrineId | null;

  const paths: DoctrinePath[] = DOCTRINES.map((doctrine) => {
    const lockedOut = committed !== null && committed !== doctrine;
    const defs = Object.values(UPGRADES)
      // `.doctrine` rather than table membership: `hardEdge` is `aiOnly` and carries none, and the
      // engine's own `committedDoctrine` guards the same way for the same reason.
      .filter((d) => d.doctrine === doctrine)
      .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));

    return {
      doctrine,
      lockedOut,
      upgrades: defs.map((def) => entryFor(state, buildingId, def, owner, player, queuedIds, lockedOut)),
    };
  });

  return {
    paths,
    committed,
    choiceIsOpen: committed === null,
    queue: queue.map((j) => ({
      id: j.techId, name: UPGRADES[j.techId]?.name ?? j.techId, progress: j.progress,
    })),
  };
}

function entryFor(
  state: State,
  buildingId: string,
  def: UpgradeDef,
  owner: OwnerId,
  player: { upgrades: Record<string, unknown>; resources: Resources },
  queuedIds: Set<string>,
  lockedOut: boolean,
): UpgradeEntry {
  const id = def.id;
  const done = Boolean(player.upgrades[id]);
  const queued = queuedIds.has(id);
  const canStart = !done && !queued && dryRunUpgrade(state, buildingId, id);

  return {
    id,
    name: def.name,
    desc: def.desc ?? "",
    tier: def.tier ?? 0,
    costText: costText(def),
    timeSeconds: def.time ?? 0,
    state: done ? "done" : queued ? "queued" : canStart ? "available" : "blocked",
    canStart,
    blockedBy: done || queued || canStart ? null : reasonFor(state, owner, player, def, lockedOut),
    effects: effectsOf(def),
  };
}

/**
 * Would `researchUpgrade` accept this right now?
 *
 * Called for real and undone, exactly as the research panel does it — the same trade and the same
 * restore-in-place discipline. `researchUpgrade` mutates two things on success: it pays the cost
 * and pushes one queue entry.
 *
 * Restoring the queue by TRUNCATION rather than by assigning a saved copy is not stylistic. The
 * caller above is holding a reference to `building.researchQueue` while this runs, and replacing
 * the array leaves it reading the mutated one — which surfaced in the research panel as a third
 * tech in a queue of two, and would surface here as a phantom doctrine commitment, which is worse:
 * `committedDoctrine` reads the queue, so a phantom entry would lock out two real paths.
 */
function dryRunUpgrade(state: State, buildingId: string, upgradeId: string): boolean {
  const building = state.buildings.get(buildingId)!;
  const res = state.players[building.owner].resources;
  const savedResources = { ...res };
  const existed = building.researchQueue !== undefined;
  const savedLength = building.researchQueue?.length ?? 0;

  const allowed = researchUpgrade(state, buildingId, upgradeId);
  if (!allowed) return false;

  for (const key of Object.keys(res)) delete res[key];
  Object.assign(res, savedResources);
  if (existed) building.researchQueue!.length = savedLength;
  else delete building.researchQueue;
  return true;
}

/**
 * Phrasing only, never a decision — but here the phrasing carries information the engine's bare
 * `false` does not, and it is the difference between "come back when you're richer" and "this is
 * gone for the rest of the match". Doctrine is checked first for that reason: a locked-out upgrade
 * is not a pricing question and never becomes one.
 */
function reasonFor(
  state: State,
  owner: OwnerId,
  player: { resources: Resources },
  def: UpgradeDef,
  lockedOut: boolean,
): "cost" | "prereq" | "doctrine" {
  if (lockedOut) return "doctrine";
  // Unlike the tech tree, a queued job does NOT meet its successor's prerequisite here, so the
  // requirement list is checked as-is rather than minus the queue.
  if (!prereqsMet(state, owner, def)) return "prereq";
  return canAfford(player.resources, def.cost ?? {}) ? "prereq" : "cost";
}

/**
 * Every numeric field on the def that is not bookkeeping, verbatim.
 *
 * Not filtered by a `*Mult` suffix: `selfSealingPlating` grants `regenRate` and `regenDelay`, which
 * are effects and do not match it, and a suffix rule would drop the entire Bulwark capstone's
 * payload while looking like it worked.
 */
function effectsOf(def: UpgradeDef): UpgradeEffect[] {
  const out: UpgradeEffect[] = [];
  for (const [field, value] of Object.entries(def)) {
    if (typeof value !== "number" || NON_EFFECT_KEYS.has(field)) continue;
    out.push({ field, value });
  }
  return out;
}

function costText(def: UpgradeDef): string {
  return Object.entries(def.cost ?? {}).map(([com, qty]) => `${qty} ${com}`).join(", ");
}
