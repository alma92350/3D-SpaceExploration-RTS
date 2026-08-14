export declare function canRecycle(entity: Entity): boolean;
export declare function beginRecycle(entity: Entity): boolean;
export declare function cancelRecycle(entity: Entity): boolean;
/** What the owner gets back if this is scrapped now. Shown before committing, never re-derived. */
export declare function recycleValue(state: State, entity: Entity): Resources;
