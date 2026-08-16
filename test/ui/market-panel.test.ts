// P2-T10 — the market panel's model (ADR-0012 §4, §5).
//
// One rule dominates this file: **no price is computed here.** Every number comes from
// `unitPrice` or `quoteSell`, and a trade goes through the engine's `buy`/`sell` and reports what
// the engine returned.
//
// The reason is specific rather than dogmatic. `sell` walks a big order in `TRADE_LOT` chunks and
// applies slippage between them, so the marginal price falls as the order fills. A panel that
// multiplied a single quoted price by the quantity would show a number the trade will not pay —
// and would be wrong by more the larger the order, which is exactly when a player is paying
// attention. Upstream already solved this: `quoteSell` dry-runs the same lot walk.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { BULK_LOTS, marketPanelModel } from "../../src/ui/market-panel.js";
import { PRESSURE_CEIL, TRADE_LOT, quoteSell, tradeables, unitPrice } from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;

function world(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  bridge.step(STEP_SECONDS);
  return bridge;
}

describe("the market panel", () => {
  it("lists exactly what the engine says is tradeable here", () => {
    const bridge = world();
    const model = marketPanelModel(bridge.state, bridge.snapshot, bridge.galaxyCredits);
    expect(model.rows.map((r) => r.com)).toEqual(tradeables(bridge.state));
  });

  it("takes every price from the engine, never from its own arithmetic", () => {
    const bridge = world();
    const state = bridge.state;
    state.players.player.resources.ore = 400;

    const model = marketPanelModel(state, bridge.snapshot, bridge.galaxyCredits);
    const ore = model.rows.find((r) => r.com === "ore")!;

    expect(ore.sellUnit).toBe(unitPrice(state.market, "ore", "sell"));
    expect(ore.buyUnit).toBe(unitPrice(state.market, "ore", "buy", state));
    // The lot proceeds are `quoteSell`'s dry run of the real lot walk, not sellUnit × TRADE_LOT.
    expect(ore.sellLotProceeds).toBe(quoteSell(state.market, "ore", TRADE_LOT));
  });

  it("shows the marginal price falling across a large order, because it does", () => {
    // The failure this guards: a panel that multiplies one price by the quantity. Upstream walks
    // the order in lots and slips the price between them, so a four-lot sale earns strictly LESS
    // than four times a one-lot sale. A player deciding whether to dump stock needs the real number.
    const bridge = world();
    const state = bridge.state;
    state.players.player.resources.ore = 1000;

    const model = marketPanelModel(state, bridge.snapshot, bridge.galaxyCredits);
    const ore = model.rows.find((r) => r.com === "ore")!;
    expect(ore.sellAllProceeds).toBe(quoteSell(state.market, "ore", ore.held));
    expect(ore.sellAllProceeds).toBeLessThan(ore.sellUnit * ore.held);
  });

  it("says how far the price has been pushed from equilibrium, in the engine's own bounds", () => {
    const bridge = world();
    const model = marketPanelModel(bridge.state, bridge.snapshot, bridge.galaxyCredits);
    // Pressure swings prices within 40%..160% of equilibrium and a saturated market pays 15%.
    // Those bounds are the engine's; the panel reports position within them rather than inventing
    // a scale, so "this is a bad time to sell" is legible without a economics lesson.
    for (const row of model.rows) {
      expect(row.pressure).toBeGreaterThanOrEqual(-1);
      expect(row.pressure).toBeLessThanOrEqual(1);
    }
  });

  it("marks a row sellable only when the player actually holds some", () => {
    const bridge = world();
    const state = bridge.state;
    state.players.player.resources.ore = 0;
    let model = marketPanelModel(state, bridge.snapshot, bridge.galaxyCredits);
    expect(model.rows.find((r) => r.com === "ore")!.canSell).toBe(false);

    state.players.player.resources.ore = TRADE_LOT;
    model = marketPanelModel(state, bridge.snapshot, bridge.galaxyCredits);
    expect(model.rows.find((r) => r.com === "ore")!.canSell).toBe(true);
  });

  it("marks a row buyable only when the credits cover a lot", () => {
    const bridge = world();
    const state = bridge.state;
    const ore = () => marketPanelModel(state, bridge.snapshot, 0).rows.find((r) => r.com === "ore")!;
    expect(ore().canBuy, "no credits, no purchase").toBe(false);

    const rich = marketPanelModel(state, bridge.snapshot, 1_000_000).rows.find((r) => r.com === "ore")!;
    expect(rich.canBuy).toBe(true);
  });

  it("is a pure function of the state it is given", () => {
    const bridge = world();
    const a = marketPanelModel(bridge.state, bridge.snapshot, 500);
    const b = marketPanelModel(bridge.state, bridge.snapshot, 500);
    expect(a).toEqual(b);
  });

  it("agrees with what a real trade actually pays", () => {
    // The end-to-end check, and the one that would catch a drift between the panel and the engine
    // that every assertion above could miss together: quote it, sell it, compare.
    const bridge = world();
    bridge.state.players.player.resources.ore = 500;
    const quoted = marketPanelModel(bridge.state, bridge.snapshot, bridge.galaxyCredits)
      .rows.find((r) => r.com === "ore")!.sellLotProceeds;

    const before = bridge.galaxyCredits;
    expect(bridge.apply({ kind: "trade", com: "ore", qty: TRADE_LOT, side: "sell" })).toBeNull();
    expect(bridge.galaxyCredits - before).toBe(quoted);
  });
});

/* =================================================================================================
   BUYING AND SELLING IN QUANTITY (PT-09)

   The panel could always trade — one LOT of 25 per click, both directions. What it could not do was
   trade a STOCKPILE, and the figure that makes that safe was already being computed and thrown
   away: `sellAllProceeds` is the engine's dry run of the whole lot walk, slippage included. So was
   `pressure`, which is the only thing on the panel that says whether a price is good.

   These drive the REAL engine, because the claim is not "the model has a field" — it is that the
   number on the button is the number the order pays.
   ================================================================================================= */

describe("trading a stockpile, not a lot at a time (PT-09)", () => {
  const firstTradeable = (bridge: WorldBridge) => tradeables(bridge.state)[0]!;

  it("quotes the whole holding at what the order will really pay, slippage and all", () => {
    const bridge = world();
    const com = firstTradeable(bridge);
    const held = TRADE_LOT * 8;
    bridge.state.players.player.resources[com] = held;
    bridge.step(STEP_SECONDS);

    const row = marketPanelModel(bridge.state, bridge.snapshot, bridge.galaxyCredits)
      .rows.find((r) => r.com === com)!;
    expect(row.sellAllQty, "the sell-all button would submit a different quantity than it quotes")
      .toBe(held);

    // The point of the whole exercise: a naive panel would print `sellUnit × held`. The real order
    // pays LESS, because `sell` slips the price down between lots — and the gap grows with size,
    // which is exactly when a player is watching.
    const naive = row.sellUnit * held;
    expect(row.sellAllProceeds, "the quote matched a multiplied unit price, which means slippage is "
      + "not being modelled and the button is promising money the trade will not pay")
      .toBeLessThan(naive);
    expect(row.sellAllProceeds).toBeCloseTo(quoteSell(bridge.state.market, com, held), 6);
  });

  it("pays what the button promised, when the order is actually submitted", () => {
    const bridge = world();
    const com = firstTradeable(bridge);
    const held = TRADE_LOT * 6;
    bridge.state.players.player.resources[com] = held;
    bridge.step(STEP_SECONDS);

    const row = marketPanelModel(bridge.state, bridge.snapshot, bridge.galaxyCredits)
      .rows.find((r) => r.com === com)!;
    const quoted = row.sellAllProceeds;
    const before = bridge.galaxyCredits;

    bridge.enqueue({ kind: "trade", com, qty: row.sellAllQty, side: "sell" });
    bridge.step(STEP_SECONDS);

    const gained = bridge.galaxyCredits - before;
    expect(gained, `the panel quoted ${quoted.toFixed(1)} cr and the engine paid ${gained.toFixed(1)}`)
      .toBeCloseTo(quoted, 0);
    expect(Math.floor(bridge.state.players.player.resources[com] ?? 0),
      "sell all left something behind").toBe(0);
  });

  it("offers no bulk buy the credits cannot cover", () => {
    const bridge = world();
    const com = firstTradeable(bridge);
    // Credits are the GALAXY's, not the seat's, so poverty is expressed by what the panel is told
    // rather than by writing to state — which is also how the HUD calls it.
    const row = marketPanelModel(bridge.state, bridge.snapshot, 0).rows.find((r) => r.com === com)!;
    expect(row.canBuy, "a broke player was offered a buy").toBe(false);
    expect(row.buyLotsAffordable, "a broke player was offered bulk lots").toBe(0);
  });

  it("caps the bulk buy at BULK_LOTS however rich the player is", () => {
    const bridge = world();
    const com = firstTradeable(bridge);
    const row = marketPanelModel(bridge.state, bridge.snapshot, 10_000_000)
      .rows.find((r) => r.com === com)!;
    // The cap bounds the BUTTON, not the order: `buy` clamps itself to what the credits cover, so
    // this is a UI choice — a row of buttons that grew with a bank balance would change length as
    // the player traded.
    expect(row.buyLotsAffordable).toBe(BULK_LOTS);
  });

  it("says whether a price is good, in words rather than as a signed fraction", () => {
    const bridge = world();
    const com = firstTradeable(bridge);

    // Driven through the engine's own pressure field at both extremes and the middle, so the words
    // are pinned to the band rather than to a number this test invented.
    bridge.state.market.pressure[com] = PRESSURE_CEIL;
    let row = marketPanelModel(bridge.state, bridge.snapshot, 0).rows.find((r) => r.com === com)!;
    expect(row.pressure).toBeCloseTo(1, 6);
    expect(row.pressureText).toContain("sell");

    bridge.state.market.pressure[com] = -PRESSURE_CEIL;
    row = marketPanelModel(bridge.state, bridge.snapshot, 0).rows.find((r) => r.com === com)!;
    expect(row.pressure).toBeCloseTo(-1, 6);
    expect(row.pressureText).toContain("buy");

    bridge.state.market.pressure[com] = 0;
    row = marketPanelModel(bridge.state, bridge.snapshot, 0).rows.find((r) => r.com === com)!;
    expect(row.pressureText, "a normal price read as an opportunity").toContain("normal");

    // No raw number reaches the player: -0.62 is not something anyone can act on (N-05).
    expect(row.pressureText).not.toMatch(/-?\d\.\d/);
  });
});
