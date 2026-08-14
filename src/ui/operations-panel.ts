// Logistics, supply and the recycle preview (P2-T13/T14/T15, ADR-0012 §4).
//
// Three small models rather than one, because they answer three unrelated questions: "is my
// haulage keeping up?", "can I train anything?", and "what do I get back if I scrap this?".
//
// **`countLogistics` is not used, and that is deliberate.** It looks exactly like the query the
// logistics panel wants, and it is a *mutator*: it walks every unit's order and writes
// `haulers`/`servers`/`ferriers` tallies onto buildings and freighters, which the AI's worker
// cycle calls to refresh its own bookkeeping. Calling it from a panel would have the view writing
// sim state on a frame — the thing ADR-0008's boundary exists to prevent, and a determinism bug
// that would appear only when a panel happened to be open.
//
// So the model counts, read-only. Counting an order is observation; `assignHaul`'s decision about
// which building deserves the next worker stays entirely in the engine.

import { LOGI_PRIORITIES, UNITS, canRecycle, recycleValue } from "../engine/index.js";

export interface LogisticsBuildingRow {
  readonly id: string;
  readonly type: string;
  readonly priority: "high" | "normal" | "low";
}

export interface LogisticsModel {
  readonly total: number;
  readonly hauling: number;
  readonly servicing: number;
  readonly ferrying: number;
  readonly idle: number;
  /** Doing something that is not logistics — gathering, building, moving. */
  readonly other: number;
  readonly priorities: readonly string[];
  readonly byBuilding: ReadonlyMap<string, LogisticsBuildingRow>;
}

export function logisticsModel(state: State, owner: OwnerId): LogisticsModel {
  let total = 0, hauling = 0, servicing = 0, ferrying = 0, idle = 0, other = 0;
  for (const u of state.units.values()) {
    if (u.owner !== owner) continue;
    // Only units that can carry anything are logistics. A Skiff with no order is not "idle
    // haulage", it is a warship standing still, and counting it would make the panel's headline
    // number meaningless the moment an army exists.
    if (!UNITS[u.type]?.canGather && !UNITS[u.type]?.cargoHold) continue;
    total++;
    const kind = u.order?.type;
    if (kind === "haul") hauling++;
    else if (kind === "service") servicing++;
    else if (kind === "ferry") ferrying++;
    else if (!kind) idle++;
    else other++;
  }

  const byBuilding = new Map<string, LogisticsBuildingRow>();
  for (const b of state.buildings.values()) {
    if (b.owner !== owner) continue;
    byBuilding.set(b.id, {
      id: b.id,
      type: b.type,
      // Unset means the engine's default rather than "no priority" — `issueSetLogiPriority` only
      // writes the field when a player changes it.
      priority: b.logiPriority ?? "normal",
    });
  }

  return { total, hauling, servicing, ferrying, idle, other, priorities: [...LOGI_PRIORITIES], byBuilding };
}

export interface SupplyModel {
  readonly text: string;
  readonly fraction: number;
  readonly blocked: boolean;
  /** What to do about it, or null. Present only when there is something to do. */
  readonly advice: string | null;
}

/**
 * Supply, stated rather than implied.
 *
 * The MVP showed "3 / 3" and let the player discover the cap by clicking a train button that did
 * nothing. Being supply-blocked is a thing to *act on* — build a Habitat — so the model says so
 * instead of leaving it to be inferred from a failure.
 */
export function supplyModel(used: number, cap: number): SupplyModel {
  const blocked = used >= cap;
  return {
    text: `${used} / ${cap}`,
    // A cap of zero is a real state at the very start of a match, and dividing by it would put
    // `Infinity` into a progress bar's width.
    fraction: cap > 0 ? Math.min(1, used / cap) : 1,
    blocked,
    advice: blocked ? "Supply is full — build a Habitat to raise the cap" : null,
  };
}

export interface RecycleRefund {
  readonly com: string;
  readonly qty: number;
}

export interface RecyclePreview {
  readonly canRecycle: boolean;
  readonly refund: readonly RecycleRefund[];
}

/**
 * What scrapping this actually returns, asked of the engine before committing.
 *
 * `recycleValue` counts a fraction of the build cost **plus everything in the entity's buffers** —
 * a factory holding 30 metals refunds those too. A panel that showed a slice of the build cost
 * would understate a full building badly, and the player would find out only after it was gone.
 */
export function recyclePreview(state: State, entityId: string): RecyclePreview {
  const entity = state.buildings.get(entityId) ?? state.units.get(entityId);
  if (!entity || !canRecycle(entity)) return { canRecycle: false, refund: [] };
  const value = recycleValue(state, entity);
  return {
    canRecycle: true,
    refund: Object.entries(value).map(([com, qty]) => ({ com, qty })),
  };
}
