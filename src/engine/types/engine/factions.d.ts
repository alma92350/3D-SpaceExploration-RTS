/** Faction identity and its traits (P5-T04, P5-T08). */
export declare const FACTIONS: Record<string, { id: string; name: string; [k: string]: unknown }>;
export declare const PLAYABLE_FACTIONS: readonly string[];
export declare function factionTrait(state: State, owner: string, key: string): unknown;
