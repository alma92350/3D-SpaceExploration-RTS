// Control groups (P3-T13).
//
// **These are client state and must never become simulation state.** `state.selection` IS sim state:
// it lives on `State`, `applyIntent` reads it to decide who every order applies to, and the
// determinism fixture replays `select` intents through the same queue as everything else. So a
// control group stored there would be a purely local, per-player convenience deciding what the
// simulation does. A group lives here instead, holds engine ids, and reaches the simulation only by
// being replayed through the ordinary `select` intent — the same path a mouse drag takes.
//
// **Correction (P3-T17).** An earlier version of this comment also said `hashState` hashes the
// selection. It does not, and the difference matters in both directions. It means a control group
// written into `state.selection` would NOT be caught by the determinism fixture — the argument above
// stands on its own and never rested on the hash. And the omission is deliberate rather than an
// oversight: hashing the selection would make every `select` trivially "covered" by P3-T17's
// per-order check, which is exactly how that check found two selects in the Phase 2 fixture that no
// later order ever read.
//
// Nothing in the engine knows this exists, which is the point.

/** How many groups a player gets. The digit row, as every RTS since the nineties. */
export const GROUP_COUNT = 10;

export class ControlGroups {
  /** id lists, indexed 0–9. Ids are engine strings, never indices into anything. */
  private readonly groups: string[][] = Array.from({ length: GROUP_COUNT }, () => []);

  /** Replace group `n` with `ids`. Duplicates are dropped; order is the caller's. */
  assign(n: number, ids: readonly string[]): void {
    if (!this.valid(n)) return;
    this.groups[n] = [...new Set(ids)];
  }

  /** Add `ids` to group `n`, keeping what was already there. */
  append(n: number, ids: readonly string[]): void {
    if (!this.valid(n)) return;
    this.groups[n] = [...new Set([...this.groups[n]!, ...ids])];
  }

  /**
   * What group `n` holds, minus anything that no longer exists.
   *
   * **Pruning happens on read, not on death.** Nothing tells this class an entity died — it has no
   * access to the simulation and should not have — so the alternative is a group that slowly fills
   * with ghosts and recalls fewer and fewer units without saying why. `alive` is the caller's
   * predicate, which in practice is "is this id in the snapshot".
   */
  recall(n: number, alive: (id: string) => boolean): string[] {
    if (!this.valid(n)) return [];
    const live = this.groups[n]!.filter(alive);
    // Write the pruned list back, so a group that lost half its army does not re-filter it forever.
    this.groups[n] = live;
    return [...live];
  }

  /** How many ids group `n` holds, without pruning. For a HUD badge. */
  size(n: number): number {
    return this.valid(n) ? this.groups[n]!.length : 0;
  }

  clear(n: number): void {
    if (this.valid(n)) this.groups[n] = [];
  }

  private valid(n: number): boolean {
    return Number.isInteger(n) && n >= 0 && n < GROUP_COUNT;
  }
}
