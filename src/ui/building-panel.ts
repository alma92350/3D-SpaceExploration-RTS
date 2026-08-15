// The building detail panel's model (P2-T09, ADR-0012 §4).
//
// Its own module, not another branch of `hudModel`. Six more panels in that function would make a
// function nobody can test a branch of, and each panel's question is genuinely separate: this one
// answers "what is this building doing, and if nothing, why?".
//
// **The stop reason is not decided here.** `snapshot.production.concern` already carries the
// engine's own `buildingConcern` code, priority-ordered to match `updateProduction`'s gating
// exactly. This turns a code into a sentence and nothing more. Looking at the buffers and deciding
// for ourselves would be a second copy of the rule, wrong the first time upstream reorders its
// gating, and the disagreement would read as the UI lying — because it would be.

import { BUILDINGS, isElectrifiable } from "../engine/index.js";
import {
  CONCERN_BUFFER_FULL, CONCERN_NONE, CONCERN_NO_FUEL, CONCERN_NO_POWER, CONCERN_PAUSED,
  CONCERN_STARVED, CONCERN_THROTTLED, FLAG_BUILDING_KIND, engineId,
  type BuildingBuffers, type Snapshot,
} from "../bridge/snapshot.js";

/** One commodity in a buffer, with the room it has — enough to draw a bar rather than a number. */
export interface BufferEntry {
  readonly com: string;
  readonly qty: number;
  readonly cap: number;
  readonly fraction: number;
}

export interface BuildingPanelModel {
  /** Null unless exactly one building is selected. */
  readonly building: { readonly id: string; readonly label: string; readonly type: string } | null;
  /** "2 ore → 2 metals", or null for a building with no recipe. */
  readonly recipeText: string | null;
  readonly statusText: string;
  /** What the player should do about it, if anything. Never colour alone in the DOM (N-05). */
  readonly severity: "ok" | "warn" | "bad" | "paused";
  readonly fed: number;
  readonly output: number;
  readonly inputs: readonly BufferEntry[];
  readonly outputs: readonly BufferEntry[];
  readonly canPause: boolean;
  readonly canElectrify: boolean;
}

const EMPTY: BuildingPanelModel = {
  building: null, recipeText: null, statusText: "", severity: "ok",
  fed: 0, output: 0, inputs: [], outputs: [], canPause: false, canElectrify: false,
};

/**
 * Each stop code as a sentence, and the severity a player should read from it.
 *
 * Every one of these is a *different thing to do*, which is why the engine keeps them distinct and
 * why this table does not collapse them into "stopped": starved means haul inputs in, buffer-full
 * means haul output away, no-power means build or fuel a source, throttled means the grid is
 * oversubscribed and everything is running slow.
 *
 * Throttled is a **warning, not a stop** — the factory is producing, just slower. Painting it the
 * same as starved would send a player to fix the wrong thing.
 */
const STATUS: Record<number, { text: string; severity: BuildingPanelModel["severity"] }> = {
  [CONCERN_NONE]: { text: "Running", severity: "ok" },
  [CONCERN_PAUSED]: { text: "Paused", severity: "paused" },
  [CONCERN_NO_POWER]: { text: "No power — the grid has no active source in reach", severity: "bad" },
  [CONCERN_NO_FUEL]: { text: "Out of fuel — nothing has been hauled in to burn", severity: "bad" },
  [CONCERN_STARVED]: { text: "Waiting on inputs — its larder is short", severity: "bad" },
  [CONCERN_BUFFER_FULL]: { text: "Output buffer full — nothing is hauling it away", severity: "bad" },
  [CONCERN_THROTTLED]: { text: "Throttled — the grid is oversubscribed", severity: "warn" },
};

export function buildingPanelModel(snap: Snapshot): BuildingPanelModel {
  if (snap.selection.length !== 1) return EMPTY;
  const id = snap.selection[0]!;
  const index = indexOfSelected(snap, id);
  if (index === null) return EMPTY;

  const type = snap.typeNames[snap.entities.typeIndex[index]!]!;
  const def = BUILDINGS[type];
  const buffers = snap.buffers.get(id) ?? null;
  const recipeIndex = snap.production.recipe[index]!;
  const status = STATUS[snap.production.concern[index]!] ?? STATUS[CONCERN_NONE]!;

  return {
    building: { id, label: def?.name ?? type, type },
    recipeText: recipeTextOf(buffers),
    statusText: status.text,
    severity: status.severity,
    fed: snap.production.fed[index]!,
    output: snap.production.output[index]!,
    // No buffers means the selection did not carry them, which is not the same claim as "the
    // buffers are empty". Showing zeroes would be inventing a fact (Q-07).
    inputs: buffers ? entriesOf(buffers.input, buffers.inputCap) : [],
    outputs: buffers ? entriesOf(buffers.output, buffers.outputCap) : [],
    // A building with no recipe has nothing to pause, and a button the engine will ignore is worse
    // than no button (F-07: every control the HUD offers does something).
    canPause: recipeIndex >= 0,
    canElectrify: isElectrifiable(type),
  };
}

function indexOfSelected(snap: Snapshot, id: string): number | null {
  const e = snap.entities;
  for (let i = 0; i < e.count; i++) {
    if ((e.flags[i]! & FLAG_BUILDING_KIND) === 0) continue;
    if (engineId(e.ids[i]!) === id) return i;
  }
  return null;
}


/**
 * "2 ore → 2 metals", from the engine's own recipe.
 *
 * Energy is dropped deliberately: it is a power *flow*, not a hauled good — `updateProduction`
 * skips it when drawing inputs — so listing it would send a player looking for energy to haul.
 */
function recipeTextOf(buffers: BuildingBuffers | null): string | null {
  const recipe = buffers?.recipe;
  if (!recipe) return null;
  const inputs = Object.entries(recipe.in)
    .filter(([com]) => com !== "energy")
    .map(([com, qty]) => `${qty} ${com}`)
    .join(" + ");
  return `${inputs} → ${recipe.qty} ${recipe.out}`;
}

function entriesOf(buffer: Record<string, number>, cap: number): BufferEntry[] {
  const out: BufferEntry[] = [];
  for (const com in buffer) {
    out.push({ com, qty: buffer[com]!, cap, fraction: cap > 0 ? buffer[com]! / cap : 0 });
  }
  return out;
}
