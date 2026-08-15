/**
 * The neighbour's opinion of you (P5-T04).
 *
 * `stanceLabel` is the piece the client has already been caught wanting: P4-T03 drew the starmap's
 * stance bar with NO bands, because the banding stopped at the engine and inventing a threshold
 * above the bridge would be a second answer to a question the simulation already answers
 * (ADR-0012 §5). It crosses now, so the bar can be labelled in the engine's own words.
 */

/** Stance at or below which the neighbour is not at peace. */
export declare const PEACE_THRESHOLD: number;
/** Seconds a tribute holds the neighbour's fire — about one attack-wave cadence. */
export declare const APPEASE_TIME: number;
/** Credits for the first appeasement. Escalates; ask `tributeCost` rather than multiplying. */
export declare const TRIBUTE_BASE_COST: number;
export declare const GOODWILL_CAP: number;
/** A fresh favour is rolled roughly this often. */
export declare const FAVOR_INTERVAL: number;
/** Seconds to fulfil a favour before it is withdrawn — the number a UI must show as a clock. */
export declare const FAVOR_WINDOW: number;
export declare const FAVOR_GOODWILL: number;
/** Guaranteed opening cordiality, so an economy can be established. */
export declare const GRACE_TIME: number;

/** What the NEXT tribute costs. Escalating, so never re-derived from `TRIBUTE_BASE_COST`. */
export declare function tributeCost(dip: unknown): number;
export declare function offerTribute(galaxy: Galaxy, state: State): boolean;
export declare function offerGift(state: State, com: string, qty: number): boolean;
export declare function fulfillRequest(galaxy: Galaxy, state: State): boolean;
export declare function atPeace(state: State): boolean;
export declare function hostility(state: State): number;
/** The engine's own banding of a −1..1 stance. Report it; never invent a threshold. */
export declare function stanceLabel(stance: number): string;
export declare function provoked(state: State): boolean;
