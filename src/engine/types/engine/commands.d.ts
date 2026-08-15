export declare function issueMove(units: Unit[], x: number, y: number, queue?: boolean, formation?: unknown): void;
export declare function issueAttackMove(units: Unit[], x: number, y: number, queue?: boolean, formation?: unknown): void;
export declare function issueAttack(units: Unit[], targetId: string, queue?: boolean): void;
export declare function issueGather(units: Unit[], nodeId: string, queue?: boolean): void;
export declare function issueStop(units: Unit[]): void;
export declare function issueHold(units: Unit[]): void;
export declare function issuePatrol(units: Unit[], points: Array<{ x: number; y: number }>): void;
export declare function issueBuild(state: State, workerId: string, buildingType: string, x: number, y: number): boolean;
export declare function issueSetRally(building: Building, x: number, y: number, nodeId?: string | null): void;

// --- Phase 2 (P2-T03). Upstream's own orders for the economy; the bridge calls these, never
// a field. Pause and electrify have no order upstream — the 2D HUD flips those flags directly.
export declare function issueRecycle(entities: Entity[]): void;
export declare function issueCancelRecycle(entities: Entity[]): void;
export declare function issueSetLogiPriority(state: State, buildingId: string, priority: string): void;
export declare function issueServiceBuilding(units: Unit[], buildingId: string, queue?: boolean): void;
export declare function issueRepair(units: Unit[], targetId: string, queue?: boolean): void;

/**
 * Escort a friendly ship: each unit takes a stable slot on a ring around the target and follows it
 * wherever it goes. `slot`/`slots` are fixed at issue time, so the ring is deterministic — and the
 * order is never cleared on arrival, which is what makes an escort look identical to a stuck move
 * order unless the view says what is being escorted (P3-T12).
 */
export declare function issueEscort(units: Unit[], targetId: string, queue?: boolean): void;

/**
 * Form up in `shape` at the group's own current centroid and hold there. Combat units also take the
 * Hold stance, so the line keeps its shape instead of scattering after a distant target.
 */
export declare function issueHoldFormation(units: Unit[], shape?: string, leaderPos?: string): void;

/** Put units into scout mode (engine/scout.js). */
export declare function issueScout(units: Unit[]): void;

// --- Phase 5's parity close-out (PARITY.md §5.2) -------------------------------------------------
//
// Five of the ten orders with no way in were not declared here at all, which is why the enumeration
// could see them in the JS and the client could not reach them. Signatures read off
// `engine/commands.js` directly, not inferred from the names.

/**
 * Send builders to finish a building already under construction.
 *
 * Gated on `canBuildCategory(u.type, BUILDINGS[buildingType].category)`, so the TYPE is needed as
 * well as the id — the engine looks the category up from it rather than from the placed building.
 */
export declare function issueAssistBuild(
  units: Unit[], buildingId: string, buildingType: string, queue?: boolean,
): void;

/** Send logistics units to ferry a freighter's hold. Logistics types only, like `issueRepair`. */
export declare function issueFerryFreighter(units: Unit[], freighterId: string, queue?: boolean): void;

/**
 * Override which Command Center a hauler calls home — the multi-base control.
 *
 * The engine's own comment: "an explicit player override for `zoneFirst`'s usual nearest-CC guess".
 * Accepts logistics, support and freighter roles, which is wider than `issueRepair`'s set.
 */
export declare function issueSetHomeBase(units: Unit[], ccId: string): void;

/**
 * Park a freighter as a collection point, anchored where it stands.
 *
 * Freighters only. `nearestGatherDrop` already honours the result (P2-T07 names the landed
 * collection-point freighter that can beat a nearer Command Center to the drop-off) — this is the
 * cause the client has been reading the consequence of since Phase 2.
 */
export declare function issueSetCollectPoint(units: Unit[], on: boolean): void;

/**
 * Hand a freighter over to the AI hauler.
 *
 * Takes `state` because switching it ON is gated on the owner having researched `FREIGHTER_AI_TECH`
 * — the engine refuses silently otherwise, so a control must ask before it offers.
 */
export declare function issueSetAILogistics(units: Unit[], on: boolean, state: State): void;
