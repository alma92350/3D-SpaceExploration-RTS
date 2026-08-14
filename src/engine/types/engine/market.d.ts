export declare const TRADE_LOT: number;
export declare const PRESSURE_FLOOR: number;
export declare const PRESSURE_CEIL: number;
export declare const GLUT_CEIL: number;

export declare function createMarket(state: State): MarketState;
export declare function unitPrice(market: MarketState, com: string, side?: "buy" | "sell", state?: State | null): number;
export declare function quoteSell(market: MarketState, com: string, qty: number): number;
export declare function sell(galaxy: Galaxy, state: State, com: string, qty: number): number;
export declare function buy(galaxy: Galaxy, state: State, com: string, qty: number): number;
export declare function tradeables(state: State): string[];
/**
 * Can `owner` get hold of `com` on this world at all — a local deposit exists, or some is held?
 * A BOOLEAN, not a quantity: comparing it against an amount reads as `true < 25`.
 */
export declare function commodityAvailable(state: State, owner: OwnerId, com: string): boolean;
