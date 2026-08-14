/** Per-world commodity market: prices move with what has been traded into and out of it. */
export interface Market {
  [commodity: string]: unknown;
}

export declare const TRADE_LOT: number;
export declare const PRESSURE_FLOOR: number;
export declare const PRESSURE_CEIL: number;
export declare const GLUT_CEIL: number;

export declare function createMarket(state: State): Market;
export declare function unitPrice(market: Market, com: string, side?: "buy" | "sell", state?: State | null): number;
export declare function quoteSell(market: Market, com: string, qty: number): number;
export declare function sell(galaxy: Galaxy, state: State, com: string, qty: number): number;
export declare function buy(galaxy: Galaxy, state: State, com: string, qty: number): number;
export declare function tradeables(state: State): string[];
export declare function commodityAvailable(state: State, owner: OwnerId, com: string): number;
