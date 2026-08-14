// The research panel's model (P2-T11, ADR-0012 §4 and §5).
//
// Availability is **asked, not predicted**. `researchTech` gates on six things in order — the
// building is a finished Datacenter, the tech is not already researched, not already queued, it
// exists, its prerequisites are met, and the player can afford it — and one of those rules is the
// kind nobody would think to copy: a prerequisite counts as met if it is *queued ahead on this
// same Datacenter*, because it will finish first.
//
// So `canStart` is a **dry run of the engine's own function**, not a reimplementation of its list.
// The cost is one speculative call per tech per panel open, which is nothing; the alternative is a
// second copy of the tech tree that goes wrong the first time upstream edits the first.
//
// `blockedBy` is separate from `canStart` and is genuinely derived here, because the engine returns
// a bare `false`. It is used only to phrase the reason, never to decide.

import { TECHS, canAfford, prereqsMet, researchTech, type TechDef } from "../engine/index.js";

export type TechState = "done" | "queued" | "available" | "blocked";

export interface ResearchEntry {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly costText: string;
  readonly state: TechState;
  readonly canStart: boolean;
  /** Why not, when `canStart` is false and the tech is neither done nor queued. */
  readonly blockedBy: "cost" | "prereq" | null;
}

export interface ResearchQueueEntry {
  readonly id: string;
  readonly name: string;
  readonly progress: number;
}

export interface ResearchPanelModel {
  readonly entries: readonly ResearchEntry[];
  readonly queue: readonly ResearchQueueEntry[];
}

const EMPTY: ResearchPanelModel = { entries: [], queue: [] };

export function researchPanelModel(state: State, buildingId: string): ResearchPanelModel {
  const building = state.buildings.get(buildingId);
  // Research happens at a Datacenter and nowhere else. Rendering the panel for anything else would
  // offer buttons the engine silently refuses (F-07).
  if (!building || building.type !== "datacenter") return EMPTY;

  const player = state.players[building.owner];
  const queue = building.researchQueue ?? [];
  const queuedIds = new Set(queue.map((j) => j.techId));

  const entries: ResearchEntry[] = [];
  for (const [id, def] of Object.entries(TECHS)) {
    const done = Boolean(player.upgrades[id]);
    const queued = queuedIds.has(id);
    const canStart = !done && !queued && dryRunResearch(state, buildingId, id);
    entries.push({
      id,
      name: def.name,
      desc: def.desc ?? "",
      costText: costText(def),
      state: done ? "done" : queued ? "queued" : canStart ? "available" : "blocked",
      canStart,
      blockedBy: done || queued || canStart ? null : reasonFor(state, building.owner, def, queuedIds),
    });
  }

  return {
    entries,
    queue: queue.map((j) => ({ id: j.techId, name: TECHS[j.techId]?.name ?? j.techId, progress: j.progress })),
  };
}

/**
 * Would `researchTech` accept this right now?
 *
 * It is called for real and then undone, because it is the only way to get the engine's answer
 * without owning a copy of its rules. `researchTech` mutates exactly two things when it succeeds —
 * it pays the cost and pushes a queue entry — and both are restored here.
 *
 * A `canResearch` predicate upstream would be better and this is where it would be used; until
 * then, this is the honest version of "ask, do not predict".
 */
function dryRunResearch(state: State, buildingId: string, techId: string): boolean {
  const building = state.buildings.get(buildingId)!;
  const res = state.players[building.owner].resources;
  const savedResources = { ...res };
  const existed = building.researchQueue !== undefined;
  const savedLength = building.researchQueue?.length ?? 0;

  const allowed = researchTech(state, buildingId, techId);
  if (!allowed) return false;

  for (const key of Object.keys(res)) delete res[key];
  Object.assign(res, savedResources);
  // Truncate IN PLACE rather than assigning a saved copy back. `researchTech` only ever pushes one
  // entry, so a length reset is exact — and replacing the array instead would leave anything that
  // captured a reference to the old one (this module's own `queue`, three lines up in the caller)
  // holding the mutated version. That aliasing bug showed up as a third tech appearing in a queue
  // of two, and it is the reason this restores in place.
  if (existed) building.researchQueue!.length = savedLength;
  else delete building.researchQueue;
  return true;
}

/**
 * Phrasing only, never a decision.
 *
 * The engine returns a bare `false`, and "you cannot afford this" and "you have not unlocked its
 * prerequisite" send a player to two completely different places. Prerequisites are checked first
 * because a node you cannot reach yet is not really a pricing question.
 */
function reasonFor(
  state: State,
  owner: OwnerId,
  def: TechDef,
  queuedIds: Set<string>,
): "cost" | "prereq" {
  const remaining = (def.requires ?? []).filter((r) => !queuedIds.has(r));
  if (!prereqsMet(state, owner, { requires: remaining })) return "prereq";
  return canAfford(state.players[owner].resources, def.cost) ? "prereq" : "cost";
}

function costText(def: TechDef): string {
  return Object.entries(def.cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}
