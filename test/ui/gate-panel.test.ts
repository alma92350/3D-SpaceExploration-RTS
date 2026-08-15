// P5-T05 — the Antimatter Gate, and the race against the rival's.
//
// The row asks for two things and this file is organised around them.
//
// **"`updateWonder`'s charge is visible on both sides"** — and a charge is a clock, so the same bar
// P4-T07 set for the lane countdown applies: the countdown is asserted TRUE by stepping the
// simulation and checking where it arrives, never by checking that a number exists. Two tests carry
// it. One runs a fed Gate the whole 150 seconds and holds the model's `secondsRemaining` against the
// elapsed sim time at every step, then watches it come online in the second the first reading
// predicted. The other starves a Gate to a quarter of a charge, asserts where the model says it will
// STOP, and then runs the simulation far past that point to prove it stopped there.
//
// **"`checkRivalGate`'s own state is reported, never re-derived"** — so every rival assertion is
// against what the engine chose, in a galaxy arranged so that a plausible re-derivation would choose
// differently: two rival Gates where the ENGINE's most-developed rule picks the second one, a razed
// Gate whose tracked record is still standing, and an ascension that clears the record entirely.
//
// And the discrimination the brief asked about, which the engine does not make on its own:
// `chargingWonderOf` answers `null` for a Gate that is absent, one still under construction, one
// that has never taken a tick of charge, and one already at full charge. Four situations, one
// answer. `does not start` and `started and stalled` are two of them, and telling them apart is
// exactly what P2-T15's `worn` failed to do. The `THE FOUR NULLS` block below walks all six states,
// asserts the engine's own detector where it applies, and asserts that the model separates what the
// detector merges.
//
// Vacuity traps specific to this subject, each answered by a paired assertion:
//
//   • **A feed clamp that is inert because every good is plentiful.** The scarcity tests make exactly
//     ONE of the three fed goods short, so a model that took the largest, the first, or the sum
//     instead of `Math.min` gets a different number — and `binding` is asserted to be that one good.
//   • **A rival test that passes because there is only one candidate.** The selection test arranges
//     two, on worlds where roster order and development disagree.
//   • **A world that was never `discovered`.** A charging Gate is deliberately not fog-gated
//     (`engine/wonder.js`), so one test asserts the rival Gate reaches the panel from an undiscovered
//     world — and the ascension test discovers its world first, so nothing it claims can be an
//     artefact of the world being invisible.

import { describe, expect, it } from "vitest";
import {
  BUILDINGS, activeState, addPlanet, chargingWonderOf, checkRivalGate, createGalaxy, galaxyStatus,
  makeBuilding, powerDraw, prereqsMet, stepGalaxy,
} from "../../src/engine/index.js";
import { GATE_TYPE, gatePanelModel, type OwnGate } from "../../src/ui/gate-panel.js";

const SEED = 20260815;
const HOME = "helix";

/**
 * The Gate's own definition. Every number in this file comes from here rather than being typed in,
 * so a re-tuned `chargeTime` or a changed `feed` moves the test with the game.
 */
interface GateDef {
  chargeTime: number;
  feed: Record<string, number>;
  powerDraw: number;
  requires: string[];
  cost: Record<string, number>;
}
const GATE = BUILDINGS[GATE_TYPE] as unknown as GateDef;
const FEED_GOODS = Object.keys(GATE.feed);
/** The good every scarcity test starves. The other two stay plentiful, so the clamp has to choose. */
const SCARCE = FEED_GOODS[FEED_GOODS.length - 1]!;

/**
 * `charge` and `capital` are written onto buildings by the engine and are not on the declared
 * `Building` shape — the same narrow cast `test/view/starmap.test.ts` makes for `galaxy.rivalGate`.
 */
const charged = (b: Building): { charge?: number } => b as unknown as { charge?: number };
const setCharge = (b: Building, v: number): void => { charged(b).charge = v; };

/** Stock each fed good to `mult` full charges' worth — `wonder.test.js`'s own helper. */
function stockFeed(res: Resources, mult: number): void {
  for (const com of FEED_GOODS) res[com] = (GATE.feed[com] ?? 0) * GATE.chargeTime * mult;
}

interface Scene { g: Galaxy; seat: State; gate: Building }

/** A galaxy whose seat holds a completed Antimatter Gate, with `mult` charges' worth of feed banked. */
function seatWithGate(mult = 2, opts: { constructing?: boolean } = {}): Scene {
  const g = createGalaxy({ seed: SEED, startId: HOME });
  const seat = activeState(g);
  const base = seat.map.bases.player;
  const gate = makeBuilding(GATE_TYPE, "player", base.x + 80, base.y, opts.constructing ? { constructing: true } : {});
  seat.buildings.set(gate.id, gate);
  stockFeed(seat.players.player.resources, mult);
  return { g, seat, gate };
}

const ourGate = (g: Galaxy): OwnGate => {
  const rows = gatePanelModel(g).ours;
  expect(rows, "the panel found no Gate at all — the scene did not build one").toHaveLength(1);
  return rows[0]!;
};

/* =================================================================================================
   THE CLOCK — asserted by stepping, never by existing
   ================================================================================================= */

describe("the Gate's charge is a countdown, and the countdown is true (P5-T05)", () => {
  it("states the engine's own charge time, and a fresh Gate is a whole one away from online", () => {
    const { g } = seatWithGate();
    const model = gatePanelModel(g);

    expect(model.chargeTime, "the panel invented a charge time instead of reading the Gate's").toBe(GATE.chargeTime);
    expect(model.requires, "the Strategic tier is the engine's own `requires` list").toEqual(GATE.requires);
    expect(model.cost).toEqual(GATE.cost);

    const gate = ourGate(g);
    expect(gate.charge).toBe(0);
    expect(gate.started, "an unfed Gate has started nothing").toBe(false);
    expect(gate.secondsRemaining).toBeCloseTo(GATE.chargeTime, 9);
  });

  it("counts down at the rate the simulation charges at, and comes online in the second it predicted", () => {
    // The central assertion of the file. A fed Gate, stepped the whole way: the model's remaining
    // seconds must track the elapsed simulation time at EVERY step — not merely start right and end
    // right — and the Gate must come online within one step of where the very first reading put it.
    const { g, gate } = seatWithGate(2);
    const predicted = ourGate(g).secondsRemaining;
    expect(predicted).toBeCloseTo(GATE.chargeTime, 9);

    const STEP = 0.25;
    let elapsed = 0;
    let onlineAt: number | null = null;

    while (elapsed < GATE.chargeTime + 5 && onlineAt === null) {
      stepGalaxy(g, STEP);
      elapsed += STEP;
      const row = ourGate(g);
      if (row.status === "online") { onlineAt = elapsed; break; }

      expect(row.status, `stalled or stopped at ${elapsed}s with feed still banked`).toBe("charging");
      expect(row.started, "charge was banked but the panel still says nothing has started").toBe(true);
      // The countdown IS the simulation's own progress, not a timer running beside it.
      expect(row.secondsRemaining, `the countdown drifted from the sim at ${elapsed}s`)
        .toBeCloseTo(GATE.chargeTime - elapsed, 6);
      expect(row.charge).toBeCloseTo(elapsed / GATE.chargeTime, 9);
    }

    expect(onlineAt, "the Gate never came online inside its own charge time plus five seconds").not.toBeNull();
    expect(onlineAt!, "the Gate arrived somewhere other than where the first reading predicted")
      .toBeGreaterThan(predicted - STEP - 1e-9);
    expect(onlineAt!).toBeLessThanOrEqual(predicted + STEP + 1e-9);

    const done = ourGate(g);
    expect(charged(gate).charge, "the engine's own charge did not reach full").toBeGreaterThanOrEqual(1);
    expect(done.secondsRemaining, "an online Gate still has time on its clock").toBe(0);
    expect(done.status).toBe("online");
  });

  it("says where the stockpile runs out, and the simulation stops exactly there", () => {
    // The number that cannot be checked by looking: `updateWonder` spends what it banks, so a fixed
    // stockpile carries the charge a fixed distance. One good is short and the other two are not, so
    // a model that summed, averaged or took the largest would predict a different distance.
    const { g, seat, gate } = seatWithGate(3);
    const quarter = 0.25;
    seat.players.player.resources[SCARCE] = (GATE.feed[SCARCE] ?? 0) * GATE.chargeTime * quarter;

    const before = ourGate(g);
    expect(before.reachableCharge, "the panel ignored the stockpile and promised a full charge")
      .toBeCloseTo(quarter, 9);
    expect(before.runwaySeconds).toBeCloseTo(quarter * GATE.chargeTime, 6);
    expect(before.status).toBe("charging");

    const binding = before.feed.filter((f) => f.binding).map((f) => f.com);
    expect(binding, "the clamp did not pick the ONE short good").toEqual([SCARCE]);
    const short = before.feed.find((f) => f.com === SCARCE)!;
    expect(short.perCharge, "a whole charge's cost is the engine's `feed[com] * chargeTime`")
      .toBeCloseTo((GATE.feed[SCARCE] ?? 0) * GATE.chargeTime, 9);
    expect(short.charges).toBeCloseTo(quarter, 9);

    // Far past the point it must stop — four times the runway.
    for (let i = 0; i < 600; i++) stepGalaxy(g, 0.25);

    const after = ourGate(g);
    expect(charged(gate).charge, "the Gate charged past what the stockpile could pay for")
      .toBeCloseTo(quarter, 6);
    expect(after.status, "a Gate that cannot advance still reads as charging").toBe("stalled");
    expect(after.started, "a stalled Gate at a quarter charge has plainly started").toBe(true);
    expect(after.runwaySeconds, "a stalled Gate still claims runway").toBeCloseTo(0, 6);
    expect(after.reachableCharge).toBeCloseTo(after.charge, 6);
    expect(seat.players.player.resources[SCARCE]).toBeGreaterThanOrEqual(0);
    // The other two goods were never the constraint and are still on the shelf.
    for (const com of FEED_GOODS) {
      if (com === SCARCE) continue;
      expect(seat.players.player.resources[com], `${com} was drained though it was never short`)
        .toBeGreaterThan(0);
    }
  });
});

/* =================================================================================================
   THE FOUR NULLS — what `chargingWonderOf` cannot tell apart
   ================================================================================================= */

describe("`chargingWonderOf` answers null four ways, and the panel tells them apart (P5-T05)", () => {
  it("no Gate at all: no rows, and the engine's own reason why", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const seat = activeState(g);
    const model = gatePanelModel(g);

    expect(model.ours, "a galaxy with no Gate reported one").toEqual([]);
    expect(chargingWonderOf(seat, "player"), "the fixture is wrong — the engine sees a Gate").toBeNull();
    expect(model.seatChargingId).toBeNull();
    // Why there is none: the whole Strategic tier is missing on a fresh seat.
    expect(model.seatPrereqsMet).toBe(false);
    expect(model.seatPrereqsMet, "the panel disagreed with `prereqsMet`")
      .toBe(prereqsMet(seat, "player", BUILDINGS[GATE_TYPE]!));
    expect(model.seatWorldId).toBe(HOME);
  });

  it("under construction: a row, `building`, and nothing charging", () => {
    const { g, seat, gate } = seatWithGate(2, { constructing: true });
    const row = ourGate(g);

    expect(gate.constructing).toBe(true);
    expect(chargingWonderOf(seat, "player"), "the engine counts a constructing Gate as charging").toBeNull();
    expect(row.status).toBe("building");
    expect(row.started).toBe(false);
    expect(row.chargingId).toBeNull();
    expect(row.onGrid, "a foundation is not on the grid — `powerDraw` skips it").toBe(false);
  });

  it("raised and starved: `stalled` at zero charge — the state the engine reports as nothing at all", () => {
    // The P2-T15 case, exactly. This Gate is complete, will never move, and `chargingWonderOf` says
    // about it precisely what it says about a Gate that was never built.
    const { g, seat } = seatWithGate(0);
    const row = ourGate(g);

    expect(chargingWonderOf(seat, "player"), "the fixture did not actually starve it").toBeNull();
    expect(row.status).toBe("stalled");
    expect(row.started, "nothing has been banked, so nothing has started").toBe(false);
    expect(row.charge).toBe(0);
    expect(row.runwaySeconds).toBe(0);
    expect(row.chargingId).toBeNull();
    // …and it is not the same reading as "no Gate": there is a row, and it says the clock is stopped.
    expect(gatePanelModel(g).ours).toHaveLength(1);
  });

  it("charging: the engine names the building and the panel reports that name unchanged", () => {
    const { g, seat, gate } = seatWithGate(2);
    setCharge(gate, 0.4);
    const row = ourGate(g);

    const engine = chargingWonderOf(seat, "player");
    expect(engine, "the engine sees no charging Gate at 40%").not.toBeNull();
    expect(row.chargingId, "the panel reported an id the engine did not give it").toBe(engine!.id);
    expect(row.status).toBe("charging");
    expect(row.started).toBe(true);
    expect(row.secondsRemaining).toBeCloseTo(0.6 * GATE.chargeTime, 6);
  });

  it("started and stalled: the engine still calls it charging, and the panel says it is not moving", () => {
    // The other half of the distinction the brief asked about. `chargingWonderOf` is a range check on
    // `charge`; it knows nothing about the feed, so it reports a Gate that has been stuck for
    // minutes exactly as it reports one advancing. Both facts are kept.
    const { g, seat, gate } = seatWithGate(0);
    setCharge(gate, 0.4);
    const row = ourGate(g);

    expect(chargingWonderOf(seat, "player")?.id, "the engine's detector changed its mind").toBe(gate.id);
    expect(row.chargingId, "the engine's own verdict was not carried through").toBe(gate.id);
    expect(row.status, "a Gate with an empty larder was reported as advancing").toBe("stalled");
    expect(row.started, "40% of a charge is banked — it has started").toBe(true);
    expect(row.runwaySeconds).toBe(0);
    expect(row.reachableCharge).toBeCloseTo(0.4, 9);

    // Prove it against the simulation rather than against the model's own arithmetic.
    for (let i = 0; i < 200; i++) stepGalaxy(g, 0.25);
    expect(charged(gate).charge, "the starved Gate advanced anyway").toBeCloseTo(0.4, 9);
  });

  it("online: full charge, and the engine reports nothing charging again", () => {
    const { g, seat, gate } = seatWithGate(2);
    setCharge(gate, 1);
    const row = ourGate(g);

    expect(chargingWonderOf(seat, "player"), "a finished Gate is not charging").toBeNull();
    expect(row.status).toBe("online");
    expect(row.started).toBe(true);
    expect(row.charge).toBe(1);
    expect(row.secondsRemaining).toBe(0);
    expect(row.chargingId).toBeNull();
    expect(seat.over, "a galaxy Gate is a milestone, never a win — the seat must play on").toBe(false);
  });

  it("all four nulls are one answer from the engine and four from the panel", () => {
    // The summary the brief asked for, as an assertion rather than a comment.
    const cases: Array<[string, Scene]> = [];

    const absent = createGalaxy({ seed: SEED, startId: HOME });
    expect(chargingWonderOf(activeState(absent), "player")).toBeNull();
    expect(gatePanelModel(absent).ours).toHaveLength(0);

    cases.push(["building", seatWithGate(2, { constructing: true })]);
    cases.push(["unstarted", seatWithGate(0)]);
    const online = seatWithGate(2);
    setCharge(online.gate, 1);
    cases.push(["online", online]);

    const engineAnswers = new Set<string>();
    const panelAnswers = new Set<string>();
    for (const [, scene] of cases) {
      engineAnswers.add(String(chargingWonderOf(scene.seat, "player")));
      panelAnswers.add(ourGate(scene.g).status);
    }

    expect(engineAnswers, "the engine's detector distinguished them after all").toEqual(new Set(["null"]));
    expect(panelAnswers, "the panel collapsed states the player has to tell apart")
      .toEqual(new Set(["building", "stalled", "online"]));
  });
});

/* =================================================================================================
   THE GRID — charging costs production, and it stops costing it
   ================================================================================================= */

describe("a charging Gate loads the grid, and the panel says so while it does (P5-T05)", () => {
  it("reports the draw the engine actually counts, and drops it the moment the Gate finishes", () => {
    const { g, seat, gate } = seatWithGate(2);
    setCharge(gate, 0.5);

    const charging = ourGate(g);
    expect(charging.onGrid).toBe(true);
    expect(charging.gridDraw).toBe(GATE.powerDraw);
    const drawWhileCharging = powerDraw(seat, "player");
    expect(charging.power.draw, "the panel's grid reading is not the engine's").toBe(drawWhileCharging);
    expect(drawWhileCharging, "the fixture's Gate is not actually on the grid")
      .toBeGreaterThanOrEqual(GATE.powerDraw);

    setCharge(gate, 1);
    const done = ourGate(g);
    expect(done.onGrid, "a finished Gate is still taxing the factories").toBe(false);
    expect(done.gridDraw).toBe(0);
    expect(done.power.draw, "the engine kept charging the grid for a finished Gate")
      .toBeCloseTo(drawWhileCharging - GATE.powerDraw, 9);
  });
});

/* =================================================================================================
   BOTH SIDES — the player's Gate is not only the seat's
   ================================================================================================= */

describe("the panel looks across the galaxy, in the galaxy's own order (P5-T05)", () => {
  it("finds a Gate on a colony world as well as on the seat, roster order first", () => {
    const { g, gate } = seatWithGate(2);
    // `korrath` is roster index 0 and `helix` is index 6, so a panel walking `galaxy.planets`
    // insertion order (seat first) would list these the other way round.
    const colony = g.planets.get("korrath")!;
    const far = makeBuilding(GATE_TYPE, "player", 400, 500);
    colony.buildings.set(far.id, far);
    setCharge(far, 0.2);
    stockFeed(colony.players.player.resources, 1);

    const rows = gatePanelModel(g).ours;
    expect(rows.map((r) => r.worldId), "the panel used Map order instead of the roster")
      .toEqual(["korrath", HOME]);
    expect(rows[0]!.buildingId).toBe(far.id);
    expect(rows[0]!.charge).toBeCloseTo(0.2, 9);
    expect(rows[0]!.chargingId, "a colony Gate's own charge was not attributed to it").toBe(far.id);
    expect(rows[1]!.buildingId).toBe(gate.id);
    // The seat's own detector still answers only about the seat.
    expect(gatePanelModel(g).seatChargingId, "a colony Gate leaked into the seat's reading").toBeNull();
  });
});

/* =================================================================================================
   THE RIVAL — `checkRivalGate`'s own state, reported
   ================================================================================================= */

/** Give `state`'s AI `n` industrial buildings, which is what `aiDevelopment` counts. */
function develop(state: State, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = makeBuilding("reactor", "ai", 700 + i * 40, 400);
    state.buildings.set(b.id, b);
  }
}

/** Raise an AI Gate on `worldId` at `charge`, and return it. */
function rivalGateOn(g: Galaxy, worldId: string, charge: number, opts: { constructing?: boolean } = {}): Building {
  const state = g.planets.get(worldId)!;
  const b = makeBuilding(GATE_TYPE, "ai", 720, 520, opts.constructing ? { constructing: true } : {});
  setCharge(b, charge);
  state.buildings.set(b.id, b);
  return b;
}

describe("the rival Gate is asked for, never looked for (P5-T05)", () => {
  it("reports the world the ENGINE selected, where a scan in roster order would pick the other", () => {
    // Two live rival Gates. `korrath` comes first in the roster and `glacius` is more developed;
    // `checkRivalGate` picks by development. A panel that took the first world with an AI wonder —
    // or the highest charge — would answer `korrath`.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    develop(g.planets.get("korrath")!, 2);
    develop(g.planets.get("glacius")!, 6);
    rivalGateOn(g, "korrath", 0.8);
    const winner = rivalGateOn(g, "glacius", 0.1);

    checkRivalGate(g);
    const model = gatePanelModel(g);

    expect(model.rival, "no rival Gate crossed into the panel").not.toBeNull();
    expect(model.rival!.worldId, "the panel picked its own favourite instead of the engine's")
      .toBe("glacius");
    expect(model.rival!.buildingId).toBe(winner.id);
    expect(model.rival!.charge).toBeCloseTo(0.1, 9);
    // Two rival Gates stand and neither is yours. `ours` is the PLAYER's side of the race.
    expect(model.ours, "a rival's Gate was reported as one of the player's").toEqual([]);
    expect(model.seatChargingId).toBeNull();
    expect(model.rival!.secondsRemaining).toBeCloseTo(0.9 * GATE.chargeTime, 6);
    // …and it is the engine's own answer, field for field.
    const status = galaxyStatus(g) as { rivalGate: { worldId: string; charge: number } | null };
    expect(model.rival!.worldId).toBe(status.rivalGate!.worldId);
    expect(model.rival!.charge).toBe(status.rivalGate!.charge);
  });

  it("reports a rival Gate on a world the player has never seen — a Gate is not fog-gated", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    expect(g.discovered.has("ferros"), "the fixture is not testing what it claims").toBe(false);
    rivalGateOn(g, "ferros", 0.55);
    checkRivalGate(g);

    const model = gatePanelModel(g);
    expect(model.rival?.worldId).toBe("ferros");
    expect(model.rival?.charge).toBeCloseTo(0.55, 9);
    expect(model.rival?.started).toBe(true);
  });

  it("a Gate still being BUILT is tracked at zero charge, and says which zero it is", () => {
    // `aiWonderOn` does not skip a constructing building, so the alert is raised the moment the
    // foundation is laid. Zero charge then means two different things, and the panel separates them.
    const building = createGalaxy({ seed: SEED, startId: HOME });
    rivalGateOn(building, "ferros", 0, { constructing: true });
    checkRivalGate(building);
    const raised = gatePanelModel(building).rival!;
    expect(raised.charge).toBe(0);
    expect(raised.constructing, "a foundation was reported as a charging Gate").toBe(true);
    expect(raised.started).toBe(false);

    const starved = createGalaxy({ seed: SEED, startId: HOME });
    rivalGateOn(starved, "ferros", 0);
    checkRivalGate(starved);
    const standing = gatePanelModel(starved).rival!;
    expect(standing.charge).toBe(0);
    expect(standing.constructing, "a finished Gate was reported as still under construction").toBe(false);
    expect(standing.started).toBe(false);
  });

  it("follows the engine's live answer when its own tracking record has gone stale", () => {
    // A razed Gate leaves `galaxy.rivalGate` pointing at a building that no longer exists until the
    // next scan. `galaxyStatus` returns null immediately, and so does the starmap; a panel reading
    // the raw record would keep alerting on a Gate that is rubble.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const gate = rivalGateOn(g, "ferros", 0.5);
    checkRivalGate(g);
    expect(gatePanelModel(g).rival?.worldId).toBe("ferros");

    g.planets.get("ferros")!.buildings.delete(gate.id);
    const stale = (g as unknown as { rivalGate: { worldId: string } | null }).rivalGate;
    expect(stale, "the fixture did not leave a stale record to disagree with").not.toBeNull();
    expect(gatePanelModel(g).rival, "the panel reported a Gate the engine no longer reports").toBeNull();
  });

  it("an ascension clears the engine's own alert — and the panel is the thing that still says it happened", () => {
    // The finding this row's second half turns on. `checkRivalGate` ascends the world and nulls its
    // tracked record, so `galaxyStatus().rivalGate` — which IS the starmap's alert — goes quiet at
    // the exact moment the race is lost. Without `ascendedWorlds`, "nobody is racing you" and
    // "somebody finished" are the same reading.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    g.discovered.add("ferros");                 // visible, so nothing below is an artefact of fog
    const gate = rivalGateOn(g, "ferros", 0.9);
    checkRivalGate(g);

    const racing = gatePanelModel(g);
    expect(racing.rival?.worldId).toBe("ferros");
    expect(racing.rivalAscended).toBe(false);
    expect(racing.ascendedWorlds).toEqual([]);

    setCharge(gate, 1);
    checkRivalGate(g);

    const status = galaxyStatus(g) as { rivalGate: unknown | null };
    expect(status.rivalGate, "the engine kept alerting after the ascension").toBeNull();

    const after = gatePanelModel(g);
    expect(after.rival, "the panel must agree with the engine that nothing is being tracked").toBeNull();
    expect(after.rivalAscended, "the race was lost and the panel said nothing").toBe(true);
    expect(after.ascendedWorlds, "the ascended world was not named").toEqual(["ferros"]);
  });

  it("names ascended worlds in roster order, and the latch is permanent", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    // `glacius` is roster index 3 and `korrath` index 0, ascended in the other order.
    for (const id of ["glacius", "korrath"]) {
      const gate = rivalGateOn(g, id, 1);
      expect(gate.owner).toBe("ai");
      checkRivalGate(g);
    }
    const model = gatePanelModel(g);
    expect(model.ascendedWorlds, "ascensions were listed in the order they happened, not the roster")
      .toEqual(["korrath", "glacius"]);
    expect(model.rivalAscended).toBe(true);

    // Nothing un-ascends: further scans neither add nor remove.
    checkRivalGate(g);
    expect(gatePanelModel(g).ascendedWorlds).toEqual(["korrath", "glacius"]);
  });

  it("says nothing about a rival when there is none, on a galaxy with worlds it has not instantiated", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    addPlanet(g, "verdani");
    const model = gatePanelModel(g);
    expect(model.rival).toBeNull();
    expect(model.rivalAscended).toBe(false);
    expect(model.ascendedWorlds).toEqual([]);
  });
});

/* =================================================================================================
   PURITY — a panel that scans is a panel that changes the game
   ================================================================================================= */

describe("the panel reads and never runs a scan (P5-T05)", () => {
  it("does not select, ascend or raise anything by being opened", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    rivalGateOn(g, "ferros", 1);

    // Nothing has scanned yet, so the engine is tracking nothing and has raised nothing.
    expect(gatePanelModel(g).rival, "the panel selected a rival Gate `checkRivalGate` had not").toBeNull();
    expect(gatePanelModel(g).rivalAscended, "the panel ascended a world by being opened").toBe(false);
    expect([...g.reached], "the panel raised a milestone").toEqual([]);
    expect(g.milestones, "the panel queued a firework").toEqual([]);

    // …and the engine's own scan still does its job afterwards.
    checkRivalGate(g);
    expect(gatePanelModel(g).ascendedWorlds).toEqual(["ferros"]);
    expect([...g.reached]).toContain("rival-gate");
  });
});
