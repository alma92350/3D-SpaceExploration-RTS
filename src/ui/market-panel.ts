// The market panel's model (P2-T10, ADR-0012 §4 and §5).
//
// **No price is computed in this file.** Every number comes from `unitPrice` or `quoteSell`, and a
// trade goes through the bridge's `trade` intent, which calls the engine's own `buy`/`sell`.
//
// That rule is specific rather than dogmatic. `sell` walks a large order in `TRADE_LOT` chunks and
// applies slippage between them, so the marginal price falls as the order fills. A panel that
// multiplied one quoted price by the quantity would show a number the trade will not pay, and
// would be wrong by *more* the larger the order — exactly when a player is paying attention.
// Upstream already solved this: `quoteSell` dry-runs the same lot walk against a scratch market.
//
// This module reads engine `State` rather than only the snapshot, which is a deliberate exception
// to the usual rule. Market prices are not in the snapshot and should not be: they are read when a
// panel is open, not 20 times a second, and widening the snapshot for them would put 23 more
// numbers a tick behind a panel most players have closed.

import {
  PRESSURE_CEIL, TRADE_LOT, quoteSell, tradeables, unitPrice,
} from "../engine/index.js";
import { type Snapshot } from "../bridge/snapshot.js";

export interface MarketRow {
  readonly com: string;
  /** How much the player holds here. */
  readonly held: number;
  readonly sellUnit: number;
  readonly buyUnit: number;
  /** What one lot actually pays, from the engine's dry run — not `sellUnit × TRADE_LOT`. */
  readonly sellLotProceeds: number;
  /** What selling the whole holding pays, with the slippage the real order will suffer. */
  readonly sellAllProceeds: number;
  /**
   * Where this price sits between the engine's own bounds, -1..1.
   *
   * Not a percentage the panel invented: `PRESSURE_FLOOR`/`PRESSURE_CEIL` are the engine's swing
   * limits (prices move within 40%..160% of equilibrium), so this is position within them. It is
   * what makes "this is a bad time to sell" legible without an economics lesson.
   */
  readonly pressure: number;
  readonly canSell: boolean;
  readonly canBuy: boolean;
}

export interface MarketPanelModel {
  readonly rows: readonly MarketRow[];
  readonly credits: number;
  readonly lot: number;
}

export function marketPanelModel(state: State, _snap: Snapshot, credits: number): MarketPanelModel {
  const rows: MarketRow[] = [];
  for (const com of tradeables(state)) {
    const held = Math.floor(state.players.player.resources[com] ?? 0);
    const sellUnit = unitPrice(state.market, com, "sell");
    const buyUnit = unitPrice(state.market, com, "buy", state);
    rows.push({
      com,
      held,
      sellUnit,
      buyUnit,
      sellLotProceeds: quoteSell(state.market, com, TRADE_LOT),
      sellAllProceeds: quoteSell(state.market, com, held),
      pressure: clamp((state.market.pressure[com] ?? 0) / PRESSURE_CEIL, -1, 1),
      // A lot is the trade unit; holding less than one is not "sell what you have" here, because
      // `sell` clamps to the holding and would quietly fill a smaller order than the button says.
      canSell: held > 0,
      canBuy: credits >= buyUnit * TRADE_LOT,
    });
  }
  return { rows, credits: Math.floor(credits), lot: TRADE_LOT };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
