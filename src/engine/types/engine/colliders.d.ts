export declare function canPlaceBuilding(state: State, buildingType: string, x: number, y: number): boolean;
export declare function findPlacement(state: State, buildingType: string, x: number, y: number, maxRadius?: number): { x: number; y: number } | null;
export declare function radiusOf(e: Entity): number;
