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

export interface HudModel {
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

  return {
    canDeploy,
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
// DOM binding. Everything above this line is testable without a browser.
// ---------------------------------------------------------------------------

export interface HudCallbacks {
  onTrain(unitType: string): void;
  onBuild(buildingType: string): void;
  onDeploy(): void;
}

export class HudView {
  private lastText = new Map<string, string>();
  private lastProductionKey = "";
  private lastBuildKey = "";
  private lastDeploy: boolean | null = null;

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

    const supply = this.root.querySelector<HTMLElement>('[data-hud="supply"]');
    if (supply) supply.classList.toggle("blocked", model.supplyBlocked);

    this.setText("selection-detail", model.selection.length === 1
      ? `${model.selection[0]!.hp} / ${model.selection[0]!.maxHp} HP`
      : model.selection.length > 1 ? `${model.selection.length} selected` : "");

    // Buttons are rebuilt only when the SET changes, not when affordability does — affordability
    // is a class toggle. Rebuilding a button list every frame is both garbage and a lost click.
    if (model.canDeploy !== this.lastDeploy) {
      this.lastDeploy = model.canDeploy;
      const host = this.root.querySelector<HTMLElement>('[data-hud="deploy"]');
      if (host) {
        host.replaceChildren(...(model.canDeploy
          ? [this.button("Deploy base", "founds a Command Center here", () => this.cb.onDeploy())]
          : []));
      }
    }

    const prodKey = model.production.map((p) => p.unitType).join(",");
    const prodHost = this.root.querySelector<HTMLElement>('[data-hud="production"]');
    if (prodHost && prodKey !== this.lastProductionKey) {
      this.lastProductionKey = prodKey;
      prodHost.replaceChildren(...model.production.map((p) =>
        this.button(p.label, p.costText, () => this.cb.onTrain(p.unitType))));
    }
    this.syncAffordability(prodHost, model.production.map((p) => p.affordable));

    const buildKey = model.builds.map((b) => b.buildingType).join(",");
    const buildHost = this.root.querySelector<HTMLElement>('[data-hud="builds"]');
    if (buildHost && buildKey !== this.lastBuildKey) {
      this.lastBuildKey = buildKey;
      buildHost.replaceChildren(...model.builds.map((b) =>
        this.button(b.label, b.costText, () => this.cb.onBuild(b.buildingType))));
    }
    this.syncAffordability(buildHost, model.builds.map((b) => b.affordable));
  }

  /** Transient message — a rejected order, a tier drop. Cleared by the next one. */
  notice(text: string | null): void {
    const el = this.root.querySelector<HTMLElement>('[data-hud="notice"]');
    if (!el) return;
    el.textContent = text ?? "";
    el.classList.toggle("visible", !!text);
  }

  private button(label: string, cost: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "hud-button";
    b.innerHTML = `<span class="hud-button-label"></span><span class="hud-button-cost"></span>`;
    b.querySelector(".hud-button-label")!.textContent = label;
    b.querySelector(".hud-button-cost")!.textContent = cost;
    b.addEventListener("click", onClick);
    return b;
  }

  private syncAffordability(host: HTMLElement | null, affordable: readonly boolean[]): void {
    if (!host) return;
    const children = host.children;
    for (let i = 0; i < children.length; i++) {
      children[i]!.classList.toggle("unaffordable", !affordable[i]);
    }
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
  <div class="hud-bottom">
    <div class="hud-panel">
      <div class="hud-title" data-hud="selection-summary">Nothing selected</div>
      <div class="hud-detail" data-hud="selection-detail"></div>
    </div>
    <div class="hud-actions">
      <div class="hud-row" data-hud="deploy"></div>
      <div class="hud-row" data-hud="production"></div>
      <div class="hud-row" data-hud="builds"></div>
    </div>
  </div>
`;
