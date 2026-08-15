// Which build am I looking at? (P6-T06.)
//
// The version lived in `package.json` and **nowhere else** — not in the page, not in the DOM, not
// on `globalThis`, not in a comment. Every one of the five playtest scripts in `docs/playtests/`
// asks a tester to record the build they were on, and until this file there was no build to record:
// the honest answer a tester could give was "the one that was up on Tuesday".
//
// Two rules, and ADR-0022 is where they are argued:
//
//   1. **The build injects it; a human never retypes it.** `vite.config.ts` reads `package.json`'s
//      `version` and asks git for the short commit, and `define` substitutes both at build time.
//      A version a person has to remember to bump in two places is a version that is wrong in one.
//   2. **It is a build-time stamp and never a network call.** N-06 allows "no network calls beyond
//      loading the app itself", and ADR-0022 rules that "which build am I on" is answerable without
//      one — which is the half of "versioning and the update check" that survives that requirement.
//
// The commit is what actually identifies a build, because `version` moves once a phase and the
// deploy moves every push: two builds a week apart both read `0.1.0`, and only one of them has the
// bug. The version is kept beside it because it is the number a human says out loud.

// Substituted by `define` (see vite.config.ts). Declared, not imported: `package.json` is outside
// `src/`, and pulling it through the module graph would put the whole manifest — scripts, dev
// dependencies, everything — one bad tree-shake away from the payload N-03 budgets.
declare const __BUILD_VERSION__: string;
declare const __BUILD_COMMIT__: string;

export interface BuildStamp {
  /** `package.json`'s `version`. */
  readonly version: string;
  /** Short git commit, or `"unknown"` where the build had no git (a tarball, a fresh unpack). */
  readonly commit: string;
  /** What a player reads and quotes into a bug report: `0.1.0 · a1b2c3d`. */
  readonly label: string;
}

/**
 * A define that survived, or the fallback.
 *
 * `typeof` rather than a bare read: an undeclared identifier is a `ReferenceError`, and the whole
 * point of this module is that it cannot be the thing that stops the game from starting. The
 * fallback is `"dev"` rather than `"0.0.0"` because a plausible-looking wrong version is worse than
 * an obviously absent one — a tester who reports "dev" has told us something true.
 */
function stamped(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const version = stamped(typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : undefined, "dev");
const commit = stamped(typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : undefined, "unknown");

export const BUILD: BuildStamp = {
  version,
  commit,
  // Middle dot rather than a hyphen: the commit is a hex string and a hyphen beside one reads as
  // part of it when someone copies the line into an issue.
  label: `${version} · ${commit}`,
};

/**
 * Put the stamp where a player, a screenshot and a console can all reach it.
 *
 * Three surfaces because the three failures that need it are different: a tester filing a report
 * reads the sidebar, a support round trip on a screenshot needs it *rendered*, and a Playwright run
 * or a developer in devtools wants it without parsing the DOM. All three are the same string.
 *
 * Total: a missing element is not an error. This runs before `boot()` so that a build which fails
 * to start still says which build failed, and it must never be the reason one does.
 */
export function stampBuild(doc: Document = document): void {
  try {
    doc.documentElement.dataset.build = BUILD.label;
    const el = doc.getElementById("build");
    if (el) el.textContent = `Build ${BUILD.label}`;
    (globalThis as unknown as { __odysseyBuild?: BuildStamp }).__odysseyBuild = BUILD;
  } catch {
    // A document that will not take an attribute is a browser we cannot help anyway. The label is
    // still on `BUILD`, which is what the failure banner reads.
  }
}
