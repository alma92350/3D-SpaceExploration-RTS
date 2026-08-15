/**
 * Colony standing orders (P4-T08, and P4-T09's proof that they survive a save).
 *
 * A policy is a plain record on `galaxy.colonyPolicies`, executed by `runColonyPolicies` for
 * BACKGROUND worlds only — the active seat takes the player's own orders instead. Both halves are
 * opt-in: a fresh policy is inert.
 *
 * `sanitizePolicy` is the validator, and it is the SAME one the load path runs (engine/persist.js
 * calls it on every stored entry), which is why a hand-edited save cannot smuggle an unknown
 * commodity or a negative floor into the sim. Never treat it as a copy helper.
 */

/** Ceiling on the sustain-workers target. A UI must show this clamp rather than silently apply it. */
export declare const MAX_WORKER_TARGET: number;

/** Coerce an untrusted or absent policy into the one shape this module reads. Never throws. */
export declare function sanitizePolicy(p: unknown): ColonyPolicy;

/** The policy for `planetId`, or the fully-off default. Returns a sanitized copy, never the store's. */
export declare function getColonyPolicy(galaxy: Galaxy, planetId: string): ColonyPolicy;

/**
 * Patch a colony's policy. `autoSell.floors` MERGES into the existing floor set; `autoSell.enabled`
 * and `workerTarget` override when present. Returns the resulting sanitized policy.
 */
export declare function setColonyPolicy(galaxy: Galaxy, planetId: string, patch?: ColonyPolicyPatch): ColonyPolicy;

declare global {
  interface ColonyPolicy {
    /** Sell stock above each floor into the world's own market, through the real `sell()` path. */
    autoSell: { enabled: boolean; floors: Record<string, number> };
    /** Re-queue workers up to this headcount. Zero is the single "sustain workers" off switch. */
    workerTarget: number;
  }

  interface ColonyPolicyPatch {
    autoSell?: { enabled?: boolean; floors?: Record<string, number> };
    workerTarget?: number;
  }
}
