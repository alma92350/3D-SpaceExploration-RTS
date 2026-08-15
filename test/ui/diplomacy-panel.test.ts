// P5-T04 — diplomacy: stances, tribute, gifts and favours.
//
// The row names `FAVOR_WINDOW` (90 s) as the legibility risk, and this file is built around it the
// way `test/ui/lane-panel.test.ts` is built around `LANE_PERIOD`. An ask that lapses unfulfilled is
// withdrawn silently — no event, no toast, and no fresh one until the next `FAVOR_INTERVAL` bucket
// four minutes later — so an ask nobody could see the clock on is indistinguishable from one that
// was never made. The lesson P4-T07 left behind is that asserting *a countdown exists* proves
// nothing, so the central test here walks the whole window one tick at a time and asserts the ask
// is still standing on exactly the ticks the countdown said it would be, and gone on the first one
// it did not.
//
// The three other traps this API sets, each with a test that would pass without it:
//
//   • **`tributeCost` escalates**, 1.55× per payment. A panel showing `TRIBUTE_BASE_COST` is right
//     for the first tribute and wrong for every one after, so nothing here asserts one tribute:
//     every claim is made across two, against the credits the treasury actually loses.
//   • **The bands are the engine's.** P4-T03 left the starmap's stance bar unbanded rather than
//     invent a threshold above the bridge, and `stanceLabel` is what fixes that — so the edges are
//     asserted against `stanceLabel` itself and against `PEACE_THRESHOLD`, never against numbers
//     typed into this file.
//   • **"At peace" is three different states.** `GRACE_TIME` guarantees the opening is cordial
//     whatever the ground looks like, so a mined-out world reads exactly like a friendly one until
//     minute seven. The grace test is the only slow one in the file and it earns its 9200 ticks: it
//     runs a mined-out world and an untouched one on the same clock, and only one of them is at war
//     at the end.
//
// Two shapes of vacuity are hunted throughout, both of which this repo has recently been bitten by:
// a claim that holds because the fixture made it inert (every "nothing moved" here is paired with
// the same scene where something does), and a scene that never reached the state under test (the
// favour walk asserts the ask existed before it asserts it lapsed).

import { describe, expect, it } from "vitest";
import {
  BG_STEP, FAVOR_GOODWILL, FAVOR_INTERVAL, FAVOR_WINDOW, GOODWILL_CAP, GRACE_TIME, ODYSSEY_WORLDS,
  APPEASE_TIME, PEACE_THRESHOLD, TRIBUTE_BASE_COST,
  atPeace, createGalaxy, fulfillRequest, hostility, offerGift, offerTribute, quoteSell,
  stanceLabel, stepGalaxy, tick, tributeCost, unitPrice,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { diplomacyPanelModel, giftPreview } from "../../src/ui/diplomacy-panel.js";

const SEED = 20260814;

/**
 * The seat, and it is chosen rather than inherited.
 *
 * `updateDiplomacy` rolls for a favour on a `FAVOR_INTERVAL` bucket boundary and only 60% of rolls
 * produce one, off a hash of the world's own seed. On this galaxy seed Ferros Prime rolls one on its
 * opening tick, so the 90-second window can be walked in full without first simulating the four
 * minutes to the next bucket. Nothing else in this file depends on which world it is.
 */
const SEAT = "ferros";

const galaxy = (): Galaxy => createGalaxy({ seed: SEED, startId: SEAT });
const model = (g: Galaxy, id: string = SEAT) => diplomacyPanelModel(g, id);
const seat = (g: Galaxy): State => g.planets.get(SEAT)!;

/**
 * The neighbour's stance record, as the panel reads it.
 *
 * Narrowed here rather than declared on `State` for `src/ui/diplomacy-panel.ts`'s own reason, and
 * with the same treatment `test/bridge/galaxy-save.test.ts` gives `state.background`. Tests write
 * `stance` directly in one place — the band-edge test — because the alternative is forty minutes of
 * drift to reach a number that is one assignment away, and the levers that a *player* moves are all
 * driven through the engine's own functions below.
 */
interface Dip {
  stance: number;
  depletion: number;
  tributes: number;
  goodwill: number;
  provokedAt: number | null;
  appeaseUntil?: number;
  pacified?: boolean;
  request: { com: string; qty: number; until: number; reward: number } | null;
}
const dipOf = (s: State): Dip => (s as unknown as { diplomacy: Dip }).diplomacy;

/** Step the seat's whole galaxy one fixed tick, exactly as the app's loop does. */
const step = (g: Galaxy): void => stepGalaxy(g, STEP_SECONDS);

/**
 * Advance ONE world by the step the engine's own background scheduler uses.
 *
 * Only the two walks past the grace boundary use this, and only because of what they cost: seven
 * sim-minutes at the app's 20 Hz is 8400 ticks of an entire galaxy for a claim about one world's
 * stance. `tick` is what `stepGalaxy` calls for a world, and `BG_STEP × STEP_SECONDS` is exactly
 * the step it advances a background colony by — so this is a step the simulation already takes on
 * its own, not a coarser one invented here to go faster. That `WorldBridge.step` really reaches
 * `updateDiplomacy` at the app's own rate is a separate claim, pinned in
 * `test/bridge/diplomacy.test.ts`.
 */
const drift = (s: State): void => tick(s, BG_STEP * STEP_SECONDS);

/** A galaxy whose seat has already rolled its opening favour, checked rather than assumed. */
function withFavor(): { g: Galaxy; s: State } {
  const g = galaxy();
  const s = seat(g);
  step(g);
  expect(
    dipOf(s).request,
    `${SEAT} did not roll a favour on its opening tick — this seed no longer sets up this file`,
  ).toBeTruthy();
  return { g, s };
}

/* =================================================================================================
   THE STANCE, IN THE ENGINE'S OWN BANDS
   ================================================================================================= */

describe("the stance is banded by the engine, never by the panel (P5-T04)", () => {
  it("finds every band's edge by asking stanceLabel, and lands the war edge on PEACE_THRESHOLD", () => {
    // THE anti-invention assertion. `stanceLabel`'s edges are private to `engine/diplomacy.js`, and
    // the whole reason P4-T03 drew the starmap's stance bar with no bands is that copying them up
    // here would be a second answer to a question the simulation answers. So the bands are derived
    // from `stanceLabel` and checked against `stanceLabel` — plus the one edge that IS exported,
    // which is what proves the derivation is finding real boundaries rather than plausible ones.
    const bands = model(galaxy()).bands;

    expect(bands.map((b) => b.label), "the panel's bands are not the engine's five words")
      .toEqual(["Hostile", "Wary", "Neutral", "Cordial", "Allied"]);
    expect(bands[0]!.from, "the bands do not start at fully hostile").toBe(-1);
    expect(bands[bands.length - 1]!.to, "the bands do not reach fully allied").toBe(1);

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!;
      expect(band.to, `band ${band.label} is empty or inverted`).toBeGreaterThan(band.from);
      // Inside the band the engine agrees with the label; a hair past its upper edge it does not.
      // The last band is exempt from the second half: its `to` is the end of the stance range, not
      // an edge `stanceLabel` stops at — everything above +1 is still Allied.
      expect(stanceLabel((band.from + band.to) / 2), `the engine disagrees inside ${band.label}`)
        .toBe(band.label);
      if (i < bands.length - 1) {
        expect(stanceLabel(band.to + 1e-6), `${band.label} runs past the edge the panel drew`)
          .not.toBe(band.label);
        expect(stanceLabel(band.to), `the edge itself belongs to ${band.label}, so it is not an edge`)
          .toBe(bands[i + 1]!.label);
      }
      if (i > 0) {
        expect(band.from, "the bands leave a gap between them").toBe(bands[i - 1]!.to);
      }
    }

    // The one edge the engine exports. `stanceLabel` returns "Wary" AT the threshold and "Neutral"
    // above it, so the Wary band's exclusive upper edge is PEACE_THRESHOLD itself.
    const wary = bands.find((b) => b.label === "Wary")!;
    expect(wary.to, "the war edge is not where PEACE_THRESHOLD is").toBeCloseTo(PEACE_THRESHOLD, 8);
  });

  it("puts peace on the engine's side of the war line, not one step either way", () => {
    // `atPeace` is `stance > PEACE_THRESHOLD` — strictly. A panel using `>=` would call the exact
    // threshold peace, and the AI would be mustering while it said so.
    const g = galaxy();
    const dip = dipOf(seat(g));

    dip.stance = PEACE_THRESHOLD;
    let m = model(g);
    expect(m.atPeace, "the panel calls the threshold itself peace").toBe(false);
    expect(m.atPeace, "the panel disagrees with the engine").toBe(atPeace(seat(g)));
    expect(m.label).toBe("Wary");
    expect(m.marginToWar).toBeCloseTo(0, 12);
    expect(m.peaceRestsOn).toBe("war");
    // Exactly at the line the ramp is still zero: this is war beginning, not war raging.
    expect(m.hostility).toBe(0);

    dip.stance = PEACE_THRESHOLD + 1e-9;
    m = model(g);
    expect(m.atPeace, "a stance a hair above the line is not peace").toBe(true);
    expect(m.label).toBe("Neutral");
  });

  it("reports the engine's hostility ramp rather than re-deriving one", () => {
    const g = galaxy();
    const s = seat(g);
    const dip = dipOf(s);

    expect(model(g).hostility, "a peaceful neighbour is already mustering").toBe(0);

    dip.stance = -0.6;
    const m = model(g);
    expect(m.label).toBe("Hostile");
    expect(m.hostility, "the panel's ramp is not the engine's").toBe(hostility(s));
    // Anti-vacuity: `hostility` returning 0 for everything would satisfy the line above.
    expect(m.hostility, "the ramp did not climb at all on a hostile stance").toBeGreaterThan(0.4);
    expect(m.marginToWar, "a hostile stance is not past the war line").toBeLessThan(0);
  });
});

/* =================================================================================================
   THE FAVOUR, AND ITS 90 SECONDS
   ================================================================================================= */

describe("a favour's window is visible while it runs out (P5-T04)", () => {
  it("counts down to the tick the ask is withdrawn on, and to no other", () => {
    // The central test of this file. `updateDiplomacy` withdraws an unfulfilled request the first
    // tick at which `state.time >= request.until`, in silence. So the countdown is asserted against
    // the withdrawal itself, tick by tick, for the whole 90-second window: the ask must survive
    // exactly the ticks the panel showed time left on, and no others.
    const { g, s } = withFavor();
    const deadline = dipOf(s).request!.until;

    let ticks = 0;
    let withdrawnAt: number | null = null;
    let last = model(g).favor!.secondsLeft;
    expect(last, "the window did not open at its full length").toBeCloseTo(FAVOR_WINDOW - STEP_SECONDS, 9);

    while (withdrawnAt === null && ticks < 4000) {
      const shown = model(g).favor?.secondsLeft ?? null;
      step(g);
      ticks++;
      const standing = dipOf(s).request !== null;
      expect(
        standing,
        `tick ${ticks} (t=${s.time.toFixed(2)}): the ask was ${standing ? "still standing" : "withdrawn"} ` +
        `while the panel showed ${shown}s left`,
      ).toBe(shown !== null && shown > 0);
      if (!standing) withdrawnAt = s.time;
      else {
        // …and the clock is sim time, not a timer this panel started: every tick takes exactly one
        // step off it, down to the floor it rests on for the one tick before the sweep.
        const now = model(g).favor!.secondsLeft;
        expect(now, `the countdown did not fall by one step on tick ${ticks}`)
          .toBeCloseTo(Math.max(0, last - STEP_SECONDS), 9);
        last = now;
      }
    }

    expect(withdrawnAt, "the ask was never withdrawn — the walk never reached the deadline").not.toBeNull();
    expect(ticks, "the window lapsed in far fewer ticks than FAVOR_WINDOW covers")
      .toBe(Math.round(FAVOR_WINDOW / STEP_SECONDS) + 1);
    expect(withdrawnAt!, "the ask outlived its own deadline").toBeGreaterThanOrEqual(deadline);
    expect(model(g).favor, "the panel still shows an ask the engine has withdrawn").toBeNull();
  });

  it("stops offering a fulfil the moment the clock reads zero, a tick before the sweep", () => {
    // The gap nobody would think to look for: `updateDiplomacy` tests the deadline at the TOP of a
    // tick, so an ask whose window has just closed is still on the state until the next tick runs.
    // `fulfillRequest` refuses in that gap. A panel that offered the button because the object was
    // still there would hand a player a payment that silently does nothing.
    const { g, s } = withFavor();
    const ask = dipOf(s).request!;
    s.players.player.resources[ask.com] = ask.qty + 100;      // never short — only the clock decides

    let ticks = 0;
    while (s.time < ask.until && ticks < 4000) { step(g); ticks++; }

    const m = model(g);
    expect(m.favor, "the engine withdrew the ask early — the gap this test is about is gone").not.toBeNull();
    expect(m.favor!.secondsLeft, "the countdown did not reach zero").toBe(0);
    expect(m.favor!.held, "the stock this test set is not what the panel sees")
      .toBeGreaterThanOrEqual(m.favor!.qty);
    expect(m.favor!.shortfall).toBe(0);
    expect(m.favor!.canFulfill, "the panel still offers a fulfil on a lapsed ask").toBe(false);

    const credits = g.credits;
    const stock = s.players.player.resources[ask.com];
    expect(fulfillRequest(g, s), "the engine paid out on a lapsed ask").toBe(false);
    expect(g.credits, "credits moved on a refused fulfil").toBe(credits);
    expect(s.players.player.resources[ask.com], "stock moved on a refused fulfil").toBe(stock);

    step(g);
    expect(model(g).favor, "the next tick did not withdraw the lapsed ask").toBeNull();
  });

  it("reports the ask the engine made, and pays what it said it would", () => {
    const { g, s } = withFavor();
    const ask = dipOf(s).request!;

    // One short of the quantity: `fulfillRequest` is all-or-nothing, so the panel must not offer it.
    s.players.player.resources[ask.com] = ask.qty - 1;
    let m = model(g);
    expect(m.favor!.com).toBe(ask.com);
    expect(m.favor!.qty).toBe(ask.qty);
    expect(m.favor!.reward, "the panel promised a reward the engine did not offer").toBe(ask.reward);
    expect(m.favor!.goodwill).toBe(FAVOR_GOODWILL);
    expect(m.favor!.held).toBe(ask.qty - 1);
    expect(m.favor!.shortfall, "one short is not reported as one short").toBe(1);
    expect(m.favor!.canFulfill, "the panel offered a fulfil the engine will refuse").toBe(false);

    const before = { credits: g.credits, goodwill: dipOf(s).goodwill };
    expect(fulfillRequest(g, s), "the engine took a part payment").toBe(false);
    expect(g.credits, "a refused fulfil paid out anyway").toBe(before.credits);

    // A fraction of a unit is not a unit. `fulfillRequest` floors the stockpile before comparing, so
    // a panel comparing the raw float would offer a fulfil the engine refuses on a holding of 74.5.
    s.players.player.resources[ask.com] = ask.qty - 0.5;
    m = model(g);
    expect(m.favor!.held, "the panel did not floor the holding the way the engine does")
      .toBe(ask.qty - 1);
    expect(m.favor!.canFulfill, "half a unit short still offers a fulfil").toBe(false);
    expect(fulfillRequest(g, s), "the engine took a fractional part payment").toBe(false);

    // The same ask, covered. Everything the panel promised is what the engine then moves.
    s.players.player.resources[ask.com] = ask.qty + 5;
    m = model(g);
    expect(m.favor!.shortfall).toBe(0);
    expect(m.favor!.canFulfill, "a covered ask is still refused by the panel").toBe(true);

    expect(fulfillRequest(g, s)).toBe(true);
    expect(g.credits - before.credits, "the treasury did not gain what the panel promised")
      .toBe(m.favor!.reward);
    expect(m.favor!.reward, "the ask paid nothing, so this proves nothing").toBeGreaterThan(0);
    expect(dipOf(s).goodwill - before.goodwill, "the goodwill bump is not FAVOR_GOODWILL")
      .toBeCloseTo(FAVOR_GOODWILL, 12);
    expect(s.players.player.resources[ask.com], "the engine took something other than the exact quantity")
      .toBe(5);
    expect(model(g).favor, "the ask is still standing after being paid").toBeNull();
  });

  it("states the window and the cadence the engine works on", () => {
    const { g } = withFavor();
    const m = model(g);
    expect(m.favorWindow, "FAVOR_WINDOW does not reach the player").toBe(FAVOR_WINDOW);
    expect(m.favorInterval, "FAVOR_INTERVAL does not reach the player").toBe(FAVOR_INTERVAL);
    expect(m.favorGoodwill, "FAVOR_GOODWILL does not reach the player").toBe(FAVOR_GOODWILL);
    expect(m.favor!.fraction, "the bar is not the countdown over the window")
      .toBeCloseTo(m.favor!.secondsLeft / FAVOR_WINDOW, 12);
    expect(m.favor!.expiresAt, "the deadline is not the engine's own")
      .toBe(dipOf(seat(g)).request!.until);
  });

  it("shows no ask, and no clock, when the neighbour is not asking for anything", () => {
    // The state every other assertion here is measured against. A model that always produced a
    // favour would pass most of this file.
    const g = galaxy();
    const m = model(g);
    expect(m.favor, "an ask exists before the first tick has run").toBeNull();
    expect(m.favorWindow, "the window is only reported when there is an ask").toBe(FAVOR_WINDOW);
  });
});

/* =================================================================================================
   TRIBUTE, AND WHY THE BASE COST IS NOT THE PRICE
   ================================================================================================= */

describe("tribute escalates, so the constant is never the price (P5-T04)", () => {
  it("charges the engine's escalating price across two payments, not TRIBUTE_BASE_COST twice", () => {
    const g = galaxy();
    const s = seat(g);
    g.credits = 5000;                                  // enough for both, so only the price is in play

    const first = model(g);
    expect(first.tributes).toBe(0);
    expect(first.tributeCost, "the first tribute is not the base cost").toBe(TRIBUTE_BASE_COST);
    expect(first.tributeBaseCost, "TRIBUTE_BASE_COST does not reach the player").toBe(TRIBUTE_BASE_COST);
    expect(first.tributeEscalation).toBe(1);
    expect(first.canAffordTribute).toBe(true);

    let credits = g.credits;
    expect(offerTribute(g, s)).toBe(true);
    expect(credits - g.credits, "the treasury paid something other than the price shown")
      .toBe(first.tributeCost);

    const second = model(g);
    expect(second.tributes).toBe(1);
    expect(second.tributeCost, "the second tribute still costs the base constant")
      .not.toBe(TRIBUTE_BASE_COST);
    expect(second.tributeCost, "the price did not escalate").toBeGreaterThan(first.tributeCost);
    expect(second.tributeCost, "the price is not the engine's own").toBe(tributeCost(dipOf(s)));
    expect(second.tributeBaseCost, "the base cost stopped being reported once one was paid")
      .toBe(TRIBUTE_BASE_COST);
    expect(second.tributeEscalation).toBeCloseTo(second.tributeCost / TRIBUTE_BASE_COST, 12);

    credits = g.credits;
    expect(offerTribute(g, s)).toBe(true);
    expect(credits - g.credits, "the second payment was not the escalated price the panel showed")
      .toBe(second.tributeCost);
    expect(model(g).tributeCost, "the price stopped escalating after two")
      .toBeGreaterThan(second.tributeCost);
  });

  it("says the opening treasury buys one tribute and not two", () => {
    // The escalation made concrete: a galaxy starts with 500 credits, the first tribute costs 200
    // and the second costs more than the 300 left. A panel showing the base cost would have offered
    // a button that does nothing.
    const g = galaxy();
    const s = seat(g);
    const opening = g.credits;

    expect(model(g).canAffordTribute, "the opening treasury cannot afford the first tribute").toBe(true);
    expect(offerTribute(g, s)).toBe(true);

    const m = model(g);
    expect(m.credits, "the panel's treasury is not the galaxy's").toBe(g.credits);
    expect(m.credits, "the first tribute was free").toBeLessThan(opening);
    expect(m.tributeCost, "the second tribute is affordable — the escalation is not biting")
      .toBeGreaterThan(m.credits);
    expect(m.canAffordTribute, "the panel offers a tribute the treasury cannot cover").toBe(false);

    const credits = g.credits;
    expect(offerTribute(g, s), "the engine took a tribute it could not be paid for").toBe(false);
    expect(g.credits, "a refused tribute moved credits").toBe(credits);

    // …and exactly enough is enough. `offerTribute` refuses on `credits < cost`, so a panel using a
    // strict `>` would grey out the button at precisely the price the player just finished saving
    // for — the one moment they are watching it.
    g.credits = m.tributeCost;
    expect(model(g).canAffordTribute, "the panel refuses a tribute the treasury covers exactly").toBe(true);
    expect(offerTribute(g, s), "the engine refused a tribute the treasury covered exactly").toBe(true);
    expect(g.credits, "paying with the exact price left something behind").toBe(0);
  });

  it("buys a truce with a clock on it, and the clock is APPEASE_TIME", () => {
    const g = galaxy();
    const s = seat(g);

    expect(model(g).underTruce, "a fresh world is already under a paid truce").toBe(false);
    expect(model(g).truceEndsIn).toBe(0);

    expect(offerTribute(g, s)).toBe(true);
    let m = model(g);
    expect(m.appeaseTime, "APPEASE_TIME does not reach the player").toBe(APPEASE_TIME);
    expect(m.underTruce).toBe(true);
    expect(m.truceEndsIn, "the truce did not open at its full length").toBe(APPEASE_TIME);

    for (let i = 0; i < 200; i++) step(g);              // ten sim-seconds
    m = model(g);
    expect(m.truceEndsIn, "the truce clock is not sim time").toBeCloseTo(APPEASE_TIME - 10, 6);
    expect(m.underTruce, "ten seconds ended a two-minute truce").toBe(true);
  });
});

/* =================================================================================================
   WHY THE PEACE IS HOLDING — THE ONE THE PANEL EXISTS FOR

   `GRACE_TIME` is 420 seconds of guaranteed cordiality. A world stripped to nothing reads exactly
   like a world nobody has touched for the whole of it, which is why "at peace" on its own tells a
   player nothing about minute eight. This is the slow test in the file and it is slow on purpose:
   two galaxies, identical but for their deposits, walked side by side past the grace boundary.
   ================================================================================================= */

describe("at peace is three states, and the panel says which (P5-T04)", () => {
  it("distinguishes peace bought by the opening grace from peace the neighbour actually means", () => {
    const mined = galaxy();
    const rich = galaxy();
    // Everything gone. `dip.depletion` is recomputed from the map every tick, so this is the world
    // the scarcity target reads as fully stripped — the state that sets the stance to −1 the moment
    // nothing is holding it up.
    for (const n of seat(mined).map.nodes) n.amount = 0;

    let m = model(mined);
    expect(m.graceTime, "GRACE_TIME does not reach the player").toBe(GRACE_TIME);
    expect(m.graceEndsIn, "the opening window did not start full").toBe(GRACE_TIME);
    expect(m.inGrace).toBe(true);

    // Seven minutes on both worlds, in lockstep.
    while (seat(mined).time < GRACE_TIME - 1) { drift(seat(mined)); drift(seat(rich)); }

    m = model(mined);
    expect(m.depletion, "the world under test is not actually mined out").toBe(1);
    expect(m.atPeace, "a stripped world went to war inside the opening grace").toBe(true);
    expect(m.inGrace).toBe(true);
    expect(m.graceEndsIn, "the countdown to the end of the opening is not running")
      .toBeCloseTo(GRACE_TIME - seat(mined).time, 6);
    expect(m.peaceRestsOn, "the panel calls floored peace a stance the neighbour means").toBe("grace");
    // …and it looks completely ordinary while it lasts. This is the reading a player would act on.
    expect(m.label, "the floored stance is not the engine's own band").toBe(stanceLabel(m.stance));
    expect(m.stance, "the stance is not being held up by anything").toBeGreaterThan(PEACE_THRESHOLD);

    // Past the boundary. Nothing changes but the clock.
    while (seat(mined).time < GRACE_TIME + 20) { drift(seat(mined)); drift(seat(rich)); }

    m = model(mined);
    expect(m.inGrace, "the opening window never closed").toBe(false);
    expect(m.graceEndsIn).toBe(0);
    expect(m.atPeace, "the stripped world is still at peace twenty seconds past its grace").toBe(false);
    expect(m.peaceRestsOn).toBe("war");
    expect(m.hostility, "the neighbour turned but is not mustering").toBeGreaterThan(0);
    expect(m.label).toBe("Hostile");

    // THE control, and the reason this test runs two galaxies. Same seed, same seat, same 440
    // seconds, same closed grace window — and still at peace, because the only thing that changed
    // is the ground. Without it, "war at minute eight" is equally well explained by the clock.
    const control = model(rich);
    expect(control.inGrace, "the control world is still inside its opening grace").toBe(false);
    expect(control.atPeace, "an untouched world went to war on the clock alone").toBe(true);
    expect(control.peaceRestsOn, "the untouched world's peace is not its own stance").toBe("stance");
    expect(control.depletion, "the control world was mined out too").toBeLessThan(0.75);
    expect(m.depletion, "the two worlds are equally depleted, so the control controls nothing")
      .toBeGreaterThan(control.depletion);
    expect(control.hostility).toBe(0);
  });

  it("names a paid truce as a paid truce once the opening is over", () => {
    // Continues the world above: a tribute is what buys peace back when the ground has run out and
    // grace has closed. `offerTribute` snaps the stance to the truce line, and the panel has to say
    // that the peace now standing is the one that was paid for and has 120 seconds on it.
    const g = galaxy();
    const s = seat(g);
    for (const n of s.map.nodes) n.amount = 0;
    while (s.time < GRACE_TIME + 20) drift(s);
    expect(model(g).atPeace, "the world did not reach war, so there is nothing to buy back").toBe(false);

    g.credits = 5000;
    const price = model(g).tributeCost;
    expect(offerTribute(g, s)).toBe(true);

    const m = model(g);
    expect(m.atPeace, "the tribute did not stop the war").toBe(true);
    expect(m.peaceRestsOn, "bought peace is not reported as bought").toBe("truce");
    // Not exact: `state.time` here is 460-odd seconds of accumulated 0.05 steps.
    expect(m.truceEndsIn).toBeCloseTo(APPEASE_TIME, 6);
    expect(m.inGrace, "the opening grace is somehow open again").toBe(false);
    expect(price, "the tribute was free").toBeGreaterThan(0);
  });
});

/* =================================================================================================
   GIFTS
   ================================================================================================= */

describe("a gift is priced flat, and clamped to what is held (P5-T04)", () => {
  it("values a gift the way offerGift values it — no slippage, because it is not a sale", () => {
    // `market-panel.ts` exists because `sell` slips the price as a large order fills. `offerGift`
    // does the opposite: it multiplies once at the flat sell price and takes nothing off. A panel
    // that reached for `quoteSell` out of habit would understate a big gift by more than half.
    const g = galaxy();
    const s = seat(g);
    s.players.player.resources.ore = 5000;

    const preview = giftPreview(s, "ore", 400);
    const flat = unitPrice(s.market, "ore", "sell");
    expect(preview.value, "the gift is not priced at the engine's flat sell rate").toBe(400 * flat);
    expect(preview.value, "the flat price and the slipped price agree here, so this proves nothing")
      .not.toBe(quoteSell(s.market, "ore", 400));
    expect(preview.amount).toBe(400);
    expect(preview.clamped).toBe(false);
    expect(preview.wouldHappen).toBe(true);

    // And the goodwill the engine actually pays follows the flat value: twice the gift is twice the
    // goodwill, which the slipped price is emphatically not (826 against 1289 for these two).
    const small = galaxy();
    const smallSeat = seat(small);
    smallSeat.players.player.resources.ore = 5000;
    expect(offerGift(smallSeat, "ore", 200)).toBe(true);
    expect(offerGift(s, "ore", 400)).toBe(true);

    expect(dipOf(s).goodwill, "goodwill is not linear in the flat value of the gift")
      .toBeCloseTo(dipOf(smallSeat).goodwill * 2, 12);
    expect(quoteSell(s.market, "ore", 400), "the slipped price is linear too, so the line above is not a test")
      .not.toBe(quoteSell(s.market, "ore", 200) * 2);
    expect(dipOf(smallSeat).goodwill, "the gift bought no goodwill at all").toBeGreaterThan(0);
  });

  it("shows the clamp rather than applying it behind the player's back", () => {
    // `offerGift` hands over `min(qty, floor(held))` and only refuses at zero, so an over-ask is a
    // smaller gift rather than an error — the same shape as `MAX_WORKER_TARGET` in
    // `test/ui/colony-panel.test.ts`, and the same rule: a UI must SHOW a clamp, never silently
    // apply it.
    const g = galaxy();
    const s = seat(g);
    s.players.player.resources.ore = 50;

    const preview = giftPreview(s, "ore", 500);
    expect(preview.requested).toBe(500);
    expect(preview.amount, "the panel promised to gift stock the world does not hold").toBe(50);
    expect(preview.held).toBe(50);
    expect(preview.clamped, "the clamp is not reported").toBe(true);
    expect(preview.value, "the value is of the request rather than of what would leave")
      .toBe(50 * unitPrice(s.market, "ore", "sell"));
    expect(preview.wouldHappen).toBe(true);

    expect(offerGift(s, "ore", 500), "the engine refused a gift the panel said would happen").toBe(true);
    expect(s.players.player.resources.ore, "the engine moved something other than what was shown").toBe(0);

    // Nothing left: the engine now refuses outright, and the panel says so first.
    const empty = giftPreview(s, "ore", 500);
    expect(empty.amount).toBe(0);
    expect(empty.wouldHappen, "the panel offers a gift from an empty stockpile").toBe(false);
    expect(offerGift(s, "ore", 500), "the engine took a gift of nothing").toBe(false);
  });

  it("reports the goodwill pool against the ceiling that stops a gifting spree", () => {
    const g = galaxy();
    const s = seat(g);
    s.players.player.resources.ore = 100_000;

    expect(model(g).goodwill).toBe(0);
    expect(model(g).goodwillCap, "GOODWILL_CAP does not reach the player").toBe(GOODWILL_CAP);
    expect(model(g).atGoodwillCap).toBe(false);

    expect(offerGift(s, "ore", 1000)).toBe(true);
    const partial = model(g);
    expect(partial.goodwill, "a 1000-unit gift bought nothing").toBeGreaterThan(0);
    expect(partial.atGoodwillCap, "one gift already filled the pool — pick a smaller one").toBe(false);

    expect(offerGift(s, "ore", 20_000)).toBe(true);
    const capped = model(g);
    expect(capped.goodwill, "the pool ran past its own ceiling").toBe(GOODWILL_CAP);
    expect(capped.atGoodwillCap, "the panel does not say the ceiling has been reached").toBe(true);

    // …and the ceiling is real: another gift buys nothing, which is the whole point of showing it.
    expect(offerGift(s, "ore", 20_000)).toBe(true);
    expect(model(g).goodwill, "the pool grew past the cap on a further gift").toBe(GOODWILL_CAP);
  });
});

/* =================================================================================================
   PROVOCATION, AND A WORLD WITH NO NEIGHBOUR AT ALL
   ================================================================================================= */

describe("what the player has done, and what cannot be known (P5-T04)", () => {
  it("reports provocation once the player has drawn blood, and not before", () => {
    // `updateDiplomacy` reads the neighbour's unit-count delta rather than kill events (a substep
    // cannot double-count that way), so removing one of its ships is exactly the signal a kill
    // sends. That is the engine's own mechanism, not a shortcut around it.
    const g = galaxy();
    const s = seat(g);
    step(g);

    const before = model(g);
    expect(before.provoked, "a player who has done nothing is already a provocateur").toBe(false);

    const theirs = [...s.units.values()].filter((u) => u.owner === "ai");
    expect(theirs.length, "the neighbour has no ships, so nothing can be destroyed").toBeGreaterThan(0);
    s.units.delete(theirs[0]!.id);
    step(g);

    const after = model(g);
    expect(after.provoked, "destroying a neighbour's ship did not register as provocation").toBe(true);
    expect(after.stance, "the grievance did not sour the stance").toBeLessThan(before.stance);
    // Anti-vacuity: the stance was RISING before the kill, so the drop is the grievance rather than
    // the ordinary drift.
    expect(before.stance, "the stance was already falling on its own").toBeGreaterThan(0.35);
  });

  it("answers for a world the galaxy has never brought up, rather than throwing on it", () => {
    const g = galaxy();
    const dormant = ODYSSEY_WORLDS.find((id) => !g.planets.has(id))!;
    expect(dormant, "every roster world is instantiated in this galaxy").toBeTruthy();

    const m = model(g, dormant);
    expect(m.known, "a world that does not exist yet has a stance").toBe(false);
    expect(m.planetId).toBe(dormant);
    expect(m.stance).toBe(0);
    expect(m.atPeace).toBe(false);
    expect(m.peaceRestsOn).toBe("unknown");
    expect(m.favor).toBeNull();
    // The constants are constants and still stand — only the readings are unknown.
    expect(m.peaceThreshold).toBe(PEACE_THRESHOLD);
    expect(m.graceTime).toBe(GRACE_TIME);
    expect(m.favorWindow).toBe(FAVOR_WINDOW);
  });

  it("never forwards hostility's skirmish answer as an opinion of the player", () => {
    // `hostility` returns 1 for a state with no `state.diplomacy` — that is the SKIRMISH path,
    // where the answer means "the AI's offense ramp is ungated", not "this neighbour hates you".
    // Forwarding it would paint a world with no diplomacy as maximally hostile, which is the exact
    // reading a player would evacuate over. Only `state.diplomacy` is removed here, because that is
    // the one condition the engine's own branch tests.
    const g = galaxy();
    const s = seat(g);
    delete (s as unknown as { diplomacy?: unknown }).diplomacy;

    expect(hostility(s), "the engine no longer answers 1 without diplomacy — this test is stale").toBe(1);
    const m = model(g);
    expect(m.known).toBe(false);
    expect(m.hostility, "the panel forwarded the skirmish answer as a stance reading").toBe(0);
    expect(m.atPeace).toBe(false);
    expect(m.provoked).toBe(false);
  });
});

describe("the diplomacy model itself (P5-T04)", () => {
  it("is a pure function of the galaxy it is given", () => {
    const { g } = withFavor();
    expect(model(g)).toEqual(model(g));
  });

  it("reads the world it was asked about, not the seat", () => {
    // Every background world has its own neighbour and its own stance, and the starmap addresses
    // them by id. A model that quietly answered for `galaxy.activeId` would be right on exactly the
    // screen where nobody would notice.
    const g = galaxy();
    const other = [...g.planets.keys()].find((id) => id !== SEAT)!;
    const dip = dipOf(g.planets.get(other)!);
    dip.stance = -0.8;

    expect(model(g, other).stance, "the panel answered for the seat").toBe(-0.8);
    expect(model(g, other).label).toBe("Hostile");
    expect(model(g).stance, "the seat's own stance moved with it").not.toBe(-0.8);
  });
});
