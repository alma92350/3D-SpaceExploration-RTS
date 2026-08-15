/**
 * The nearest place a gatherer may bank a raw haul: a completed drop-off BUILDING (today the
 * Command Center alone), or a landed, player-toggled collection-point freighter with room. Which
 * kind it is matters to the caller — a `Building` and a `Unit` are both possible returns — so this
 * is deliberately not narrowed to `Building`.
 *
 * `excludeId` skips one building, the guard `updateHaul` uses so a worker cannot pick its own haul
 * source as its destination and loop.
 */
export declare function nearestGatherDrop(
  state: State, owner: OwnerId, x: number, y: number, excludeId?: string,
): Building | Unit | null;

/** The nearest completed Command Center — the treasury, and the anchor of a zone (`zoneFirst`). */
export declare function nearestCommandCenter(
  state: State, owner: OwnerId, x: number, y: number,
): Building | null;
