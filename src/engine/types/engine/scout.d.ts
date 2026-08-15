import type { State } from "./state";

/**
 * Scout mode's per-tick update (P5-T13, PARITY.md row 35).
 *
 * A whole engine module with one export that nothing in this client reached: `issueScout` crossed
 * the façade for Phase 3 and was never wired to a gesture, so the mode could be entered by nobody
 * and this update ran over an empty set for four phases.
 *
 * **PER UNIT, not per state.** This was declared `(state, dt)` when it was first written here and
 * that is wrong: `sim.js:300` calls it inside its unit loop. Anyone calling it through the façade on
 * the strength of the declaration would have passed `dt` where a `Unit` goes and crashed on
 * `unit.type`. Caught by P5-T13 within the hour, which is the argument for the one-file-wide JS/TS
 * boundary rather than against it — there is exactly one place for a mistake like this to be.
 */
export declare function updateScoutMode(state: State, unit: Unit, dt: number): void;
