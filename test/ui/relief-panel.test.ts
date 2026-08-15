// P5-T07 — relief and surrender: reachable, and legible while they are happening.
//
// The row names the trap and this file is built around it: **the anti-farm cooldown is what a
// player must see, or relief looks broken rather than rate-limited.** That is P4-T07's periodic
// lane again, and the lesson from that row is what shapes the central test here — asserting that a
// countdown *exists* proves nothing. So this file does not check that `secondsUntilEligible` is a
// number; it farms relief deliberately, one galaxy tick at a time, and asserts that a ship arrives
// on exactly the ticks the countdown had counted down to and on no others.
//
// The vacuity traps specific to relief, each answered by a paired assertion:
//
//   • **A galaxy that was never wiped out.** Every "no ship arrived" claim below would pass against
//     a player who still holds a base, so each one is paired with the same galaxy, wiped, actually
//     being rescued.
//   • **A countdown that is always zero.** It would satisfy "the countdown had reached zero when
//     the ship came" perfectly, so the series between two drops is asserted to start at a full
//     `RELIEF_COOLDOWN` and to decrease.
//   • **A foothold scan that agrees with the engine by accident.** `checkGalaxyRescue` is a mutator
//     with no query beside it, so the panel has to walk the worlds itself — which means every
//     `hasFoothold` claim here is checked against what the engine then *does*, not against a second
//     reading of the same rule. The two cases where a plausible re-derivation is wrong get their
//     own tests: a Command Center that is still going up counts, and a foothold on a world the
//     player is not sitting on counts.
//
// And the surrender half, which is P2-T12's doctrine problem one degree worse: `researchUpgrade`
// at least returns `false`. `surrenderGalaxy` returns nothing at all and refuses silently, so a
// second click on an ended run is indistinguishable from a first click that worked — which is why
// the panel carries a third value meaning *never* rather than *not yet*.

import { describe, expect, it } from "vitest";
import {
  RELIEF_COOLDOWN, activeState, createGalaxy, hasColonyShip, makeBuilding, makeUnit, stepGalaxy,
  surrenderGalaxy,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { reliefPanelModel } from "../../src/ui/relief-panel.js";

const SEED = 20260815;
const SEAT = "helix";
/** A world this seed brings up in the background — somewhere that is not the seat. */
const ELSEWHERE = "ferros";

const model = (g: Galaxy) => reliefPanelModel(g);

/** Player colony ships on the seat. The observable a relief drop produces. */
function reliefShips(g: Galaxy): string[] {
  const seat = activeState(g);
  return [...seat.units.values()].filter((u) => u.owner === "player" && u.type === "colonyship").map((u) => u.id);
}

/**
 * Strip every player asset from every world — a true wipeout, which the Odyssey answers with a
 * relief ship rather than a defeat.
 *
 * The opening galaxy is already close to one: the player holds a single undeployed colony ship and
 * no Command Center anywhere, so this removes exactly that ship (and, later in a scenario, whatever
 * relief has dropped since).
 */
function wipe(g: Galaxy): Galaxy {
  for (const state of g.planets.values()) {
    for (const [id, u] of [...state.units]) if (u.owner === "player") state.units.delete(id);
    for (const [id, b] of [...state.buildings]) if (b.owner === "player") state.buildings.delete(id);
  }
  expect(model(g).hasFoothold, "the wipe left a foothold standing").toBe(false);
  return g;
}

/** A finished player Command Center, placed rather than built (as `test/ui/lane-panel.ts` places a pad). */
function base(state: State, constructing = false): Building {
  const at = state.map.bases.player;
  const cc = makeBuilding("command", "player", at.x, at.y);
  cc.constructing = constructing;
  cc.buildProgress = constructing ? 0.5 : 1;
  state.buildings.set(cc.id, cc);
  return cc;
}

/** Step until a relief ship exists, or give up. Returns the galaxy time it arrived at. */
function stepUntilRelief(g: Galaxy, limitSeconds = RELIEF_COOLDOWN * 3): number | null {
  for (let i = 0; i < Math.round(limitSeconds / STEP_SECONDS); i++) {
    stepGalaxy(g, STEP_SECONDS);
    if (reliefShips(g).length > 0) return g.time;
  }
  return null;
}

/* =================================================================================================
   THE COOLDOWN — the part a player must see
   ================================================================================================= */

describe("relief is rate-limited, and the panel says by how much (P5-T07)", () => {
  it("states the engine's own cooldown, and starts a run owing nothing", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const m = model(g);

    expect(m.cooldownSeconds, "the panel invented a cooldown instead of reading RELIEF_COOLDOWN")
      .toBe(RELIEF_COOLDOWN);
    expect(m.lastReliefTime, "a fresh galaxy has already sent relief").toBeNull();
    expect(m.eligibleAt, "a galaxy that has never sent relief has a deadline to lift").toBeNull();
    expect(m.secondsUntilEligible, "a fresh galaxy is on cooldown").toBe(0);
    expect(m.onCooldown).toBe(false);

    // The Odyssey opening — one undeployed colony ship, no Command Center anywhere — is NOT a
    // wipeout, and reading it as one would send a relief ship on tick 1 of every new game.
    expect(m.status).toBe("held");
    expect(m.footholds.map((f) => f.planetId)).toEqual([SEAT]);
    expect(m.footholds[0]!.colonyShip, "the opening ship is not being counted as a foothold").toBe(true);
    expect(m.footholds[0]!.commandCenters).toBe(0);
  });

  it("counts down to the tick a second ship arrives, and to no other", () => {
    // **The central assertion of this file.** Relief is farmed on purpose: every ship that arrives
    // is destroyed on the tick it appears, which is exactly the abuse `RELIEF_COOLDOWN` exists to
    // bound and exactly the state a player is in when relief looks broken — no base, no ship, and
    // nothing visibly happening for twenty seconds.
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));

    interface Arrival { at: number; predicted: number }
    const arrivals: Arrival[] = [];
    /** The countdown as seen on each frame between two drops, for the run of one cooldown. */
    let series: number[] = [];
    const seriesByGap: number[][] = [];

    const steps = Math.round((RELIEF_COOLDOWN * 2.5) / STEP_SECONDS);
    for (let i = 0; i < steps; i++) {
      const before = model(g);
      stepGalaxy(g, STEP_SECONDS);
      const ships = reliefShips(g);
      if (ships.length === 0) {
        series.push(before.secondsUntilEligible);
        continue;
      }
      arrivals.push({ at: g.time, predicted: before.secondsUntilEligible });
      seriesByGap.push(series);
      series = [];
      for (const id of ships) activeState(g).units.delete(id);   // farm it: destroy the ship at once
    }

    expect(arrivals.length, "no relief ever arrived, so nothing here was tested").toBeGreaterThanOrEqual(3);

    for (const a of arrivals) {
      // The panel had already counted down to zero when the ship came. Not "close to zero": the
      // only slack is the single step the engine's own clock advances inside `stepGalaxy` before
      // the scan reads it, which is why this is `<=` one step rather than `=== 0`.
      expect(
        a.predicted,
        `a ship arrived at galaxy time ${a.at} while the panel still showed ${a.predicted}s to go`,
      ).toBeLessThanOrEqual(STEP_SECONDS);
    }

    // …and the gaps are the cooldown itself, not something the panel rounded into shape. The upper
    // bound is the cooldown plus the galaxy's own ~1 Hz scan granularity: `checkGalaxyRescue` runs
    // on a throttled sweep, so a drop can land up to one scan late and never later.
    for (let i = 1; i < arrivals.length; i++) {
      const gap = arrivals[i]!.at - arrivals[i - 1]!.at;
      expect(gap, "relief was farmed faster than the cooldown allows").toBeGreaterThanOrEqual(RELIEF_COOLDOWN);
      expect(gap, "relief took far longer than the cooldown the panel advertised")
        .toBeLessThanOrEqual(RELIEF_COOLDOWN + 1 + STEP_SECONDS);
    }

    // A countdown pinned at zero would satisfy every assertion above. These are the frames between
    // two drops: it must start at a full cooldown and fall.
    const between = seriesByGap.find((s) => s.length > 10)!;
    expect(between, "no run of waiting frames was recorded").toBeDefined();
    // A full cooldown on the very first frame after a drop, never zero: a countdown that read zero
    // for the frame after the ship it just sent would tell a player another is imminent for the
    // whole of the twenty seconds they are actually waiting.
    expect(between[0], "the countdown did not reset to a full cooldown after a drop")
      .toBeCloseTo(RELIEF_COOLDOWN, 6);

    const due = between.findIndex((s) => s === 0);
    expect(due, "the countdown never reached the end of the wait").toBeGreaterThan(0);
    for (let i = 1; i < due; i++) {
      expect(between[i], `the countdown did not fall between frames ${i - 1} and ${i}`)
        .toBeLessThan(between[i - 1]!);
    }
    // The tail is the honest part: once the cooldown has elapsed the panel says so and holds at
    // zero until the galaxy's throttled scan gets to it. That window must be one scan, not a
    // second silent wait — a panel that read zero for another twenty seconds would be the original
    // complaint with extra steps.
    for (let i = due; i < between.length; i++) {
      expect(between[i], `the countdown climbed again at frame ${i}`).toBe(0);
    }
    expect(between.length - due, "the panel called relief due for longer than one galaxy scan")
      .toBeLessThanOrEqual(Math.round(1 / STEP_SECONDS) + 1);
  });

  it("separates 'waiting on the cooldown' from 'nothing is coming'", () => {
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    // Nothing held and no relief yet sent: the next scan will dispatch one.
    expect(model(g).status).toBe("due");

    const arrived = stepUntilRelief(g);
    expect(arrived, "the wipeout was never answered").not.toBeNull();
    expect(activeState(g).over, "a wipeout ended the run — the Odyssey is supposed to be endless").toBe(false);

    // The ship IS the foothold, so the panel goes quiet again while the cooldown keeps running.
    const held = model(g);
    expect(held.status).toBe("held");
    expect(held.onCooldown, "the cooldown is not running after a drop").toBe(true);
    expect(held.lastReliefTime).toBe(arrived);
    expect(held.eligibleAt).toBeCloseTo(arrived! + RELIEF_COOLDOWN, 6);

    // Lose it immediately, which is the case that reads as broken: now the panel is the only thing
    // standing between a player and the conclusion that the game has stopped answering.
    for (const id of reliefShips(g)) activeState(g).units.delete(id);
    const waiting = model(g);
    expect(waiting.status).toBe("waiting");
    expect(waiting.hasFoothold).toBe(false);
    expect(waiting.secondsUntilEligible, "the panel is not saying how long the wait is")
      .toBeGreaterThan(RELIEF_COOLDOWN / 2);
    expect(waiting.onCooldown).toBe(true);
  });

  it("measures the cooldown on the galaxy clock, never on the world under the player", () => {
    // The engine keys this on `galaxy.time` deliberately: a jump swaps the active world and each
    // world's clock runs on its own, so a panel reading `activeState(galaxy).time` would agree for
    // the whole of a first world and lie from the first jump. The seat's clock is set to a red
    // herring here exactly as the engine's own regression test does it.
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    stepUntilRelief(g);
    for (const id of reliefShips(g)) activeState(g).units.delete(id);

    const before = model(g);
    activeState(g).time = 100000;
    const after = model(g);

    expect(after.galaxyTime, "the panel is reporting a world's clock as the galaxy's").toBe(g.time);
    expect(after.galaxyTime, "the seat's clock leaked into the panel").not.toBe(activeState(g).time);
    expect(after.secondsUntilEligible, "the countdown moved when a world's local clock moved")
      .toBe(before.secondsUntilEligible);
    expect(after.status).toBe("waiting");

    // And the engine agrees: no premature relief, however ancient the seat's own clock reads.
    for (let i = 0; i < 20; i++) stepGalaxy(g, STEP_SECONDS);
    expect(reliefShips(g), "relief was farmed off a world's local clock").toEqual([]);
  });
});

/* =================================================================================================
   WHAT COUNTS AS STILL HOLDING SOMETHING
   ================================================================================================= */

describe("the panel counts footholds the way the rescue scan counts them (P5-T07)", () => {
  it("counts a Command Center that is still going up, and the engine sends nothing", () => {
    // `checkGalaxyRescue` does NOT filter on `constructing`, while `checkGalaxyProgress` does. A
    // panel that copied the milestone rule would promise a relief ship that never comes.
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    const cc = base(activeState(g), true);

    const m = model(g);
    expect(m.hasFoothold, "a half-built base was not counted as a foothold").toBe(true);
    expect(m.status).toBe("held");
    expect(m.footholds[0]!.commandCenters).toBe(1);
    expect(m.footholds[0]!.underConstruction, "the panel does not say the base is still going up").toBe(1);

    for (let i = 0; i < Math.round((RELIEF_COOLDOWN + 2) / STEP_SECONDS); i++) stepGalaxy(g, STEP_SECONDS);
    expect(reliefShips(g), "relief arrived while a base was under construction").toEqual([]);

    // Anti-vacuity: raze it and the same galaxy is rescued at once, so the silence above is the
    // foothold rather than a cooldown or a scan that never runs.
    activeState(g).buildings.delete(cc.id);
    expect(model(g).status).toBe("due");
    expect(stepUntilRelief(g), "the same galaxy with no base was not rescued").not.toBeNull();
  });

  it("looks across the whole galaxy, not just the world under the player", () => {
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    const away = g.planets.get(ELSEWHERE)!;
    const ship = makeUnit("colonyship", "player", away.map.bases.player.x, away.map.bases.player.y);
    away.units.set(ship.id, ship);

    const m = model(g);
    expect(m.footholds.map((f) => f.planetId), "a colony ship on another world was not seen")
      .toEqual([ELSEWHERE]);
    expect(m.status).toBe("held");
    expect(hasColonyShip(away, "player"), "the fixture never placed a ship").toBe(true);

    for (let i = 0; i < Math.round((RELIEF_COOLDOWN + 2) / STEP_SECONDS); i++) stepGalaxy(g, STEP_SECONDS);
    expect(reliefShips(g), "relief arrived while a ship stood on another world").toEqual([]);

    // …and the pair: remove it and the rescue fires, so "no relief" above was the foothold.
    away.units.delete(ship.id);
    expect(model(g).hasFoothold).toBe(false);
    expect(stepUntilRelief(g), "the galaxy with nothing left anywhere was not rescued").not.toBeNull();
  });

  it("reports the arrival flag as the latch it is, not as an event", () => {
    // `galaxy.reliefNote` is upstream's one-shot toast flag and upstream's `boot.js` drains it.
    // Nothing in this client does, and a panel model may not write a galaxy field — so a HUD that
    // treated this as "a ship just arrived" would show that toast for the rest of the run.
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    expect(model(g).reliefFlag, "the flag is already raised before any relief").toBe(false);

    const at = stepUntilRelief(g)!;
    expect(model(g).reliefFlag).toBe(true);

    for (let i = 0; i < 40; i++) stepGalaxy(g, STEP_SECONDS);
    expect(model(g).reliefFlag, "the flag cleared itself — something in this client drains it now")
      .toBe(true);
    // Which is why `lastReliefTime` is the edge a toast should key on: it is a moment, not a latch.
    expect(model(g).lastReliefTime).toBe(at);
  });
});

/* =================================================================================================
   THE ONE IRREVERSIBLE BUTTON
   ================================================================================================= */

describe("surrender is offered once and refused silently afterwards (P5-T07)", () => {
  it("carries a third value meaning never, because the engine's refusal is invisible", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    const live = model(g).surrender;
    expect(live.state).toBe("available");
    expect(live.canSurrender).toBe(true);
    expect(live.seatId, "the panel does not say which seat the ending is recorded on").toBe(g.activeId);

    surrenderGalaxy(g);

    const done = model(g).surrender;
    expect(done.state, "an ended run still offers the button").toBe("surrendered");
    expect(done.canSurrender).toBe(false);
    expect(model(g).status, "a surrendered run is still waiting for relief").toBe("ended");

    // The second click. `surrenderGalaxy` returns nothing whether it worked or not, so this is the
    // exact case a bare boolean could not describe — and the panel's answer must not change.
    surrenderGalaxy(g);
    expect(model(g).surrender.state).toBe("surrendered");
    expect(activeState(g).over).toBe(true);
  });

  it("distinguishes a run that ended some other way from one the player ended", () => {
    // Unreachable in a real galaxy — which is the point: if it ever appears, it is a defect and the
    // panel should say so rather than blame the player for a surrender they did not make.
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    activeState(g).over = true;
    const m = model(g);
    expect(m.surrender.state).toBe("ended");
    expect(m.surrender.canSurrender).toBe(false);
    expect(m.status).toBe("ended");
  });

  it("says relief is coming at the exact moment surrender looks obligatory", () => {
    const g = createGalaxy({ seed: SEED, startId: SEAT });
    expect(model(g).surrender.reliefWouldFollow, "a player holding a ship was told relief is coming")
      .toBe(false);

    wipe(g);
    const m = model(g);
    expect(m.surrender.reliefWouldFollow, "a wiped-out player was not told the engine will rescue them")
      .toBe(true);
    expect(m.surrender.canSurrender, "surrender is closed exactly when a player most wants it").toBe(true);

    // And it is true rather than reassuring: the ship really comes.
    expect(stepUntilRelief(g), "the promise the panel made was not kept").not.toBeNull();
    expect(model(g).surrender.reliefWouldFollow, "the offer stands after the rescue landed").toBe(false);
  });

  it("stops promising relief once the run has been surrendered", () => {
    // `checkGalaxyRescue` returns on `active.over` before it looks at anything else, so a
    // surrendered run is never rescued — and a panel that kept counting down would be describing a
    // ship that will never be built.
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    surrenderGalaxy(g);

    const m = model(g);
    expect(m.status).toBe("ended");
    expect(m.surrender.reliefWouldFollow, "an ended run still promises a rescue").toBe(false);

    for (let i = 0; i < Math.round((RELIEF_COOLDOWN + 2) / STEP_SECONDS); i++) stepGalaxy(g, STEP_SECONDS);
    expect(reliefShips(g), "a surrendered run was rescued anyway").toEqual([]);
    expect(g.lastReliefTime, "the rescue scan stamped a drop it never made").toBeUndefined();
  });
});

describe("the relief panel model itself (P5-T07)", () => {
  it("is a pure function of the galaxy it is given", () => {
    const g = wipe(createGalaxy({ seed: SEED, startId: SEAT }));
    stepUntilRelief(g);
    expect(reliefPanelModel(g)).toEqual(reliefPanelModel(g));
  });
});
