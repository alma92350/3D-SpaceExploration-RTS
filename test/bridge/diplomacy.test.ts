// P5-T04 at the bridge: the diplomacy layer under this client's own clock (ADR-0008 §3, ADR-0012 §5).
//
// **The three levers are not reachable from the game yet, and that is a fact this file states rather
// than hides.** `offerTribute` and `fulfillRequest` move `galaxy.credits`, and `offerGift` moves a
// world's stockpile — all three are simulation writes, so they belong behind an intent exactly as
// `trade` does, and `applyIntent` has no diplomacy case today. `src/ui/diplomacy-panel.ts` is
// therefore a read-only model over a live system: everything it reports is real, and nothing a
// player presses can yet reach it. That gap is one `Intent` variant wide and is recorded in the
// row's notes.
//
// What this file proves is everything underneath that seam, because all of it is load-bearing the
// moment the intent lands:
//
//   • The stance really drifts under `WorldBridge.step`. `stepGalaxy` runs `tick`, which runs
//     `updateDiplomacy` — nothing in this client had ever asserted that, and a panel over a system
//     that never advances would look perfect and say nothing.
//   • A favour arrives and lapses on the bridge's own clock **and on nothing else**. Stepping never
//     pays one and never pays a tribute, so every credit that moves here moved because something
//     called a lever.
//   • The record survives the save the bridge already owns. A tribute count that reset on load would
//     hand a player back the opening price, and a standing ask that vanished would look exactly like
//     one that had lapsed — the same indistinguishable pair the whole row is about.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  APPEASE_TIME, FAVOR_WINDOW, GOODWILL_CAP,
  fulfillRequest, offerGift, offerTribute, unitPrice,
} from "../../src/engine/index.js";
import { diplomacyPanelModel, giftPreview } from "../../src/ui/diplomacy-panel.js";

const SEED = 20260814;
/**
 * The seat, for `test/ui/diplomacy-panel.test.ts`'s reason: on this seed Ferros Prime rolls its
 * neighbour's first favour on the opening tick, so the 90-second window is walkable without first
 * simulating four minutes to the next `FAVOR_INTERVAL` bucket.
 */
const SEAT = "ferros";

const bridgeOn = (worldId = SEAT): WorldBridge => new WorldBridge({ seed: SEED, worldId });
const model = (b: WorldBridge) => diplomacyPanelModel(b.galaxy, b.worldId);

/** The neighbour's stance record, narrowed as `src/ui/diplomacy-panel.ts` narrows it. */
interface Dip {
  stance: number;
  tributes: number;
  goodwill: number;
  request: { com: string; qty: number; until: number; reward: number } | null;
}
const dipOf = (s: State): Dip => (s as unknown as { diplomacy: Dip }).diplomacy;

describe("the neighbour's stance is live under WorldBridge.step (P5-T04)", () => {
  it("drifts on the bridge's own clock, and the panel reads the bridge's own galaxy", () => {
    // Stated first because everything else here depends on it: `stepGalaxy` runs `updateDiplomacy`
    // for the seat every tick. If it did not, every reading in the panel would be frozen at
    // `createDiplomacy`'s opening values and would still look entirely plausible.
    const bridge = bridgeOn();
    const opening = model(bridge);
    expect(opening.known, "the seat has no diplomacy at all").toBe(true);
    expect(opening.planetId, "the panel is not reading the world the bridge is on").toBe(bridge.worldId);
    expect(opening.atPeace, "a fresh neighbour is already at war").toBe(true);
    expect(opening.label, "the opening stance is not the engine's Cordial band").toBe("Cordial");

    for (let i = 0; i < 100; i++) bridge.step(STEP_SECONDS);      // five sim-seconds

    const after = model(bridge);
    expect(after.stance, "the stance did not move at all — nothing is driving updateDiplomacy")
      .not.toBe(opening.stance);
    // An untouched world's target is well above its opening stance, so the drift is upward. A model
    // reading a stale copy would not follow it.
    expect(after.stance, "the stance drifted the wrong way on an untouched world")
      .toBeGreaterThan(opening.stance);
    expect(after.stance, "the panel is not reading the state the bridge stepped")
      .toBe(dipOf(bridge.state).stance);
  });

  it("rolls the neighbour's ask, and withdraws it, without anything else touching it", () => {
    // The bridge's step is the only mover in this test. Nothing in `WorldBridge.step` pays a favour
    // or a tribute — `sweepColonies` banks colony income and this galaxy's background worlds are
    // unsettled, so the treasury is flat for the whole walk. That is what makes the credit
    // assertions in the next test mean something.
    const bridge = bridgeOn();
    const state = bridge.state;
    const credits = bridge.galaxyCredits;

    bridge.step(STEP_SECONDS);
    const ask = model(bridge).favor;
    expect(ask, `${SEAT} did not roll a favour on its opening tick — this seed no longer sets up this file`)
      .not.toBeNull();
    expect(ask!.secondsLeft, "the window did not open at its full length")
      .toBeCloseTo(FAVOR_WINDOW - STEP_SECONDS, 9);

    let ticks = 0;
    while (model(bridge).favor !== null && ticks < 4000) {
      bridge.step(STEP_SECONDS);
      ticks++;
    }

    expect(ticks, "the ask lapsed on some clock other than the window")
      .toBe(Math.round(FAVOR_WINDOW / STEP_SECONDS) + 1);
    expect(state.time, "the seat's clock did not reach the deadline").toBeGreaterThanOrEqual(ask!.expiresAt);
    expect(bridge.galaxyCredits, "stepping the bridge moved credits on its own — something paid a lever")
      .toBe(credits);
    expect(dipOf(state).tributes, "stepping the bridge paid a tribute").toBe(0);
    expect(dipOf(state).goodwill, "stepping the bridge earned goodwill nobody gifted").toBe(0);
  });
});

describe("the levers move the bridge's own galaxy (P5-T04)", () => {
  it("spends and earns the credits the panel showed, on the galaxy the bridge owns", () => {
    // The path the intent will take, exercised through `WorldBridge`'s own accessors rather than
    // through a galaxy built beside it. `bridge.galaxyCredits` is what the HUD reads, so it is what
    // has to move.
    const bridge = bridgeOn();
    bridge.step(STEP_SECONDS);

    const before = model(bridge);
    expect(before.canAffordTribute, "the opening treasury cannot cover the first tribute").toBe(true);

    const opening = bridge.galaxyCredits;
    expect(offerTribute(bridge.galaxy, bridge.state), "the engine refused an affordable tribute").toBe(true);
    expect(opening - bridge.galaxyCredits, "the treasury paid something other than the price shown")
      .toBe(before.tributeCost);

    const paid = model(bridge);
    expect(paid.tributes).toBe(1);
    expect(paid.underTruce).toBe(true);
    expect(paid.truceEndsIn, "the truce did not open at APPEASE_TIME").toBeCloseTo(APPEASE_TIME, 6);
    expect(paid.tributeCost, "the next tribute is still the opening price").toBeGreaterThan(before.tributeCost);

    // And the favour pays back into the same treasury.
    const ask = paid.favor!;
    bridge.state.players.player.resources[ask.com] = ask.qty;
    expect(model(bridge).favor!.canFulfill, "the panel refuses an ask the world can cover").toBe(true);

    const funded = bridge.galaxyCredits;
    expect(fulfillRequest(bridge.galaxy, bridge.state)).toBe(true);
    expect(bridge.galaxyCredits - funded, "the reward the panel promised is not what was paid")
      .toBe(ask.reward);
    expect(ask.reward, "the ask paid nothing, so this proves nothing").toBeGreaterThan(0);
    expect(model(bridge).favor, "the ask is still standing after being paid").toBeNull();
  });

  it("gifts out of the seat's own stockpile, at the price the preview quoted", () => {
    const bridge = bridgeOn();
    const state = bridge.state;
    state.players.player.resources.ore = 800;

    const preview = giftPreview(state, "ore", 800);
    expect(preview.value, "the preview did not price the gift at the engine's flat sell rate")
      .toBe(800 * unitPrice(state.market, "ore", "sell"));
    expect(preview.wouldHappen).toBe(true);

    const credits = bridge.galaxyCredits;
    expect(offerGift(state, "ore", 800)).toBe(true);
    expect(state.players.player.resources.ore, "the gift did not leave the stockpile").toBe(0);
    expect(bridge.galaxyCredits, "a gift paid credits — it is a gift, not a sale").toBe(credits);

    const m = model(bridge);
    expect(m.goodwill, "the gift bought no goodwill").toBeGreaterThan(0);
    expect(m.goodwill, "the pool ran past its ceiling").toBeLessThanOrEqual(GOODWILL_CAP);
  });
});

describe("the record survives the save the bridge already owns (P5-T04)", () => {
  it("round-trips the tribute count, the truce, the goodwill and the standing ask", () => {
    // Every one of these is a number a player would notice going missing: the tribute price would
    // fall back to the opening one, a paid truce would end early, and a standing ask would look
    // exactly like one that had lapsed — which is the pair this whole row exists to separate.
    const bridge = bridgeOn();
    bridge.step(STEP_SECONDS);
    bridge.state.players.player.resources.ore = 500;
    expect(offerTribute(bridge.galaxy, bridge.state)).toBe(true);
    expect(offerGift(bridge.state, "ore", 500)).toBe(true);

    const before = model(bridge);
    // Anti-vacuity: a round-trip of the DEFAULTS would pass every assertion below. Each of these is
    // off its opening value, so a save that dropped the block entirely goes red.
    expect(before.tributes, "the scene never paid a tribute").toBe(1);
    expect(before.goodwill, "the scene never gifted anything").toBeGreaterThan(0);
    expect(before.underTruce, "the scene has no truce running").toBe(true);
    expect(before.favor, "the scene has no standing ask to lose").not.toBeNull();

    const restored = bridgeOn("helix");                  // a different seat, to be sure the load moves it
    expect(restored.worldId).not.toBe(SEAT);
    expect(restored.load(bridge.save()), "the bridge refused its own save").toBe(true);
    expect(restored.worldId, "the load did not restore the seat").toBe(SEAT);

    const after = model(restored);
    expect(after, "the neighbour's whole record did not survive the save").toEqual(before);

    // …and it is not merely equal to a fresh galaxy's record: a save that reset the block would
    // still have to differ from this.
    const fresh = model(bridgeOn());
    expect(after.tributes, "the restored world has the opening tribute count").not.toBe(fresh.tributes);
    expect(after.tributeCost, "the restored world has the opening tribute price").not.toBe(fresh.tributeCost);
    expect(after.goodwill).not.toBe(fresh.goodwill);
  });
});
