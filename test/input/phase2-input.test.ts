// Phase 2's economy, reachable by a player (P4-T01).
//
// **The sibling of `phase3-input.test.ts`, and it exists for the same finding one phase later.**
// Writing the Phase 3 playtest script turned up that Phase 3's orders were implemented, tested and
// unreachable; the board recorded that the wider version of it was Phase 2's, and larger. Six of
// the seven modules in `src/ui/` were imported by nothing at all, and `src/input/intents.ts` emitted
// only Phase 1's gestures — so every economy intent existed at the bridge, was tested at the bridge,
// and could not be issued.
//
// The last describe is the one that stops it happening a third time: it enumerates the economy
// intent kinds and fails when any of them has no control producing it. It is written against the
// REAL models — a real `WorldBridge`, a real `hudModel`, a real `economyModel` — because a test that
// enumerated a hand-written list of intents would pass with the wiring deleted, which is precisely
// the failure mode this whole row is about.

import { describe, expect, it } from "vitest";
import { POSITIONAL_KEYS, translateKey } from "../../src/input/intents.js";
import {
  type EconomyBoard, type HudAction, type HudCommand, economyModel, hudModel,
} from "../../src/ui/hud.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { LOGI_PRIORITIES, makeBuilding } from "../../src/engine/index.js";
import { type Intent } from "../../src/bridge/commands.js";

const SEED = 20260814;

/** A world with a base down, which is the state every economy panel is read in. */
function opened(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
  bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  bridge.enqueue({ kind: "deploy" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

/** Put `type` on the map, select it, and settle a tick so the snapshot carries it. */
function selectBuilding(bridge: WorldBridge, type: string): Building {
  const b = makeBuilding(type, "player", 620, 620);
  bridge.state.buildings.set(b.id, b);
  bridge.enqueue({ kind: "select", ids: [b.id], additive: false });
  bridge.step(STEP_SECONDS);
  return b;
}

/** Everything the HUD is showing, in the order the shell concatenates it (see `Game.renderFrame`). */
function shownActions(bridge: WorldBridge, board: EconomyBoard | null = null): readonly HudAction[] {
  const hud = hudModel(bridge.snapshot);
  const economy = economyModel({
    hud,
    state: bridge.state,
    snap: bridge.snapshot,
    credits: bridge.galaxyCredits,
    board,
    ghost: null,
  });
  return [...hud.actions, ...economy.actions];
}

function intentsOn(actions: readonly HudAction[]): HudCommand[] {
  return actions.map((a) => a.command);
}

/** The intent behind a button, refusing anything that is not one — a `buildMode` is not an order. */
function intentOf(action: HudAction): Intent {
  if (action.command.kind !== "intent") throw new Error(`${action.id} carries no intent`);
  return action.command.intent;
}

/** …narrowed to one kind, so a payload assertion below is checked rather than cast blind. */
function intentOfKind<K extends Intent["kind"]>(action: HudAction, kind: K): Extract<Intent, { kind: K }> {
  const intent = intentOf(action);
  if (intent.kind !== kind) throw new Error(`${action.id} carries ${intent.kind}, not ${kind}`);
  return intent as Extract<Intent, { kind: K }>;
}

function findIntent(actions: readonly HudAction[], kind: string): HudAction | undefined {
  return actions.find((a) => a.command.kind === "intent" && a.command.intent.kind === kind);
}

describe("the building controls reach the engine (P2-T09)", () => {
  it("offers pause and electrify on a building that has both, carrying the flip of its state", () => {
    const bridge = opened();
    // A Smelter has a recipe (so it can be paused) — `canPause` is the building panel's own answer
    // and this test does not second-guess it.
    const smelter = selectBuilding(bridge, "smelter");
    const pause = findIntent(shownActions(bridge), "pause");
    expect(pause, "a running factory offered no way to stop it").toBeDefined();
    expect(pause!.command).toEqual({
      kind: "intent", intent: { kind: "pause", buildingId: smelter.id, paused: true },
    });

    // …and once paused, the same button is the way back. A one-way pause is a trap.
    smelter.paused = true;
    bridge.step(STEP_SECONDS);
    const resume = findIntent(shownActions(bridge), "pause")!;
    expect(resume.label).toBe("Resume");
    expect(resume.command).toEqual({
      kind: "intent", intent: { kind: "pause", buildingId: smelter.id, paused: false },
    });
  });

  it("offers electrify only where the engine says it is electrifiable", () => {
    const bridge = opened();
    // The Command Center is one of the four the engine names as electrifiable; a Smelter is a
    // producer and powers itself, so offering it would be a button the engine ignores (F-07).
    const cc = [...bridge.state.buildings.values()].find((b) => b.type === "command" && b.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [cc.id], additive: false });
    bridge.step(STEP_SECONDS);
    const on = findIntent(shownActions(bridge), "electrify");
    expect(on!.command).toEqual({
      kind: "intent", intent: { kind: "electrify", buildingId: cc.id, on: true },
    });

    selectBuilding(bridge, "smelter");
    expect(findIntent(shownActions(bridge), "electrify"),
      "a Smelter is not electrifiable and must not be offered it").toBeUndefined();
  });

  it("offers scrap with the refund the engine will actually pay, and a way to call it off", () => {
    const bridge = opened();
    const smelter = selectBuilding(bridge, "smelter");
    const scrap = findIntent(shownActions(bridge), "recycle");
    expect(scrap!.command).toEqual({ kind: "intent", intent: { kind: "recycle", entityId: smelter.id } });
    // The refund is `recycleValue`'s, which counts the buffers as well as a slice of the build cost.
    expect(scrap!.detail).toMatch(/refunds \d/);

    smelter.recycling = { progress: 0, time: 5 } as Building["recycling"];
    bridge.step(STEP_SECONDS);
    const actions = shownActions(bridge);
    expect(findIntent(actions, "recycle"), "a scrap already running must not offer a second one").toBeUndefined();
    expect(findIntent(actions, "cancelRecycle")!.command)
      .toEqual({ kind: "intent", intent: { kind: "cancelRecycle", entityId: smelter.id } });
  });

  it("offers every haulage priority the engine defines, and never the one already set", () => {
    const bridge = opened();
    const smelter = selectBuilding(bridge, "smelter");
    const actions = shownActions(bridge);
    const offered = actions.filter((a) => a.command.kind === "intent" && a.command.intent.kind === "logiPriority");
    expect(offered.map((a) => intentOfKind(a, "logiPriority").priority))
      .toEqual([...LOGI_PRIORITIES]);
    // Unset means the engine's default, so "normal" is the current one and is the disabled button.
    expect(offered.find((a) => !a.enabled)!.detail).toBe("current");
    expect(offered.every((a) => intentOfKind(a, "logiPriority").buildingId === smelter.id)).toBe(true);
  });

  it("keeps the priority cast honest against the engine's own list", () => {
    // `logiPriority`'s intent names three priorities; `LOGI_PRIORITIES` is the engine's list, and
    // the HUD narrows one to the other with a guard. A fourth priority upstream would be silently
    // dropped by that guard — so this is the assertion that turns it into a failing test instead.
    // Same discipline as `FORMATION_KEY_SHAPES` in the Phase 3 file.
    expect([...LOGI_PRIORITIES]).toEqual(["high", "normal", "low"]);
  });
});

describe("research and doctrine reach the engine (P2-T11, P2-T12)", () => {
  it("puts every startable tech on a button at a Datacenter, and nothing anywhere else", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    bridge.state.players.player.resources.radioactives = 200;
    const datacenter = selectBuilding(bridge, "datacenter");

    const research = shownActions(bridge)
      .filter((a) => a.command.kind === "intent" && a.command.intent.kind === "research");
    expect(research.length, "a Datacenter offered no research").toBeGreaterThan(0);
    expect(research.every((a) => intentOfKind(a, "research").buildingId === datacenter.id)).toBe(true);
    // Enabled must track the panel's dry run, not this test's opinion: an enabled button whose
    // intent the engine refuses is the exact defect F-07 is about.
    for (const action of research.filter((a) => a.enabled)) {
      const intent = intentOfKind(action, "research");
      expect(bridge.apply(intent), `${intent.techId} was offered but refused`).toBeNull();
    }

    selectBuilding(bridge, "smelter");
    expect(findIntent(shownActions(bridge), "research"),
      "research is a Datacenter's and nowhere else's").toBeUndefined();
  });

  it("offers a cancel for each queued job, addressed by its INDEX", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    const datacenter = selectBuilding(bridge, "datacenter");
    const startable = shownActions(bridge).find((a) => a.enabled
      && a.command.kind === "intent" && a.command.intent.kind === "research")!;
    bridge.enqueue(intentOfKind(startable, "research"));
    bridge.step(STEP_SECONDS);

    const cancel = findIntent(shownActions(bridge), "cancelResearch");
    expect(cancel, "a queued tech offered no way to cancel it").toBeDefined();
    expect(cancel!.command).toEqual({
      kind: "intent", intent: { kind: "cancelResearch", buildingId: datacenter.id, index: 0 },
    });
  });

  it("offers doctrines at a Refinery and warns while the choice is still open", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    bridge.state.players.player.resources.radioactives = 200;
    const refinery = selectBuilding(bridge, "refinery");

    const hud = hudModel(bridge.snapshot);
    const economy = economyModel({
      hud, state: bridge.state, snap: bridge.snapshot, credits: bridge.galaxyCredits,
      board: null, ghost: null,
    });
    const doctrine = economy.actions
      .filter((a) => a.command.kind === "intent" && a.command.intent.kind === "doctrine");
    expect(doctrine.length, "a Refinery offered no doctrine").toBeGreaterThan(0);
    expect(doctrine.every((a) => intentOfKind(a, "doctrine").buildingId === refinery.id)).toBe(true);

    // The permanence, stated BEFORE the click. That is the whole trade-off P2-T12 asks for: the
    // engine's own refusal for a locked-out path is a bare `false` and arrives one doctrine too late.
    const section = economy.sections.find((s) => s.id === "doctrine")!;
    expect(section.warning, "nothing warned that a doctrine closes the other two").toMatch(/closes the other two/i);
  });

  it("stops warning once the choice is gone, and keeps the closed paths readable", () => {
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    bridge.state.players.player.resources.radioactives = 200;
    const refinery = selectBuilding(bridge, "refinery");
    const first = shownActions(bridge).find((a) => a.enabled
      && a.command.kind === "intent" && a.command.intent.kind === "doctrine")!;
    expect(bridge.apply(intentOf(first))).toBeNull();
    bridge.step(STEP_SECONDS);

    const economy = economyModel({
      hud: hudModel(bridge.snapshot), state: bridge.state, snap: bridge.snapshot,
      credits: bridge.galaxyCredits, board: null, ghost: null,
    });
    const section = economy.sections.find((s) => s.id === "doctrine")!;
    expect(section.warning, "the warning outlived the choice it was about").toBeNull();
    // A closed path keeps its buttons so the player can read what they gave up — disabled, with the
    // engine's reason on them rather than a blank.
    const closed = section.actions.filter((a) => !a.enabled && a.detail.startsWith("closed"));
    expect(closed.length, "the two closed doctrines vanished instead of saying they were closed")
      .toBeGreaterThan(0);
    expect(refinery.researchQueue?.length).toBe(1);
  });
});

describe("the market reaches the engine (P2-T10)", () => {
  it("offers a buy and a sell for every tradeable, in the engine's own lot", () => {
    const bridge = opened();
    bridge.state.players.player.resources.ore = 400;
    bridge.step(STEP_SECONDS);

    const closed = shownActions(bridge, null);
    expect(findIntent(closed, "trade"), "the market was open without the player asking").toBeUndefined();

    const actions = shownActions(bridge, "market");
    const trades = actions.filter((a) => a.command.kind === "intent" && a.command.intent.kind === "trade");
    expect(trades.length).toBeGreaterThan(0);
    const sell = trades.find((a) => intentOfKind(a, "trade").side === "sell"
      && intentOfKind(a, "trade").com === "ore")!;
    expect(sell.enabled, "400 ore in the store and no way to sell it").toBe(true);
    expect(bridge.apply(intentOf(sell)),
      "the sell button the HUD enabled was refused by the engine").toBeNull();
  });
});

describe("no Phase 2 economy order is left unreachable", () => {
  it("gives every economy intent a control that produces it", () => {
    // The test that would have caught the original finding, one phase further back than the Phase 3
    // version. Everything here is driven through the REAL models: if the wiring in `hud.ts` is
    // removed, or a panel stops being composed, or a control stops carrying its intent, the kind
    // disappears from `reached` and this fails with its name in the message.
    const reached = new Set<string>();
    const record = (actions: readonly HudAction[]): void => {
      for (const command of intentsOn(actions)) {
        if (command.kind === "intent") reached.add(command.intent.kind);
      }
    };

    // A producer: pause, electrify (via the Command Center below), scrap, haul priority.
    const bridge = opened();
    bridge.state.players.player.resources.crystals = 500;
    bridge.state.players.player.resources.radioactives = 200;
    bridge.state.players.player.resources.ore = 400;
    selectBuilding(bridge, "smelter");
    record(shownActions(bridge));

    // Electrification lives on the four buildings the engine names, not on a producer.
    const cc = [...bridge.state.buildings.values()].find((b) => b.type === "command" && b.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [cc.id], additive: false });
    bridge.step(STEP_SECONDS);
    record(shownActions(bridge));

    // A scrap already under way is the only state that offers to call it off.
    const scrapping = selectBuilding(bridge, "foundry");
    scrapping.recycling = { progress: 0, time: 5 } as Building["recycling"];
    bridge.step(STEP_SECONDS);
    record(shownActions(bridge));

    // A Datacenter: research, and — once something is queued — cancelResearch.
    const datacenter = selectBuilding(bridge, "datacenter");
    record(shownActions(bridge));
    // Guarded rather than asserted, so that a missing research button fails the enumeration BELOW
    // with the intent's name in the message instead of throwing here. A setup that dies before the
    // assertion still fails, but it fails saying the wrong thing — and the message is the part of
    // this test that has to survive being read by whoever trips it a year from now.
    const tech = shownActions(bridge).find((a) => a.enabled
      && a.command.kind === "intent" && a.command.intent.kind === "research");
    if (tech) expect(bridge.apply(intentOf(tech)), "a research button the HUD enabled was refused").toBeNull();
    bridge.enqueue({ kind: "select", ids: [datacenter.id], additive: false });
    bridge.step(STEP_SECONDS);
    record(shownActions(bridge));

    // A Refinery: doctrine.
    selectBuilding(bridge, "refinery");
    record(shownActions(bridge));

    // The market board: trade.
    record(shownActions(bridge, "market"));

    const PHASE_2_INTENTS = [
      "pause", "electrify", "research", "cancelResearch", "recycle", "cancelRecycle",
      "trade", "logiPriority", "doctrine",
    ];
    const missing = PHASE_2_INTENTS.filter((k) => !reached.has(k));
    expect(missing, `no control produces: ${missing.join(", ")} — implemented but unreachable`)
      .toEqual([]);
  });

  it("keeps every panel module composed, which is the other half of the same gap", () => {
    // Six of the seven panel modules were imported by nothing. Reachability is not only about
    // intents: `repair-panel` and `rig-panel` emit no command at all, so an intent sweep would stay
    // green with both of them deleted. They are reached through the sections they produce.
    const bridge = opened();
    const rig = selectBuilding(bridge, "plasmarig");
    const withRig = economyModel({
      hud: hudModel(bridge.snapshot), state: bridge.state, snap: bridge.snapshot,
      credits: bridge.galaxyCredits, board: null, ghost: null,
    });
    expect(withRig.sections.map((s) => s.id), "the Rig's own yield panel is not composed").toContain("rig");
    expect(withRig.sections.find((s) => s.id === "rig")!.lines.length).toBeGreaterThan(0);
    expect(rig.type).toBe("plasmarig");

    // The survey is the PLACEMENT half and hangs off the build ghost, not off a selection.
    const withGhost = economyModel({
      hud: hudModel(bridge.snapshot), state: bridge.state, snap: bridge.snapshot,
      credits: bridge.galaxyCredits, board: null,
      ghost: { buildingType: "plasmarig", x: 700, y: 700 },
    });
    expect(withGhost.sections.map((s) => s.id), "the Rig survey never reaches the build ghost").toContain("survey");

    const board = economyModel({
      hud: hudModel(bridge.snapshot), state: bridge.state, snap: bridge.snapshot,
      credits: bridge.galaxyCredits, board: "logistics", ghost: null,
    });
    const logistics = board.sections.find((s) => s.id === "logistics")!;
    expect(logistics.lines.some((l) => /carriers/.test(l)), "the logistics model is not reported").toBe(true);
    expect(logistics.lines.some((l) => /supply/.test(l)), "the supply model is not reported").toBe(true);
    expect(logistics.lines.some((l) => /damaged/.test(l)), "the repair model is not reported").toBe(true);
  });
});

describe("the positional keys address the row the HUD is showing", () => {
  it("still deploys on Z, through the button rather than through a hard-coded binding", () => {
    // The end-to-end version of the contract `intents.test.ts` pins one half of. A returning
    // player's hands do the same thing they always did; what changed is that the key now goes
    // through the HUD, which is what lets the same five letters reach the economy panels.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const ship = [...bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    bridge.step(STEP_SECONDS);

    const press = translateKey({ key: "z", shift: false, ctrl: false });
    const action = shownActions(bridge)[press.action!.index]!;
    expect(action.command).toEqual({ kind: "intent", intent: { kind: "deploy" } });
    expect(bridge.apply({ kind: "deploy" }), "Z reached deploy and the engine refused it").toBeNull();
  });

  it("binds the five keys upstream binds, in upstream's order", () => {
    expect([...POSITIONAL_KEYS]).toEqual(["z", "c", "v", "b", "n"]);
    POSITIONAL_KEYS.forEach((key, index) => {
      const result = translateKey({ key, shift: false, ctrl: false });
      expect(result.action, `${key} is not positional`).toEqual({ index });
      // A positional key must not ALSO be an order, or the row it fires becomes unpredictable.
      expect(result.intent, `${key} produced a fixed intent as well`).toBeNull();
      expect(result.mode, `${key} armed a mode as well`).toBeNull();
    });
  });

  it("reaches an economy control when the economy row is what is on screen", () => {
    // The point of the whole convention: with a Smelter selected, the second button is a real
    // economy control and C fires it. No new letter was spent to get there.
    const bridge = opened();
    selectBuilding(bridge, "smelter");
    const actions = shownActions(bridge);
    const pauseIndex = actions.findIndex((a) => a.command.kind === "intent" && a.command.intent.kind === "pause");
    expect(pauseIndex, "no economy control is in the positional row at all").toBeGreaterThanOrEqual(0);
    expect(pauseIndex).toBeLessThan(POSITIONAL_KEYS.length);
    expect(translateKey({ key: POSITIONAL_KEYS[pauseIndex]!, shift: false, ctrl: false }).action)
      .toEqual({ index: pauseIndex });
  });

  it("opens the two base-wide boards, and the same key closes them", () => {
    expect(translateKey({ key: "m", shift: false, ctrl: false }).board).toBe("market");
    expect(translateKey({ key: "l", shift: false, ctrl: false }).board).toBe("logistics");
    // A board is view state, exactly like the power overlay: nothing in the simulation knows a
    // panel is open, and a determinism replay must not depend on one.
    expect(translateKey({ key: "m", shift: false, ctrl: false }).intent).toBeNull();
    expect(translateKey({ key: "l", shift: false, ctrl: false }).intent).toBeNull();
  });

  it("leaves the pan keys and Phase 3's letters alone", () => {
    // The guard on the two bindings above: M and L are free, W/A/S/D pan, and F/T/P/O are Phase 3's.
    for (const key of ["w", "s", "d"]) {
      expect(translateKey({ key, shift: false, ctrl: false }).board, `${key} took a board`).toBeUndefined();
      expect(translateKey({ key, shift: false, ctrl: false }).action, `${key} became positional`).toBeUndefined();
    }
    for (const key of ["f", "t", "p", "o"]) {
      expect(translateKey({ key, shift: false, ctrl: false }).board, `${key} took a board`).toBeUndefined();
      expect(translateKey({ key, shift: false, ctrl: false }).action, `${key} became positional`).toBeUndefined();
    }
  });
});
