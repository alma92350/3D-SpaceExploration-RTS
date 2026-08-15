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
// That check is why this scenario is shaped the way it is, and three of its beats exist in their
// current form ONLY because the earlier shape failed it. Each is commented where it happens:
// the Barracks select at tick 560 (deleted), the recycle/cancel pair (moved onto a worker), and
// the pause/resume pair (collapsed to one order). Do not "tidy" any of them back.
// ---------------------------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Intent, checkPlacement } from "../../src/bridge/commands.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { FIXTURE_PATH, hashState } from "./replay.js";

const SEED = 20260814;
const TICKS = 2200;                   // 110 sim-seconds at 20 Hz. It was 1400 through Phase 2 —
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
                                      // orders are arranged. The extra 800 ticks are that wait
                                      // (~200) plus the combat sequence itself (~860): 700 units
                                      // of ground to cross in formation, an escorted advance, a
                                      // chase-down attack on a target deliberately parked outside
                                      // auto-acquire range, and a patrol still running when the
                                      // recording stops.

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

const NOTE = "The MVP demo recorded as data, plus Phase 2's economy orders and Phase 3's combat "
  + "orders: land on Helix Belt, deploy the colony ship, put the colonists on the nearest ore seam, "
  + "raise a Barracks, train four Skiffs from it, sell ore on the market and buy some back, set the "
  + "Barracks' logistics priority, start and cancel the recycle of a working colonist, push the "
  + "first Skiff east alone, then form the four up in a wedge, hold a line, ring the leader with "
  + "escorts and walk it forward, run down an enemy worker that was standing outside auto-acquire "
  + "range, patrol the ground afterwards and stop on it. Entity ids are the engine's own and depend "
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
          const spot = firstLegalSpot(bridge, builder);
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
          // costs 1.5x to buy back what it sold at 1.0x), and this is what pays for Skiffs three
          // and four: without it the fourth does not land until tick ~1900 and the whole combat
          // sequence has to move. Note what actually carries it into the hash — galaxy credits are
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

        // The third Skiff, at the first tick the treasury can pay for it. It is here to make the
        // squad, not to cover `train` a third time; see SQUAD and TICKS.
        case 1060:
          at(1060, { kind: "train", buildingId: barracksId(bridge), unitType: "skiff" });
          break;

        // --- Phase 1's combat orders, on the one Skiff that exists yet -----------------------------
        case 1000: {
          const skiffs = squad();
          expect(skiffs.length, "the Barracks should have produced a Skiff by tick 1000").toBeGreaterThan(0);
          at(1000, { kind: "select", ids: skiffs.map((s) => s.id), additive: false });
          at(1000, { kind: "move", x: 700, y: 500, queue: false });
          break;
        }
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
        // The premise these are written against, which is easy to get wrong: `dispatchFormation`
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
          // Five of this fixture's orders were NOT COVERED until this one moved.
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
          // escorts and a leader that stopped holding, would both show up below.
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
          // west, where nothing of the enemy's has been within 200 units all game, the legs actually
          // run, and the squad is genuinely walking when `stop` arrives.
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
        case 2130:
          // The Barracks' own last two orders, and `pause` is written last on purpose.
          //
          // `paused` is a plain flag on a Barracks — `updateProductionQueue` never reads it (it
          // gates industry recipes and grid draw, and a Barracks has neither), so nothing observes
          // it but the hash itself. That means only the LAST write to it can ever be covered: the
          // Phase 2 fixture paused at 640 and resumed at 700, and the pause replayed
          // byte-identically when withheld because the resume overwrote it either way. One order,
          // left set at the end, is the honest version of that beat.
          at(2130, { kind: "pause", buildingId: barracksId(bridge), paused: true });
          break;
        case 2160:
          // A recycle that is NOT cancelled, left running at the final tick so the hash carries its
          // progress. The cancelled pair at 760/780 exercises both halves of the order on a unit;
          // this is the building path, and `rc=` in the hash is the only thing that sees it.
          at(2160, { kind: "recycle", entityId: barracksId(bridge) });
          break;
        default:
          break;
      }

      bridge.step(STEP_SECONDS);
      const err = bridge.takeCommandError();
      if (err) problems.push(`tick ${tick}: ${err}`);
      if (process.env.TRACE_FIXTURE === "1" && tick % 20 === 0) {
        const b = [...bridge.state.buildings.values()].find((x) => x.owner === "player" && x.type === "barracks");
        const sk = squad();
        const ais = [...bridge.state.units.values()].filter((u) => u.owner === "ai");
        const far = ais.filter((t) => sk.every((s2) => Math.hypot(t.x - s2.x, t.y - s2.y) > OUT_OF_AGGRO));
        writeFileSync("/tmp/claude-0/-home-user-3D-SpaceExploration-RTS/9bfd454b-2b1e-52f5-a55d-ef11811420f8/scratchpad/trace.txt",
          `tick ${tick} ore=${(bridge.state.players.player.resources.ore ?? 0).toFixed(1)} skiffs=${sk.length} q=${b?.queue.length ?? "-"} orders=${squadOrders().join(",")} at=${sk.map((u) => `${u.id}@${u.x.toFixed(0)},${u.y.toFixed(0)}`).join(" ")} ai=${ais.length} far=${far.length}\n`,
          { flag: "a" });
      }
    }

    expect(problems, `the recorded scenario must not contain refused orders:\n  ${problems.join("\n  ")}`).toEqual([]);

    // The two end-state facts the hash cannot state for itself.
    expect(
      bridge.state.units.get(attackTargetId!),
      `the attack target ${attackTargetId} was still alive at the final tick — the attack order is `
        + "decoration, and withholding it would move the hash only by whatever the chase happened to disturb",
    ).toBeUndefined();
    expect(squad().length, "the squad did not survive to the end of the recording — the last orders "
      + "were issued to fewer units than the scenario is written for").toBe(SQUAD);

    const fixture = {
      seed: SEED,
      world: MVP_WORLD,
      ticks: TICKS,
      note: NOTE,
      script,
      hash: hashState(bridge.state),
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

/** The first buildable Barracks site near a worker, searched in a fixed order so it is repeatable. */
function firstLegalSpot(bridge: WorldBridge, worker: Unit): { x: number; y: number } | null {
  for (const distance of [70, 90, 110, 130]) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]] as const) {
      const x = worker.x + dx * distance;
      const y = worker.y + dy * distance;
      if (checkPlacement(bridge.state, "barracks", x, y).valid) return { x, y };
    }
  }
  return null;
}
