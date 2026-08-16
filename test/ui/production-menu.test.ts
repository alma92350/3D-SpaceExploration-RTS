// P5-T14 — the production menu offers what the engine allows, and tells the truth about the price.
//
// PARITY.md rows 47 and 48. Two lies in one menu, and both are the same mistake: the HUD re-derived
// a rule the engine already owns and got it wrong (ADR-0012 §5).
//
//   • **Row 47.** `queueProduction` gates on `def.odysseyOnly && !state.endless`. The menu filtered
//     `def.odysseyOnly` outright — and every world in this game is `endless`. So the menu dropped
//     half of an `&&` and hid **six of eighteen units the engine would have accepted**: the Colony
//     Ship, the three freight hulls, the Leviathan and the Helium Bomb. This is P4-T14's finding one
//     level down — that row fixed *buildings* by deleting a hand-written list, and the *unit* menu
//     still had its own.
//
//   • **Row 48.** Affordability was computed against **three commodities of twenty-three**; every
//     other one read `have = 0`, so the Wraith (gas), the Aegis (ice), the Colossus (relics), the
//     Plasma Rig (machinery + electronics + AI) and the Torpedo Battery (alloys) were struck through
//     forever at any stockpile. The buttons still fired — `bind()` only toggles a class — so it was
//     a lie in the HUD rather than a lock, which is the harder kind to notice.
//
// **This file enumerates; it does not list.** A test naming the six hidden units is a test somebody
// has to remember to update, and PARITY §7.4 says so in as many words: the check that catches the
// next one "would be a sweep asserting that every `UNITS` key the engine would accept has a button".
// So the oracle here is **`queueProduction` itself**, run for real on a fixture where money and
// supply cannot be the reason, and the menu is asserted to agree with it unit by unit. A seventh
// `odysseyOnly` unit, or a tenth commodity, arrives in this suite on its own.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { hudModel } from "../../src/ui/hud.js";
import {
  BUILDINGS, COM, UNITS, canAfford, makeBuilding, makeUnit, queueProduction,
} from "../../src/engine/index.js";

const SEED = 20260814;

/** Every building that trains anything, from the engine's roster rather than from memory. */
const PRODUCERS = Object.keys(BUILDINGS).filter((b) => BUILDINGS[b]!.produces?.length);

/** Every unit some building trains. The difference from `UNITS` is a finding — see the sweep. */
const PRODUCED = new Set(PRODUCERS.flatMap((b) => BUILDINGS[b]!.produces ?? []));

/** Big enough that no cost in the roster binds, small enough to stay a plain number. */
const RICH = 100_000;

/**
 * A base with every producer standing and every unit prerequisite met.
 *
 * The four buildings units name in `requires` are Foundry, Arsenal, Spaceport and Star Dock — read
 * off the roster below rather than typed here, so a new prerequisite lands in the fixture by itself.
 * Habitats are for supply headroom: `queueProduction` refuses a Leviathan on population as readily
 * as on ore, and this fixture exists to make the offer gate the *only* thing that can refuse.
 */
function fullyTeched() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;

  const needed = new Set<string>([...PRODUCERS]);
  for (const u of Object.keys(UNITS)) {
    for (const req of UNITS[u]!.requires ?? []) if (BUILDINGS[req]) needed.add(req);
  }
  // Prerequisites of the prerequisites are irrelevant here: `prereqsMet` reads the *unit's* own
  // `requires`, and a building placed by hand stands whether or not its own tree does.
  let n = 0;
  for (const type of needed) {
    const b = makeBuilding(type, "player", base.x + 60 + (n++ * 40), base.y + 60);
    b.constructing = false;
    bridge.state.buildings.set(b.id, b);
  }
  for (let i = 0; i < 4; i++) {
    const h = makeBuilding("habitat", "player", base.x - 60 - (i * 40), base.y + 60);
    h.constructing = false;
    bridge.state.buildings.set(h.id, h);
  }
  stock(bridge, RICH);
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

/** Set every commodity the engine knows to `amount`. Never a subset — that is the bug under test. */
function stock(bridge: WorldBridge, amount: number): void {
  const res = bridge.state.players.player.resources;
  for (const com of Object.keys(COM)) res[com] = amount;
}

/** The menu the HUD is showing for `buildingId`, as unit types. */
function menu(bridge: WorldBridge, buildingId: string): string[] {
  bridge.enqueue({ kind: "select", ids: [buildingId], additive: false });
  bridge.step(STEP_SECONDS);
  return hudModel(bridge.snapshot, bridge.state).production.map((p) => p.unitType);
}

function place(bridge: WorldBridge, type: string, x: number, y: number) {
  const b = makeBuilding(type, "player", x, y);
  b.constructing = false;
  bridge.state.buildings.set(b.id, b);
  bridge.step(STEP_SECONDS);
  return b;
}

/**
 * **The oracle: `queueProduction` itself, asked and then undone.**
 *
 * Not a re-implementation of its gate — the whole row exists because a re-implementation of its gate
 * is what shipped. It is run for real against the live state and rolled back: the resources it spent
 * are restored, the job it queued is dropped, and the `productionBlocked` events it pushed are
 * discarded. A dry run belongs in a test, never in `hudModel`, which is a function of a TICK.
 *
 * The fixture is deliberately rich and roomy, so the only refusals left are the *offer* gates —
 * unknown unit, wrong producer, the Odyssey gate, unmet prerequisites. Affordability and supply are
 * shown rather than obeyed (see `HudAction`), so they must not reach this answer.
 */
function engineWouldAccept(bridge: WorldBridge, buildingId: string, unitType: string): boolean {
  const state = bridge.state;
  const before = { ...state.players.player.resources };
  const building = state.buildings.get(buildingId)!;
  const queued = building.queue.length;
  const events = state.events.length;

  const accepted = queueProduction(state, buildingId, unitType);

  building.queue.length = queued;
  state.events.length = events;
  state.players.player.resources = before;
  return accepted;
}

describe("the production menu is the engine's answer (P5-T14, row 47)", () => {
  it("holds the premise the whole row rests on: this world is endless, and units are gated on it", () => {
    // Without both halves there is no bug and no fix. `queueProduction`'s gate is
    // `odysseyOnly && !endless`; the old menu read only the first half, which is wrong exactly when
    // the second is false — that is, always, here.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    expect(bridge.state.endless, "every galaxy world is created endless (galaxy.js)").toBe(true);
    const gated = [...PRODUCED].filter((u) => UNITS[u]!.odysseyOnly);
    expect(gated.length, "no odysseyOnly unit is produced by anything — row 47 is moot").toBeGreaterThan(0);
  });

  it("offers a unit exactly when `queueProduction` would accept it — swept over every UNITS key", () => {
    // The assertion is an **iff**, per producer, over the whole unit roster rather than over the
    // menu: a menu that merely grew would pass a count check while offering the wrong things, and a
    // sweep over what is offered can never notice what is missing.
    const { bridge } = fullyTeched();
    for (const producerType of PRODUCERS) {
      const building = [...bridge.state.buildings.values()]
        .find((b) => b.owner === "player" && b.type === producerType && !b.constructing)!;
      expect(building, `${producerType} is not in the fixture`).toBeDefined();
      const offered = new Set(menu(bridge, building.id));

      for (const unitType of Object.keys(UNITS)) {
        const accepted = engineWouldAccept(bridge, building.id, unitType);
        expect(offered.has(unitType),
          `${producerType} → ${unitType}: engine says ${accepted}, menu says ${offered.has(unitType)}`)
          .toBe(accepted);
      }
    }
  });

  it("reaches every unit the engine trains, and the one it misses is one nothing produces", () => {
    // PARITY §7.4's sweep, stated as a set equality rather than as a list of six names. This is the
    // check that fires when upstream adds an eighteenth-and-first unit and nobody widens a menu.
    const { bridge } = fullyTeched();
    const reachable = new Set<string>();
    for (const producerType of PRODUCERS) {
      const b = [...bridge.state.buildings.values()]
        .find((x) => x.owner === "player" && x.type === producerType && !x.constructing)!;
      for (const u of menu(bridge, b.id)) reachable.add(u);
    }
    expect([...reachable].sort()).toEqual([...PRODUCED].sort());

    // Computed, not asserted away: the gap between `UNITS` and what any menu could offer is the
    // Freight Lane's own vessel, which no building trains and `createLane` mints.
    const unproduced = Object.keys(UNITS).filter((u) => !PRODUCED.has(u));
    expect(unproduced, "a unit stopped being produced by anything — say which, and why")
      .toEqual(["freighter"]);
  });

  it("gates on `odysseyOnly && !endless`, not on `odysseyOnly` — which is the whole defect", () => {
    // The half of the `&&` the old menu dropped, pinned from both sides on one fixture so the
    // difference cannot be blamed on anything else about the state.
    const { bridge } = fullyTeched();
    const cc = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "command")!;

    const inOdyssey = new Set(menu(bridge, cc.id));
    const gated = (BUILDINGS.command!.produces ?? []).filter((u) => UNITS[u]!.odysseyOnly);
    expect(gated.length, "the Command Center trains no gated unit — this test proves nothing").toBeGreaterThan(0);
    for (const u of gated) expect(inOdyssey.has(u), `${u} is hidden in an endless world`).toBe(true);

    bridge.state.endless = false;
    bridge.step(STEP_SECONDS);
    const inSkirmish = new Set(menu(bridge, cc.id));
    for (const u of gated) expect(inSkirmish.has(u), `${u} is offered in a skirmish`).toBe(false);
    // And nothing else moved: the gate is about `odysseyOnly`, not about the flag in general.
    const ungated = (BUILDINGS.command!.produces ?? []).filter((u) => !UNITS[u]!.odysseyOnly);
    for (const u of ungated) expect(inSkirmish.has(u), `${u} vanished with the endless flag`).toBe(true);
  });

  it("filters on prerequisites, and the menu grows as the tech behind it lands", () => {
    // The same judgement `buildableTypes` documents for structures: a locked unit is not a decision
    // yet, so it is filtered rather than greyed. Asserted as a growing set against the engine's own
    // `requires`, so it cannot pass by naming units.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const base = bridge.state.map.bases.player;
    stock(bridge, RICH);
    const barracks = place(bridge, "barracks", base.x + 80, base.y);
    const roster = BUILDINGS.barracks!.produces ?? [];

    const opened = new Set<string>();
    const check = (msg: string) => {
      const offered = new Set(menu(bridge, barracks.id));
      for (const u of roster) {
        const unmet = (UNITS[u]!.requires ?? []).filter((r) => BUILDINGS[r] && !opened.has(r));
        expect(offered.has(u), `${msg}: ${u} needs ${unmet.join(", ") || "nothing"}`).toBe(unmet.length === 0);
      }
      return offered;
    };
    const bare = check("a bare Barracks");
    expect(bare.size, "a bare Barracks should still offer something").toBeGreaterThan(0);
    expect(bare.size, "a bare Barracks offered its whole roster — prerequisites are not filtering")
      .toBeLessThan(roster.length);

    place(bridge, "foundry", base.x + 120, base.y);
    opened.add("foundry");
    const afterFoundry = check("with a Foundry");
    expect(afterFoundry.size, "the Foundry unlocked nothing").toBeGreaterThan(bare.size);

    place(bridge, "arsenal", base.x + 160, base.y);
    opened.add("arsenal");
    const afterArsenal = check("with an Arsenal");
    expect(afterArsenal.size).toBeGreaterThan(afterFoundry.size);
    expect([...afterArsenal].sort(), "a fully-teched Barracks should reach its whole roster")
      .toEqual([...roster].sort());
  });

  it("does not offer a unit whose prerequisite is still under construction", () => {
    // The case a snapshot-only menu gets wrong: the Foundry is on the map and visible, and
    // `prereqsMet` still refuses it because `!b.constructing` is part of the engine's rule.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const base = bridge.state.map.bases.player;
    stock(bridge, RICH);
    const barracks = place(bridge, "barracks", base.x + 80, base.y);
    const shell = makeBuilding("foundry", "player", base.x + 120, base.y);
    // `makeBuilding` hands back a FINISHED building; `buildProgress` has to come back down too or
    // the next tick simply completes it (the same trap `build-menu.test.ts` records).
    shell.constructing = true;
    shell.buildProgress = 0.1;
    bridge.state.buildings.set(shell.id, shell);
    bridge.step(STEP_SECONDS);
    expect(menu(bridge, barracks.id), "a half-built Foundry unlocked its units").not.toContain("lancer");
  });

  it("falls back, with no State, to units `queueProduction` accepts in EVERY state", () => {
    // `hudModel(snap)` still has callers. Without a `State` there is nothing to ask, so the answer
    // is the engine's answer for the weakest state it has — no Odyssey, no tech — and the property
    // that makes that sound rather than an opinion is asserted here rather than described.
    //
    // **Swept over every producer, and the first draft was not.** It asked the Command Center only,
    // where the two filters overlap: every gated unit there is also an Odyssey one, so deleting the
    // prerequisite half changed nothing and the mutation survived. The Barracks is where `requires`
    // bites alone — which is the argument for enumerating producers rather than picking one.
    const { bridge } = fullyTeched();
    let narrowedSomewhere = false;
    let offeredSomething = false;

    for (const producerType of PRODUCERS) {
      const b = [...bridge.state.buildings.values()]
        .find((x) => x.owner === "player" && x.type === producerType && !x.constructing)!;
      bridge.enqueue({ kind: "select", ids: [b.id], additive: false });
      bridge.step(STEP_SECONDS);

      const stateless = hudModel(bridge.snapshot).production.map((p) => p.unitType);
      const withState = hudModel(bridge.snapshot, bridge.state).production.map((p) => p.unitType);
      for (const u of stateless) {
        expect(UNITS[u]!.odysseyOnly ?? false, `${producerType} → ${u} is not accepted in a skirmish`).toBe(false);
        expect(UNITS[u]!.requires ?? [], `${producerType} → ${u} is not accepted with nothing built`).toHaveLength(0);
        expect(withState, `${producerType} → ${u} is offered without a State and not with one`).toContain(u);
      }
      if (withState.length > stateless.length) narrowedSomewhere = true;
      if (stateless.length > 0) offeredSomething = true;
    }
    expect(offeredSomething, "the fallback offered nothing anywhere — a caller lost its menu").toBe(true);
    expect(narrowedSomewhere, "the fallback matched the real answer everywhere — it is not narrowing").toBe(true);
  });
});

describe("what row 47 actually unlocked (P5-T14)", () => {
  it("trains a Helium Bomb from the menu, which nothing else could give the player one of", () => {
    // **P3-T10 built the whole arming and detonation path for a unit no player could own.** The AI
    // mints one (`aiIndustry.js` calls `queueProduction` on its own Star Dock); for the player,
    // `queueProduction` from a Star Dock is the only path there has ever been, and this menu was the
    // only thing that could reach it. So the proof is the whole way through: press the button the
    // HUD is showing and wait for the unit.
    const { bridge } = fullyTeched();
    const dock = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "stardock")!;
    bridge.enqueue({ kind: "select", ids: [dock.id], additive: false });
    bridge.step(STEP_SECONDS);

    const action = hudModel(bridge.snapshot, bridge.state).actions.find((a) => a.id === "train:heliumbomb");
    expect(action, "no Helium Bomb button on a Star Dock").toBeDefined();
    expect(action!.enabled, "a stocked player cannot afford it — row 48 is still lying").toBe(true);
    expect(action!.command.kind).toBe("intent");
    if (action!.command.kind !== "intent") throw new Error("unreachable");
    bridge.enqueue(action!.command.intent);

    const owned = () => [...bridge.state.units.values()].some((u) => u.owner === "player" && u.type === "heliumbomb");
    expect(owned(), "a bomb existed before the button was pressed").toBe(false);
    const ticks = Math.ceil((UNITS.heliumbomb!.buildTime ?? 60) / STEP_SECONDS) + 20;
    for (let i = 0; i < ticks && !owned(); i++) bridge.step(STEP_SECONDS);
    expect(owned(), "the button was pressed and no Helium Bomb was ever built").toBe(true);
  });

  it("trains a second Colony Ship, which is the only way to make one", () => {
    // A player starts with exactly one (`state.js` mints it at world creation) and the engine's other
    // two sources are both out of reach here: `packCapital` is not on the façade at all, and
    // `checkGalaxyRescue`'s relief ship arrives only after everything is already lost.
    const { bridge } = fullyTeched();
    const cc = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "command")!;
    const ships = () => [...bridge.state.units.values()].filter((u) => u.owner === "player" && u.type === "colonyship").length;
    const before = ships();

    bridge.enqueue({ kind: "select", ids: [cc.id], additive: false });
    bridge.step(STEP_SECONDS);
    const action = hudModel(bridge.snapshot, bridge.state).actions.find((a) => a.id === "train:colonyship");
    expect(action, "no Colony Ship button on a Command Center").toBeDefined();
    if (action!.command.kind !== "intent") throw new Error("unreachable");
    bridge.enqueue(action!.command.intent);

    const ticks = Math.ceil((UNITS.colonyship!.buildTime ?? 40) / STEP_SECONDS) + 20;
    for (let i = 0; i < ticks && ships() === before; i++) bridge.step(STEP_SECONDS);
    expect(ships(), "the button was pressed and no Colony Ship was ever built").toBe(before + 1);
  });
});

describe("affordability is the engine's answer, over every commodity (P5-T14, row 48)", () => {
  /** Every commodity any cost in the roster mentions — derived, so a new one arrives on its own. */
  const COSTED = new Set<string>([
    ...Object.values(UNITS).flatMap((u) => Object.keys(u.cost ?? {})),
    ...Object.values(BUILDINGS).flatMap((b) => Object.keys(b.cost ?? {})),
  ]);

  it("holds the premise: costs reach past the three commodities the old menu knew", () => {
    const KNEW = ["ore", "crystals", "radioactives"];
    const beyond = [...COSTED].filter((c) => !KNEW.includes(c));
    expect(beyond.length, "no cost uses a fourth commodity — row 48 is moot").toBeGreaterThan(0);
    for (const c of COSTED) expect(Object.keys(COM), `${c} is not a commodity`).toContain(c);
  });

  it("agrees with `canAfford` for every option on screen, at several stockpiles", () => {
    // The anti-re-derivation pin, and the one that goes red the instant anybody reintroduces a local
    // opinion about what a player has: the menu's flag against the engine's own predicate, over the
    // player's whole resource bag, for every unit AND every building the HUD is offering.
    const { bridge, base } = fullyTeched();
    const worker = makeUnit("worker", "player", base.x + 30, base.y);
    bridge.state.units.set(worker.id, worker);
    const dock = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "stardock")!;

    for (const amount of [0, 1, 85, 500, RICH]) {
      stock(bridge, amount);
      bridge.enqueue({ kind: "select", ids: [dock.id, worker.id], additive: false });
      bridge.step(STEP_SECONDS);
      // Two selections rather than one, because `production` and `builds` are filled on different
      // branches and a fix applied to one of them would otherwise pass.
      for (const [ids, read] of [
        [[dock.id], (m: ReturnType<typeof hudModel>) => m.production.map((p) => [p.unitType, p.affordable, UNITS[p.unitType]!.cost] as const)],
        [[worker.id], (m: ReturnType<typeof hudModel>) => m.builds.map((b) => [b.buildingType, b.affordable, BUILDINGS[b.buildingType]!.cost] as const)],
      ] as const) {
        bridge.enqueue({ kind: "select", ids: [...ids], additive: false });
        bridge.step(STEP_SECONDS);
        const rows = read(hudModel(bridge.snapshot, bridge.state));
        expect(rows.length, `nothing offered at ${amount}`).toBeGreaterThan(0);
        for (const [type, flag, cost] of rows) {
          expect(flag, `${type} at ${amount} of everything`)
            .toBe(canAfford(bridge.state.players.player.resources, cost ?? {}));
        }
      }
    }
  });

  it("goes unaffordable for exactly the options that need the commodity it is short of", () => {
    // Swept over every commodity a cost mentions, not over the five the checklist happened to name.
    // The old three-commodity read fails the *positive* half of this at gas, ice, relics, alloys,
    // machinery, electronics, AI, antimatter and plasma torpedoes — nine of them, all permanently.
    const { bridge, base } = fullyTeched();
    const worker = makeUnit("worker", "player", base.x + 30, base.y);
    bridge.state.units.set(worker.id, worker);
    const dock = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "stardock")!;

    for (const com of COSTED) {
      stock(bridge, RICH);
      bridge.state.players.player.resources[com] = 0;
      bridge.enqueue({ kind: "select", ids: [dock.id], additive: false });
      bridge.step(STEP_SECONDS);
      for (const p of hudModel(bridge.snapshot, bridge.state).production) {
        const needs = (UNITS[p.unitType]!.cost?.[com] ?? 0) > 0;
        expect(p.affordable, `${p.unitType} with no ${com} (needs ${needs ? "it" : "none"})`).toBe(!needs);
      }

      bridge.enqueue({ kind: "select", ids: [worker.id], additive: false });
      bridge.step(STEP_SECONDS);
      for (const b of hudModel(bridge.snapshot, bridge.state).builds) {
        const needs = (BUILDINGS[b.buildingType]!.cost?.[com] ?? 0) > 0;
        expect(b.affordable, `${b.buildingType} with no ${com} (needs ${needs ? "it" : "none"})`).toBe(!needs);
      }
    }
  });

  it("marks the exotic-commodity units affordable once the player actually holds them", () => {
    // The half the three-commodity read could never pass, made concrete: stock the exact bag each
    // cost names and nothing else, and the button must come alive. Under the old code every one of
    // these stayed struck through at any stockpile, forever.
    const { bridge } = fullyTeched();
    const dock = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "stardock")!;
    const exotic = (BUILDINGS.stardock!.produces ?? [])
      .filter((u) => Object.keys(UNITS[u]!.cost ?? {}).some((c) => !["ore", "crystals", "radioactives"].includes(c)));
    expect(exotic.length, "the Star Dock trains nothing with an exotic cost").toBeGreaterThan(0);

    for (const unitType of exotic) {
      stock(bridge, 0);
      for (const [com, qty] of Object.entries(UNITS[unitType]!.cost ?? {})) {
        bridge.state.players.player.resources[com] = qty;
      }
      bridge.enqueue({ kind: "select", ids: [dock.id], additive: false });
      bridge.step(STEP_SECONDS);
      const option = hudModel(bridge.snapshot, bridge.state).production.find((p) => p.unitType === unitType);
      expect(option, `${unitType} is not on the menu`).toBeDefined();
      expect(option!.affordable, `${unitType} priced exactly, and still struck through`).toBe(true);
    }
  });

  it("shows what cannot be afforded, and the button still carries its order", () => {
    // Affordability is presentational **on purpose** — `bind()` only toggles a class, so the engine's
    // own refusal is what explains the failure (see `HudAction`). Making the strike-through true must
    // not turn it into a lock, so both halves are asserted together.
    //
    // **Both rows, not one.** `actions` is the positional Z/C/V/B/N sequence and it is assembled from
    // `production` and `builds` on separate lines; a mutation that dropped affordability from the
    // *builds* line survived a first draft that only read `train:`. The menu and the key row are two
    // surfaces and each needs its own assertion.
    const { bridge, base } = fullyTeched();
    const dock = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "stardock")!;
    const worker = makeUnit("worker", "player", base.x + 30, base.y);
    bridge.state.units.set(worker.id, worker);
    stock(bridge, 0);

    for (const [id, prefix, rows] of [
      ["train", "train:", (m: ReturnType<typeof hudModel>) => m.production.map((p) => p.affordable)],
      ["build", "build:", (m: ReturnType<typeof hudModel>) => m.builds.map((b) => b.affordable)],
    ] as const) {
      bridge.enqueue({ kind: "select", ids: [id === "train" ? dock.id : worker.id], additive: false });
      bridge.step(STEP_SECONDS);

      const model = hudModel(bridge.snapshot, bridge.state);
      const flags = rows(model);
      expect(flags.length, `a broke player was shown an empty ${id} menu`).toBeGreaterThan(0);
      expect(flags.every((f) => !f), `something read as affordable at zero (${id})`).toBe(true);

      const actions = model.actions.filter((a) => a.id.startsWith(prefix));
      expect(actions.length, `the ${id} options did not reach the positional row`).toBe(flags.length);
      for (const a of actions) {
        expect(a.enabled, `${a.id} should be struck through`).toBe(false);
        expect(a.command.kind === "intent" || a.command.kind === "buildMode",
          `${a.id} lost its command along with its money`).toBe(true);
      }
    }
  });
});

/* =================================================================================================
   AND THEN THE PLAYER CAN SEE IT HAPPENING (PT-04)

   The menu offering the right units is worth nothing if pressing one produces no visible result.
   The first tester pressed a button, got no feedback of any kind, and reported *"cannot see any
   progression, but i knwo they will appear"* — they had deduced the queue rather than read it.

   This drives the REAL engine through the REAL bridge: no hand-built table, because the claim is
   precisely that the number the engine advances reaches the panel a player is looking at.
   ================================================================================================= */

describe("a queued unit is visible while it is being trained (PT-04)", () => {
  it("shows nothing before the order, rises while training, and clears when it finishes", () => {
    const { bridge } = fullyTeched();
    const barracks = [...bridge.state.buildings.values()]
      .find((b) => b.owner === "player" && (BUILDINGS[b.type]!.produces ?? []).includes("skiff"))!;

    bridge.enqueue({ kind: "select", ids: [barracks.id], additive: false });
    bridge.step(STEP_SECONDS);
    expect(
      hudModel(bridge.snapshot, bridge.state).buildingDetail.trainingText,
      "an idle barracks claimed to be training something",
    ).toBeNull();

    bridge.enqueue({ kind: "train", buildingId: barracks.id, unitType: "skiff" });
    bridge.step(STEP_SECONDS);

    // Sampled across the job rather than at one instant: the assertion is that it MOVES, which a
    // single reading cannot make and a constant would satisfy.
    const seen: number[] = [];
    let cleared = false;
    for (let i = 0; i < 400; i++) {
      bridge.step(STEP_SECONDS);
      const detail = hudModel(bridge.snapshot, bridge.state).buildingDetail;
      if (detail.trainingText === null) { cleared = seen.length > 0; break; }
      seen.push(detail.trainingProgress);
    }

    expect(seen.length, "the barracks never reported training at all").toBeGreaterThan(2);
    expect(Math.max(...seen), "progress never advanced past its starting value")
      .toBeGreaterThan(Math.min(...seen));
    expect(Math.max(...seen), "progress left the 0..1 range the panel draws as a bar")
      .toBeLessThanOrEqual(1);
    expect(cleared, "the barracks was still training after the unit came out").toBe(true);
  });

  it("counts a second order as one behind the first", () => {
    const { bridge } = fullyTeched();
    const barracks = [...bridge.state.buildings.values()]
      .find((b) => b.owner === "player" && (BUILDINGS[b.type]!.produces ?? []).includes("skiff"))!;

    bridge.enqueue({ kind: "select", ids: [barracks.id], additive: false });
    bridge.enqueue({ kind: "train", buildingId: barracks.id, unitType: "skiff" });
    bridge.enqueue({ kind: "train", buildingId: barracks.id, unitType: "skiff" });
    bridge.step(STEP_SECONDS);
    bridge.step(STEP_SECONDS);

    expect(hudModel(bridge.snapshot, bridge.state).buildingDetail.trainingText)
      .toContain("1 queued behind");
  });
});
