// Phase 5's parity close-out, reachable by a player (P5-T13 — PARITY.md §5.2, rows 31–40).
//
// **This file is the answer to a number, not to a feature request.** §5.2 counted 18 of 28: ten of
// the engine's own orders had no gesture, no button and no intent, a third of the verb list the 2D
// game gives a player. Two of them — `setRally` and `cancelTrain` — had an intent in
// `bridge/commands.ts` since Phase 1 with **no producer on either end**, and §7.4 says exactly why
// nothing caught them: "an intent sweep cannot see a menu that never offers the intent", and the
// Phase 1 sweep that would have asked the union question was never written (§2, step 4).
//
// So this file is in three halves rather than the usual two.
//
//   1. **The gestures**, one per row: the key arms it, the click resolves it, and the payload is
//      the one the engine takes — including `setRally`'s `nodeId`, which is the whole reason row 31
//      could not simply be wired as it stood.
//   2. **The engine's own verdict.** Every one of these nine `issue*` functions returns `void` and
//      silently skips what it does not accept, so "the intent was produced" proves nothing on its
//      own. Each order is driven through a real `WorldBridge` against a real selection and the
//      SIMULATION is asked whether it happened — and, where it is cheap, stepped so the engine's own
//      consumer (`updateScoutMode`, `assignShuttle`) is the witness rather than a field.
//   3. **The sweep §2 step 4 never had.** Every `kind` in the `Intent` union must have a producer.
//      That is the check that would have found rows 31 and 32 five phases ago, and it is written to
//      fail by name rather than by count.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  type PendingMode, type PointerGesture, translateKey, translatePointer,
} from "../../src/input/intents.js";
import { type Intent } from "../../src/bridge/commands.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  BUILDINGS, FREIGHTER_AI_TECH, TECHS, UNITS, makeBuilding, makeUnit,
} from "../../src/engine/index.js";

const SEED = 20260814;
const SEAT = "helix";
const NONE: PendingMode = { kind: "none" };

function key(k: string, mode: PendingMode = NONE, mods: { shift?: boolean; ctrl?: boolean } = {}) {
  return translateKey({ key: k, shift: mods.shift ?? false, ctrl: mods.ctrl ?? false }, mode);
}

/**
 * A world with one of everything these ten orders address.
 *
 * Placed rather than built, exactly as `phase4-input.test.ts` places its Spaceport: none of the
 * claims below turns on how a Barracks got there, only on the engine's own predicates finding it.
 * The Odyssey opening seeds a colony ship and no Command Center at all, so the CC is placed too —
 * without it `issueSetHomeBase` has nothing legal to point at and row 38 would be untestable for a
 * reason that has nothing to do with the wiring.
 */
function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  const state = bridge.state;
  const base = state.map.bases.player;

  const place = (type: string, dx: number, dy: number, constructing = false): Building => {
    const b = makeBuilding(type, "player", base.x + dx, base.y + dy, { constructing });
    b.constructing = constructing;
    b.buildProgress = constructing ? 0.4 : 1;
    state.buildings.set(b.id, b);
    return b;
  };
  const spawn = (type: string, dx: number, dy: number, owner: OwnerId = "player"): Unit => {
    const u = makeUnit(type, owner, base.x + dx, base.y + dy);
    state.units.set(u.id, u);
    return u;
  };

  const fixture = {
    bridge,
    state,
    cc: place("command", 0, 0),
    barracks: place("barracks", 90, 0),
    smelter: place("smelter", 140, 0),
    site: place("habitat", -90, 0, true),
    worker: spawn("worker", 20, 20),
    ranger: spawn("ranger", 30, 20),
    hauler: spawn("hauler", 40, 20),
    skiff: spawn("skiff", 50, 20),
    enemyCc: (() => {
      const b = makeBuilding("command", "ai", base.x + 600, base.y + 600);
      state.buildings.set(b.id, b);
      return b;
    })(),
    select(...ids: string[]): void {
      bridge.apply({ kind: "select", ids, additive: false });
    },
    /** Apply one intent through the same path `drain` uses, and hand back the engine's refusal. */
    run(intent: Intent): string | null {
      return bridge.apply(intent);
    },
  };
  state.players.player.resources.ore = 10_000;
  state.players.player.resources.crystals = 10_000;
  return fixture;
}

/** A left click, for a mode to resolve. `entityId`/`nodeId` are what the picker found. */
function click(
  mode: PendingMode,
  over: { entityId?: string | null; nodeId?: string | null; x?: number; y?: number; shift?: boolean } = {},
) {
  const gesture: PointerGesture = {
    type: "click", button: "left",
    worldX: over.x ?? 400, worldY: over.y ?? 250,
    entityId: over.entityId ?? null, nodeId: over.nodeId ?? null,
    shift: over.shift ?? false, ctrl: false,
  };
  // A real snapshot: `translatePointer` reads one to decide what is under the cursor, and handing
  // it a stub would let a gesture that quietly consulted it pass.
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  bridge.step(STEP_SECONDS);
  return translatePointer(gesture, mode, bridge.snapshot);
}

/* =================================================================================================
   HALF ONE — THE GESTURES

   One row per row, in PARITY.md's own order.
   ================================================================================================= */

describe("row 31 — a rally point, and the node it can be set on", () => {
  it("arms on U and turns the next click into a rally point", () => {
    expect(key("u").mode).toEqual({ kind: "rally" });
    const r = click({ kind: "rally" }, { x: 640, y: 480 });
    expect(r.intent).toEqual({ kind: "setRally", x: 640, y: 480, nodeId: null });
    expect(r.mode, "the rally mode survived its own click").toEqual(NONE);
  });

  it("carries the NODE when the rally lands on a deposit — upstream's rally-to-minerals", () => {
    // The half that made row 31 more than a wiring job. `issueSetRally(building, x, y, nodeId)`
    // makes a produced worker spawn already gathering; an intent with only x/y is a rally point
    // quietly worse than upstream's for exactly the unit that needs it most.
    const r = click({ kind: "rally" }, { x: 700, y: 300, nodeId: "n4" });
    expect(r.intent).toEqual({ kind: "setRally", x: 700, y: 300, nodeId: "n4" });
  });
});

describe("row 32 — a production queue a player can empty", () => {
  it("cancels on Delete, naming neither the building nor the index", () => {
    // Both are resolved at the bridge, because a key cannot see either: `input/` has no selection
    // and no queue. That is `deploy`'s shape, and it is why the Phase 1 intent sat unused — it
    // demanded two numbers nothing that could press a key was ever going to have.
    const r = key("delete");
    expect(r.intent).toEqual({ kind: "cancelTrain" });
    expect(r.mode, "cancelling left a pending mode armed").toEqual(NONE);
  });

  it("answers to the name the browser actually sends, which is `Delete`", () => {
    // `KeyboardEvent.key` for this key is capital-D `Delete`, and `translateKey` lowercases before
    // it switches. Asserting the lower-case spelling alone would pass a binding no keyboard reaches
    // — the same trap `intents.test.ts` guards for the letters with its caps-lock case.
    expect(key("Delete").intent).toEqual({ kind: "cancelTrain" });
  });
});

describe("rows 33 and 36 — repair, and the build order that is not one", () => {
  it("arms repair on Shift+R and leaves bare R as patrol", () => {
    expect(key("r", NONE, { shift: true }).mode).toEqual({ kind: "repair" });
    expect(key("r").mode, "Shift+R took patrol's own binding with it").toEqual({ kind: "patrol" });
  });

  it("arms assist-build on Shift+I and leaves bare I as the service order", () => {
    expect(key("i", NONE, { shift: true }).mode).toEqual({ kind: "assist" });
    expect(key("i").mode).toEqual({ kind: "service" });
  });

  it("takes the entity under the click, and queues on shift", () => {
    expect(click({ kind: "repair" }, { entityId: "b3" }).intent)
      .toEqual({ kind: "repair", targetId: "b3", queue: false });
    expect(click({ kind: "assist" }, { entityId: "b9", shift: true }).intent)
      .toEqual({ kind: "assistBuild", buildingId: "b9", queue: true });
  });

  it("cancels on empty ground rather than swallowing the click", () => {
    // `escort`'s rule, for `escort`'s reason: staying armed AND issuing nothing means the player
    // clicks again and the second click lands the order on whatever they happened to hit.
    for (const mode of ["repair", "service", "assist", "ferry", "homeBase"] as const) {
      const r = click({ kind: mode }, { entityId: null });
      expect(r.intent, `${mode} issued an order for empty ground`).toBeNull();
      expect(r.mode, `the ${mode} mode survived a miss`).toEqual(NONE);
    }
  });
});

describe("rows 34, 37 and 38 — the service, ferry and home-base orders", () => {
  it("puts service on I, ferry on Shift+F and the home base on Shift+H", () => {
    expect(click({ kind: "service" }, { entityId: "b2" }).intent)
      .toEqual({ kind: "serviceBuilding", buildingId: "b2", queue: false });
    expect(key("f", NONE, { shift: true }).mode).toEqual({ kind: "ferry" });
    expect(click({ kind: "ferry" }, { entityId: "u5" }).intent)
      .toEqual({ kind: "ferryFreighter", freighterId: "u5", queue: false });
    expect(key("h", NONE, { shift: true }).mode).toEqual({ kind: "homeBase" });
    expect(click({ kind: "homeBase" }, { entityId: "b1" }).intent)
      .toEqual({ kind: "setHomeBase", ccId: "b1" });
  });

  it("leaves bare F cycling the formation and bare H holding position", () => {
    // The shifted bindings are only safe if the bare ones are untouched — a returning player's
    // hands are the whole argument for upstream's letters (persona P1).
    expect(key("f").mode).toEqual({ kind: "formation", shape: "grid", leaderPos: "front" });
    expect(key("h").intent).toEqual({ kind: "hold" });
    expect(key("h", NONE, { shift: true }).intent, "Shift+H still held position as well").toBeNull();
  });

  it("gives the home base no queue flag, because the engine takes none", () => {
    // `issueSetHomeBase(units, ccId)` — two arguments. It is passive: the engine's own comment says
    // it "never touches whatever order the unit is already running", so there is nothing for a
    // waypoint to sit behind and a `queue` field would be a promise nothing keeps.
    const intent = click({ kind: "homeBase" }, { entityId: "b1", shift: true }).intent!;
    expect("queue" in intent, "the home base carried a queue flag the engine cannot use").toBe(false);
  });
});

describe("rows 35, 39 and 40 — the three that need no click", () => {
  it("scouts on E, which this file reserved for it in the MVP", () => {
    // The module header has said since Phase 1 that "upstream has already spent Q and E on
    // select-army and scout". This is that reservation being spent, and it is the only one of the
    // ten with an upstream letter at all — `input.js` was never vendored (PARITY §6.3).
    const r = key("e");
    expect(r.intent).toEqual({ kind: "scout" });
    expect(r.mode, "scout mode is a stance, not a pending click").toEqual(NONE);
  });

  it("toggles the collection point on Shift+P and AI logistics on Shift+L", () => {
    expect(key("p", NONE, { shift: true }).intent).toEqual({ kind: "collectPoint" });
    expect(key("l", NONE, { shift: true }).intent).toEqual({ kind: "aiLogistics" });
  });

  it("sends neither toggle with an `on` — only the simulation knows which way it points", () => {
    const collect = key("p", NONE, { shift: true }).intent!;
    const ai = key("l", NONE, { shift: true }).intent!;
    expect("on" in collect, "the key decided a flag it cannot read").toBe(false);
    expect("on" in ai, "the key decided a flag it cannot read").toBe(false);
  });

  it("leaves bare P on escort and bare L on the logistics board", () => {
    expect(key("p").mode).toEqual({ kind: "escort" });
    expect(key("l").board).toBe("logistics");
    expect(key("l", NONE, { shift: true }).board, "Shift+L opened the board as well").toBeUndefined();
    expect(key("p", NONE, { shift: true }).mode, "Shift+P armed an escort as well").toEqual(NONE);
  });
});

describe("the keys these ten did NOT take", () => {
  it("keeps Shift off X, because the caps-lock guard pins it to stop", () => {
    // `intents.test.ts`'s "caps lock does not disarm the army" is why Shift+X is not a Phase 5
    // binding: a key that stops the army is not one to overload, and that test is the guard.
    expect(key("x", NONE, { shift: true }).intent).toEqual({ kind: "stop" });
  });

  it("leaves J and K unbound, and Q with upstream's select-army", () => {
    // J is `intents.test.ts`'s example of a key this module does not own — the guard that would
    // catch a letter quietly acquiring a binding. K is left free on purpose: a bare letter is the
    // scarce thing on this board, and P5-T13 had Shift slots to spare.
    for (const k of ["j", "k", "q"]) {
      expect(key(k), `${k} acquired a binding`)
        .toEqual({ intent: null, mode: null, camera: null, cancel: false });
    }
  });

  it("keeps every new binding off the positional row and off the pan keys", () => {
    // Z/C/V/B/N fire the Nth button the HUD is showing (P4-T01) and W/A/S/D pan (PRD §5). A Phase 5
    // order on either would break a rule that predates it — shifted or not, since `applyContinuousPan`
    // reads the raw key and never looks at the modifier.
    for (const k of ["z", "c", "v", "b", "n", "w", "s", "d"]) {
      for (const shift of [false, true]) {
        const r = key(k, NONE, { shift });
        expect(r.intent, `${shift ? "Shift+" : ""}${k} took a reserved key`).toBeNull();
        expect(r.mode, `${shift ? "Shift+" : ""}${k} took a reserved key`).not.toEqual({ kind: "rally" });
      }
    }
  });
});

/* =================================================================================================
   HALF TWO — THE ENGINE'S OWN VERDICT

   Nine of the ten engine functions return `void`. "An intent was produced" is therefore worth
   nothing on its own, and every claim below is made against the simulation instead.
   ================================================================================================= */

describe("the ten orders reach the simulation, not just the bridge", () => {
  it("row 31: sets the rally the engine reads at spawn, node and all", () => {
    const w = world();
    w.select(w.barracks.id);
    expect(w.run({ kind: "setRally", x: 700, y: 300, nodeId: "n4" })).toBeNull();
    // `production.js` reads `building.rally` fresh at spawn time, so this object IS the feature.
    expect(w.barracks.rally).toEqual({ x: 700, y: 300, nodeId: "n4" });
  });

  it("row 31: refuses a building that trains nothing, rather than setting a dead rally", () => {
    // `issueSetRally` accepts any building and returns nothing, so it cannot say this. The filter
    // is `BUILDINGS[type].produces` — the same field `queueProduction` gates on, which makes it the
    // engine's own answer to "does anything ever come out of here".
    const w = world();
    const before = { ...w.smelter.rally };
    w.select(w.smelter.id);
    expect(w.run({ kind: "setRally", x: 700, y: 300 })).toMatch(/trains no units/);
    expect(w.smelter.rally, "a refused rally was written anyway").toEqual(before);
  });

  it("row 32: empties a queue a player filled, and refunds what was charged", () => {
    const w = world();
    w.select(w.barracks.id);
    expect(w.run({ kind: "train", buildingId: w.barracks.id, unitType: "skiff" })).toBeNull();
    expect(w.run({ kind: "train", buildingId: w.barracks.id, unitType: "bastion" })).toBeNull();
    expect(w.barracks.queue.length).toBe(2);
    const ore = w.state.players.player.resources.ore;

    // The NEWEST job, not the one being built. Cancelling the head would abort work in progress,
    // which is not what "cancel" means to a player who has just over-queued.
    expect(w.run({ kind: "cancelTrain" })).toBeNull();
    expect(w.barracks.queue.map((j) => j.unitType)).toEqual(["skiff"]);
    expect(w.state.players.player.resources.ore - ore,
      "the refund was not the cost the engine actually charged").toBe(UNITS.bastion!.cost!.ore!);
  });

  it("row 32: says so when there is nothing queued, instead of going quiet", () => {
    const w = world();
    w.select(w.barracks.id);
    expect(w.run({ kind: "cancelTrain" })).toMatch(/Nothing is queued/);
    w.select();
    expect(w.run({ kind: "cancelTrain" })).toMatch(/Select a building/);
  });

  it("row 33: puts a worker on a repair job the engine keeps", () => {
    const w = world();
    w.smelter.hp = w.smelter.maxHp * 0.5;
    w.select(w.worker.id);
    expect(w.run({ kind: "repair", targetId: w.smelter.id, queue: false })).toBeNull();
    expect(w.worker.order).toMatchObject({ type: "repair", targetId: w.smelter.id, manual: true });
    // …and it survives a tick. `updateRepairJob` drops the order on a target it will not mend, so
    // an order that is still there after the engine has looked at it is an order the engine took.
    w.bridge.step(STEP_SECONDS);
    expect(w.worker.order?.type, "the engine threw the repair job away on the next tick")
      .toBe("repair");
  });

  it("row 34: puts a worker on a manual service round trip", () => {
    const w = world();
    w.select(w.worker.id);
    expect(w.run({ kind: "serviceBuilding", buildingId: w.smelter.id, queue: false })).toBeNull();
    expect(w.worker.order)
      .toMatchObject({ type: "service", buildingId: w.smelter.id, manual: true });
    w.bridge.step(STEP_SECONDS);
    expect(w.worker.order?.type, "the engine dropped the service job on the next tick")
      .toBe("service");

    // **Found by mutation testing: this assertion was missing and the guard survived.** Dropping
    // the `constructing` check left every test green, because the only place a service order on a
    // half-built target shows up is one tick later, when `updateService`'s own
    // `if (!b || b.constructing)` throws it away without a word. So it is asserted BOTH ways: the
    // bridge refuses it, and the worker is left doing nothing rather than doing something invisible.
    w.worker.order = null;
    expect(w.run({ kind: "serviceBuilding", buildingId: w.site.id, queue: false }))
      .toMatch(/still being built/);
    expect(w.worker.order, "a service run was accepted onto a construction site").toBeNull();
  });

  it("row 35: puts a Ranger into the scout mode a whole engine module was written for", () => {
    // `scout.js` has one export and nothing in this client reached it, so `updateScoutMode` has run
    // over an empty set for four phases. The assertion is that it runs: the Ranger is given the
    // stance and then MOVES under it, with no destination anybody handed it.
    const w = world();
    w.select(w.ranger.id);
    expect(w.run({ kind: "scout" })).toBeNull();
    expect(w.ranger.order).toMatchObject({ type: "scout" });
    const from = { x: w.ranger.x, y: w.ranger.y };
    for (let i = 0; i < 12; i++) w.bridge.step(STEP_SECONDS);
    expect(Math.hypot(w.ranger.x - from.x, w.ranger.y - from.y),
      "scout mode was set and the Ranger never went anywhere").toBeGreaterThan(1);
    expect(w.ranger.order?.type, "the scout stance did not persist past arrival").toBe("scout");
  });

  it("row 36: sends a worker to a site already founded, and refuses a finished one", () => {
    const w = world();
    w.select(w.worker.id);
    expect(w.run({ kind: "assistBuild", buildingId: w.site.id, queue: false })).toBeNull();
    expect(w.worker.order).toMatchObject({ type: "build", buildingId: w.site.id });
    // The other half of the line the engine draws between rows 33 and 36.
    expect(w.run({ kind: "assistBuild", buildingId: w.smelter.id, queue: false }))
      .toMatch(/already finished/);
    expect(w.run({ kind: "repair", targetId: w.site.id, queue: false }))
      .toMatch(/still being built/);
  });

  it("row 37: puts a worker on a freighter's hold, and refuses a ship with none", () => {
    const w = world();
    w.select(w.worker.id);
    expect(w.run({ kind: "ferryFreighter", freighterId: w.hauler.id, queue: false })).toBeNull();
    expect(w.worker.order)
      .toMatchObject({ type: "ferry", freighterId: w.hauler.id, manual: true });

    // `updateFerry` nulls its target on `!UNITS[f.type]?.cargoHold` and the job goes with it. The
    // plain `freighter` really has none, so this is a live case rather than padding.
    const plain = makeUnit("freighter", "player", w.hauler.x + 20, w.hauler.y);
    w.state.units.set(plain.id, plain);
    expect(UNITS.freighter!.cargoHold, "the plain freighter grew a hold, so this proves nothing")
      .toBeUndefined();
    expect(w.run({ kind: "ferryFreighter", freighterId: plain.id, queue: false }))
      .toMatch(/no hold/);
  });

  it("row 38: pins a home base, and only onto something `zoneFirst` would honour", () => {
    const w = world();
    w.select(w.worker.id, w.hauler.id, w.skiff.id);
    expect(w.run({ kind: "setHomeBase", ccId: w.cc.id })).toBeNull();
    // The engine's own accepting set is wider here than anywhere else in the group: logistics,
    // support AND freighter. A combat unit consults no home zone and is silently skipped.
    expect((w.worker as HomeBased).homeCC).toBe(w.cc.id);
    expect((w.hauler as HomeBased).homeCC).toBe(w.cc.id);
    expect((w.skiff as HomeBased).homeCC, "a Skiff was given a home base it never reads")
      .toBeUndefined();

    // `zoneFirst`'s `pinned` test, condition for condition. An override failing any of the three is
    // IGNORED there and written anyway by `issueSetHomeBase`, so each has to be caught here.
    for (const [id, why] of [[w.barracks.id, /not a Command Center/], [w.enemyCc.id, /not your base/]] as const) {
      expect(w.run({ kind: "setHomeBase", ccId: id })).toMatch(why);
      expect((w.worker as HomeBased).homeCC, "a refused home base was written anyway").toBe(w.cc.id);
    }
    const half = makeBuilding("command", "player", w.cc.x + 300, w.cc.y, { constructing: true });
    w.state.buildings.set(half.id, half);
    expect(w.run({ kind: "setHomeBase", ccId: half.id })).toMatch(/still being built/);
  });

  it("row 39: anchors a collection point where the ship stands, and the engine runs it", () => {
    const w = world();
    w.select(w.hauler.id);
    expect(w.run({ kind: "collectPoint" })).toBeNull();
    const ship = w.hauler as CollectionPoint;
    expect(ship.collectPoint).toBe(true);
    // "Turning it ON stamps the freighter's CURRENT spot as that anchor" — upstream's own words.
    expect(ship.anchor).toEqual({ x: w.hauler.x, y: w.hauler.y });

    // …and `assignShuttle` picks it up. The witness is the engine's own consumer rather than the
    // flag: a run it offers is proof the toggle reached `sim.js`, which a field is not.
    (w.hauler as CollectionPoint).freight = { ore: 40 };
    w.bridge.step(STEP_SECONDS);
    expect(w.hauler.order?.type, "a loaded collection point was never given its shuttle run")
      .toBe("shuttle");

    // The toggle flips back with no `on`, which is what makes one key enough.
    w.hauler.order = null;
    expect(w.run({ kind: "collectPoint" })).toBeNull();
    expect(ship.collectPoint).toBe(false);
  });

  it("row 40: refuses AI logistics until the tech is in, which the engine does silently", () => {
    const w = world();
    w.select(w.hauler.id);
    const refusal = w.run({ kind: "aiLogistics" });
    expect(refusal, "an unresearched freighter was switched on and nothing was said")
      .toBe(`${TECHS[FREIGHTER_AI_TECH]!.name} has not been researched`);
    expect((w.hauler as Automated).aiLogistics, "the refused toggle was written anyway").toBeFalsy();

    w.state.players.player.upgrades[FREIGHTER_AI_TECH] = true;
    expect(w.run({ kind: "aiLogistics" })).toBeNull();
    expect((w.hauler as Automated).aiLogistics).toBe(true);
    // The invariant `updateService`'s own comment says is "enforced by one command handler, not by
    // the loader or by this consumer": an autonomous freighter's cargo slot exists only because
    // this order minted it.
    expect(w.hauler.cargo, "the automated freighter got no cargo slot to work with").toEqual({
      com: null, qty: 0,
    });

    // Standing DOWN is never gated — upstream's own comment — so the refusal must not be symmetric.
    delete w.state.players.player.upgrades[FREIGHTER_AI_TECH];
    expect(w.run({ kind: "aiLogistics", on: false }),
      "a freighter could be automated and then never stood down").toBeNull();
    expect((w.hauler as Automated).aiLogistics).toBe(false);
  });
});

describe("no order is offered to a unit the engine would silently skip", () => {
  it("names what each order needs, using the engine's own roster", () => {
    // The failure mode this row exists to avoid: a gesture that does nothing for what is selected
    // and says nothing about it. Every message below is built from `UNITS` rather than typed in, so
    // it stays true on the day upstream adds a second scout or a fourth freighter.
    const w = world();
    w.select(w.skiff.id);
    expect(w.run({ kind: "repair", targetId: w.smelter.id, queue: false })).toBe("Only a Worker can be sent to repair");
    expect(w.run({ kind: "serviceBuilding", buildingId: w.smelter.id, queue: false }))
      .toBe("Only a Worker can run a service round trip");
    expect(w.run({ kind: "ferryFreighter", freighterId: w.hauler.id, queue: false }))
      .toBe("Only a Worker can load a freighter");
    expect(w.run({ kind: "scout" })).toBe("Only a Ranger can scout");
    expect(w.run({ kind: "setHomeBase", ccId: w.cc.id })).toBe("Nothing selected keeps a home base");
    expect(w.run({ kind: "collectPoint" })).toMatch(/^Only a .* can be a collection point$/);
    expect(w.run({ kind: "aiLogistics" })).toMatch(/^Only a .* can be automated$/);
    // A Skiff builds nothing, and the message names the building rather than the category.
    expect(w.run({ kind: "assistBuild", buildingId: w.site.id, queue: false }))
      .toBe(`Nothing selected can build a ${BUILDINGS.habitat!.name}`);
  });

  it("reads the roster rather than a list, so the freighter names are the engine's four", () => {
    // The claim under `roleNames`: every unit with the role, by name. Four freighters exist and a
    // message that named one of them would be wrong for the other three.
    const w = world();
    w.select(w.skiff.id);
    const message = w.run({ kind: "collectPoint" })!;
    for (const [type, def] of Object.entries(UNITS)) {
      if (def.role !== "freighter") continue;
      expect(message, `${type} is a freighter and the refusal does not mention it`)
        .toContain(def.name);
    }
  });

  it("never acts on somebody else's entity, which the engine does not check at all", () => {
    // `issueRepair` checks no owner and neither does `updateRepairJob` — the engine will happily
    // have a worker heal the enemy's Command Center. Owner-checked at the bridge for the reason
    // `bombOrNull` is: the one thing a command may never do is act on another player's entity.
    const w = world();
    w.enemyCc.hp = w.enemyCc.maxHp * 0.5;
    w.select(w.worker.id);
    expect(w.run({ kind: "repair", targetId: w.enemyCc.id, queue: false }))
      .toBe("That is not yours to repair");
    expect(w.worker.order, "a worker was sent to heal the enemy").toBeNull();
    expect(w.run({ kind: "serviceBuilding", buildingId: w.enemyCc.id, queue: false }))
      .toBe("That is not yours to service");
    expect(w.run({ kind: "assistBuild", buildingId: w.enemyCc.id, queue: false }))
      .toBe("That is not yours to build");
  });

  it("refuses a collection point on a ship with no hold, which the engine accepts", () => {
    // `issueSetCollectPoint` filters on `role === "freighter"` and the plain Freighter passes it —
    // but `assignShuttle` weighs `freightUsed`, and a ship with no `cargoHold` can never hold
    // anything, so the run it offers can never start. The engine draws no line between the two.
    const w = world();
    const plain = makeUnit("freighter", "player", w.hauler.x + 20, w.hauler.y);
    w.state.units.set(plain.id, plain);
    w.select(plain.id);
    expect(w.run({ kind: "collectPoint" })).toMatch(/no hold/);
    expect((plain as CollectionPoint).collectPoint, "a refused toggle was written anyway")
      .toBeFalsy();
    // A mixed selection still goes through: the ship that CAN collect is the reason to allow it,
    // and the engine's own filter is what decides the rest.
    w.select(plain.id, w.hauler.id);
    expect(w.run({ kind: "collectPoint" })).toBeNull();
    expect((w.hauler as CollectionPoint).collectPoint).toBe(true);
  });

  it("will not set a rally or empty a queue on somebody else's building", () => {
    // `state.selection` holds enemy entities on purpose — they are inspectable, exactly as upstream
    // — so every command path filters to the player's own. Both of these orders resolve their
    // target FROM the selection, which is the one place that filter could go missing.
    const w = world();
    w.enemyCc.queue.push({ unitType: "worker", progress: 0 });
    w.select(w.enemyCc.id);
    expect(w.run({ kind: "cancelTrain" })).toMatch(/Select a building/);
    expect(w.enemyCc.queue.length, "the enemy's queue was emptied for them").toBe(1);
    expect(w.run({ kind: "setRally", x: 10, y: 10 })).toMatch(/Select a building/);
  });

  it("takes a named building for the two orders a panel could also drive", () => {
    // `setRally` and `cancelTrain` are the two intents that already existed, and a HUD building
    // panel is the obvious second producer for both — so the `buildingId` path is kept, kept
    // owner-checked, and kept tested. Without this the selection path is the only one anything
    // exercises, and the named path could lose its owner filter unnoticed.
    const w = world();
    w.select();                                        // nothing selected: the id is doing the work
    expect(w.run({ kind: "setRally", buildingId: w.barracks.id, x: 512, y: 256 })).toBeNull();
    expect(w.barracks.rally).toEqual({ x: 512, y: 256, nodeId: null });
    expect(w.run({ kind: "setRally", buildingId: w.enemyCc.id, x: 1, y: 1 }))
      .toMatch(/Select a building/);

    w.select(w.barracks.id);
    w.run({ kind: "train", buildingId: w.barracks.id, unitType: "skiff" });
    w.run({ kind: "train", buildingId: w.barracks.id, unitType: "bastion" });
    // An index the caller names wins over the newest-job default, which is what a queue chip needs.
    expect(w.run({ kind: "cancelTrain", buildingId: w.barracks.id, queueIndex: 0 })).toBeNull();
    expect(w.barracks.queue.map((j) => j.unitType)).toEqual(["bastion"]);
  });

  it("keeps the freighter out of its own ferry crew, on the engine's own filter", () => {
    // **Written this way because mutation testing killed the first version.** The first draft added
    // a `u.id !== ship.id` guard beside `escort`'s, and removing it changed nothing: no freighter
    // is a logistics type, so `canLogisticsType` had already excluded the ship. The engine means
    // that — `sim.js` offers `assignFerry` to logistics types only, "a freighter doesn't ferry
    // another freighter" — so the claim to pin is that the LOGISTICS filter is what does it, and
    // this test now goes red when that filter goes rather than when a redundant one does.
    const w = world();
    w.select(w.worker.id, w.hauler.id);
    expect(w.run({ kind: "ferryFreighter", freighterId: w.hauler.id, queue: false })).toBeNull();
    expect(w.hauler.order, "the freighter was crewed onto itself").toBeNull();
    expect(w.worker.order?.type).toBe("ferry");
  });
});

/* =================================================================================================
   HALF THREE — THE SWEEP §2 STEP 4 NEVER HAD

   "The Phase 1 intent sweep that does not exist would have caught rows 31 and 32 five phases ago."
   ================================================================================================= */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every `kind` in the `Intent` union, read out of the source.
 *
 * Comments are stripped first and the block is walked by brace depth rather than to the first `;` —
 * the members are object types full of semicolons, so "the next semicolon" ends inside the very
 * first one and would report a union of exactly one kind, which passes everything.
 */
export function intentKindsIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const start = code.indexOf("export type Intent =");
  if (start < 0) throw new Error("the Intent union is not where this scan looks for it");
  let depth = 0;
  let end = -1;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ";" && depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("the Intent union does not terminate");
  return [...code.slice(start, end).matchAll(/\bkind:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * The kinds a CONTROL OTHER THAN A GESTURE produces, and the enumeration that proves each one.
 *
 * This is the list a new intent will not be on, which is the entire point: adding one without a
 * producer fails the sweep below by name. It is written as a mapping rather than an array so that
 * "covered" always means "covered by a named test", never "somebody added it here to go green".
 */
const REACHED_BY_A_CONTROL: Readonly<Record<string, string>> = {
  train: "test/ui/production-menu.test.ts", deploy: "test/input/phase2-input.test.ts",
  pause: "test/input/phase2-input.test.ts", electrify: "test/input/phase2-input.test.ts",
  research: "test/input/phase2-input.test.ts", cancelResearch: "test/input/phase2-input.test.ts",
  recycle: "test/input/phase2-input.test.ts", cancelRecycle: "test/input/phase2-input.test.ts",
  trade: "test/input/phase2-input.test.ts", logiPriority: "test/input/phase2-input.test.ts",
  doctrine: "test/input/phase2-input.test.ts",
  armBomb: "test/input/phase3-input.test.ts", detonate: "test/input/phase3-input.test.ts",
  jump: "test/input/phase4-input.test.ts", upgradeSpaceport: "test/input/phase4-input.test.ts",
  createLane: "test/input/phase4-input.test.ts", deleteLane: "test/input/phase4-input.test.ts",
  assignLane: "test/input/phase4-input.test.ts", unassignLane: "test/input/phase4-input.test.ts",
  colonyPolicy: "test/input/phase4-input.test.ts",
  tribute: "test/ui/phase5-wiring.test.ts", gift: "test/ui/phase5-wiring.test.ts",
  fulfilFavor: "test/ui/phase5-wiring.test.ts", surrender: "test/ui/phase5-wiring.test.ts",
};

/** Everything `translateKey` and `translatePointer` can be made to produce, driven for real. */
function kindsReachableByGesture(): Set<string> {
  const reached = new Set<string>();
  const add = (i: Intent | null): void => { if (i) reached.add(i.kind); };

  // Every key on the board, bare and shifted, with a pending mode to cycle against. A key that
  // returns an intent directly is caught here and needs no listing.
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  for (const k of [...letters, "delete", "escape", " ", "home", ",", "."]) {
    for (const shift of [false, true]) {
      const r = key(k, NONE, { shift });
      add(r.intent);
      // …and whatever the mode it armed makes of a click on an entity, on a node, and on nothing.
      if (!r.mode || r.mode.kind === "none") continue;
      for (const over of [{ entityId: "u1" }, { nodeId: "n1" }, {}]) {
        add(click(r.mode, over).intent);
      }
    }
  }

  // The pointer's own gestures, which no key arms. The enemy has to stand inside the player's own
  // vision, because the snapshot `translatePointer` reads is fog-filtered and `isEnemy` scans it —
  // an AI unit across the map is not in the table at all, and the right-click falls through to a
  // move. That is the correct behaviour and it makes the attack order unreachable in this scan
  // unless the fixture is set up honestly.
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  const base = bridge.state.map.bases.player;
  const enemy = makeUnit("skiff", "ai", base.x + 30, base.y + 30);
  bridge.state.units.set(enemy.id, enemy);
  bridge.step(STEP_SECONDS);
  const snap = bridge.snapshot;
  const at = (type: PointerGesture["type"], button: PointerGesture["button"], over: Partial<PointerGesture>) =>
    translatePointer({
      type, button, worldX: 300, worldY: 300, shift: false, ctrl: false, ...over,
    } as PointerGesture, NONE, snap).intent;
  add(at("click", "left", { entityId: "u1" }));
  add(at("boxSelect", "left", { worldX2: 900, worldY2: 900 }));
  add(at("contextClick", "right", {}));
  add(at("contextClick", "right", { nodeId: bridge.state.map.nodes[0]!.id }));
  add(at("contextClick", "right", { entityId: enemy.id }));
  // The build mode is armed by a HUD button rather than by a key, and resolved by a click here.
  add(click({ kind: "build", buildingType: "turret" }, {}).intent);
  return reached;
}

describe("no order is left unreachable — the union sweep (PARITY §2 step 4)", () => {
  it("gives every intent kind in the union a producer, by name", () => {
    // **The check that was missing for five phases.** `setRally` and `cancelTrain` sat in
    // `bridge/commands.ts` from the MVP with nothing on either end of them, and every enumeration
    // in this directory stayed green throughout, because each asks only about its own phase's list.
    // This one asks the union question: it reads the kinds out of the source, so it cannot be
    // satisfied by editing an array here.
    const kinds = intentKindsIn(readFileSync(join(ROOT, "src/bridge/commands.ts"), "utf8"));
    expect(kinds.length, "the Intent union scan found almost nothing, so it is not scanning")
      .toBeGreaterThan(30);
    expect(new Set(kinds).size, "the union declares the same kind twice").toBe(kinds.length);

    const gestures = kindsReachableByGesture();
    const orphans = kinds.filter((k) => !gestures.has(k) && !(k in REACHED_BY_A_CONTROL)).sort();
    expect(orphans, [
      "These intents exist and nothing a player does produces them:",
      ...orphans.map((o) => `  ${o}`),
      "",
      "Give it a gesture in src/input/intents.ts, or a control — and then add it to",
      "REACHED_BY_A_CONTROL with the enumeration test that proves the control is there.",
    ].join("\n")).toEqual([]);
  });

  it("keeps the covered-by-a-control list honest, so it cannot outlive its intents", () => {
    // The other direction. A name left behind here after its intent was renamed or removed would
    // quietly excuse whatever kind took its place.
    const kinds = new Set(intentKindsIn(readFileSync(join(ROOT, "src/bridge/commands.ts"), "utf8")));
    const stale = Object.keys(REACHED_BY_A_CONTROL).filter((k) => !kinds.has(k)).sort();
    expect(stale, `these are excused and no longer exist: ${stale.join(", ")}`).toEqual([]);
    // …and nothing in it is reachable by a gesture, which would mean the excuse was never needed.
    const gestures = kindsReachableByGesture();
    const overlap = Object.keys(REACHED_BY_A_CONTROL).filter((k) => gestures.has(k)).sort();
    expect(overlap, `these have a gesture and do not need excusing: ${overlap.join(", ")}`)
      .toEqual([]);
  });

  it("gives all ten of PARITY §5.2's absent orders a gesture", () => {
    // The row's own list, named the way `phase{2,3,4}-input.test.ts` name theirs — so a regression
    // reports which ORDER went missing rather than that a count moved.
    const gestures = kindsReachableByGesture();
    const PARITY_ROWS_31_TO_40 = [
      "setRally", "cancelTrain", "repair", "serviceBuilding", "scout",
      "assistBuild", "ferryFreighter", "setHomeBase", "collectPoint", "aiLogistics",
    ];
    const missing = PARITY_ROWS_31_TO_40.filter((k) => !gestures.has(k));
    expect(missing, `no gesture produces: ${missing.join(", ")} — implemented but unreachable`)
      .toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------
   Engine shapes the hand-written declarations do not carry.

   `ui/gate-panel.ts`'s move: a field that exists in the vendored JavaScript, is read in exactly one
   place, and has never been declared — written down next to the code that reads it.
   ------------------------------------------------------------------------------------------- */

/** `issueSetHomeBase` writes this; `Unit` declares no `homeCC`. */
type HomeBased = Unit & { homeCC?: string };
/** `issueSetCollectPoint` writes both; `freight` is what `assignShuttle` weighs. */
type CollectionPoint = Unit & { collectPoint?: boolean; anchor?: { x: number; y: number }; freight?: Record<string, number> };
/** `issueSetAILogistics` writes this. */
type Automated = Unit & { aiLogistics?: boolean };
