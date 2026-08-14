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
import { marketPanelModel } from "../../src/ui/market-panel.js";
import { TRADE_LOT, quoteSell, tradeables, unitPrice } from "../../src/engine/index.js";
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
