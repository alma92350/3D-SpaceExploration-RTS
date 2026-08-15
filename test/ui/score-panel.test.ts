// P5-T08 — the score readout, and the endings an Odyssey does and does not have.
//
// The row's own note is the rule this file enforces: **`scoreBreakdown` is the engine's own
// arithmetic, and a score recomputed above the bridge disagrees with it the first time a weight
// moves.** So every total the panel reports is asserted against `playerScore`, which is upstream's
// own thin wrapper over the same breakdown — and against a fixture whose three components are
// non-zero and pairwise distinct, because a model that dropped one of them agrees with the engine
// on any state where two of the buckets happen to be empty. `BANK_WEIGHT` and `COMBAT_BONUS` are
// module-private upstream and appear nowhere here: the point of the test is that this project never
// learns the weights, only asks for the results.
//
// **The clock is the trap the row names, and the trap is the null.** `DEFAULT_MATCH_TIME_LIMIT` is
// 2400 s and it belongs to `checkWinCondition` — the skirmish path, which ADR-0002 rules out and
// which `sim.js` never dispatches for a galaxy world (every one is created `endless: true`). A
// panel that showed a match clock in the Odyssey would count down to an ending that never comes.
// So `rules.clock` is null here — and a hardcoded null would pass that assertion just as well,
// which is why the skirmish branch is driven too: a real non-endless state reports a real deadline,
// and the engine really does end at it. Both halves, or neither proves anything.
//
// The same pairing runs through the two endless checks. In a galaxy, losing every base is not a
// defeat and a completed Antimatter Gate is not a victory; outside one, the very same engine
// functions do end the run on both. Each in-galaxy "it does not end" below is therefore paired with
// a standalone state where it does.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_TIME_LIMIT, UNITS, activeState, checkEndlessLoss, checkEndlessWin,
  checkWinCondition, createGalaxy, createGameState, makeBuilding, makeUnit, playerScore,
  scoreBreakdown, stepGalaxy, surrenderGalaxy,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { scoreLines, scorePanelModel, terminalRules } from "../../src/ui/score-panel.js";

const SEED = 20260815;
const SEAT = "helix";

/** A world with something in every one of the engine's three buckets, and no two of them equal. */
function stocked(state: State, owner: OwnerId = "player"): State {
  const at = state.map.bases[owner === "player" ? "player" : "ai"];
  Object.assign(state.players[owner]!.resources, { ore: 1000, crystals: 200, radioactives: 40 });

  const cc = makeBuilding("command", owner, at.x, at.y);
  cc.constructing = false;
  cc.buildProgress = 1;
  state.buildings.set(cc.id, cc);

  // A combat unit and a non-combat one, because they land in different buckets and a model that
  // conflated them would still add up to the same total.
  const skiff = makeUnit("skiff", owner, at.x + 40, at.y);
  state.units.set(skiff.id, skiff);
  const worker = makeUnit("worker", owner, at.x - 40, at.y);
  state.units.set(worker.id, worker);
  return state;
}

/**
 * `state.winner`, which the vendored declarations do not carry — read the way
 * `src/ui/colony-panel.ts` reads `state.background`.
 */
const winnerOf = (state: State): string | null =>
  (state as unknown as { winner?: string | null }).winner ?? null;

/** Strip a side back to nothing — no base, no ship, the state `checkEndlessLoss` is about. */
function razed(state: State, owner: OwnerId = "player"): State {
  for (const [id, u] of [...state.units]) if (u.owner === owner) state.units.delete(id);
  for (const [id, b] of [...state.buildings]) if (b.owner === owner) state.buildings.delete(id);
  return state;
}

/** A skirmish world: not endless, not in a galaxy — the one path that consults a clock. */
function skirmish(): State {
  const state = createGameState({ endless: false, seed: 7, planetId: "ferros" });
  expect(state.endless, "the fixture is endless, so it is not the skirmish branch").toBe(false);
  return state;
}

/** A standalone endless world: the Odyssey's rules WITHOUT a galaxy around it. */
function standalone(): State {
  const state = createGameState({ endless: true, seed: 7, planetId: "ferros" });
  expect((state as unknown as { inGalaxy?: boolean }).inGalaxy, "the fixture is already in a galaxy")
    .toBeUndefined();
  return state;
}

/** A finished, fully charged Antimatter Gate. */
function gate(state: State, owner: OwnerId): Building {
  const at = state.map.bases[owner === "player" ? "player" : "ai"];
  const b = makeBuilding("antimatter_gate", owner, at.x + 80, at.y + 80);
  b.constructing = false;
  b.buildProgress = 1;
  (b as unknown as { charge: number }).charge = 1;
  state.buildings.set(b.id, b);
  return b;
}

/* =================================================================================================
   THE ENGINE'S OWN NUMBERS
   ================================================================================================= */

describe("the score is the engine's arithmetic, never this project's (P5-T08)", () => {
  it("reports scoreBreakdown's three components and its own total", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const seat = stocked(activeState(g));
    const line = scorePanelModel(g).lines.find((l) => l.owner === "player")!;
    const engine = scoreBreakdown(seat, "player");

    expect(line.bank, "the bank is not the engine's").toBe(engine.bank);
    expect(line.army, "the army is not the engine's").toBe(engine.army);
    expect(line.structures, "the structures figure is not the engine's").toBe(engine.structures);
    // The assertion the row asks for: the total is `playerScore`'s, not a sum taken up here.
    expect(line.total, "the total disagrees with playerScore").toBe(playerScore(seat, "player"));

    // …and the fixture is one where dropping any single bucket would show. Without this, a model
    // that reported `army + structures` as the total would pass everything above on any state
    // whose bank happens to be empty.
    expect(line.bank, "the bank is empty, so a model that ignored it would pass").toBeGreaterThan(0);
    expect(line.army, "no combat units, so the army bucket proves nothing").toBeGreaterThan(0);
    expect(line.structures, "nothing built, so the structures bucket proves nothing").toBeGreaterThan(0);
    expect(new Set([line.bank, line.army, line.structures]).size, "two buckets are equal — a swap would hide")
      .toBe(3);
    expect(line.total).toBeGreaterThan(line.bank + line.army);
  });

  it("puts each unit in the bucket the engine's own roster puts it in", () => {
    // `scoreBreakdown` folds workers, freighters and Menders into the same bucket as buildings, and
    // gives combat units a bonus on top of their cost. A panel that split them any other way would
    // still total correctly and explain the run wrongly — which is the whole reason the engine
    // hands over three numbers instead of one.
    //
    // The Ranger is the case that makes the point: it is armed, it is built at the Command Center
    // alongside the Skiff, and the engine's roster gives it `role: "scout"` — so it scores as
    // infrastructure, not as army. A panel that bucketed by "does it have an attack" would be
    // plausible, self-consistent, and disagree with the tiebreak it claims to explain.
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const seat = razed(activeState(g));
    for (const key of Object.keys(seat.players.player!.resources)) seat.players.player!.resources[key] = 0;
    const cost = (type: string) => Object.values(UNITS[type]!.cost ?? {}).reduce((a, b) => a + b, 0);
    const player = () => scorePanelModel(g).lines.find((l) => l.owner === "player")!;

    const worker = makeUnit("worker", "player", seat.map.bases.player.x, seat.map.bases.player.y);
    seat.units.set(worker.id, worker);
    expect(player().army, "a worker was counted as army").toBe(0);
    expect(player().structures, "a worker is not in the structures bucket at raw cost").toBe(cost("worker"));

    const ranger = makeUnit("ranger", "player", seat.map.bases.player.x + 30, seat.map.bases.player.y);
    seat.units.set(ranger.id, ranger);
    expect(UNITS.ranger!.role, "the Ranger is a combat unit now — this test is about the other case")
      .not.toBe("combat");
    expect(player().army, "an armed scout was counted as army").toBe(0);
    expect(player().structures, "the Ranger did not land in the engine's own else-bucket")
      .toBe(cost("worker") + cost("ranger"));

    const skiff = makeUnit("skiff", "player", seat.map.bases.player.x + 60, seat.map.bases.player.y);
    seat.units.set(skiff.id, skiff);
    const armed = player();
    expect(armed.structures, "the Skiff landed in structures").toBe(cost("worker") + cost("ranger"));
    expect(armed.army, "the army is the raw cost — the engine's combat weighting was dropped")
      .toBeGreaterThan(cost("skiff"));
    expect(armed.total, "the total stopped agreeing with the engine once a fighter existed")
      .toBe(playerScore(seat, "player"));
  });

  it("scores every side in the engine's own order, not just the player's", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const seat = stocked(activeState(g));
    stocked(seat, "ai");
    const model = scorePanelModel(g);

    expect(model.lines.map((l) => l.owner), "the sides are not in state.owners order")
      .toEqual([...seat.owners]);
    for (const line of model.lines) {
      expect(line.total, `${line.owner}'s total is not the engine's`).toBe(playerScore(seat, line.owner));
      expect(line.total, `${line.owner} scored nothing, so the row proves nothing`).toBeGreaterThan(0);
    }
  });

  it("scores every instantiated world on its own numbers, and invents none for the rest", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    stocked(activeState(g));
    const model = scorePanelModel(g);

    expect(model.seatId).toBe(SEAT);
    expect(model.worlds.map((w) => w.planetId), "the roster order was not kept")
      .toEqual(g.worlds.filter((id) => g.planets.has(id)));
    expect(model.worlds.length, "a dormant world was scored as if it existed")
      .toBeLessThan(g.worlds.length);
    expect(model.worlds.length, "no worlds were scored").toBeGreaterThan(1);
    expect(model.worlds.filter((w) => w.seat).map((w) => w.planetId), "the seat is not marked exactly once")
      .toEqual([SEAT]);

    for (const world of model.worlds) {
      const state = g.planets.get(world.planetId)!;
      for (const line of world.lines) {
        expect(line.total, `${world.planetId}/${line.owner} is not the engine's own score`)
          .toBe(playerScore(state, line.owner));
      }
    }
    // The seat's line and a colony's differ, so "every world" is not one world copied.
    const colony = model.worlds.find((w) => !w.seat)!;
    expect(colony.lines.find((l) => l.owner === "player")!.total, "a colony carries the seat's score")
      .not.toBe(model.lines.find((l) => l.owner === "player")!.total);
  });

  it("scoreLines is the same answer for a world handed over on its own", () => {
    const state = stocked(skirmish());
    const lines = scoreLines(state);
    expect(lines.map((l) => l.owner)).toEqual([...state.owners]);
    expect(lines[0]!.total).toBe(playerScore(state, lines[0]!.owner));
  });
});

/* =================================================================================================
   THE CLOCK THAT DOES NOT APPLY
   ================================================================================================= */

describe("the Odyssey has no match clock, and the engine agrees (P5-T08)", () => {
  it("shows no deadline on a galaxy world, whatever the clock reads", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    stocked(activeState(g));
    const rules = scorePanelModel(g).rules;

    expect(rules.path, "a galaxy world is not on the endless path").toBe("endless");
    expect(rules.endless).toBe(true);
    expect(rules.inGalaxy, "the world does not know it is in a galaxy").toBe(true);
    expect(rules.clock, "a match clock was drawn for the Odyssey").toBeNull();

    // Past the skirmish limit by a minute, and the run does not so much as notice — which is what
    // makes the null above a fact about the engine rather than a preference of this panel.
    const seat = activeState(g);
    seat.time = DEFAULT_MATCH_TIME_LIMIT + 60;
    stepGalaxy(g, STEP_SECONDS);
    expect(seat.time, "the fixture never passed the limit").toBeGreaterThan(DEFAULT_MATCH_TIME_LIMIT);
    expect(seat.over, "the Odyssey ended on a clock it is not supposed to have").toBe(false);
    expect(scorePanelModel(g).rules.clock, "the clock appeared once the limit passed").toBeNull();
    expect(scorePanelModel(g).ending.over).toBe(false);
  });

  it("shows the deadline for a state that really has one — so the null is a decision, not a constant", () => {
    // The control the null needs. A non-endless state is the one path `sim.js` sends to
    // `checkWinCondition`, and this project never creates one (ADR-0002) — but the branch has to be
    // live, or "no clock in the Odyssey" is a hardcoded null that would survive any change.
    const state = stocked(skirmish());
    const rules = terminalRules(state);

    expect(rules.path).toBe("skirmish");
    expect(rules.clock, "the skirmish branch reports no clock, so the Odyssey's null proves nothing")
      .not.toBeNull();
    expect(rules.clock!.limitSeconds, "the default limit is not the engine's").toBe(DEFAULT_MATCH_TIME_LIMIT);
    expect(rules.clock!.elapsedSeconds).toBe(0);
    expect(rules.clock!.remainingSeconds).toBe(DEFAULT_MATCH_TIME_LIMIT);
    expect(rules.wipeoutEndsRun, "a skirmish cannot be lost by elimination").toBe(true);

    // And the deadline is real: at the limit, the engine ends the match on score.
    stocked(state, "ai");
    state.time = DEFAULT_MATCH_TIME_LIMIT;
    checkWinCondition(state);
    expect(state.over, "the skirmish clock did not fire at the limit the panel showed").toBe(true);
    expect((state as unknown as { winReason?: string }).winReason).toBe("timeout-score");
  });

  it("reports a chosen match length rather than the default it falls back to", () => {
    // `state.matchTimeLimit` is null unless a length was deliberately picked, and `checkWinCondition`
    // resolves `?? DEFAULT_MATCH_TIME_LIMIT` itself. A panel that read the constant would be wrong
    // for every match that chose one.
    const state = skirmish();
    (state as unknown as { matchTimeLimit: number }).matchTimeLimit = 900;
    state.time = 300;
    const clock = terminalRules(state).clock!;

    expect(clock.limitSeconds, "the panel showed the default instead of the chosen length").toBe(900);
    expect(clock.remainingSeconds).toBe(600);
  });
});

/* =================================================================================================
   VICTORY AND DEFEAT — the two the Odyssey does not have
   ================================================================================================= */

describe("in a galaxy there is no defeat and no victory (P5-T08)", () => {
  it("does not end when the player loses everything, and says so before it happens", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const seat = activeState(g);
    expect(scorePanelModel(g).rules.wipeoutEndsRun, "the panel threatens a defeat the engine will not deliver")
      .toBe(false);

    razed(seat);
    checkEndlessLoss(seat);
    stepGalaxy(g, STEP_SECONDS);

    const model = scorePanelModel(g);
    expect(model.ending.over, "a wipeout ended the run").toBe(false);
    expect(model.ending.winner).toBeNull();

    // The pair: the identical check, on the identical kind of state, WITHOUT a galaxy around it —
    // where it really does end the run. So "no defeat" is the galaxy, not a check that never fires.
    // Razed first, because a standalone endless state opens holding a colony ship and an undeployed
    // ship is a foothold in its own right — the premise has to be established or both branches
    // agree for the wrong reason.
    const alone = razed(standalone());
    expect(terminalRules(alone).wipeoutEndsRun, "the standalone branch also claims no defeat").toBe(true);
    checkEndlessLoss(alone);
    expect(alone.over, "checkEndlessLoss did nothing even outside a galaxy — the pair proves nothing")
      .toBe(true);
    expect((alone as unknown as { winner?: string }).winner).toBe("ai");
  });

  it("does not end when a player Antimatter Gate comes online — that is a milestone", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const seat = stocked(activeState(g));
    expect(scorePanelModel(g).rules.gateEndsRun, "the panel promises a victory the galaxy has no room for")
      .toBe(false);

    gate(seat, "player");
    checkEndlessWin(seat);
    stepGalaxy(g, STEP_SECONDS);

    expect(scorePanelModel(g).ending.over, "a completed Gate ended the run").toBe(false);
    expect(winnerOf(seat), "a completed Gate crowned a winner").toBeNull();
    // The engine turned it into a firework instead, which is P5-T06's row and this row's evidence
    // that the Gate was really finished rather than never noticed.
    expect([...g.reached], "the Gate was not recognised at all, so 'no victory' proves nothing")
      .toContain("gate");

    // The pair again: the same charged Gate outside a galaxy IS a win.
    const alone = standalone();
    gate(alone, "player");
    expect(terminalRules(alone).gateEndsRun).toBe(true);
    checkEndlessWin(alone);
    expect(alone.over, "checkEndlessWin never fires anywhere — the pair proves nothing").toBe(true);
    expect((alone as unknown as { winner?: string }).winner).toBe("player");
  });

  it("reports a surrender as a surrender, in the engine's own words", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    stocked(activeState(g));

    const live = scorePanelModel(g).ending;
    expect(live.over).toBe(false);
    expect(live.winner).toBeNull();
    expect(live.bySurrender).toBe(false);

    surrenderGalaxy(g);

    const ended = scorePanelModel(g).ending;
    expect(ended.over).toBe(true);
    expect(ended.winner, "the winner is not the engine's own field").toBe(winnerOf(activeState(g)));
    expect(ended.winner, "the surrender did not record a result").toBe("ai");
    expect(ended.bySurrender, "the run ended and the screen cannot tell the player why").toBe(true);
    // `winReason` is `checkWinCondition`'s vocabulary — the skirmish clock and its score tiebreak.
    // The Odyssey's endings carry none, and inventing one here would be a sentence the engine never
    // said.
    expect(ended.reason).toBeNull();

    // The score survives the ending: a game-over screen is exactly where the breakdown is read.
    const line = scorePanelModel(g).lines.find((l) => l.owner === "player")!;
    expect(line.total).toBe(playerScore(activeState(g), "player"));
    expect(line.total).toBeGreaterThan(0);
  });
});

describe("the score panel model itself (P5-T08)", () => {
  it("is a pure function of the galaxy it is given", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    stocked(activeState(g));
    expect(scorePanelModel(g)).toEqual(scorePanelModel(g));
  });
});
