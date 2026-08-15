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

import { BUILDINGS, PLANETS, UNITS, canBuildType, prereqsMet } from "../engine/index.js";
import { type BuildingPanelModel, buildingPanelModel } from "./building-panel.js";
import { type Intent } from "../bridge/commands.js";
import { colonyIncomeModel, colonyPolicyModel, policyPreview } from "./colony-panel.js";
import { diplomacyPanelModel } from "./diplomacy-panel.js";
import { doctrinePanelModel } from "./doctrine-panel.js";
import { gatePanelModel } from "./gate-panel.js";
import { milestoneLabel, milestonesPanelModel } from "./milestones-panel.js";
import { type OnboardingModel, onboardingModel, settingsModel } from "./onboarding.js";
import { reliefPanelModel } from "./relief-panel.js";
import { type SaveCatalog, savePanelModel } from "./save-panel.js";
import { scorePanelModel } from "./score-panel.js";
import { jumpPanelModel } from "./jump-panel.js";
import { landingPanelModel } from "./landing-panel.js";
import { lanePanelModel } from "./lane-panel.js";
import { logisticsModel, recyclePreview, supplyModel } from "./operations-panel.js";
import { marketPanelModel } from "./market-panel.js";
import { repairPanelModel } from "./repair-panel.js";
import { researchPanelModel } from "./research-panel.js";
import { rigSurveyModel, rigYieldModel } from "./rig-panel.js";
import { type ApproachBrief, type GroundPoint, type LandingSite } from "../view/landing.js";
import { type Settings } from "../app/settings.js";
import { type Tier } from "../view/renderer/port.js";
import { FLAG_BUILDING_KIND, engineId, type Snapshot } from "../bridge/snapshot.js";

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
  | { readonly kind: "buildMode"; readonly buildingType: string }
  // --- Phase 4's screens (P4-T13) ---------------------------------------------------------------
  //
  // Two more commands that are not orders, for the reason `buildMode` is not one: a screen is view
  // state, nothing in the simulation knows one is open, and a replay must not depend on it. They are
  // here rather than as a second callback because the whole point of `HudCommand` is that a button
  // press and a positional key press take ONE path (`Game.runCommand`) — a screen the mouse could
  // open and the keyboard could not would be exactly half a control.
  | { readonly kind: "screen"; readonly screen: "world" | "starmap" }
  /** Open the approach view on a destination — the landing picker, which is per-world. */
  | { readonly kind: "approach"; readonly destId: string }
  // --- Phase 5's long game (P5-T12) --------------------------------------------------------------
  //
  // Five more that are not orders. The first is view state like `screen`; the rest write to the
  // BROWSER rather than to the simulation — storage and preferences — which is the same reason they
  // cannot be intents: `applyIntent` is what a determinism replay feeds, and a replay that wrote a
  // save slot would be a replay that changed the machine it ran on.
  | { readonly kind: "galaxyBoard"; readonly board: GalaxyBoard | null }
  | { readonly kind: "save"; readonly name: string }
  | { readonly kind: "loadSave"; readonly id: string }
  | { readonly kind: "deleteSave"; readonly id: string }
  | { readonly kind: "settings"; readonly settings: Settings }
  | { readonly kind: "dismissOnboarding" };

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

/**
 * The MVP's build menu — kept only as the fallback when no `State` is available (P4-T14).
 *
 * It was the whole menu until Phase 4, and that was the bug: **five of the engine's twenty-nine
 * building types**, hand-written in Phase 1 and never widened, while Phase 2 shipped meshes, panel
 * models and economy logic for all 29. The cost compounded through the tech tree — Foundry, Arsenal,
 * Spaceport and Star Dock were all unbuildable, so of 18 unit types only five could be trained, and
 * **exactly one of ADR-0016's nine new silhouettes (the Ranger) was reachable in a real game.**
 */
export const MVP_BUILDINGS = ["command", "barracks", "habitat", "refinery", "turret"] as const;

/**
 * What this builder can put down right now (P4-T14).
 *
 * **Two engine predicates, no hand-written list.** `canBuildType` answers whether THIS builder's
 * category covers the building — a Worker and a Colony Ship do not build the same things — and
 * `prereqsMet` answers whether the tech behind it stands. Both already existed; the old menu was a
 * constant doing their job badly.
 *
 * Unmet prerequisites are **filtered rather than greyed**, which is a judgement worth naming: 29
 * buttons at t=0 is a wall, and the menu growing as a base techs up is how the genre teaches its
 * own tree. The cost is that a player cannot see what is coming — if the playtest says that matters,
 * the fix is to show the locked rows with their `requires` named, not to go back to a fixed list.
 *
 * Affordability is NOT a filter. A building you cannot yet pay for is a plan; one whose Foundry you
 * have not built is not on the menu at all.
 */
function buildableTypes(state: State | undefined, builderTypes: readonly string[]): string[] {
  if (!state) return [...MVP_BUILDINGS];
  const out: string[] = [];
  for (const type of Object.keys(BUILDINGS)) {
    const def = BUILDINGS[type];
    if (!def) continue;
    if (!builderTypes.some((b) => canBuildType(b, type))) continue;
    if (!prereqsMet(state, "player", def)) continue;
    out.push(type);
  }
  return out;
}

/**
 * `state` is optional and only widens the build menu (P4-T14): with it, the offer is the engine's
 * own answer for this builder; without it, the Phase 1 subset. Optional rather than required
 * because every existing caller passes a snapshot alone, and the precedent for a model reading
 * `State` is already set — P2-T10's market panel does, and says why.
 */
export function hudModel(snap: Snapshot, state?: State): HudModel {
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
  const builders = selection
    .filter((s) => !s.isBuilding && UNITS[s.type]?.buildCategories?.length)
    .map((s) => s.type);
  if (builders.length > 0) {
    for (const buildingType of buildableTypes(state, builders)) {
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
  /** `loadOnboardingSeen()`, held by the shell. The card is gone for good once this is true. */
  readonly onboardingSeen: boolean;
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
    input.onboardingSeen ? "seen" : "new",
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

  // First, because it is for someone who has not worked out that there is a drawer yet (P5-T10).
  // It retires itself twice over — on dismissal, and the moment the player has a base — so this is
  // not a section that lives at the top of the screen for a ten-hour campaign.
  const onboarding = onboardingModel({ snap, seen: input.onboardingSeen });
  if (onboarding.visible) sections.push(onboardingSection(onboarding));

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
// The galaxy (P4-T13). Still a model; still no DOM.
// ---------------------------------------------------------------------------
//
// Phase 4 built five modules a player could not reach: the starmap, the approach view, and the
// jump, colony and lane panels. Four of the five were models with no composition layer — the exact
// hole P4-T01 filled for Phase 2's economy, dug again one phase later because "a control reaches
// it" was in nobody's definition of done. This is that layer for the galaxy, and it is deliberately
// the same shape as `economyModel` above: every judgement stays in the panel that asks the engine,
// and nothing here decides a rule.
//
// It produces `EconomySection`s rather than a vocabulary of its own, which is not laziness: it means
// the galaxy screens inherit the drawer's whole DOM discipline (nodes rebuilt only when the button
// SET changes, text written only when the string changes) and the positional row (Z/C/V/B/N fire
// the Nth button on screen) without a second implementation of either.
//
// **It is a function of a galaxy TICK, not of a frame** — see `GalaxyCache`, which is `EconomyCache`
// one layer up and for the same reason: `jumpPanelModel` walks every pad's manifest and prices every
// destination, `colonyIncomeModel` walks every world's buildings, and none of that changes between
// two frames of the same tick.

/** The approach screen's live state, as the shell holds it. `ApproachView` supplies all three. */
export interface ApproachState {
  readonly brief: ApproachBrief;
  /** The raw ground point under the pointer — never the snapped one (see `landing-panel.ts`). */
  readonly pick: GroundPoint | null;
  /** Where the jump will actually touch down, which is not necessarily the pick. */
  readonly site: LandingSite;
}

/**
 * The campaign boards (P5-T12), toggled from the starmap's own drawer.
 *
 * `EconomyBoard`'s idea one screen up, and for the same reason: these are the panels that are NOT
 * about the thing under the cursor, so they need a control of their own. They take BUTTONS rather
 * than letters — the positional row (Z/C/V/B/N) already addresses the galaxy drawer, so a board
 * costs no key, and Phase 4 had already spent every letter this keyboard had left.
 *
 * Only one is open at a time. Nine sections at once is a wall, and every one of these is a thing a
 * player goes to look at deliberately rather than something they need beside the jump board.
 */
export type GalaxyBoard = "diplomacy" | "gate" | "records" | "system";

export interface GalaxyInput {
  readonly galaxy: Galaxy;
  /** The app's fixed step. `lanePanelModel` turns tick counts into seconds with it, never assumes it. */
  readonly stepSeconds: number;
  /** The open approach view, or null while the starmap is up. */
  readonly approach: ApproachState | null;
  /** Which campaign board is open, if any. View state, exactly like `EconomyInput.board`. */
  readonly board: GalaxyBoard | null;
  /** The save catalog, read by the shell — `readCatalog()` touches storage and this model may not. */
  readonly saves: SaveCatalog;
  /** Wall-clock ms, passed in so every string the save panel produces stays a pure function. */
  readonly now: number;
  readonly settings: Settings;
  /** The tier actually running, which is not necessarily the one chosen (see `settingsModel`). */
  readonly currentTier: Tier;
}

/**
 * The galaxy screens' drawer.
 *
 * The approach view REPLACES the starmap's three boards rather than adding to them, because it is a
 * modal decision about one destination: a jump button beside ten other worlds' jump buttons is a
 * misclick that costs a fleet.
 */
export function galaxyModel(input: GalaxyInput): EconomyModel {
  const sections = input.approach
    ? [approachSection(input.approach)]
    : galaxySections(input);
  const actions: HudAction[] = [];
  for (const s of sections) actions.push(...s.actions);
  return { sections, actions };
}

function galaxySections(input: GalaxyInput): EconomySection[] {
  const galaxy = input.galaxy;
  const sections: EconomySection[] = [
    jumpSection(galaxy),
    colonySection(galaxy),
    laneSection(galaxy, input.stepSeconds),
    campaignSection(input.board),
  ];

  // The relief board is the one that is NOT behind a button, because it is the one a player needs
  // when they have just lost everything and are not in a mood to go looking. It appears exactly
  // when the engine's own rescue clock is doing something — and stays hidden the rest of the run.
  const relief = reliefPanelModel(galaxy);
  if (relief.status !== "held") sections.push(reliefSection(relief));

  switch (input.board) {
    case "diplomacy": sections.push(diplomacySection(galaxy)); break;
    case "gate": sections.push(gateSection(galaxy)); break;
    case "records":
      sections.push(milestonesSection(galaxy), scoreSection(galaxy, relief));
      break;
    case "system":
      sections.push(
        savesSection(input.galaxy, input.saves, input.now),
        settingsSection(input.settings, input.currentTier),
      );
      break;
    case null: break;
  }
  return sections;
}

/**
 * `galaxyModel`, rebuilt only when something it reads has moved.
 *
 * `galaxy.tick` is the clock every one of these panels is a function of — income accrues on it,
 * lanes count down on it, and every player order lands on one. The pick is the one input that moves
 * faster: `pointAt` runs on pointermove, so it is quantised to a whole world unit, which is finer
 * than anything the landing panel prints and far coarser than a mouse.
 *
 * Like `EconomyCache`, it lives here so the property can be TESTED: `galaxyModel` allocates a fresh
 * object every call, so "the same object came back" is proof that nothing was rebuilt.
 */
export class GalaxyCache {
  private key: string | null = null;
  private model: EconomyModel = { sections: [], actions: [] };

  get(input: GalaxyInput): EconomyModel {
    const key = galaxyCacheKeyOf(input);
    if (key !== this.key) {
      this.key = key;
      this.model = galaxyModel(input);
    }
    return this.model;
  }
}

function galaxyCacheKeyOf(input: GalaxyInput): string {
  const a = input.approach;
  const pick = a?.pick;
  return [
    input.galaxy.tick,
    a ? a.brief.destId : "-",
    pick ? `${Math.round(pick.x)}:${Math.round(pick.y)}` : "-",
    input.board ?? "-",
    // Only the system board reads either of these, and `now` is a wall clock: keyed on raw
    // milliseconds it would rebuild the whole galaxy drawer every frame, which is the exact
    // opposite of what this cache is for. Quantised to five seconds, so "12 minutes ago" still
    // becomes "13 minutes ago" on its own, and nothing else pays for it.
    input.board === "system" ? `${Math.floor(input.now / 5000)}:${input.saves.saves.length}` : "-",
    input.board === "system" ? `${input.settings.tierOverride ?? "auto"}:${input.currentTier}` : "-",
  ].join("|");
}

/** A world's name, from the engine's own table. `jump-panel.ts` reads it the same way. */
function planetName(id: string): string {
  return PLANETS.find((p) => p.id === id)?.name ?? id;
}

/**
 * The jump board (P4-T04): what this world's pads can lift, and what every destination costs.
 *
 * The destination button is an `approach`, not a `jump`. That is the row's own rule made
 * structural — a jump is committed on the approach view, after the player has seen where they will
 * land — and it is what stops the starmap from being able to launch a fleet on a single click.
 */
function jumpSection(galaxy: Galaxy): EconomySection {
  const model = jumpPanelModel(galaxy);
  const actions: HudAction[] = [];
  const lines: string[] = [
    model.canLaunch
      ? `${model.launch.riders.length} aboard (${model.launch.supply} of ${model.launch.capacity} supply)`
        + `${model.launch.overCapacity ? ` · ${model.launch.leftBehind} left behind` : ""}`
      : "No completed Spaceport here — a jump moves the seat and carries nobody",
  ];

  for (const pad of model.pads) {
    lines.push(`${pad.id}: tier ${pad.tier}, lifts ${pad.capacity} supply, fuel ×${pad.fuelDiscount}`);
    // Shown even at the ceiling and even when it cannot be paid for, exactly as an unaffordable
    // build button is: a menu that hides what you cannot do yet leaves the player with no idea what
    // the pad is for (F-07).
    actions.push({
      id: `upgradePad:${pad.id}`,
      label: pad.atMaxTier ? `${pad.id} at max tier` : `Extend ${pad.id}`,
      detail: pad.atMaxTier
        ? `tier ${pad.tier} is the ceiling`
        : `${costText(pad.upgradeCost ?? undefined)} → lifts ${pad.nextCapacity}`,
      enabled: pad.canUpgrade,
      command: { kind: "intent", intent: { kind: "upgradeSpaceport", buildingId: pad.id } },
    });
  }

  for (const dest of model.destinations) {
    const name = planetName(dest.id);
    lines.push(
      `${name}: ${dest.reached ? "reached" : `${Math.ceil(dest.cost)} cr`}`
      + `${dest.reachable ? (dest.fallback ? " · fall back only, no fleet" : "") : " · out of reach"}`,
    );
    actions.push({
      id: `approach:${dest.id}`,
      label: `Approach ${name}`,
      // The two refusals a player can act on, separated: `canJumpTo` is not "can I afford it".
      detail: !dest.reachable ? "no way in from here"
        : !dest.affordable ? `${Math.ceil(dest.cost)} cr — not enough`
          : dest.fallback ? "fall back, carrying nobody" : `${Math.ceil(dest.cost)} cr`,
      enabled: dest.reachable && dest.affordable,
      command: { kind: "approach", destId: dest.id },
    });
  }

  return {
    id: "jump",
    title: `Jump · ${Math.floor(model.credits)} credits`,
    lines,
    actions,
    warning: null,
  };
}

/**
 * The colonies (P4-T06) and their standing orders (P4-T08).
 *
 * Every world gets a line, including the ones paying nothing — that is the income model's own
 * decision and the answer to "why did the treasury stop moving after I jumped home". Only the
 * worlds the colony scan actually acts on get buttons: an order set on the world under your feet is
 * inert, and `inertReason` is what says so rather than a rule invented here.
 */
function colonySection(galaxy: Galaxy): EconomySection {
  const income = colonyIncomeModel(galaxy);
  const actions: HudAction[] = [];
  const lines: string[] = [
    `${income.perSecond.toFixed(2)}/s · ${income.perMinute.toFixed(0)}/min`
    + ` · ${income.perBuilding}/s per building to a cap of ${income.cap} (${income.colonyCeiling}/s)`,
  ];

  for (const row of income.rows) {
    if (!row.earning) {
      lines.push(`${planetName(row.id)}: not a background colony — pays nothing`);
      continue;
    }
    lines.push(
      `${planetName(row.id)}: ${row.perSecond.toFixed(2)}/s from ${row.counted} of ${row.incomeBuildings}`
      + `${row.beyondCap > 0 ? ` (${row.beyondCap} past the cap, earning nothing)` : ""}`
      + `${row.pacified ? ` · pacified +${income.pacifiedRate}/s` : ""}`
      + `${row.atCap ? "" : ` · one more building: +${row.marginalPerSecond}/s`}`,
    );

    const policy = colonyPolicyModel(galaxy, row.id);
    for (const warning of policy.warnings) lines.push(`${planetName(row.id)}: ${warning}`);

    actions.push({
      id: `autoSell:${row.id}`,
      label: `${policy.autoSellEnabled ? "Stop" : "Start"} auto-sell · ${row.id}`,
      detail: policy.floors.length > 0
        ? `${policy.floors.length} floor(s), next run sells ${policy.floors.reduce((n, f) => n + f.surplus, 0)}`
        : "no floor set — nothing would sell",
      enabled: true,
      command: {
        kind: "intent",
        intent: {
          kind: "colonyPolicy", planetId: row.id,
          patch: { autoSell: { enabled: !policy.autoSellEnabled } },
        },
      },
    });

    // The worker target, one worker at a time, with the ENGINE's verdict on the button rather than
    // this file's: `policyPreview` runs `sanitizePolicy` on the request before it is sent, which is
    // the whole reason P4-T08 built it — `MAX_WORKER_TARGET` is a clamp, and a UI that accepted 21
    // and stored 20 would be lying at the keystroke and at every later read.
    for (const delta of [1, -1]) {
      const wanted = policy.workerTarget + delta;
      const preview = policyPreview({ workerTarget: wanted });
      actions.push({
        id: `workers${delta > 0 ? "Up" : "Down"}:${row.id}`,
        label: `Workers ${delta > 0 ? "+1" : "−1"} · ${row.id}`,
        detail: preview.adjustments[0]?.reason
          ?? `${policy.workerTarget} → ${preview.policy.workerTarget}, ${policy.workers} standing`,
        enabled: preview.policy.workerTarget !== policy.workerTarget,
        command: {
          kind: "intent",
          intent: { kind: "colonyPolicy", planetId: row.id, patch: { workerTarget: wanted } },
        },
      });
    }
  }

  return {
    id: "colonies",
    title: `Colonies · ${Math.floor(income.credits)} credits`,
    lines,
    actions,
    warning: null,
  };
}

/**
 * Freight Lanes (P4-T07).
 *
 * The countdown leads, because the panel's own header says why: a lane does nothing at all for nine
 * seconds out of ten, and "nothing is happening" and "nothing has happened for nine seconds and
 * will in one" are different states with only one of them a bug.
 *
 * A lane can be opened between any two worlds the galaxy has instantiated — `createLane`'s own two
 * conditions, mirrored here to decide which buttons exist and re-derived nowhere: the engine still
 * refuses, and its refusal still reaches the notice.
 */
function laneSection(galaxy: Galaxy, stepSeconds: number): EconomySection {
  const model = lanePanelModel(galaxy, stepSeconds);
  const actions: HudAction[] = [];
  const lines: string[] = [
    `next run in ${model.secondsUntilRun.toFixed(1)}s (every ${model.periodSeconds.toFixed(0)}s,`
    + ` ${model.runsPerMinute.toFixed(1)}/min)`,
  ];

  for (const lane of model.rows) {
    lines.push(
      `${planetName(lane.from)} → ${planetName(lane.to)}: ${lane.status}`
      + ` · ${lane.standingCrew} of ${lane.crew.length} crew standing`
      + ` · ${lane.capacity} hold, next run ${lane.nextRunTotal}`
      + ` · holds ${lane.heldFromJump} supply out of the jump ring`,
    );
    actions.push({
      id: `deleteLane:${lane.id}`,
      label: `Close ${planetName(lane.from)} → ${planetName(lane.to)}`,
      detail: `frees ${lane.crew.length} ship(s)`,
      enabled: true,
      command: { kind: "intent", intent: { kind: "deleteLane", laneId: lane.id } },
    });
    for (const ship of lane.crew) {
      actions.push({
        id: `unassignLane:${lane.id}:${ship.unitId}`,
        label: `Release ${ship.type}`,
        detail: ship.standing ? `${ship.cargoHold} hold, back to the jump ring` : "not at a pad — carries nothing",
        enabled: true,
        command: { kind: "intent", intent: { kind: "unassignLane", laneId: lane.id, unitId: ship.unitId } },
      });
    }
    for (const ship of lane.candidates) {
      actions.push({
        id: `assignLane:${lane.id}:${ship.unitId}`,
        label: `Crew ${ship.type}`,
        // The trade, before the click: a lane-booked ship is skipped by `stagedRiders`, so crewing
        // one shrinks the next expedition by exactly its supply.
        detail: `+${ship.cargoHold} hold, −${ship.supplyCost} supply from the jump ring`,
        enabled: true,
        command: { kind: "intent", intent: { kind: "assignLane", laneId: lane.id, unitId: ship.unitId } },
      });
    }
  }

  const open = new Set(model.rows.map((lane) => `${lane.from}>${lane.to}`));
  for (const id of galaxy.planets.keys()) {
    if (id === galaxy.activeId || open.has(`${galaxy.activeId}>${id}`)) continue;
    actions.push({
      id: `createLane:${id}`,
      label: `Open lane → ${planetName(id)}`,
      detail: `ships ${model.defaultCommodities.join(", ")}`,
      enabled: true,
      // No filter: an empty commodity list is `runLanes`' own "everything in CARGO_GOODS", and the
      // lane's row reports that as `filtered: false` rather than pretending a choice was made.
      command: {
        kind: "intent",
        intent: { kind: "createLane", from: galaxy.activeId, to: id, commodities: [] },
      },
    });
  }

  return { id: "lanes", title: "Freight lanes", lines, actions, warning: null };
}

// ---------------------------------------------------------------------------
// The long game (P5-T12). Still a model; still no DOM.
// ---------------------------------------------------------------------------
//
// Seven panels, wired the way Phase 2's and Phase 4's were: every judgement stays in the panel that
// asks the engine, and nothing below decides a rule. This layer picks WHICH panel is on screen and
// turns its answers into rows.
//
// The composition itself is the row P4-T13 wrote the reachability scan for. Three phases running,
// this project built panels nothing could open — Phase 2 shipped six of seven orphaned, Phase 4 did
// it again with five, and Phase 5's four parallel agents produced seven more in one afternoon. The
// scan is what turns "wire it up" from a thing someone remembers into a red test, and this layer is
// what makes it green.

/** The board switcher. Always on the starmap, so every campaign panel is two clicks from anywhere. */
function campaignSection(open: GalaxyBoard | null): EconomySection {
  const boards: readonly { readonly id: GalaxyBoard; readonly label: string; readonly detail: string }[] = [
    { id: "diplomacy", label: "Diplomacy", detail: "your neighbour's stance, and the three ways to move it" },
    { id: "gate", label: "Antimatter Gate", detail: "both sides of the race" },
    { id: "records", label: "Records", detail: "milestones, score, and the one terminal choice" },
    { id: "system", label: "Saves & settings", detail: "this browser's storage" },
  ];
  return {
    id: "campaign",
    title: "Campaign",
    lines: [],
    // A board's own button CLOSES it, so the control that opened it is the control that gets rid of
    // it — the same rule M and L follow on the battlefield.
    actions: boards.map(({ id, label, detail }) => ({
      id: `board:${id}`,
      label: open === id ? `▾ ${label}` : label,
      detail,
      enabled: true,
      command: { kind: "galaxyBoard", board: open === id ? null : id },
    })),
    warning: null,
  };
}

/**
 * The rescue clock (P5-T07).
 *
 * `reliefWouldFollow` is the line that matters and it is the panel's, not this layer's: at the
 * moment surrender looks obligatory — nothing held anywhere — the engine's own answer is a ship,
 * not a defeat. Saying so is the difference between a player waiting twenty seconds and a player
 * quitting a run they had not lost.
 */
function reliefSection(model: ReturnType<typeof reliefPanelModel>): EconomySection {
  const lines: string[] = [];
  if (model.status === "ended") {
    lines.push(model.surrender.state === "surrendered" ? "You surrendered this run." : "This run is over.");
  } else if (model.surrender.reliefWouldFollow) {
    lines.push("You hold nothing anywhere — but the run is not lost.");
    lines.push(model.status === "due"
      ? "A colony ship is on its way to your landing zone."
      : `A colony ship is dispatched in ${Math.ceil(model.secondsUntilEligible)}s.`);
  } else {
    lines.push(`Relief is on cooldown for ${Math.ceil(model.secondsUntilEligible)}s.`);
  }
  for (const f of model.footholds) {
    const bits = [`${f.commandCenters} base${f.commandCenters === 1 ? "" : "s"}`];
    if (f.underConstruction > 0) bits.push(`${f.underConstruction} building`);
    if (f.colonyShip) bits.push("colony ship");
    lines.push(`${planetName(f.planetId)} — ${bits.join(", ")}`);
  }
  return { id: "relief", title: "Relief", lines, actions: [], warning: null };
}

/** The neighbour, and the three levers (P5-T04). Read for the SEAT — the world you are standing on. */
function diplomacySection(galaxy: Galaxy): EconomySection {
  const model = diplomacyPanelModel(galaxy, galaxy.activeId);
  const planetId = galaxy.activeId;
  const lines: string[] = [];
  const actions: HudAction[] = [];

  if (!model.known) {
    lines.push("This world has no neighbour on record.");
    return { id: "diplomacy", title: "Diplomacy", lines, actions, warning: null };
  }

  lines.push(`${model.label} — ${model.atPeace ? "at peace" : "at war"}`);
  lines.push(`Peace rests on: ${model.peaceRestsOn}`);
  if (model.goodwill > 0) lines.push(`Goodwill ${Math.round(model.goodwill)} of ${model.goodwillCap}`);
  if (model.provoked) lines.push("They have been provoked by something you did.");

  // The price, never `TRIBUTE_BASE_COST`: it escalates 1.55x a payment, so the constant is right
  // once and wrong for the rest of the run.
  actions.push({
    id: "tribute",
    label: "Offer tribute",
    detail: `${model.tributeCost} credits`,
    enabled: model.canAffordTribute,
    command: { kind: "intent", intent: { kind: "tribute", planetId } },
  });

  const favor = model.favor;
  if (favor) {
    lines.push(
      `They want ${favor.qty} ${favor.com} — ${Math.ceil(favor.secondsLeft)}s left`
      + (favor.shortfall > 0 ? ` (${Math.ceil(favor.shortfall)} short)` : ""),
    );
    actions.push({
      id: "fulfilFavor",
      label: "Fulfil the request",
      detail: favor.canFulfill ? `hand over ${favor.qty} ${favor.com}` : "not enough in the stockpile",
      enabled: favor.canFulfill,
      command: { kind: "intent", intent: { kind: "fulfilFavor", planetId } },
    });
  }

  return { id: "diplomacy", title: "Diplomacy", lines, actions, warning: null };
}

/**
 * Both sides of the Gate race (P5-T05).
 *
 * The status line is the panel's four-way answer, not `chargingWonderOf`'s — the engine returns one
 * identical `null` for "no Gate", "still building", "never charged" and "already online", and calls
 * a Gate starved for minutes "charging" because it never looks at the feed.
 */
function gateSection(galaxy: Galaxy): EconomySection {
  const model = gatePanelModel(galaxy);
  const lines: string[] = [];

  if (model.ours.length === 0) {
    lines.push(model.seatPrereqsMet
      ? `No ${model.gateName} yet. It needs ${Object.entries(model.cost).map(([c, n]) => `${n} ${c}`).join(", ")}.`
      : `No ${model.gateName}. Still missing: ${model.requires.join(", ")}.`);
  }
  for (const gate of model.ours) {
    const pct = Math.floor(gate.charge * 100);
    const head = `${planetName(gate.worldId)} — ${gate.status} ${pct}%`;
    lines.push(gate.secondsRemaining === null ? head : `${head}, ${Math.ceil(gate.secondsRemaining)}s left`);
    if (gate.status === "stalled") {
      const binding = gate.feed.find((f) => f.binding);
      lines.push(binding
        ? `Stalled: ${binding.com} runs out at ${Math.floor(gate.reachableCharge * 100)}%`
        : "Stalled: the feed cannot carry it further");
    }
  }

  // `null` covers two opposite situations and the latch is the only thing that separates them.
  if (model.rival) {
    const left = model.rival.secondsRemaining;
    lines.push(`A rival Gate on ${planetName(model.rival.worldId)} — ${Math.floor(model.rival.charge * 100)}%`
      + (left === null ? "" : `, ${Math.ceil(left)}s left`));
  } else if (model.rivalAscended) {
    lines.push(`A rival Gate has completed on ${model.ascendedWorlds.map(planetName).join(", ")}.`);
  } else {
    lines.push("No rival is racing you.");
  }

  return {
    id: "gate",
    title: "Antimatter Gate",
    lines,
    actions: [],
    warning: model.rivalAscended ? "A rival has already ascended." : null,
  };
}

/** What the galaxy has celebrated (P5-T06). The engine raises these; this only reports them. */
function milestonesSection(galaxy: Galaxy): EconomySection {
  const model = milestonesPanelModel(galaxy);
  const d = model.domination;
  const lines: string[] = [
    `${model.reachedCount} of ${model.namedTotal} milestones`,
    `Pacified ${d.pacified} of ${d.target}`
    + (d.pendingScan ? " — the engine has not raised it yet" : d.milestoneReached ? " — reached" : ""),
  ];
  for (const row of model.named) lines.push(`${row.reached ? "✓" : "·"} ${row.label}`);
  if (model.worlds.length) lines.push(`Worlds settled: ${model.worlds.map((w) => w.label).join(", ")}`);
  if (model.unknown.length) lines.push(`Unrecognised: ${model.unknown.map(milestoneLabel).join(", ")}`);
  return { id: "milestones", title: "Milestones", lines, actions: [], warning: null };
}

/**
 * The score, and the one button that ends a run (P5-T08).
 *
 * Surrender lives here rather than beside the relief clock on purpose: it is a decision about the
 * whole run, and putting it next to "you have lost everything" is putting it exactly where a player
 * should not be offered it — the engine's answer there is a rescue ship.
 */
function scoreSection(galaxy: Galaxy, relief: ReturnType<typeof reliefPanelModel>): EconomySection {
  const model = scorePanelModel(galaxy);
  const lines: string[] = [];
  for (const line of model.lines) {
    lines.push(`${line.owner}: ${Math.round(line.total)}`
      + ` (army ${Math.round(line.army)}, structures ${Math.round(line.structures)},`
      + ` bank ${Math.round(line.bank)})`);
  }
  // Every galaxy world is created `endless`, so `rules.clock` is null for the Odyssey and a
  // countdown here would be inventing one.
  lines.push(model.rules.clock === null
    ? "No time limit — this run ends when you or a rival ends it."
    : `Time limit ${formatClock(model.rules.clock.remainingSeconds)} left`);

  const surrender = relief.surrender;
  return {
    id: "score",
    title: "Score",
    lines,
    actions: [{
      id: "surrender",
      label: "Surrender the run",
      detail: surrender.state === "surrendered" ? "already surrendered" : `ends the run on ${planetName(surrender.seatId)}`,
      enabled: surrender.canSurrender,
      command: { kind: "intent", intent: { kind: "surrender" } },
    }],
    // The one thing that cannot be undone, said before it happens (P2-T12) — and the second line is
    // the whole reason the warning is worth the space.
    warning: surrender.canSurrender
      ? "Surrender cannot be undone."
        + (surrender.reliefWouldFollow ? " You hold nothing — but a relief ship is coming." : "")
      : null,
  };
}

/** Saved games (P5-T09). The panel describes; the shell writes. */
function savesSection(galaxy: Galaxy, catalog: SaveCatalog, now: number): EconomySection {
  const model = savePanelModel({ catalog, galaxy, now });
  const lines: string[] = [];
  if (model.storageProblem) lines.push(model.storageProblem);
  if (!model.rows.length && !model.storageProblem) lines.push("No saved games in this browser.");
  for (const row of model.rows) lines.push(`${row.name} — ${row.detail} · ${row.ageText}`);

  const actions: HudAction[] = [{
    id: "save",
    label: "Save",
    detail: model.suggestedName,
    enabled: model.canSave,
    command: { kind: "save", name: model.suggestedName },
  }];
  for (const row of model.rows) {
    // A row that cannot be loaded still gets its button, disabled and struck through, because the
    // failure to avoid is the silent one — a live button whose click returns false into nothing.
    actions.push({
      id: `load:${row.id}`,
      label: `Load ${row.name}`,
      detail: row.canLoad ? row.description.summary : row.detail,
      enabled: row.canLoad,
      command: { kind: "loadSave", id: row.id },
    });
    actions.push({
      id: `delete:${row.id}`,
      label: `Delete ${row.name}`,
      detail: "frees this slot",
      enabled: true,
      command: { kind: "deleteSave", id: row.id },
    });
  }
  return { id: "saves", title: "Saved games", lines, actions, warning: model.warning };
}

/** Preferences (P5-T10). Each option carries a WHOLE `Settings`, so the shell never merges. */
function settingsSection(settings: Settings, currentTier: Tier): EconomySection {
  const model = settingsModel({ settings, currentTier });
  const lines: string[] = [];
  const actions: HudAction[] = [];
  for (const row of model.rows) {
    lines.push(`${row.label} — ${row.detail}`);
    for (const option of row.options) {
      actions.push({
        id: `set:${row.id}:${option.id}`,
        label: option.active ? `● ${option.label}` : option.label,
        detail: option.detail,
        enabled: !option.active,
        command: { kind: "settings", settings: option.settings },
      });
    }
  }
  return { id: "settings", title: "Settings", lines, actions, warning: null };
}

/** The first sixty seconds (P5-T10), on the world screen and nowhere else. */
function onboardingSection(model: OnboardingModel): EconomySection {
  const lines = model.steps.map((step) => {
    // `null` is not `false`. A step the snapshot cannot honestly answer for — did you rotate the
    // camera? — gets a neutral mark, because an empty checkbox against something nobody measured is
    // the interface calling the player a failure.
    const mark = step.done === true ? "✓" : step.done === false ? "·" : " ";
    const lead = step.id === model.nextStepId ? "▸" : mark;
    return `${lead} ${step.text}`;
  });
  return {
    id: "onboarding",
    title: model.title,
    lines,
    actions: [{
      id: "dismissOnboarding",
      label: model.dismissLabel,
      detail: "for good — this card does not come back",
      enabled: true,
      command: { kind: "dismissOnboarding" },
    }],
    warning: null,
  };
}

/**
 * The approach view's panel (P4-T05) and the one button that commits a jump.
 *
 * **The landing fields are omitted when the panel says they are null**, and that is deliberate
 * rather than tidy: `landingZone` discards a landing point whenever a pad stands on the destination,
 * so an intent carrying one would be a promise the recorded stream keeps and the game does not. The
 * panel decides; this only obeys, which is why the two can never disagree.
 */
function approachSection(approach: ApproachState): EconomySection {
  const panel = landingPanelModel(approach.brief, approach.pick, approach.site);
  const name = planetName(panel.destId);
  const jump: Intent = panel.landingX !== null && panel.landingY !== null
    ? { kind: "jump", destId: panel.destId, landingX: panel.landingX, landingY: panel.landingY }
    : { kind: "jump", destId: panel.destId };

  return {
    id: "approach",
    title: `Approach · ${name}`,
    lines: [
      panel.headline,
      panel.detail,
      // Blank rather than absent when the mark was not moved: the drawer rebuilds its nodes when
      // the line COUNT changes, and a line that came and went as the pointer crossed a grid edge
      // would rebuild this section on every other pointer move.
      panel.drift > 0 ? `the engine moved your mark ${Math.round(panel.drift)} units` : "",
    ],
    actions: [
      {
        id: `jump:${panel.destId}`,
        label: `Jump to ${name}`,
        detail: panel.canConfirm ? `landing at ${Math.round(panel.siteX)}, ${Math.round(panel.siteY)}` : "mark a spot first",
        enabled: panel.canConfirm,
        command: { kind: "intent", intent: jump },
      },
      {
        id: "backToStarmap",
        label: "Back to the starmap",
        detail: "no jump, nothing spent",
        enabled: true,
        command: { kind: "screen", screen: "starmap" },
      },
    ],
    // `override` is present only when the engine will overrule the pick, and it says so plainly —
    // the same slot the doctrine commitment uses, for the same reason: it is the thing a player has
    // to be told BEFORE they press the button, not after.
    warning: panel.override,
  };
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
  private lastScreen = "";
  /**
   * What each button node is currently for.
   *
   * A `WeakMap` because the key is the node: `replaceChildren` drops whole rows of buttons on a
   * structural change and nothing else would ever remove their entries.
   */
  private readonly bound = new WeakMap<Element, HudAction>();

  constructor(private readonly root: HTMLElement, private readonly cb: HudCallbacks) {
    root.innerHTML = TEMPLATE;
  }

  /**
   * Which screen the shell is showing, published to the stylesheet (P4-T13).
   *
   * One attribute, written only when it changes, and the CSS does the rest — the starmap replaces
   * the battlefield's frame (ADR-0019 §1), so the minimap beside it is no longer looking at what
   * the player is looking at, and the drawer has the whole bottom of the screen to itself once the
   * world's action row is empty.
   */
  setScreen(screen: string): void {
    if (this.lastScreen === screen) return;
    this.lastScreen = screen;
    this.root.dataset.screen = screen;
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
    this.syncActions(host, model.actions);
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
      this.syncActions(this.root.querySelector<HTMLElement>(`[data-econ-actions="${s.id}"]`), s.actions);
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
    this.bind(b, action);
    // The command is read at the PRESS from whatever this button is currently bound to — not
    // captured here, and not an index either.
    //
    // The index was never right: a button that fired "action 3" would fire whatever the third
    // action happened to be by the time it was clicked. Capturing the command looked right and was
    // subtly wrong in the other direction, because the node SET is only rebuilt when the button ids
    // change (see `render`): a button whose id is stable while its payload flips kept the payload it
    // was born with. That is not hypothetical — `pause:b7` carries `paused: !building.paused`, so a
    // paused factory's button went on sending "pause" forever, and P4-T13's jump confirm carries the
    // landing point the pointer is over, which changes without changing anything's id.
    b.addEventListener("click", () => {
      const bound = this.bound.get(b);
      if (bound) this.cb.onCommand(bound.command);
    });
    return b;
  }

  /**
   * Point a button at its current action, writing only what changed.
   *
   * Same rule as `setText` and for the same reason (P1-T16): this runs for every button on screen
   * every frame, and a label written unconditionally is a style recalculation the frame budget has
   * not got. The previous action is what it is compared against, so the check costs one reference.
   */
  private bind(el: Element, action: HudAction): void {
    const prev = this.bound.get(el);
    this.bound.set(el, action);
    if (!prev || prev.label !== action.label) el.querySelector(".hud-button-label")!.textContent = action.label;
    if (!prev || prev.detail !== action.detail) el.querySelector(".hud-button-cost")!.textContent = action.detail;
    el.classList.toggle("unaffordable", !action.enabled);
  }

  /** Re-bind a row of buttons that was NOT rebuilt this frame. Order is the model's, as built. */
  private syncActions(host: HTMLElement | null, actions: readonly HudAction[]): void {
    if (!host) return;
    const children = host.children;
    for (let i = 0; i < children.length; i++) {
      const action = actions[i];
      if (action) this.bind(children[i]!, action);
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
