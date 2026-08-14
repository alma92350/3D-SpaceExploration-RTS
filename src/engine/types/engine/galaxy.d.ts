export declare const ODYSSEY_WORLDS: string[];
export declare const BACKGROUND_WORLDS: number;
export declare function createGalaxy(opts?: GalaxyOpts): Galaxy;
export declare function stepGalaxy(galaxy: Galaxy, dt: number): void;
export declare function activeState(galaxy: Galaxy): State;
export declare function addPlanet(galaxy: Galaxy, planetId: string, opts?: { unsettled?: boolean }): State;
