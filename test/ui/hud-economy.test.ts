// @vitest-environment jsdom
//
// P4-T01 — the economy drawer: the composition layer that was missing, and the DOM writer that
// renders it.
//
// Two properties are load-bearing here and neither is about what the panels say.
//
//  1. **Reading a panel cannot move the simulation.** `researchPanelModel` and `doctrinePanelModel`
//     are dry runs of the engine's own gating — they call `researchTech`/`researchUpgrade` for real
//     and undo them — and `logisticsModel`/`repairPanelModel` sit one careless line away from
//     `countLogistics`/`countRepairJobs`, which look like queries and are mutators. A panel that
//     moved the state hash would be a determinism bug that appeared only while it happened to be
//     open, which is the worst shape of bug this project can have.
//  2. **The DOM writer touches nothing whose text has not changed** (P1-T16). The HUD runs inside
//     the same 16.6 ms as the renderer, and a research panel is twenty-odd buttons; rebuilding
//     those every frame is both the largest allocation in the client and a lost click.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EconomyInput, type EconomyModel, type HudAction, type HudCommand, EconomyCache, HudView,
  economyModel, hudModel,
} from "../../src/ui/hud.js";
import { type Intent } from "../../src/bridge/commands.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { makeBuilding } from "../../src/engine/index.js";
import { hashState } from "../determinism/replay.js";

const SEED = 20260814;

function opened(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
  bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  bridge.enqueue({ kind: "deploy" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

function selectBuilding(bridge: WorldBridge, type: string): Building {
  const b = makeBuilding(type, "player", 620, 620);
  bridge.state.buildings.set(b.id, b);
  bridge.enqueue({ kind: "select", ids: [b.id], additive: false });
  bridge.step(STEP_SECONDS);
  return b;
}

/** The intent behind a button, refusing anything that is not one. */
function intentOf(action: HudAction): Intent {
  if (action.command.kind !== "intent") throw new Error(`${action.id} carries no intent`);
  return action.command.intent;
}

function model(bridge: WorldBridge, board: "market" | "logistics" | null = null): EconomyModel {
  return economyModel({
    onboardingSeen: true,
    hud: hudModel(bridge.snapshot),
    state: bridge.state,
    snap: bridge.snapshot,
    credits: bridge.galaxyCredits,
    board,
    ghost: null,
  });
}

describe("reading the economy panels cannot move the simulation", () => {
  it("leaves the state hash untouched with every panel composed", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    bridge.state.players.player.resources.radioactives = 200;
    bridge.state.players.player.resources.ore = 400;
    for (const type of ["datacenter", "refinery", "plasmarig", "smelter"]) {
      const b = makeBuilding(type, "player", 620, 620);
      bridge.state.buildings.set(b.id, b);
    }
    bridge.step(STEP_SECONDS);

    for (const type of ["datacenter", "refinery", "plasmarig", "smelter"]) {
      const b = [...bridge.state.buildings.values()].find((x) => x.type === type)!;
      bridge.enqueue({ kind: "select", ids: [b.id], additive: false });
      bridge.step(STEP_SECONDS);

      const before = hashState(bridge.state);
      for (const board of [null, "market", "logistics"] as const) {
        economyModel({
    onboardingSeen: true,
          hud: hudModel(bridge.snapshot), state: bridge.state, snap: bridge.snapshot,
          credits: bridge.galaxyCredits, board,
          ghost: { buildingType: "plasmarig", x: 700, y: 700 },
        });
      }
      expect(hashState(bridge.state), `composing the panels for a ${type} moved the simulation`)
        .toBe(before);
    }
  });

  it("leaves no phantom entry in a research queue the dry runs pushed to", () => {
    // `hashState` does not cover `researchQueue`, so the hash above cannot see this one — and it is
    // the specific leak the panels' own headers warn about: the dry run truncates IN PLACE because
    // assigning a saved copy back left the caller holding the mutated array. A phantom entry here
    // would read as a third tech in a queue of two, and on a Refinery it would be worse:
    // `committedDoctrine` reads the queue, so a phantom would lock out two real doctrine paths.
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    const datacenter = selectBuilding(bridge, "datacenter");
    expect(datacenter.researchQueue ?? []).toHaveLength(0);

    model(bridge);
    model(bridge);
    expect(datacenter.researchQueue ?? [], "a dry run left a job in the queue").toHaveLength(0);

    const refinery = selectBuilding(bridge, "refinery");
    model(bridge);
    expect(refinery.researchQueue ?? [], "a dry run left a doctrine job in the queue").toHaveLength(0);
  });

  it("is a pure function — the same inputs always yield the same model", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    selectBuilding(bridge, "datacenter");
    expect(model(bridge)).toEqual(model(bridge));
  });
});

describe("the economy model is a function of a tick, not of a frame", () => {
  function inputOf(bridge: WorldBridge, over: Partial<EconomyInput> = {}): EconomyInput {
    return {
      hud: hudModel(bridge.snapshot), state: bridge.state, snap: bridge.snapshot,
      credits: bridge.galaxyCredits, board: null, ghost: null, onboardingSeen: true, ...over,
    };
  }

  it("returns the very same object across frames inside one tick", () => {
    // `economyModel` allocates a fresh object every call, so reference equality is proof that the
    // dry runs did NOT happen again. This is the whole perf argument for the drawer: the HUD is
    // rendered ~3 times per tick, and a research panel is eleven speculative `researchTech` calls.
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    selectBuilding(bridge, "datacenter");

    const cache = new EconomyCache();
    const first = cache.get(inputOf(bridge));
    expect(cache.get(inputOf(bridge)), "the economy model was rebuilt within one tick").toBe(first);
    expect(cache.get(inputOf(bridge))).toBe(first);
    expect(first.sections.some((s) => s.id === "research")).toBe(true);
  });

  it("rebuilds when the tick moves, so it can never show a stale number", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    selectBuilding(bridge, "datacenter");
    const cache = new EconomyCache();
    const first = cache.get(inputOf(bridge));
    bridge.step(STEP_SECONDS);
    expect(cache.get(inputOf(bridge)), "the cache outlived the tick it was built from").not.toBe(first);
  });

  it("rebuilds when the selection, the board or the ghost changes", () => {
    const bridge = opened();
    selectBuilding(bridge, "smelter");
    const cache = new EconomyCache();
    const base = cache.get(inputOf(bridge));

    expect(cache.get(inputOf(bridge, { board: "market" })), "opening a board did not rebuild").not.toBe(base);
    expect(cache.get(inputOf(bridge, { ghost: { buildingType: "plasmarig", x: 700, y: 700 } })),
      "arming a build ghost did not rebuild").not.toBe(base);

    const again = cache.get(inputOf(bridge));
    const other = selectBuilding(bridge, "datacenter");
    expect(cache.get(inputOf(bridge)), "selecting another building did not rebuild").not.toBe(again);
    expect(other.type).toBe("datacenter");
  });

  it("ignores a mouse twitch under the build ghost but not a real move", () => {
    const bridge = opened();
    const cache = new EconomyCache();
    const at = (x: number, y: number) => cache.get(inputOf(bridge, { ghost: { buildingType: "plasmarig", x, y } }));
    const first = at(700, 700);
    expect(at(701, 700), "a two-pixel drift re-surveyed the whole map").toBe(first);
    expect(at(900, 700), "a real move did not re-survey").not.toBe(first);
  });
});

describe("the economy drawer's DOM writer", () => {
  let root: HTMLElement;
  let commands: HudCommand[];
  let view: HudView;

  beforeEach(() => {
    root = document.createElement("div");
    commands = [];
    view = new HudView(root, { onCommand: (c) => commands.push(c) });
  });

  it("renders a section's title, lines and buttons", () => {
    const bridge = opened();
    selectBuilding(bridge, "smelter");
    view.renderEconomy(model(bridge));

    const host = root.querySelector('[data-hud="economy"]')!;
    expect(host.classList.contains("visible")).toBe(true);
    expect(root.querySelector('[data-hud="econ:building:title"]')!.textContent).toBeTruthy();
    expect(host.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("hides itself when there is nothing to show", () => {
    const bridge = opened();
    view.renderEconomy(model(bridge));   // nothing selected, no board open
    expect(root.querySelector('[data-hud="economy"]')!.classList.contains("visible")).toBe(false);
  });

  it("does not touch a single node when the model has not changed (P1-T16)", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    selectBuilding(bridge, "datacenter");
    const m = model(bridge);
    view.renderEconomy(m);

    // The instrument: every text write and every node replacement in the subtree is counted. A
    // render that rebuilt the panel, or re-wrote text it had already written, shows up here as a
    // non-zero count — which is the regression the perf gate cannot see because the HUD is not in it.
    let writes = 0;
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-hud], [data-econ-actions]")];
    for (const node of nodes) {
      const own = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
      Object.defineProperty(node, "textContent", {
        configurable: true,
        get: own.get,
        set(v: string) { writes++; own.set!.call(this, v); },
      });
      vi.spyOn(node, "replaceChildren").mockImplementation(function (this: HTMLElement, ...args: (string | Node)[]) {
        writes++;
        Element.prototype.replaceChildren.apply(this, args);
      });
    }

    view.renderEconomy(m);
    view.renderEconomy(m);
    expect(writes, "the economy drawer rewrote the DOM for an unchanged model").toBe(0);
  });

  it("rebuilds the buttons when the SET changes, and only then", () => {
    const bridge = opened();
    selectBuilding(bridge, "smelter");
    const first = model(bridge);
    view.renderEconomy(first);
    const before = [...root.querySelectorAll("button")];
    expect(before.length).toBeGreaterThan(0);

    // Same set, different text: the buttons must be the SAME nodes, or a click lands on a button
    // that was replaced between the mousedown and the mouseup.
    view.renderEconomy(model(bridge));
    expect([...root.querySelectorAll("button")], "an unchanged button set was rebuilt").toEqual(before);

    // A different building is a different set, and must rebuild.
    selectBuilding(bridge, "datacenter");
    view.renderEconomy(model(bridge));
    expect([...root.querySelectorAll("button")]).not.toEqual(before);
  });

  it("fills a reopened panel rather than leaving it blank", () => {
    // The bug the `econ:` key eviction exists to stop. Close a panel and reopen it: the nodes are
    // new, but a `setText` cache still holding the old strings would decide nothing had changed and
    // skip every write, and the panel would come back empty.
    const bridge = opened();
    selectBuilding(bridge, "smelter");
    view.renderEconomy(model(bridge));
    const title = root.querySelector('[data-hud="econ:building:title"]')!.textContent;
    expect(title).toBeTruthy();

    bridge.enqueue({ kind: "select", ids: [], additive: false });
    bridge.step(STEP_SECONDS);
    view.renderEconomy(model(bridge));                       // closed — the section is gone

    const smelter = [...bridge.state.buildings.values()].find((b) => b.type === "smelter")!;
    bridge.enqueue({ kind: "select", ids: [smelter.id], additive: false });
    bridge.step(STEP_SECONDS);
    view.renderEconomy(model(bridge));                       // reopened
    expect(root.querySelector('[data-hud="econ:building:title"]')!.textContent,
      "the reopened panel came back blank").toBe(title);
  });

  it("sends the button's own command, not an index into a row that has since moved", () => {
    const bridge = opened();
    const smelter = selectBuilding(bridge, "smelter");
    view.renderEconomy(model(bridge));

    const pause = [...root.querySelectorAll("button")]
      .find((b) => b.textContent?.startsWith("Pause"))!;
    pause.click();
    expect(commands).toEqual([
      { kind: "intent", intent: { kind: "pause", buildingId: smelter.id, paused: true } },
    ]);
  });

  it("marks a disabled control instead of hiding it, and never by colour alone (N-05)", () => {
    const bridge = opened();
    selectBuilding(bridge, "smelter");
    view.renderEconomy(model(bridge));
    // "Haul normal" is the priority already set, so its button is the disabled one.
    const disabled = [...root.querySelectorAll("button")].filter((b) => b.classList.contains("unaffordable"));
    expect(disabled.length, "no control was marked disabled").toBeGreaterThan(0);
    // The class dims AND strikes the detail through in the stylesheet; what matters here is that the
    // reason is in the TEXT as well, so it survives a player who cannot separate the two shades.
    expect(disabled.some((b) => (b.textContent ?? "").includes("current"))).toBe(true);
  });
});

describe("the main action row", () => {
  it("keeps Deploy findable by its accessible name, which the smoke test drives", () => {
    const root = document.createElement("div");
    const view = new HudView(root, { onCommand: () => {} });
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    bridge.step(STEP_SECONDS);

    view.render(hudModel(bridge.snapshot));
    const deploy = [...root.querySelectorAll("button")].find((b) => /deploy/i.test(b.textContent ?? ""));
    expect(deploy, "e2e/smoke.spec.ts finds this button by name — S6's one discoverable action")
      .toBeDefined();
  });

  it("rebuilds the row only when the action set changes", () => {
    const root = document.createElement("div");
    const view = new HudView(root, { onCommand: () => {} });
    const bridge = opened();
    const worker = [...bridge.state.units.values()].find((u) => u.type === "worker" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
    bridge.step(STEP_SECONDS);

    view.render(hudModel(bridge.snapshot));
    const before = [...root.querySelectorAll("button")];
    expect(before.length).toBeGreaterThan(0);

    // Affordability changes; the SET does not. The nodes must survive.
    bridge.state.players.player.resources.ore = 0;
    bridge.step(STEP_SECONDS);
    view.render(hudModel(bridge.snapshot));
    expect([...root.querySelectorAll("button")], "the build row was rebuilt for an affordability change")
      .toEqual(before);
    expect(before.some((b) => b.classList.contains("unaffordable")),
      "nothing was marked unaffordable after the ore ran out").toBe(true);
  });
});

describe("a refused economy order reaches the player", () => {
  it("surfaces the engine's own refusal through takeCommandError, the way a build order does", () => {
    const bridge = opened();
    const refinery = selectBuilding(bridge, "refinery");
    // Commit to one doctrine, then ask for another. The engine returns a bare `false` for both
    // "too poor" and "closed forever"; the bridge is what turns it into the sentence a player needs.
    bridge.state.players.player.resources.crystals = 500;
    bridge.state.players.player.resources.radioactives = 200;
    const taken = model(bridge).actions.find((a) => a.enabled
      && a.command.kind === "intent" && a.command.intent.kind === "doctrine")!;
    expect(bridge.apply(intentOf(taken))).toBeNull();

    const closed = model(bridge).actions.find((a) => !a.enabled
      && a.command.kind === "intent" && a.command.intent.kind === "doctrine"
      && a.detail.startsWith("closed"))!;
    bridge.enqueue(intentOf(closed));
    bridge.step(STEP_SECONDS);

    expect(bridge.takeCommandError(), "a closed doctrine was refused silently")
      .toMatch(/closed|committed/i);
    expect(refinery.researchQueue).toHaveLength(1);
  });
});
