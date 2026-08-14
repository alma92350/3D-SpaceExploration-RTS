// Types for the one build script a test imports directly.
//
// The scripts stay plain `.mjs` — they run under bare `node` in CI, before and independently of any
// transform — so this is the seam that lets `test/engine/vendor-drift.test.ts` call the real check
// rather than a re-implementation of it. A test that re-implemented the drift rule would prove
// nothing about the rule CI actually runs.

/**
 * @param dir           vendored directory to verify (defaults to src/engine)
 * @param manifestPath  the VENDOR.json describing it
 * @returns human-readable problems; empty means in sync
 */
export declare function checkVendor(dir?: string, manifestPath?: string): string[];
