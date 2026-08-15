/**
 * Formation shapes and leader placement (P3-T11).
 *
 * `formationSlots` returns one point per unit **in the same order as the input**, with `units[0]`
 * always taking the leader slot — so a caller that reorders its selection reorders the formation.
 */
export declare const FORMATION_SHAPES: readonly string[];
export declare const LEADER_POSITIONS: readonly string[];

/** The unit the engine would put at the head of this group. */
export declare function pickLeader(units: Unit[]): Unit | null;

export declare function formationSlots(
  units: Unit[],
  destX: number,
  destY: number,
  opts?: {
    shape?: string;
    leaderPos?: string;
    originX?: number;
    originY?: number;
    headingX?: number;
    headingY?: number;
  },
): Array<{ x: number; y: number }>;
