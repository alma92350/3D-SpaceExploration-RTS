// The HUD (P1-T16). Plain DOM, no framework (ADR-0007), and — the part that matters — no state.
//
// PRD F-07 says "no state lives only in the HUD". So the whole panel is a **pure function of a
// snapshot**: `hudModel(snapshot)` produces the numbers and labels, and `renderHud` writes them
// into the DOM. Nothing is remembered between frames, which means the HUD can never disagree with
// the simulation, and the whole thing is testable without a browser.
//
// The DOM write is separated from the model for a second reason: it is the only part that costs
// anything, and at 60 fps it must not touch a node whose text has not changed. Browsers are fast
// but layout is not free, and this runs inside the same 16.6 ms as the renderer.

import { BUILDINGS, UNITS } from "../engine/index.js";
import { type BuildingPanelModel, buildingPanelModel } from "./building-panel.js";
import { type Intent } from "../bridge/commands.js";
import { doctrinePanelModel } from "./doctrine-panel.js";
import { logisticsModel, recyclePreview, supplyModel } from "./operations-panel.js";
import { marketPanelModel } from "./market-panel.js";
import { repairPanelModel } from "./repair-panel.js";
import { researchPanelModel } from "./research-panel.js";
import { rigSurveyModel, rigYieldModel } from "./rig-panel.js";
import { FLAG_BUILDING_KIND, type Snapshot } from "../bridge/snapshot.js";

export interface SelectionEntry {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly isBuilding: boolean;
  readonly rank: number;
}

export interface ProductionOption {
  readonly unitType: string;
  readonly label: string;
  readonly costText: string;
  readonly affordable: boolean;
}

export interface BuildOption {
  readonly buildingType: string;
  readonly label: string;
  readonly costText: string;
  readonly affordable: boolean;
}

/**
 * What pressing a HUD button does.
 *
 * An `intent` goes straight to `bridge.enqueue`; a `buildMode` arms the placement mode instead,
 * because a structure is not ordered until the player has picked the ground. Data rather than a
 * closure, for the reason `bridge/commands.ts` gives about intents: a closure cannot be recorded,
 * replayed, or asserted on in a test without a DOM.
 */
export type HudCommand =
  | { readonly kind: "intent"; readonly intent: Intent }
  | { readonly kind: "buildMode"; readonly buildingType: string };

/**
 * One button the HUD is showing.
 *
 * `id` is identity, not decoration: it is what the DOM writer compares to decide whether the button
 * SET changed, and rebuilding a row whose set has not changed is both garbage and a lost click.
 *
 * A disabled button is still shown (F-07's "every number the HUD shows is real" cuts the other way
 * here — hiding what a player cannot afford leaves them with an empty menu and no idea why), and
 * clicking it still enqueues, so the engine's own refusal is what explains it.
 */
export interface HudAction {
  readonly id: string;
  readonly label: string;
  /** The cost, the refund, or the reason it is closed. Struck through when `enabled` is false. */
  readonly detail: string;
  readonly enabled: boolean;
  readonly command: HudCommand;
}

export interface HudModel {
  /**
   * What to do next, or null once the player is under way.
   *
   * S6 asks that a first-time player work out what to click WITHOUT documentation, and the opening
   * gives them one ship on an unexplored map with no visible affordance. This is the interface
   * answering the question rather than a tutorial: one line, only while the player has no base,
   * derived entirely from the snapshot so it cannot drift out of step with the world.
   */
  readonly prompt: string | null;
  /**
   * True when a colony ship is selected. The Odyssey opening is "land, then deploy", and S6 asks
   * that a first-time player find what to click WITHOUT documentation — so the one action available
   * at t=0 gets its own prominent button rather than hiding behind a hotkey they have not read.
   */
  readonly canDeploy: boolean;
  readonly ore: number;
  readonly crystals: number;
  readonly radioactives: number;
  readonly credits: number;
  readonly supplyText: string;
  readonly supplyBlocked: boolean;
  readonly selection: readonly SelectionEntry[];
  readonly selectionSummary: string;
  /** Unit options for the single selected production building, if that is what is selected. */
  readonly production: readonly ProductionOption[];
  /** Structures a selected worker can start. Empty unless a worker is selected. */
  readonly builds: readonly BuildOption[];
  readonly tickText: string;
  /**
   * The selected building's detail, composed in rather than inlined (ADR-0012 §4).
   *
   * `hudModel` calls `buildingPanelModel` and hands the result through. That is what "composed"
   * means here: one model per panel, each testable alone, assembled at the top rather than grown
   * into one function with six branches.
   */
  readonly buildingDetail: BuildingPanelModel;
  /**
   * The action row, in order — deploy, then production, then builds.
   *
   * Ordered because the order is a CONTROL: upstream's Z/C/V/B/N are positional action keys that
   * fire the Nth button the HUD is showing, and `input/intents.ts` has documented that convention
   * since the MVP while having no button list to point it at. This is that list. `production` and
   * `builds` above stay as they are — they are what the panel tests asserted on before this existed
   * and they are still the honest description of what is offered; `actions` is the same information
   * flattened into the sequence a key press indexes into.
   */
  readonly actions: readonly HudAction[];
}

/** The MVP's build menu. A deliberate subset — the rest of the roster is Phase 2 (PRD §5). */
export const MVP_BUILDINGS = ["command", "barracks", "habitat", "refinery", "turret"] as const;

export function hudModel(snap: Snapshot): HudModel {
  const e = snap.entities;
  const selection: SelectionEntry[] = [];
  const byId = new Map<string, number>();
  for (let i = 0; i < e.count; i++) byId.set(engineId(e.ids[i]!), i);

  for (const id of snap.selection) {
    const i = byId.get(id);
    if (i === undefined) continue;                     // selected but no longer visible
    const isBuilding = (e.flags[i]! & FLAG_BUILDING_KIND) !== 0;
    const type = snap.typeNames[e.typeIndex[i]!]!;
    selection.push({
      id, type, isBuilding,
      label: (isBuilding ? BUILDINGS[type]?.name : UNITS[type]?.name) ?? type,
      hp: Math.round(e.hp[i]!),
      maxHp: Math.round(e.maxHp[i]!),
      rank: e.rank[i]!,
    });
  }

  const res = snap.resources;
  const affordable = (cost: Resources | undefined): boolean => {
    if (!cost) return true;
    for (const [com, qty] of Object.entries(cost)) {
      const have = com === "ore" ? res.ore : com === "crystals" ? res.crystals : com === "radioactives" ? res.radioactives : 0;
      if (have < qty) return false;
    }
    return true;
  };

  const production: ProductionOption[] = [];
  const singleBuilding = selection.length > 0 && selection.every((s) => s.isBuilding && s.type === selection[0]!.type)
    ? selection[0]!
    : null;
  if (singleBuilding) {
    for (const unitType of BUILDINGS[singleBuilding.type]?.produces ?? []) {
      const def = UNITS[unitType];
      // Odyssey-gated units (colony ships, freighters) are Phase 4's; showing a button that the
      // engine will refuse is worse than not showing it (F-07: every number the HUD shows is real).
      if (!def || def.odysseyOnly) continue;
      production.push({
        unitType, label: def.name, costText: costText(def.cost), affordable: affordable(def.cost),
      });
    }
  }

  const canDeploy = selection.some((s) => s.type === "colonyship");

  const hasBase = (() => {
    for (let i = 0; i < e.count; i++) {
      if (e.owner[i] !== 0) continue;
      if ((e.flags[i]! & FLAG_BUILDING_KIND) === 0) continue;
      if (snap.typeNames[e.typeIndex[i]!] === "command") return true;
    }
    return false;
  })();
  const prompt = hasBase
    ? null
    : canDeploy
      ? "Press Deploy base to found your Command Center."
      : "Click your colony ship to select it.";

  const builds: BuildOption[] = [];
  const hasWorker = selection.some((s) => !s.isBuilding && UNITS[s.type]?.buildCategories?.length);
  if (hasWorker) {
    for (const buildingType of MVP_BUILDINGS) {
      const def = BUILDINGS[buildingType];
      if (!def) continue;
      builds.push({
        buildingType, label: def.name, costText: costText(def.cost), affordable: affordable(def.cost),
      });
    }
  }

  // The positional row. Deploy first because at t=0 it is the only thing there is to do, which is
  // what put it on Z in the first place (see `translateKey`'s note on the positional keys).
  const actions: HudAction[] = [];
  if (canDeploy) {
    actions.push({
      id: "deploy",
      label: "Deploy base",
      detail: "founds a Command Center here",
      enabled: true,
      command: { kind: "intent", intent: { kind: "deploy" } },
    });
  }
  for (const p of production) {
    actions.push({
      id: `train:${p.unitType}`,
      label: p.label,
      detail: p.costText,
      enabled: p.affordable,
      // `singleBuilding` is non-null whenever `production` is non-empty — that is the condition it
      // was filled under, twenty lines up.
      command: { kind: "intent", intent: { kind: "train", buildingId: singleBuilding!.id, unitType: p.unitType } },
    });
  }
  for (const b of builds) {
    actions.push({
      id: `build:${b.buildingType}`,
      label: b.label,
      detail: b.costText,
      enabled: b.affordable,
      command: { kind: "buildMode", buildingType: b.buildingType },
    });
  }

  return {
    canDeploy,
    prompt,
    ore: Math.floor(res.ore),
    crystals: Math.floor(res.crystals),
    radioactives: Math.floor(res.radioactives),
    credits: Math.floor(res.credits),
    supplyText: `${res.supplyUsed} / ${res.supplyCap}`,
    supplyBlocked: res.supplyUsed >= res.supplyCap,
    selection,
    selectionSummary: summarise(selection),
    production,
    builds,
    tickText: formatClock(snap.time),
    buildingDetail: buildingPanelModel(snap),
    actions,
  };
}

function summarise(selection: readonly SelectionEntry[]): string {
  if (selection.length === 0) return "Nothing selected";
  if (selection.length === 1) return selection[0]!.label;
  const counts = new Map<string, number>();
  for (const s of selection) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
  return [...counts].map(([label, n]) => `${n}× ${label}`).join(", ");
}

function costText(cost: Resources | undefined): string {
  if (!cost) return "free";
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function engineId(numeric: number): string {
  return numeric < 0 ? `b${-numeric - 1}` : `u${numeric - 1}`;
}

// ---------------------------------------------------------------------------
// The economy (P4-T01). Still a model; still no DOM.
// ---------------------------------------------------------------------------
//
// Phase 2 built seven panel MODELS and wired none of them: six of the seven modules were imported
// by nothing, so every economy intent existed at the bridge, was tested at the bridge, and could not
// be issued by a player. This is the composition layer that was missing, and it is deliberately thin
// — it renders the panels' answers and turns a click into an intent that already exists. Every
// judgement about *whether* something can be done stays in the panel that already asks the engine.
//
// **It is a function of a tick, not of a frame.** `researchPanelModel` and `doctrinePanelModel` are
// dry runs of the engine's own gating: they call `researchTech`/`researchUpgrade` for real and undo
// them. That is correct and it is what makes them agree with the engine, but it is not something to
// do 60 times a second — and `market-panel`'s own header says prices are "read when a panel is open,
// not 20 times a second". So the caller memoises on `snap.version`, which moves exactly once per
// tick, and the expensive sections are built only when they are actually on screen.

/** The base-wide boards. Everything else follows the selection, so it needs no key. */
export type EconomyBoard = "market" | "logistics";

export interface EconomySection {
  readonly id: string;
  readonly title: string;
  /** Read-only readouts, already phrased. Plain strings so a DOM update is one write per line. */
  readonly lines: readonly string[];
  readonly actions: readonly HudAction[];
  /** The one thing that cannot be undone, said before it happens (P2-T12). */
  readonly warning: string | null;
}

export interface EconomyInput {
  /** Reused rather than recomputed: `buildingDetail` already answers "which building, and can it". */
  readonly hud: HudModel;
  readonly state: State;
  readonly snap: Snapshot;
  readonly credits: number;
  readonly board: EconomyBoard | null;
  /** Where the build ghost stands, when one is up — the Rig survey is a PLACEMENT reading (P2-T16). */
  readonly ghost: { readonly buildingType: string; readonly x: number; readonly y: number } | null;
}

export interface EconomyModel {
  readonly sections: readonly EconomySection[];
  /** Every economy control on screen, in order. Continues `HudModel.actions`' positional sequence. */
  readonly actions: readonly HudAction[];
}

/**
 * `economyModel`, rebuilt only when something it reads has moved.
 *
 * The HUD renders at 60 Hz and this model is a function of a TICK: `snap.version` moves once per
 * extraction, the selection decides which panels exist at all, and the board and the ghost are the
 * player's own view state. Everything else is the same answer, and recomputing it would be twenty
 * dry runs of the engine's research gating per frame for a number that cannot have changed.
 *
 * It lives here rather than in the shell so the property can be TESTED: `economyModel` allocates a
 * fresh object every call, so "the same object came back" is proof that nothing was rebuilt.
 */
export class EconomyCache {
  private key: string | null = null;
  private model: EconomyModel = { sections: [], actions: [] };

  get(input: EconomyInput): EconomyModel {
    const key = cacheKeyOf(input);
    if (key !== this.key) {
      this.key = key;
      this.model = economyModel(input);
    }
    return this.model;
  }
}

function cacheKeyOf(input: EconomyInput): string {
  const ghost = input.ghost;
  return [
    input.snap.version,
    input.board ?? "-",
    input.hud.buildingDetail.building?.id ?? "-",
    // The ghost is quantised. A survey reading does not change between two pixels of mouse travel,
    // and rebuilding on every pointer move would undo the point of the cache — the pointer moves far
    // more often than the tick does.
    ghost ? `${ghost.buildingType}:${Math.round(ghost.x / GHOST_CACHE_CELL)}:${Math.round(ghost.y / GHOST_CACHE_CELL)}` : "-",
  ].join("|");
}

/** Coarser than a pixel, finer than the survey radius (160) — so a real move still re-reads. */
const GHOST_CACHE_CELL = 16;

/** The building types that own a panel of their own. The engine's ids, not a display name. */
const DATACENTER = "datacenter";
const REFINERY = "refinery";
const PLASMA_RIG = "plasmarig";

export function economyModel(input: EconomyInput): EconomyModel {
  const { hud, state, snap, credits, board, ghost } = input;
  const sections: EconomySection[] = [];

  const detail = hud.buildingDetail;
  const building = detail.building ? state.buildings.get(detail.building.id) : undefined;
  if (detail.building && building) {
    const id = detail.building.id;
    sections.push(buildingSection(state, detail, building, id));
    if (building.type === DATACENTER) sections.push(researchSection(state, id));
    if (building.type === REFINERY) sections.push(doctrineSection(state, id));
    if (building.type === PLASMA_RIG) sections.push(rigSection(state, id));
  }

  if (ghost && ghost.buildingType === PLASMA_RIG) sections.push(surveySection(state, ghost));
  if (board === "market") sections.push(marketSection(state, snap, credits));
  if (board === "logistics") sections.push(logisticsSection(state, snap));

  const actions: HudAction[] = [];
  for (const s of sections) actions.push(...s.actions);
  return { sections, actions };
}

/**
 * Pause, electrify, scrap and haulage priority for the selected building.
 *
 * `canPause`/`canElectrify` are the building panel's own answers and are not re-derived here — a
 * building with no recipe has nothing to pause, and `isElectrifiable` is the engine's predicate.
 * The scrap button asks `recyclePreview`, which counts the buffers as well as a slice of the build
 * cost, so the number on the button is what the player will actually get back.
 */
function buildingSection(
  state: State,
  detail: BuildingPanelModel,
  building: Building,
  id: string,
): EconomySection {
  const actions: HudAction[] = [];

  if (detail.canPause) {
    actions.push({
      id: `pause:${id}`,
      label: building.paused ? "Resume" : "Pause",
      detail: building.paused ? "start this line again" : "stop the line without scrapping it",
      enabled: true,
      command: { kind: "intent", intent: { kind: "pause", buildingId: id, paused: !building.paused } },
    });
  }

  if (detail.canElectrify) {
    actions.push({
      id: `electrify:${id}`,
      label: building.electrified ? "Unwire" : "Electrify",
      detail: building.electrified ? "stop drawing from the grid" : "runs better, loads the grid",
      enabled: true,
      command: { kind: "intent", intent: { kind: "electrify", buildingId: id, on: !building.electrified } },
    });
  }

  // Scrap and un-scrap are the same button in two states. `canRecycle` is false while a recycle is
  // already running (the engine checks `entity.recycling` itself), so the second branch is the only
  // way back — without it a mis-clicked scrap would be unstoppable.
  const scrap = recyclePreview(state, id);
  if (scrap.canRecycle) {
    actions.push({
      id: `recycle:${id}`,
      label: "Scrap",
      detail: scrap.refund.length > 0
        ? `refunds ${scrap.refund.map((r) => `${Math.round(r.qty)} ${r.com}`).join(", ")}`
        : "no refund",
      enabled: true,
      command: { kind: "intent", intent: { kind: "recycle", entityId: id } },
    });
  } else if (building.recycling) {
    actions.push({
      id: `cancelRecycle:${id}`,
      label: "Cancel scrap",
      detail: "keep the building",
      enabled: true,
      command: { kind: "intent", intent: { kind: "cancelRecycle", entityId: id } },
    });
  }

  const logi = logisticsModel(state, "player");
  const row = logi.byBuilding.get(id);
  const lines: string[] = [];
  if (row) {
    lines.push(`Haulage priority: ${row.priority}`);
    for (const priority of logi.priorities) {
      // The engine's own list, walked rather than a copy of the three names — and the guard is what
      // keeps the cast honest if upstream ever adds a fourth. `test/input/phase2-input.test.ts`
      // asserts the two lists still match, so a new priority fails a test rather than vanishing.
      if (!isLogiPriority(priority)) continue;
      actions.push({
        id: `logi:${id}:${priority}`,
        label: `Haul ${priority}`,
        detail: priority === row.priority ? "current" : "",
        enabled: priority !== row.priority,
        command: { kind: "intent", intent: { kind: "logiPriority", buildingId: id, priority } },
      });
    }
  }

  return { id: "building", title: detail.building?.label ?? building.type, lines, actions, warning: null };
}

function isLogiPriority(value: string): value is "high" | "normal" | "low" {
  return value === "high" || value === "normal" || value === "low";
}

/**
 * The tech tree at a Datacenter, and the queue's cancel buttons.
 *
 * Everything the engine defines is listed, including what the player cannot start yet: hiding a
 * blocked node would leave a new player with a shrinking menu and no idea what unlocks it. The
 * panel already says WHY (`blockedBy`), which is the half the engine's bare `false` cannot.
 */
function researchSection(state: State, id: string): EconomySection {
  const model = researchPanelModel(state, id);
  const actions: HudAction[] = [];

  for (const entry of model.entries) {
    // A finished tech has nothing to press; a queued one has a cancel button below rather than a
    // second start button that `researchTech` would refuse.
    if (entry.state === "done" || entry.state === "queued") continue;
    actions.push({
      id: `research:${entry.id}`,
      label: entry.name,
      detail: entry.canStart ? entry.costText
        : entry.blockedBy === "cost" ? `${entry.costText} — not enough`
          : "needs an earlier technology",
      enabled: entry.canStart,
      command: { kind: "intent", intent: { kind: "research", buildingId: id, techId: entry.id } },
    });
  }

  model.queue.forEach((job, index) => {
    actions.push({
      id: `cancelResearch:${id}:${index}`,
      label: `Cancel ${job.name}`,
      detail: `${Math.round(job.progress * 100)}% done`,
      enabled: true,
      command: { kind: "intent", intent: { kind: "cancelResearch", buildingId: id, index } },
    });
  });

  const done = model.entries.filter((e) => e.state === "done").length;
  return {
    id: "research",
    title: "Research",
    lines: [`${done} of ${model.entries.length} researched · ${model.queue.length} queued`],
    actions,
    warning: null,
  };
}

/**
 * The three Refinery doctrines (P2-T12).
 *
 * The warning is the whole point of the panel and it is shown only while `choiceIsOpen`: committing
 * spends the other two paths for the rest of the match on a single click, and once that has
 * happened, warning about it is noise. A locked-out upgrade keeps its button so the player can read
 * what they gave up — pressing it returns the engine's own "closed" refusal through the notice.
 */
function doctrineSection(state: State, id: string): EconomySection {
  const model = doctrinePanelModel(state, id);
  const actions: HudAction[] = [];
  const lines: string[] = [];

  for (const path of model.paths) {
    lines.push(`${path.doctrine}${path.lockedOut ? " — closed" : ""}: ${path.upgrades.map((u) => u.name).join(", ")}`);
    for (const upgrade of path.upgrades) {
      if (upgrade.state === "done" || upgrade.state === "queued") continue;
      actions.push({
        id: `doctrine:${upgrade.id}`,
        label: upgrade.name,
        detail: upgrade.canStart ? upgrade.costText
          : upgrade.blockedBy === "doctrine" ? `closed — you took ${model.committed}`
            : upgrade.blockedBy === "cost" ? `${upgrade.costText} — not enough`
              : "needs an earlier upgrade",
        enabled: upgrade.canStart,
        command: { kind: "intent", intent: { kind: "doctrine", buildingId: id, upgradeId: upgrade.id } },
      });
    }
  }

  model.queue.forEach((job, index) => {
    actions.push({
      id: `cancelDoctrine:${id}:${index}`,
      label: `Cancel ${job.name}`,
      detail: `${Math.round(job.progress * 100)}% done`,
      enabled: true,
      // A Refinery's jobs sit in the same `researchQueue` a Datacenter's do, so the engine's own
      // `cancelResearch` is the one that cancels them. There is no second intent for this and there
      // should not be — a duplicate would be a second copy of the same rule.
      command: { kind: "intent", intent: { kind: "cancelResearch", buildingId: id, index } },
    });
  });

  return {
    id: "doctrine",
    title: "Doctrine",
    lines,
    actions,
    warning: model.choiceIsOpen
      ? "Committing to one doctrine closes the other two for the rest of the match."
      : null,
  };
}

/** The Rig's rolled yield, reported verbatim (P2-T16). Read-only: a rig has no order to give. */
function rigSection(state: State, id: string): EconomySection {
  const model = rigYieldModel(state, id);
  if (!model) return { id: "rig", title: "Plasma Rig", lines: [], actions: [], warning: null };
  const stopped = model.stoppedBy === "noFuel" ? "Stopped — no nuclear fuel"
    : model.stoppedBy === "noPower" ? "Stopped — the grid is dead"
      : model.stoppedBy === "bufferFull" ? "Stopped — the store is full"
        : `Digging${model.throttle < 1 ? ` at ${Math.round(model.throttle * 100)}% (throttled)` : ""}`;
  return {
    id: "rig",
    title: "Plasma Rig",
    lines: [
      `${model.vein} · ${model.richLabel}`,
      model.lastTier ? `last dig: ${model.lastTier} ×${model.lastTierMult} → ${Math.round(model.lastYield)}` : "no dig yet",
      `store ${Math.round(model.stored)} / ${Math.round(model.storeCap)}`,
      stopped,
    ],
    actions: [],
    warning: null,
  };
}

/**
 * What the ground under the build ghost reads like (P2-T16).
 *
 * Fog-gated inside `rigSurveyModel`, which is the line that keeps this from being a map hack — so
 * the reading is allowed to be wrong, and `blind` is reported rather than inferred from a low
 * confidence. This is the half of the Rig panel that has to be legible BEFORE 200 ore is committed.
 */
function surveySection(
  state: State,
  ghost: { readonly buildingType: string; readonly x: number; readonly y: number },
): EconomySection {
  const model = rigSurveyModel(state, "player", ghost.x, ghost.y);
  return {
    id: "survey",
    title: "Survey",
    lines: model.blind
      ? [`Blind spot — nothing you have found lies within ${Math.round(model.radius)}`]
      : [
        `likely ${model.likelyVein} · ${model.richLabel}`,
        `confidence ${Math.round(model.confidence * 100)}% over ${model.seen.length} known deposits`,
      ],
    actions: [],
    warning: null,
  };
}

/**
 * The market (P2-T10). Both sides trade one LOT, which is the engine's own unit.
 *
 * The sell figure is `quoteSell`'s dry run of the real lot walk, never a unit price multiplied out —
 * `sell` applies slippage between lots, so a multiplied number would be wrong by more the larger the
 * order. The buy side shows the UNIT price for the same reason: this file computes no total.
 */
function marketSection(state: State, snap: Snapshot, credits: number): EconomySection {
  const model = marketPanelModel(state, snap, credits);
  const actions: HudAction[] = [];
  for (const row of model.rows) {
    actions.push({
      id: `sell:${row.com}`,
      label: `Sell ${row.com}`,
      detail: `${model.lot} → ${Math.round(row.sellLotProceeds)} cr`,
      enabled: row.canSell,
      command: { kind: "intent", intent: { kind: "trade", com: row.com, qty: model.lot, side: "sell" } },
    });
    actions.push({
      id: `buy:${row.com}`,
      label: `Buy ${row.com}`,
      detail: `${model.lot} at ${row.buyUnit.toFixed(1)} cr each`,
      enabled: row.canBuy,
      command: { kind: "intent", intent: { kind: "trade", com: row.com, qty: model.lot, side: "buy" } },
    });
  }
  return {
    id: "market",
    title: `Market · ${model.credits} credits`,
    lines: model.rows.map((r) => `${r.com} ${r.held} held · sell ${r.sellUnit.toFixed(1)} · buy ${r.buyUnit.toFixed(1)}`),
    actions,
    warning: null,
  };
}

/**
 * Haulage, supply and repair, read-only (P2-T13/T14/T15).
 *
 * `nothingWillBeDispatched` gets its own line because it is the state the repair panel exists to
 * explain: everything damaged is inside the `NEEDS_REPAIR`/`HEALED` hysteresis band, so a player
 * watching a 90% wall is watching something nobody is coming to fix.
 */
function logisticsSection(state: State, snap: Snapshot): EconomySection {
  const logi = logisticsModel(state, "player");
  const supply = supplyModel(snap.resources.supplyUsed, snap.resources.supplyCap);
  // The repairer's standing point decides the answer — targeting is zone-first and distance-tied,
  // so `pickRepairTarget` legitimately differs per Mender. The base is the one point every player
  // shares, and naming it in the line keeps the reading from reading as universal.
  const repair = repairPanelModel(state, "player", { x: snap.map.baseX, y: snap.map.baseY });

  const lines = [
    `${logi.total} carriers · ${logi.hauling} hauling · ${logi.servicing} servicing · ${logi.ferrying} ferrying · ${logi.idle} idle · ${logi.other} elsewhere`,
    `supply ${supply.text}${supply.advice ? ` — ${supply.advice}` : ""}`,
    `${repair.entries.length} damaged · ${repair.activeRepairers} being repaired`,
  ];
  if (repair.nothingWillBeDispatched) {
    lines.push(`Nothing will be sent: every casualty is above ${Math.round(repair.needsRepairAt * 100)}% and no repairer has committed.`);
  } else if (repair.nextTargetId) {
    lines.push(`next from the base: ${repair.nextTargetId}`);
  }

  return { id: "logistics", title: "Logistics", lines, actions: [], warning: null };
}

// ---------------------------------------------------------------------------
// DOM binding. Everything above this line is testable without a browser.
// ---------------------------------------------------------------------------

export interface HudCallbacks {
  /**
   * One entry point for every button, because there is now more than one kind of them.
   *
   * The view does not decide what a press means — the model already put the command on the action,
   * and the shell runs it. That is what lets a positional key press and a mouse click take exactly
   * the same path (`Game.runCommand`) rather than two that can drift.
   */
  onCommand(command: HudCommand): void;
}

export class HudView {
  private lastText = new Map<string, string>();
  private lastActionKey = "";
  private lastEconomyKey = "";

  constructor(private readonly root: HTMLElement, private readonly cb: HudCallbacks) {
    root.innerHTML = TEMPLATE;
  }

  render(model: HudModel): void {
    this.setText("ore", String(model.ore));
    this.setText("crystals", String(model.crystals));
    this.setText("radioactives", String(model.radioactives));
    this.setText("credits", String(model.credits));
    this.setText("supply", model.supplyText);
    this.setText("clock", model.tickText);
    this.setText("selection-summary", model.selectionSummary);
    this.setText("prompt", model.prompt ?? "");
    const prompt = this.root.querySelector<HTMLElement>('[data-hud="prompt"]');
    if (prompt) prompt.classList.toggle("visible", model.prompt !== null);

    const supply = this.root.querySelector<HTMLElement>('[data-hud="supply"]');
    if (supply) supply.classList.toggle("blocked", model.supplyBlocked);

    this.setText("selection-detail", model.selection.length === 1
      ? `${model.selection[0]!.hp} / ${model.selection[0]!.maxHp} HP`
      : model.selection.length > 1 ? `${model.selection.length} selected` : "");

    this.renderBuildingDetail(model.buildingDetail);

    // Buttons are rebuilt only when the SET changes, not when affordability does — affordability
    // is a class toggle. Rebuilding a button list every frame is both garbage and a lost click.
    const host = this.root.querySelector<HTMLElement>('[data-hud="actions"]');
    const key = model.actions.map((a) => a.id).join(",");
    if (host && key !== this.lastActionKey) {
      this.lastActionKey = key;
      host.replaceChildren(...model.actions.map((a) => this.actionButton(a)));
    }
    this.syncAffordability(host, model.actions.map((a) => a.enabled));
  }

  /**
   * The economy drawer (P4-T01).
   *
   * Same discipline as `render`, and it needs it more: a research panel is twenty-odd buttons, and
   * rebuilding those every frame would be the single largest allocation in the client. The
   * structural key covers the section ids, the line COUNT and the action ids — everything whose
   * change needs new nodes. Text that merely changed value goes through `setText`, which touches a
   * node only when the string is different.
   */
  renderEconomy(model: EconomyModel): void {
    const host = this.root.querySelector<HTMLElement>('[data-hud="economy"]');
    if (!host) return;

    const key = model.sections
      .map((s) => `${s.id}#${s.lines.length}#${s.actions.map((a) => a.id).join("|")}`)
      .join(";");
    if (key !== this.lastEconomyKey) {
      this.lastEconomyKey = key;
      // Text keys belong to the nodes that are going away. Left behind, a stale entry would make
      // `setText` skip the first write into a NEW node that happens to want the same string, and
      // the panel would open blank — which is exactly the bug this line exists to prevent.
      for (const k of [...this.lastText.keys()]) if (k.startsWith("econ:")) this.lastText.delete(k);
      host.replaceChildren(...model.sections.map((s) => this.section(s)));
    }
    host.classList.toggle("visible", model.sections.length > 0);

    for (const s of model.sections) {
      this.setText(`econ:${s.id}:title`, s.title);
      this.setText(`econ:${s.id}:warning`, s.warning ?? "");
      const warning = this.root.querySelector<HTMLElement>(`[data-hud="econ:${s.id}:warning"]`);
      if (warning) warning.classList.toggle("visible", s.warning !== null);
      s.lines.forEach((line, i) => this.setText(`econ:${s.id}:line:${i}`, line));
      this.syncAffordability(
        this.root.querySelector<HTMLElement>(`[data-econ-actions="${s.id}"]`),
        s.actions.map((a) => a.enabled),
      );
    }
  }

  private section(s: EconomySection): HTMLElement {
    const el = document.createElement("div");
    el.className = "hud-econ-section";
    const title = document.createElement("div");
    title.className = "hud-econ-title";
    title.dataset.hud = `econ:${s.id}:title`;
    const warning = document.createElement("div");
    warning.className = "hud-econ-warning";
    warning.dataset.hud = `econ:${s.id}:warning`;
    el.append(title, warning);
    s.lines.forEach((_, i) => {
      const line = document.createElement("div");
      line.className = "hud-econ-line";
      line.dataset.hud = `econ:${s.id}:line:${i}`;
      el.append(line);
    });
    const actions = document.createElement("div");
    actions.className = "hud-row";
    actions.dataset.econActions = s.id;
    actions.replaceChildren(...s.actions.map((a) => this.actionButton(a)));
    el.append(actions);
    return el;
  }

  /** Transient message — a rejected order, a tier drop. Cleared by the next one. */
  notice(text: string | null): void {
    const el = this.root.querySelector<HTMLElement>('[data-hud="notice"]');
    if (!el) return;
    el.textContent = text ?? "";
    el.classList.toggle("visible", !!text);
  }

  private actionButton(action: HudAction): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "hud-button";
    b.innerHTML = `<span class="hud-button-label"></span><span class="hud-button-cost"></span>`;
    b.querySelector(".hud-button-label")!.textContent = action.label;
    b.querySelector(".hud-button-cost")!.textContent = action.detail;
    // The command is captured, not the index: a button that fired "action 3" would fire whatever
    // the third action happened to be by the time it was clicked.
    b.addEventListener("click", () => this.cb.onCommand(action.command));
    return b;
  }

  private syncAffordability(host: HTMLElement | null, affordable: readonly boolean[]): void {
    if (!host) return;
    const children = host.children;
    for (let i = 0; i < children.length; i++) {
      children[i]!.classList.toggle("unaffordable", !affordable[i]);
    }
  }

  /**
   * The building detail (P2-T09). Text-only and cheap: a factory's status changes on a tick, not on
   * a frame, so every write here is guarded by `setText`'s "only if it changed" check.
   *
   * The status carries a **glyph as well as a class**, because N-05 forbids colour alone — a player
   * who cannot separate the amber warning from the red stop still has to be able to tell "running
   * slow" from "stopped dead", which are different things to do about it.
   */
  private renderBuildingDetail(detail: BuildingPanelModel): void {
    this.setText("recipe", detail.recipeText ?? "");
    const glyph = detail.severity === "ok" ? "▶" : detail.severity === "paused" ? "❙❙"
      : detail.severity === "warn" ? "▲" : "■";
    this.setText("status", detail.building ? `${glyph} ${detail.statusText}` : "");
    const status = this.root.querySelector<HTMLElement>('[data-hud="status"]');
    if (status) status.dataset.severity = detail.building ? detail.severity : "";

    // Buffers are a string rather than a node list: at most a handful of commodities, changing on
    // a tick, and a rebuilt node list per tick is the garbage this HUD is careful not to make.
    const buffers = [...detail.inputs, ...detail.outputs]
      .map((b) => `${b.com} ${Math.floor(b.qty)}/${Math.round(b.cap)}`)
      .join(" · ");
    this.setText("buffers", buffers);
  }

  private setText(key: string, value: string): void {
    if (this.lastText.get(key) === value) return;
    this.lastText.set(key, value);
    const el = this.root.querySelector<HTMLElement>(`[data-hud="${key}"]`);
    if (el) el.textContent = value;
  }
}

const TEMPLATE = `
  <div class="hud-top">
    <span class="hud-res"><i class="dot ore"></i><b data-hud="ore">0</b> ore</span>
    <span class="hud-res"><i class="dot crystals"></i><b data-hud="crystals">0</b> crystals</span>
    <span class="hud-res"><i class="dot radioactives"></i><b data-hud="radioactives">0</b> radioactives</span>
    <span class="hud-res"><i class="dot credits"></i><b data-hud="credits">0</b> credits</span>
    <span class="hud-res" data-hud="supply"><b>supply</b> <span data-hud="supply">0 / 0</span></span>
    <span class="hud-res hud-clock" data-hud="clock">0:00</span>
  </div>
  <div class="hud-notice" data-hud="notice"></div>
  <div class="hud-prompt" data-hud="prompt"></div>
  <div class="hud-bottom">
    <div class="hud-panel">
      <div class="hud-title" data-hud="selection-summary">Nothing selected</div>
      <div class="hud-detail" data-hud="selection-detail"></div>
      <div class="hud-recipe" data-hud="recipe"></div>
      <div class="hud-status" data-hud="status"></div>
      <div class="hud-buffers" data-hud="buffers"></div>
    </div>
    <div class="hud-actions">
      <div class="hud-row" data-hud="actions"></div>
    </div>
  </div>
  <div class="hud-economy" data-hud="economy"></div>
`;
