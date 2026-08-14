export interface TechDef {
  id: string;
  name: string;
  ico?: string;
  cost: Resources;
  time: number;
  requires?: string[];
  desc?: string;
  rateMult?: number;
  yieldMult?: number;
  powerMult?: number;
  appliesTo?: string[];
}

export declare const TECHS: Record<string, TechDef>;

export declare function researchTech(state: State, buildingId: string, techId: string): boolean;
export declare function cancelResearch(state: State, buildingId: string, index: number): boolean;
export declare function techMult(upgrades: Record<string, unknown>, field: string, buildingType?: string): number;
