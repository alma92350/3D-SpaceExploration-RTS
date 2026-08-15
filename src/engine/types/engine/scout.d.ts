import type { State } from "./state";

/**
 * Scout mode's per-tick update (P5-T13, PARITY.md row 35).
 *
 * A whole engine module with one export that nothing in this client reached for four phases:
 * `issueScout` crossed the façade for Phase 3 and was not wired to a gesture until P5-T13, so the
 * mode could be entered by nobody and this update ran over an empty set. **It is bound now** — `E`,
 * gated to `role === "scout"`, i.e. the Ranger alone — and the sentence above described the world
 * up to P5-T13 while reading like a present-tense fact for two phases after it. PT-03 is what that
 * cost: the first tester reported scout mode as a feature the game did not have.
 *
 * **PER UNIT, not per state.** This was declared `(state, dt)` when it was first written here and
 * that is wrong: `sim.js:300` calls it inside its unit loop. Anyone calling it through the façade on
 * the strength of the declaration would have passed `dt` where a `Unit` goes and crashed on
 * `unit.type`. Caught by P5-T13 within the hour, which is the argument for the one-file-wide JS/TS
 * boundary rather than against it — there is exactly one place for a mistake like this to be.
 */
export declare function updateScoutMode(state: State, unit: Unit, dt: number): void;
