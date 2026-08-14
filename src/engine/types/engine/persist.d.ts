export declare const SAVE_VERSION: number;
export declare const GALAXY_SAVE_VERSION: number;
export declare function serializeGalaxy(galaxy: Galaxy): Record<string, unknown>;
export declare function serializeGalaxyString(galaxy: Galaxy): string;
export declare function deserializeGalaxy(input: unknown): Galaxy | null;
