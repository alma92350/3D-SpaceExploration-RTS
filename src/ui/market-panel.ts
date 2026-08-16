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
  /** The whole holding, which is what a "sell all" order actually submits. */
  readonly sellAllQty: number;
  /** How many whole lots the credits currently cover, capped — see `BULK_LOTS`. */
  readonly buyLotsAffordable: number;
  /**
   * `pressure` as words, because -0.62 is not a thing a player can act on (PT-09, N-05).
   *
   * Derived from the engine's own swing bounds rather than from a price the panel judged: the
   * market moves within 40%..160% of equilibrium, and this says where in that band the commodity
   * currently sits. It is the difference between "sell now" and "wait", and it was computed and
   * thrown away for six phases.
   */
  readonly pressureText: string;
}

/**
 * The largest multi-lot buy the panel offers.
 *
 * Four, and it is a UI choice rather than an engine one: `buy` will take any quantity and clamps
 * itself to what the credits cover, so this bounds the BUTTON, not the order. A row of buttons
 * scaling to a player's bank balance would be a row that changes length as they trade.
 */
export const BULK_LOTS = 4;

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
    const pressure = clamp((state.market.pressure[com] ?? 0) / PRESSURE_CEIL, -1, 1);
    rows.push({
      com,
      held,
      sellUnit,
      buyUnit,
      sellLotProceeds: quoteSell(state.market, com, TRADE_LOT),
      sellAllProceeds: quoteSell(state.market, com, held),
      pressure,
      // A lot is the trade unit; holding less than one is not "sell what you have" here, because
      // `sell` clamps to the holding and would quietly fill a smaller order than the button says.
      canSell: held > 0,
      canBuy: credits >= buyUnit * TRADE_LOT,
      sellAllQty: held,
      // Floor, then cap: what the credits really cover, never more than the panel will show.
      buyLotsAffordable: Math.min(BULK_LOTS, Math.floor(credits / Math.max(buyUnit * TRADE_LOT, 1))),
      pressureText: pressureWords(pressure),
    });
  }
  return { rows, credits: Math.floor(credits), lot: TRADE_LOT };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Where a price sits in the engine's swing band, said out loud (PT-09).
 *
 * **Sell-side language**, because selling is what a player does with a stockpile and buying is the
 * exception. Positive pressure means the price has been pushed UP by demand, which is the moment to
 * sell — so the words describe what the number is good FOR, not what it is.
 *
 * The thresholds are thirds of the band and nothing cleverer. A finer scale would be a precision
 * the underlying number does not have, and a coarser one would not separate "wait" from "now".
 */
function pressureWords(pressure: number): string {
  if (pressure >= 0.34) return "high — good to sell";
  if (pressure <= -0.34) return "low — good to buy";
  return "near normal";
}
