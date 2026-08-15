/**
 * The difficulty roster (PARITY.md row 104).
 *
 * `WorldOptions` has accepted a `difficulty` since Phase 1 and `main.ts` has never passed one, so
 * every session ever played has been Medium. Each entry carries its own tuning table — around a
 * dozen fields, from `aiApm` to `graceMult` — and the client must never re-derive any of them: the
 * whole point of naming a difficulty is that the engine decides what it means.
 */
export interface DifficultyOption {
  readonly label: string;
  readonly mult: string;
  /** The one-line description upstream wrote for its own menu. */
  readonly note: string;
  readonly aiApm: number;
  readonly aiMicro: boolean;
  readonly [key: string]: unknown;
}

export declare const DIFFICULTY_OPTIONS: readonly DifficultyOption[];
