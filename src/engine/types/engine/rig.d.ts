export interface YieldTier { name: string; mult: number; [k: string]: unknown }
export interface RigInfo { [k: string]: unknown }

export declare const PLASMA_VEINS: string[];
export declare const SURVEY_RADIUS: number;
export declare const YIELD_TIERS: YieldTier[];

export declare function locationRichness(state: State, x: number, y: number): number;
export declare function rigSurvey(nodes: ResourceNode[], planetId: string, x: number, y: number): unknown;
export declare function rigInfo(state: State, building: Building): RigInfo | null;
