export declare const MAP_WIDTH: number;
export declare const MAP_HEIGHT: number;
export declare const TERRAIN_CELL_SIZE: number;
export declare const TERRAIN: Record<number, TerrainDef>;
export declare const NODE_RADIUS: number;
export declare function sampleTerrain(terrain: TerrainGrid | null, x: number, y: number): TerrainDef;
export declare function generateMap(planetId?: string, rng?: () => number, opts?: Record<string, unknown>): GameMap;
