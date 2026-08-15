import type { State } from "./state";

/**
 * Scout mode's per-tick update (P5-T13, PARITY.md row 35).
 *
 * A whole engine module with one export that nothing in this client reached: `issueScout` crossed
 * the façade for Phase 3 and was never wired to a gesture, so the mode could be entered by nobody
 * and this update ran over an empty set for four phases.
 */
export declare function updateScoutMode(state: State, dt: number): void;
