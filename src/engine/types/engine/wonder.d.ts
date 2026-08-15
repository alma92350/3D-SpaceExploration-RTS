/** The Antimatter Gate's charge (P5-T05). A 150-second commitment the whole match bends around. */
export declare function updateWonder(state: State, building: Building, dt: number): void;
/** The wonder `owner` is currently charging, if any. */
export declare function chargingWonderOf(state: State, owner: string): Building | null;
export declare function chargingPlayerWonder(state: State): Building | null;
