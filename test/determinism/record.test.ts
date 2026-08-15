// The recorder that produces `fixtures/mvp-replay.json`. Skipped unless RECORD_FIXTURE=1.
//
//   RECORD_FIXTURE=1 npx vitest run test/determinism/record.test.ts
//
// Why a recorder exists at all, rather than a hand-written fixture: engine entity ids are minted
// from a counter that advances as the world runs, so "the Barracks" is `b8` if you order it at
// tick 141 and something else if you order it at tick 140. Hand-writing ids produces a fixture
// that hashes deterministically while every order in it silently fails — which is worse than no
// fixture, because it is green.
//
// So the SCENARIO is written here as intent ("select the colony ship", "put the workers on the
// nearest ore"), the recorder resolves it against a real run, and what lands in the fixture is a
// flat list of concrete ids and ticks. The fixture stays exactly what P1-T21 asks for — a recorded
// seed plus a command stream — and this file is how you re-record it after an engine sync.
//
// ---------------------------------------------------------------------------------------------
// THE RULE THIS FILE IS WRITTEN AGAINST (P2-T19, and again in P3-T17)
//
// Every order here must MOVE THE HASH. `replay.test.ts` proves it by replaying the fixture once
// per order with that order withheld and asserting each withheld run lands on a different hash.
// An order that cannot move the hash is not coverage — it is a green line in a fixture that would
// stay green if the intent stopped reaching the engine altogether.
//
// That check is why this scenario is shaped the way it is. Seven of its beats exist in their
// current form ONLY because the earlier shape failed it, and each is commented where it happens:
// the builder select at 140 (now picks the LAST colonist), the Barracks select at 560 (deleted),
// the recycle/cancel pair (moved off the Barracks onto a working colonist), the pause/resume pair
// (collapsed to one order), `hold` at 1120 (moved back from 1160, to halt the Skiff mid-journey),
// `holdFormation` at 1400 (moved back from 1500, to anchor mid-flight), and the patrol (moved out
// of the enemy's base, where its legs never ran). Do not "tidy" any of them back.
//
// The one structural rule underneath most of those: NOTHING in this scenario may end with the
// squad standing still on a coordinate the script names. A unit that arrives at a scripted
// destination and stops has erased how it got there, and every positional order before it replays
// away to nothing.
//
// P4-T11 added an eighth, and it is a rule about the CLOCK rather than about a coordinate: the
// Barracks' `pause` and its un-cancelled `recycle` are now at 7190/7220 rather than 2130/2160,
// because a building recycle completes in half its build time (10 seconds for a Barracks) and the
// jump needed 5 200 more ticks in front of it. Left where they were, the recycle would have
// finished at tick ~2360 and taken three claims with it: `paused` is a flag nothing but the hash
// reads, so a razed Barracks makes that order permanently uncoverable; the un-cancelled recycle's
// only mark is its in-progress `rc=` timer; and — found the hard way — a Foundry needs a Barracks
// standing, so the whole Phase 4 build-out was refused with "Foundry needs a prerequisite
// building" until those two moved. Both keep their original design intent, which was always "the
// LAST write, left set at the final tick"; the final tick simply moved.
// ---------------------------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Intent, checkPlacement } from "../../src/bridge/commands.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { JUMP_LOAD_RADIUS, jumpCost, jumpManifestAll, playerSpaceports } from "../../src/engine/index.js";
import { FIXTURE_PATH, galaxyOf, hashGalaxy } from "./replay.js";

const SEED = 20260814;
const TICKS = 7400;                   // 370 sim-seconds at 20 Hz. It was 2200 through Phase 3 —
                                      // long enough for a Barracks to finish and put two Skiffs on
                                      // the field, which is all the economy orders needed.
                                      //
                                      // P3-T17's combat orders need a SQUAD, and that is what the
                                      // extra 1000 ticks buy. A formation of one unit is not a
                                      // formation: `dispatchFormation`'s n===1 branch hands the
                                      // lone unit a plain move, so a fixture that "covers"
                                      // `moveInFormation` with one Skiff exercises `issueMove`
                                      // and nothing else. An escort needs a target AND escorts.
                                      // A Skiff is 100 ore and this world's opening — one seam,
                                      // three colonists — pays roughly two ore a second, so the
                                      // third Skiff does not exist until tick ~1300 however the
                                      // orders are arranged. Every one of the 800 extra ticks is
                                      // the combat sequence that then runs from 1340: 700 units of
                                      // ground to cross in formation, a re-form into a line while
                                      // still closing, an escorted advance, a patrol out west and
                                      // a halt on the leg, and a chase-down attack on a target
                                      // parked outside auto-acquire range, with 400 ticks left
                                      // after it so the kill and its aftermath are in the hash.
                                      //
                                      // P4-T11's jump then costs 5 200 more, and every one of them
                                      // is ORE. A jump needs a Spaceport, a Spaceport needs a
                                      // Foundry behind it, and the two together are 475 ore on top
                                      // of ~70 more sold at the market for the 342-credit fuel
                                      // (`jumpCost` to Verdani, not `JUMP_COST`). This world's
                                      // opening pays about 1.7 ore a second — three colonists on a
                                      // seam whose near deposits are exhausted by tick 2 200 — so
                                      // 545 ore is a little over four minutes of mining however
                                      // the orders are arranged, and the recorder was written
                                      // against a measured curve rather than a guess. Training
                                      // more colonists does NOT shorten it and was tried: the
                                      // seam's `minerSoftCap` is 3, so a fourth digger on it earns
                                      // `minerFalloff` and three extra workers moved the income
                                      // curve by nothing at all while costing 150 ore.

/**
 * The squad size the combat half of the scenario is written for.
 *
 * Three, not more, and the number is the tick budget rather than a design preference: a fourth
 * Skiff is another ~600 ticks of mining before it can even be queued, and it buys nothing the
 * engine paths under test do not already get from three — one leader with two distinct follower
 * offsets, and two escorts on two distinct ring slots. Two would not do: a two-unit formation has
 * a single follower, so "two followers were given the same station" becomes unaskable.
 */
const SQUAD = 3;

/**
 * How far the `attack` target must be from every Skiff when the order is given.
 *
 * A Skiff's `aggroRange` is 120: it acquires and kills anything that wanders inside that on its
 * own. An `attack` order on a unit already inside it would be the exact trap P3-T17 warns about —
 * a target "that dies to something else anyway" — and dropping the order would still leave a
 * corpse. 220 puts the target a hundred units beyond auto-acquire, so the kill is attributable to
 * the order and to nothing else, and the squad has to actually chase it down.
 */
const OUT_OF_AGGRO = 220;

/**
 * Where the expedition jumps (P4-T11).
 *
 * Verdani, and each half of that is a measured choice rather than a name picked off the starmap:
 *
 *   • CHEAPEST. `jumpCost` scales with the distance across `data.js`'s planet line, and Verdani
 *     (x=5) is one step from Helix Belt (x=6) — 342 credits, against 387 for Ferros and 400 for the
 *     far side. Every credit of that is ore sold at the market, and ore is what the whole tail of
 *     this scenario is short of.
 *   • DORMANT for this seed. `createGalaxy` brings up only `BACKGROUND_WORLDS` neighbours
 *     (ferros, nimbus and kybernet here), so Verdani does not exist in `galaxy.planets` at all
 *     until `jumpCapital` calls `addPlanet` on arrival. The destination therefore enters the hash
 *     as a world that was not there before — the clearest possible mark for the one order this row
 *     is about, and one a same-seed replay cannot produce any other way.
 */
const JUMP_DEST = "verdani";

const NOTE = "The MVP demo recorded as data, plus Phase 2's economy orders and Phase 3's combat "
  + "orders: land on Helix Belt, deploy the colony ship, put the colonists on the nearest ore seam, "
  + "raise a Barracks, train three Skiffs from it, sell ore on the market and buy some back, set the "
  + "Barracks' logistics priority, start and cancel the recycle of a working colonist, push the "
  + "first Skiff east alone and halt it halfway, then form the three up in a wedge, re-form them "
  + "into a line while they are still closing, ring the leader with escorts and walk it forward, "
  + "patrol the open ground west of the enemy, halt on the leg, run down an enemy worker standing "
  + "outside auto-acquire range, then raise a Foundry and a Spaceport off four minutes of mining, "
  + "sell the ore that fuels the jump, leave the Barracks paused and recycling, and jump the "
  + "colonists to Verdani — leaving the squad and every building behind on a Helix Belt that keeps "
  + "running as a background colony. Entity ids are the "
  + "on WHEN each order is issued, so this file is generated by test/determinism/record.test.ts "
  + "rather than hand-written. Regenerate it only when the vendored engine ref changes, in its own "
  + "commit, naming the new ref.";

const shouldRecord = process.env.RECORD_FIXTURE === "1";

describe.skipIf(!shouldRecord)("fixture recorder", () => {
  it("plays the MVP scenario and writes the fixture", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    const script: Array<[number, Intent]> = [];
    const problems: string[] = [];

    const at = (tick: number, intent: Intent): void => {
      script.push([tick, intent]);
      bridge.enqueue(intent);
    };
    const own = (pred: (u: Unit) => boolean): Unit | undefined =>
      [...bridge.state.units.values()].find((u) => u.owner === "player" && pred(u));
    const mine = (type: string): Unit[] =>
      [...bridge.state.units.values()].filter((u) => u.owner === "player" && u.type === type);
    /** The squad, in the engine's own insertion order — so `units[0]`, the leader, is the eldest. */
    const squad = (): Unit[] => mine("skiff");
    /** What each of the squad's orders currently is, sorted, for an assertion that names them. */
    const squadOrders = (): string[] => squad().map((u) => u.order?.type ?? "-").sort();

    // The one enemy the `attack` order is aimed at. Resolved live (ids are the engine's), and
    // recorded so `replay.test.ts` can assert it is dead at the end of a replay — an attack order
    // whose target survives is decoration, and the hash would not say so on its own.
    let attackTargetId: string | null = null;
    /** The colonist the recycle/cancel pair is aimed at — resolved at 760, cancelled at 780. */
    let recycledWorkerId: string | null = null;
    /** The world the expedition launches FROM. After the jump `bridge.state` is no longer it. */
    const origin = bridge.state;

    for (let tick = 0; tick < TICKS; tick++) {
      switch (tick) {
        case 1: {
          const ship = own((u) => u.type === "colonyship");
          expect(ship, "the Odyssey opening must seed a colony ship").toBeDefined();
          at(1, { kind: "select", ids: [ship!.id], additive: false });
          break;
        }
        case 2:
          at(2, { kind: "deploy" });
          break;
        case 20: {
          const workers = mine("worker");
          expect(workers.length, "deploy should have landed colonists").toBeGreaterThan(0);
          const cc = [...bridge.state.buildings.values()].find((b) => b.owner === "player" && b.type === "command")!;
          const ore = bridge.state.map.nodes
            .filter((n) => n.com === "ore")
            .sort((a, b) => Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y))[0]!;
          at(20, { kind: "select", ids: workers.map((w) => w.id), additive: false });
          at(20, { kind: "gather", nodeId: ore.id, queue: false });
          break;
        }
        case 140: {
          // The LAST colonist, not the first, and that is the whole point of the line.
          //
          // `applyBuild` does not read the id in the select — it takes the first builder in the
          // selection. With the first worker selected, dropping this select left the selection at
          // the three-worker group from tick 20, whose first builder is that same worker: same
          // builder, same site, byte-identical run. The select was in the fixture, looked like
          // coverage, and could not move the hash. Selecting the last worker makes it the one line
          // that decides who builds and (through `firstLegalSpot`, which searches from the chosen
          // worker) where.
          const workers = mine("worker");
          const builder = workers[workers.length - 1]!;
          const spot = firstLegalSpot(bridge, builder, "barracks");
          expect(spot, "no legal Barracks site near the base — the scenario cannot proceed").not.toBeNull();
          at(140, { kind: "select", ids: [builder.id], additive: false });
          at(140, { kind: "build", buildingType: "barracks", x: spot!.x, y: spot!.y });
          break;
        }
        case 560: {
          // No `select` of the Barracks here, deliberately. `train` carries its own `buildingId`
          // and never reads `state.selection`, so a select in front of it cannot reach the hash by
          // any route — it replayed byte-identically when withheld. It was in the Phase 2 fixture,
          // and it was the second of the two selects that proved to be decoration. A player does
          // click the building first; the fixture records the orders that change the simulation.
          const barracks = [...bridge.state.buildings.values()]
            .find((b) => b.owner === "player" && b.type === "barracks");
          expect(barracks, "the Barracks should exist by tick 560").toBeDefined();
          expect(barracks!.constructing, "…and should have finished building").toBe(false);
          at(560, { kind: "train", buildingId: barracks!.id, unitType: "skiff" });
          at(560, { kind: "train", buildingId: barracks!.id, unitType: "skiff" });
          break;
        }
        // --- Phase 2's economy orders (P2-T19) ---------------------------------------------------
        //
        // Each one is a NEW intent path, and the point of putting them here is that the replay hash
        // then covers them: an economy command that silently stopped reaching the engine would
        // still leave the hash unchanged if the fixture never issued one.
        //
        // Research is deliberately absent, and the reason is worth writing down rather than
        // leaving as a gap. It needs a Datacenter (200 ore) AND crystals for the tech itself, and
        // the recorder cannot inject resources — the fixture records only a seed and a script, so
        // anything handed to the player here would not exist on replay and the hash would not
        // reproduce. Two minutes of one ore seam does not fund a Datacenter. Covering research
        // needs a longer scenario, not a special case.

        case 600: {
          // Trade moves galaxy credits, which live above the world — so this is also the one order
          // in the fixture that proves the galaxy reference reaches the engine intact.
          at(600, { kind: "trade", com: "ore", qty: 25, side: "sell" });
          break;
        }
        case 610:
          // The buy side, which the Phase 2 fixture never exercised — and it is not here only for
          // symmetry. `buy` and `sell` are separate engine functions with separate spreads (raw ore
          // costs 1.5x to buy back what it sold at 1.0x), and this is what pays for the third Skiff:
          // without it the squad is not complete until tick ~1600 and the whole combat sequence has
          // to move. Note what actually carries it into the hash — galaxy credits are
          // NOT hashed, the player's ore is, so the coverage comes from the ore that arrives.
          at(610, { kind: "trade", com: "ore", qty: 75, side: "buy" });
          break;
        case 620:
          at(620, { kind: "logiPriority", buildingId: barracksId(bridge), priority: "high" });
          break;
        case 760: {
          // A recycle START and its CANCEL, on a colonist that is currently working a seam — and
          // the "currently working" half is load-bearing, not colour.
          //
          // Through Phase 2 this pair was aimed at the Barracks, and the pair cancelled out: a
          // recycling BUILDING stays fully functional until its timer completes, so twenty ticks of
          // building-recycle-then-cancel left a byte-identical world and `recycle` came back NOT
          // COVERED. (P2-T19 patched around it by adding a second, uncancelled recycle, which
          // covered the KIND while leaving this order itself inert.)
          //
          // A recycling UNIT is different: upstream's rule is that it "can't act" for the duration.
          // So one second of recycle on a working colonist is one second off its gather cycle, and
          // that phase shift never comes back — it moves every later ore total and every position
          // downstream of it. Both halves of the pair are now covered on their own: withhold the
          // start and the colonist never stalls; withhold the cancel and it is scrapped outright
          // four seconds later.
          //
          // An IDLE unit would not do: it does not move, so stalling it changes nothing. The
          // builder from tick 140 is idle by now, which is exactly the wrong unit to pick.
          const digger = own((u) => u.type === "worker" && u.order?.type === "gather");
          expect(digger, "no colonist is working a seam at tick 760 — a recycle here would be inert")
            .toBeDefined();
          recycledWorkerId = digger!.id;
          at(760, { kind: "recycle", entityId: recycledWorkerId });
          break;
        }
        case 780: {
          // Twenty ticks later, and issued from its own case rather than alongside the start:
          // `at` enqueues as well as records, so writing both here would apply the cancel on tick
          // 760 while the fixture claimed 780 — the recorded stream and the recorded hash would
          // disagree, and the replay would be the one that looked broken.
          // Cast because `recycling` is declared on Building and not on Unit in shared.d.ts —
          // the declarations carry only what the project reads, and nothing above the bridge has
          // needed a unit's recycle timer before now.
          const stalled = bridge.state.units.get(recycledWorkerId!) as (Unit & { recycling?: unknown }) | undefined;
          expect(stalled?.recycling,
            "the colonist is not recycling at tick 780 — the cancel has nothing to stand down").toBeTruthy();
          at(780, { kind: "cancelRecycle", entityId: recycledWorkerId! });
          break;
        }


        // --- Phase 1's combat orders, on the one Skiff that exists yet -----------------------------
        case 1000: {
          const skiffs = squad();
          expect(skiffs.length, "the Barracks should have produced a Skiff by tick 1000").toBeGreaterThan(0);
          at(1000, { kind: "select", ids: skiffs.map((s) => s.id), additive: false });
          at(1000, { kind: "move", x: 700, y: 500, queue: false });
          break;
        }
        // The third Skiff, at the first tick the treasury can pay for it. It is here to make the
        // squad, not to cover `train` a third time; see SQUAD and TICKS.
        case 1060:
          at(1060, { kind: "train", buildingId: barracksId(bridge), unitType: "skiff" });
          break;
        case 1080:
          at(1080, { kind: "attackMove", x: 1100, y: 500, queue: false });
          break;
        case 1120:
          // Stands the Skiff down MID-JOURNEY — roughly halfway to the attack-move's destination,
          // not eleven units short of it, and the difference between those two is the difference
          // between an order that is covered and one that is not.
          //
          // At 1160 the Skiff had all but arrived, so withholding this order moved it eleven units
          // and nothing else; the squad then formed up on it, arrived at a fixed destination, and
          // the eleven units were gone. Halting it 200 units back makes its stopping place — and
          // therefore the squad's centroid at 1400, which is what `holdFormation` anchors on —
          // carry the whole of this order's history forward.
          at(1120, { kind: "hold" });
          break;

        // --- Phase 3's combat orders (P3-T11, P3-T12, P3-T17) --------------------------------------
        //
        // `armBomb`/`detonate` are deliberately absent, and for a harder reason than research is.
        // They are the two intents in the bridge that write a sim field directly, so they are the
        // ones a broken intent-queue ordering would desync first — exactly what this fixture is
        // for. But a Helium Bomb costs gas 150 + antimatter 3 + plasmatorp 3 and can only be built
        // at a Star Dock, which needs 350 ore and BOTH an AI Foundry and a Torpedo Works before it
        // can be founded. This scenario finishes 110 sim-seconds with 140 ore in the bank and no
        // gas industry at all. The only way to put a bomb in this fixture is to hand the player one
        // — and the fixture records a seed and a script, nothing else, so anything placed by hand
        // would not exist on replay and the hash would not reproduce. Covering the bomb needs a
        // second, much longer fixture, not a special case in this one.
        //
        // The premise the rest are written against, which is easy to get wrong: `dispatchFormation`
        // does NOT give each unit its own move. For a PLAYER selection it gives `units[0]` — the
        // leader, the eldest Skiff here — one real order, and every other unit a persistent
        // `follow-leader` order carrying a fixed offset. So the assertion after each order counts
        // leaders and followers, not destinations, and a scenario written on the other premise
        // would look right and prove nothing (see test/bridge/formations.test.ts).
        case 1340: {
          const skiffs = squad();
          expect(skiffs.length, `the combat scenario needs ${SQUAD} Skiffs by tick 1340`).toBe(SQUAD);
          at(1340, { kind: "select", ids: skiffs.map((s) => s.id), additive: false });
          at(1340, { kind: "moveInFormation", x: 760, y: 430, shape: "wedge", leaderPos: "front", queue: false });
          break;
        }
        case 1360:
          expect(squadOrders(), "a formation move should be one leader under way and the rest keeping station")
            .toEqual(["follow-leader", "follow-leader", "move"]);
          break;
        case 1400:
          // Form up where they now stand and hold — and "where they now stand" is why this fires at
          // 1400 rather than after the wedge has landed.
          //
          // `issueHoldFormation` anchors the shape on the group's OWN CURRENT CENTROID. Issued
          // after the squad has arrived, that centroid is the wedge's destination: a fixed point,
          // identical no matter what the units did to get there, and every positional order before
          // it replays away to nothing. Issued while they are still closing, the anchor is a live
          // function of the run so far, and it carries that history into every position after it.
          // Five of this fixture's thirty orders replayed byte-identically when withheld until
          // this one moved back to 1400.
          //
          // It also differs from the move above in the hash by order type (`hold-formation`), which
          // is worth having on its own: the two formation intents call different engine functions
          // and a fixture that only ever moved would not tell them apart.
          at(1400, { kind: "holdFormation", shape: "line", leaderPos: "center" });
          break;
        case 1420:
          expect(squadOrders(), "the squad did not take the line — holdFormation reached nothing")
            .toEqual(["follow-leader", "follow-leader", "hold-formation"]);
          break;
        case 1500: {
          // Escort the leader with the other two. The selection still holds all three; the bridge
          // filters the target out of its own escort (the engine documents that as the caller's
          // job), so this order also proves that filter is still there — three escorts, or two
          // escorts and a leader that had stopped holding its anchor, would both show up in the
          // assertion below.
          const leader = squad()[0]!;
          at(1500, { kind: "escort", targetId: leader.id, queue: false });
          break;
        }
        case 1520: {
          expect(squadOrders(), "the escort ring did not form, or the target was told to ring itself")
            .toEqual(["escort", "escort", "hold-formation"]);
          // Now walk the escorted ship forward. The escorts hold their ring slots on it as it goes,
          // which is the property that makes `escort` more than a move — and it is why the fixture
          // moves the leader afterwards rather than issuing the escort and leaving it standing.
          //
          // The destination is chosen so the leader NEVER REACHES IT: the patrol at 1580 pulls the
          // squad away first. That is deliberate. An escorted ship that arrives and stops parks the
          // whole ring on fixed offsets from a fixed point, and a fixed point is where a replay's
          // history goes to die — this was the single convergence that left five earlier orders
          // uncovered. Nothing in this fixture may end a leg by standing still on a coordinate that
          // was written into the script.
          const leader = squad()[0]!;
          at(1520, { kind: "select", ids: [leader.id], additive: false });
          at(1520, { kind: "move", x: 1200, y: 300, queue: false });
          break;
        }
        case 1580: {
          // Patrol, in OPEN GROUND, and both halves of that matter.
          //
          // A patrol leg is an attack-move, and an attack-move suspends itself to fight. The first
          // draft issued this at 2020 with the squad standing in the enemy's base: every leg was
          // instantly interrupted by a target in range, the squad never left the spot, and the order
          // replayed byte-identically when withheld — a patrol that never patrolled. Issued out
          // west, where nothing of the enemy's has set foot all game, the legs actually run, and the
          // squad is genuinely walking when `stop` arrives.
          const skiffs = squad();
          at(1580, { kind: "select", ids: skiffs.map((s) => s.id), additive: false });
          at(1580, { kind: "patrol", x: 700, y: 600 });
          break;
        }
        case 1600:
          expect(squadOrders(), "the squad is not patrolling — patrol legs are attack-move legs")
            .toEqual(["attack-move", "attack-move", "attack-move"]);
          break;
        case 1700:
          // Stop, on a squad that is genuinely under way. It clears the order — the hash carries
          // order types, so that alone is visible — and leaves each Skiff wherever its patrol leg
          // had got to, which is a function of the whole run before it.
          //
          // Ordering is not free here: `stop` after the attack below would have been inert, because
          // an attack order clears itself the moment its target dies and the squad is already
          // orderless by then. `stop` only says anything about the engine when there is something
          // to stop.
          at(1700, { kind: "stop" });
          break;
        case 1800: {
          // The attack, and the selection is deliberately NOT re-issued in front of it: the squad
          // has been selected since 1580 and a second identical `select` could not move the hash
          // (`state.selection` is not hashed, so a select only ever reaches the hash through the
          // order that reads it).
          const skiffs = squad();
          const centre = {
            x: skiffs.reduce((s, u) => s + u.x, 0) / skiffs.length,
            y: skiffs.reduce((s, u) => s + u.y, 0) / skiffs.length,
          };
          // The nearest enemy standing OUTSIDE everyone's auto-acquire range — see OUT_OF_AGGRO.
          // Nearest, so the chase fits in the ticks that are left.
          const target = [...bridge.state.units.values()]
            .filter((u) => u.owner === "ai")
            .filter((t) => skiffs.every((s) => Math.hypot(t.x - s.x, t.y - s.y) > OUT_OF_AGGRO))
            .sort((a, b) => Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y))[0];
          expect(target, `no enemy is more than ${OUT_OF_AGGRO} away — an attack order here would be `
            + "indistinguishable from the squad's own auto-acquire").toBeDefined();
          attackTargetId = target!.id;
          at(1800, { kind: "attack", targetId: target!.id, queue: false });
          break;
        }
        case 1820:
          expect(squadOrders(), "nobody took the attack order").toEqual(["attack", "attack", "attack"]);
          break;
        // --- Phase 4: the launch pad, and the jump (P4-T04, P4-T11) --------------------------------
        //
        // Everything from here to the jump exists to satisfy ONE precondition the engine will not
        // let a fixture fake: `canJumpTo` needs a completed Spaceport on this world (there is no
        // fall-back, because Helix Belt is the only world the player holds a foothold on), a
        // Spaceport needs a completed Foundry, and both need ore this world pays out at 1.7 a
        // second. The recorder cannot hand the player a pad — the fixture records a seed and a
        // script and nothing else, so anything placed by hand would not exist on replay — which is
        // the same rule that keeps research and the Helium Bomb out of this scenario. Here it is
        // affordable, barely, and the tick numbers below are where a measured run crosses each
        // threshold with ~20 ore of margin, not round numbers.
        case 2700: {
          // The Foundry, the Spaceport's own prerequisite. Selected onto the LAST colonist for the
          // same reason tick 140 does: `applyBuild` takes the first builder in the SELECTION, the
          // selection at this point is the three Skiffs (set at 1580, and none of them can build),
          // and `firstLegalSpot` searches outward from whichever worker this names — so this one
          // line decides both who builds and where.
          const workers = mine("worker");
          const builder = workers[workers.length - 1]!;
          const spot = firstLegalSpot(bridge, builder, "foundry");
          expect(spot, "no legal Foundry site near the colonists — the Phase 4 build-out cannot start")
            .not.toBeNull();
          expect(bridge.state.players.player.resources.ore ?? 0,
            "the Foundry is unaffordable at tick 2700 — the ore curve moved and this beat must too")
            .toBeGreaterThanOrEqual(175);
          at(2700, { kind: "select", ids: [builder.id], additive: false });
          at(2700, { kind: "build", buildingType: "foundry", x: spot!.x, y: spot!.y });
          break;
        }
        case 6320: {
          // The Spaceport, and NO select in front of it — deliberately, and for exactly the reason
          // the deleted Barracks select at 560 is documented above. The selection has held this one
          // colonist since 2700 and nothing has touched it since, so a second identical select
          // could not move the hash and would be decoration in a file whose whole rule is that it
          // has none.
          const builder = mine("worker")[mine("worker").length - 1]!;
          const spot = firstLegalSpot(bridge, builder, "spaceport");
          expect(spot, "no legal Spaceport site — there is nowhere to launch the expedition from")
            .not.toBeNull();
          expect(bridge.state.players.player.resources.ore ?? 0,
            "the Spaceport is unaffordable at tick 6320 — re-measure the ore curve before moving it")
            .toBeGreaterThanOrEqual(300);
          at(6320, { kind: "build", buildingType: "spaceport", x: spot!.x, y: spot!.y });
          break;
        }
        case 7000: {
          // The fuel. `jumpCost` is what the treasury has to cover, and it is NOT `JUMP_COST`
          // (P4-T04): 342 credits for a one-step hop to Verdani off a Tier-1 pad, against the
          // constant's 400. The scenario has 62 credits left after Phase 2's buy, so this sells the
          // ore that pays the difference — and the sale is the second half of the make-here/pay-
          // there loop the market beats at 600/610 opened.
          expect(playerSpaceports(bridge.state).length,
            "the pad has not finished by tick 7000 — the fuel is being raised for a jump that "
            + "cannot launch").toBeGreaterThan(0);
          at(7000, { kind: "trade", com: "ore", qty: 70, side: "sell" });
          break;
        }
        case 7190:
          // The Barracks' own last two orders. This is the ONLY write to `paused` in the whole
          // fixture — deliberately, because a second one could not be covered.
          //
          // `paused` is a plain flag on a Barracks — `updateProductionQueue` never reads it (it
          // gates industry recipes and grid draw, and a Barracks has neither), so nothing observes
          // it but the hash itself. That means only the LAST write to it can ever be covered: the
          // Phase 2 fixture paused at 640 and resumed at 700, and the pause replayed
          // byte-identically when withheld because the resume overwrote it either way. One order,
          // left set at the end, is the honest version of that beat.
          //
          // It also has to be the last write on the ORIGIN world, and therefore in front of the
          // jump: `applyIntent` addresses a building through the ACTIVE state, so this same order
          // issued after tick 7240 would look up a Helix Belt id in Verdani's building map, find
          // nothing, and return null — a recorded order that silently does nothing at all.
          at(7190, { kind: "pause", buildingId: barracksId(bridge), paused: true });
          break;
        case 7220:
          // A recycle that is NOT cancelled, left running at the final tick so the hash carries its
          // progress. The cancelled pair at 760/780 exercises both halves of the order on a unit;
          // this is the building path, and `rc=` in the hash is the only thing that sees it.
          //
          // 180 ticks from the end, and the margin is arithmetic rather than taste: a building's
          // recycle runs for half its build time (`RECYCLE_TIME_FRAC`), so a 20-second Barracks
          // finishes at 7420 — 20 ticks after the recording stops. Let it complete and the Barracks
          // is razed, which erases `paused` above along with this order's own timer.
          at(7220, { kind: "recycle", entityId: barracksId(bridge) });
          break;
        case 7240: {
          // THE JUMP (P4-T11).
          //
          // Nothing about it is scripted except the destination: who rides is `jumpManifestAll`'s
          // answer, and that answer is a function of where the colonists happen to be standing in
          // their gather cycle when the order lands — which is itself downstream of every order in
          // this file, including the one-second recycle stall at 760. The pad went up beside the
          // seam they work, so they stage themselves by mining rather than by a scripted move to a
          // coordinate, which is what keeps the structural rule at the top of this file intact
          // through the last order in the fixture.
          //
          // What leaves and what stays is the whole shape of the beat: the colonists ride, the
          // Skiffs are 800 units away in the enemy's half of the map and stay exactly where the
          // chase left them, and NO building moves — `jumpCapital` never relocates a base. So Helix
          // Belt keeps the Command Center, the Barracks mid-recycle, the Foundry, the pad and the
          // squad, and becomes a background colony that goes on ticking at `BG_STEP` cadence. That
          // is why the hash had to widen to every world (see `hashGalaxy`): hashing the seat alone
          // would have thrown all of that away at this exact tick.
          const galaxy = galaxyOf(bridge);
          const pad = playerSpaceports(bridge.state)[0]!;
          const manifest = jumpManifestAll(bridge.state);
          expect(galaxy.planets.has(JUMP_DEST),
            `${JUMP_DEST} is already instantiated — it is no longer a dormant world for this seed, `
            + "so the jump no longer proves that the destination is built on arrival").toBe(false);
          expect(jumpCost(galaxy, JUMP_DEST),
            "the destination is free, which means it has already been reached — this is a return "
            + "trip, not the settlement the scenario is written for").toBeGreaterThan(0);
          expect(galaxy.credits,
            `the treasury cannot fund the ${jumpCost(galaxy, JUMP_DEST)}-credit jump — sell more ore `
            + "at 7000, or move the sale earlier").toBeGreaterThanOrEqual(jumpCost(galaxy, JUMP_DEST));
          expect(manifest.riders.length,
            `nothing is staged within ${JUMP_LOAD_RADIUS} of the pad at ${pad.x.toFixed(0)},`
            + `${pad.y.toFixed(0)} — the jump would move no unit at all, and half of what it proves `
            + "would be missing").toBeGreaterThan(0);
          at(7240, { kind: "jump", destId: JUMP_DEST });
          break;
        }
        case 7241: {
          // One tick later, because the intent queue drains at the TOP of a step: at 7240 the order
          // has been enqueued and not yet applied. These are the facts the fixture is recorded
          // for, asserted while the run is still in hand.
          const galaxy = galaxyOf(bridge);
          expect(galaxy.activeId, "the seat did not move — the jump was refused").toBe(JUMP_DEST);
          expect(galaxy.planets.has(JUMP_DEST), "the destination world was never built").toBe(true);
          expect([...bridge.state.units.values()].filter((u) => u.owner === "player").length,
            "the expedition did not arrive on the destination").toBeGreaterThan(0);
          expect([...origin.units.values()].filter((u) => u.owner === "player" && u.type === "worker").length,
            "every colonist is still on the world the expedition left — nothing actually rode").toBe(0);
          expect([...origin.buildings.values()].filter((b) => b.owner === "player").length,
            "the world we left lost its buildings — a jump moves units, never a base").toBeGreaterThan(0);
          break;
        }
        default:
          break;
      }

      bridge.step(STEP_SECONDS);
      const err = bridge.takeCommandError();
      if (err) problems.push(`tick ${tick}: ${err}`);
    }

    expect(problems, `the recorded scenario must not contain refused orders:\n  ${problems.join("\n  ")}`).toEqual([]);

    // The end-state facts the hash cannot state for itself — asked of the ORIGIN world, not of
    // `bridge.state`. After the jump the seat is Verdani, where there is no corpse and no squad, so
    // `bridge.state.units.get(attackTargetId)` would be `undefined` for the wrong reason entirely
    // and the strongest assertion in this file would pass vacuously.
    expect(
      origin.units.get(attackTargetId!),
      `the attack target ${attackTargetId} was still alive at the final tick — the attack order is `
        + "decoration, and withholding it would move the hash only by whatever the chase happened to disturb",
    ).toBeUndefined();
    const survivors = [...origin.units.values()].filter((u) => u.owner === "player" && u.type === "skiff");
    expect(survivors.length, "the squad did not survive to the end of the recording — the last orders "
      + "were issued to fewer units than the scenario is written for").toBe(SQUAD);

    const fixture = {
      seed: SEED,
      world: MVP_WORLD,
      ticks: TICKS,
      note: NOTE,
      script,
      hash: hashGalaxy(galaxyOf(bridge)),
    };
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`determinism fixture written: ${script.length} orders, hash ${fixture.hash}`);
  });
});

/** The player's Barracks. Its id is the engine's own, which is why the scenario asks rather than names. */
function barracksId(bridge: WorldBridge): string {
  const barracks = [...bridge.state.buildings.values()]
    .find((b) => b.owner === "player" && b.type === "barracks");
  if (!barracks) throw new Error("the economy orders expect a Barracks to exist by now");
  return barracks.id;
}

/**
 * The first buildable site of `type` near a worker, searched in a fixed order so it is repeatable.
 *
 * The type is a parameter rather than a constant because Phase 4 places three different footprints
 * through it, and a Spaceport's radius is wider than a Barracks' — the 150 ring exists for that:
 * `canPlaceBuilding` refuses the closer offsets where the Barracks fitted.
 */
function firstLegalSpot(bridge: WorldBridge, worker: Unit, type: string): { x: number; y: number } | null {
  for (const distance of [70, 90, 110, 130, 150]) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]] as const) {
      const x = worker.x + dx * distance;
      const y = worker.y + dy * distance;
      if (checkPlacement(bridge.state, type, x, y).valid) return { x, y };
    }
  }
  return null;
}
