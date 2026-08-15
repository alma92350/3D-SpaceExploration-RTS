# ADR-0022: No update check — N-06 keeps its measured zero, and "which build am I on?" is answered at build time

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Resolves:** PRD §5 (Phase 6 scope) against PRD §6.3 (N-06)
**Relates to:** PRD N-03, N-04, N-06, N-07; ADR-0002, ADR-0005, ADR-0007, ADR-0011; P6-T05,
P6-T06, P6-T09, P6-T10

## Context

The PRD contradicts itself, in one document, eighty lines apart.

- **§5, Phase 6 scope:** *"LOD and effect budgets, accessibility …, tutorial, performance passes,
  error handling, a release build, docs, versioning **and the update check**."*
- **§6.3, N-06:** *"**No secrets, no telemetry, no network calls** beyond loading the app itself."*

An update check is a network call. Both sentences are requirements of the same phase, and Phase 6
closes against both. One of them has to give, and which one is a decision rather than an
implementation detail — so it is recorded here rather than settled by whoever writes the code first.

### 1. "No network calls" is currently a measured zero, not a policy

`grep` over `src/` — including the vendored engine, which ships — for every network primitive a
browser has:

| Primitive | Occurrences in `src/` |
|---|---|
| `fetch(` | **0** |
| `XMLHttpRequest` | **0** |
| `WebSocket` | **0** |
| `EventSource` | **0** |
| `navigator.sendBeacon` | **0** |
| `serviceWorker` | **0** |
| Web app manifest / Cache API | **0** |

Not "no telemetry that we know of": **no network primitive of any kind is reachable from the
shipped bundle.** The only requests the game makes are the ones the browser makes to load it — the
document, one stylesheet, three JavaScript chunks (`npm run check:size`, 236 kB gzipped against
N-03's 3 MB).

That is a property which is cheap to hold and expensive to recover. The *first* `fetch` is the one
that costs: it needs an endpoint someone operates, a privacy answer, a timeout, an offline path, a
failure mode that does not block the game, and a test. Every one after it is free. This ADR is
about whether to pay for the first.

### 2. On this deployment, the reload *is* the update mechanism

`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages. `vite.config.ts` sets
`base: "./"`, and Vite emits content-hashed asset names — `assets/index-CZ1_vwgC.js`,
`assets/three-DUruuwVx.js` — behind one unhashed document, `index.html`. Nothing is installed on
the player's machine. There is no service worker holding an old copy.

So a player who reloads gets the current build, always, with no version endpoint to publish and no
staleness in the check itself. **An update check on this deployment would tell a player something
the next reload applies anyway**, and would tell it less reliably than the browser does.

The case where a check genuinely earns its keep is a client that *cannot* self-update: an
installable PWA behind a service worker, or a packaged desktop build. ADR-0002 scoped this project
to the browser and neither exists.

### 3. "Versioning and the update check" is two requirements joined by an `and`

Separated, they are not the same size and only one of them has evidence behind it.

- **"Which build am I on?"** — real, and unmet until this phase. The version was `0.1.0` in
  `package.json` **and nowhere else**: not in the page, not in the DOM, not on `globalThis`. Four of
  the five playtest scripts in `docs/playtests/` carry a literal
  `Build under test: commit hash ______` line, and the fifth opens with *"check these on the build
  under test"*. Until P6-T06 the honest answer a tester could write was the date. **This needs no
  network at all.**
- **"Is there a newer build?"** — needs a network call, and §2 shows the platform already answers it
  on reload.

The requirement with the evidence is the one that survives N-06 untouched.

### 4. What N-06 is protecting, stated honestly

N-06's three clauses are one clause. **A request to a server the developer controls is a session log
whether or not it carries a payload**: the far end sees an IP, a User-Agent, a timestamp and a
frequency, which is a record of who played and when. That is the telemetry the requirement's *first*
clause forbids, arriving through its third. An update check with an empty request body is telemetry
with extra steps.

Two more, both concrete rather than abstract:

- **The constraint personas.** ADR-0007 and PRD §4 are written around a locked-down machine and a
  10 Mbit line. A check that hangs behind a corporate proxy is a check that has to have a timeout,
  and a timeout is a code path nobody exercises until it is the one failing.
- **There is nothing to know.** This is a single-player game with no account, no server and no save
  sync. Saves are `localStorage` (`odyssey3d.save.*`), settings are `localStorage`
  (`odyssey3d.settings.v1`). Nothing about the player exists anywhere else, and an update check
  would be the first thing that made the player exist to us at all.

### 5. The one real cost, named rather than glossed: a save-format change

`engine/persist.js:44–45` — `SAVE_VERSION = 1`, `GALAXY_SAVE_VERSION = 1`. If either bumps, a
player on a stale cached build writes saves a newer build refuses, or is handed a save it cannot
open. That is the one scenario where *"you are on an old build"* is information a player needs
**before** something goes wrong rather than after, and it is the strongest argument the update check
has.

The answer is already in the repo and it is not a request. `describeSave` (`src/ui/save-panel.ts`)
refuses on version and **names both numbers**: *"Saved by a different version of the game (save v2,
this build reads v1). It cannot be loaded."* Paired with the build stamp this ADR requires, a player
has the whole diagnosis — which build they are on, which version it reads, which version the file
is — with no network at any point. What they then do is press reload, which is what the check would
have told them to do.

## Decision

**We will not ship an update check. N-06 wins, at its literal zero. The Phase 6 scope's "and the
update check" is answered by a build-time version stamp plus the reload the platform already
provides.**

1. **No network primitive ships, and the bar is §1's measured zero rather than a promise.**
   `test/architecture/no-network.test.ts` enforces it over `src/` and `index.html` — including the
   vendored tree, so an upstream sync that introduces one is a red build with a message naming N-06
   rather than a quiet arrival. Adding the first network call requires an ADR that supersedes this
   one and answers §4.

2. **The version is stamped at build time and rendered where a player can read and quote it.**
   `vite.config.ts` reads `package.json`'s `version`, asks git for the short commit, and injects
   both through `define`. `src/app/build.ts` exposes them; `stampBuild()` writes them to
   `#build` in the sidebar (visible on every screen), to `document.documentElement.dataset.build`
   (for a Playwright run), and to `globalThis.__odysseyBuild` (for a console). Every message
   `src/app/failure.ts` shows carries it too, because a player filing a bug will not think to add
   it and the failure screen is exactly where it is most needed (P6-T05).

3. **The commit identifies the build; the semver names it.** `version` moves once a phase and the
   deploy moves every push, so two builds a week apart both read `0.1.0` and only one has the bug.
   The playtest scripts ask for a *commit hash* by name. Both are stamped, joined as
   `0.1.0 · a1b2c3d`.

4. **`package.json` is the single source of the version, and no human retypes it.** A number kept in
   two places is a number that is wrong in one of them, silently, for a phase.

5. **No service worker, no web app manifest, no offline cache.** This is part of the decision rather
   than an omission: a service worker would make the app self-caching, at which point §2's claim
   that "reload is the update mechanism" stops being true and this ADR would have to be reopened —
   see the trigger below.

6. **A build with no git reports `unknown` rather than failing.** A source tarball or a shallow
   checkout must still build; `unknown` is a true statement, and a plausible-looking wrong commit
   would be worse than an obviously absent one.

## Consequences

**This makes easy:**
- Answering "which build?" in a bug report, a playtest form and a screenshot — the thing P6-T09
  needs before it can book five testers' afternoons.
- Keeping N-06 checkable rather than assertable. P6-T10 requires "every N-requirement has a test or
  a recorded decision"; N-06 now has both.
- Auditing this project at a glance: a static site that makes no requests needs no privacy policy,
  no consent banner, no data-retention answer, and can be run from a `file://` copy or an air-gapped
  intranet without degrading.
- Reviewing the next proposal. "We just need one small fetch" now has a document to argue with.

**This makes hard / gives up:**
- **A player who leaves the tab open for a week is on a week-old build and is never told.** That is
  the literal feature being declined, and it is a real loss on a game with sessions long enough for
  P5-T11's script to run on prepared saves.
- **No in-app changelog and no "what's new".** A player cannot discover that the thing they reported
  has been fixed; they find out by reloading and noticing.
- **No kill switch.** If a build ships a save-corrupting defect there is no channel to say so to the
  people already running it. Accepted with the mitigation named in §5 — the save panel refuses a
  version it cannot read and says which two versions disagree — and with the observation that a
  channel we would use once in the project's life is not worth the first `fetch`.
- **No way to tell a playtester mid-session that their build is superseded.** P6-T09 handles this by
  pinning the build before the session, which is what its scripts already ask for.
- **The stamp is only as honest as the build it came from.** A `dist/` served from a stale CDN edge
  reports the version *it* was built with — correct, and still capable of confusing someone. The
  commit is what disambiguates, which is why both are stamped.

**Obligations it creates:**
- `test/architecture/no-network.test.ts` exists and scans the vendored tree too.
- Any future ADR proposing a network call names the endpoint, states what is logged at the far end,
  and says what the app does when it is unreachable.
- P6-T10's release checklist cites this ADR for N-06 and for the versioning half of §5's scope.

## The trigger, stated in advance

**This ADR is superseded when either of these happens:**

1. **A service worker or an installable PWA lands.** At that point the app caches itself, §2's claim
   that a reload is the update mechanism becomes false, and a stale client is a real state the app
   can be in rather than a hypothetical. The right answer then is still not a version endpoint: it
   is the service worker's own `updatefound` event, which is same-origin, needs no server we
   operate, and logs nothing anywhere — see the third alternative below.
2. **`GALAXY_SAVE_VERSION` bumps *and* a playtest or a bug report shows a player stranded on a stale
   build because of it.** Both halves are required: the version bump alone is handled by §5's
   refusal message. Even then the first thing to try is not a check — it is serving `index.html`
   with `Cache-Control: no-cache`, which is a header on the deploy and not a line of client code.

Deliberately **not** a trigger: *"every other web app has one."* Most other web apps have an
account, a server and something to sell. PRD §4's personas have a browser and ten minutes.

## Alternatives considered

### A silent version check on load
The literal reading of §5. One request to a JSON manifest at boot, compare, toast if newer.
Rejected on §4: it makes every launch a log line at a server someone has to operate, for information
§2 shows a reload already supplies. It also has to answer "what if it fails?" — and the only correct
answer, "carry on silently", means the feature is invisible exactly when the network is the problem.

### An opt-in check, off by default
The compromise, and the one worth taking seriously because it appears to cost nothing until
somebody enables it. Rejected: **it costs the same to build and one more thing to explain.** It
needs the endpoint, the timeout, the failure path, the settings row, the sentence explaining what
gets sent — all of it — plus a new class of bug where the setting says on and the check is silently
failing. And the benefit to the player who opts in is a toast that says "press F5". Splitting the
difference here would be exactly the "quietly implement one side" the task board warned against,
with a checkbox on it.

### Compare `index.html` against itself — no endpoint, same origin
Genuinely the best of the network options and the closest call in this document. `index.html` is the
one unhashed file; re-fetching it and comparing the asset hash it references would detect a new
deploy with a request to a file the browser already fetched once, from a server we do not have to
add. Rejected **on the ratio, not on principle**: it is still a request, on a timer, from a client
that would otherwise make none — the same log line at the far end, the same privacy sentence to
write, the same timeout — and the payoff is a toast telling the player to do the thing the request
itself proves they can do. Recorded here rather than dismissed, because it is the shape trigger 1
should take if a service worker ever makes staleness real.

### Ship the check and weaken N-06 to "no third-party network calls"
Honest about the trade, and the version an update check actually needs. Rejected because the
weakened wording protects nothing this project cares about: §4's concern is the *record*, and a
first-party server keeps exactly the same one. It would also make N-06 unfalsifiable — "no
third-party calls" cannot be checked by grep, where "no calls" can, and a requirement that CI can
verify is worth more than a broader one it cannot.

### Leave the contradiction and implement neither
The status quo, and the outcome if nobody rules. Rejected on N-07 ("every architectural choice has
an ADR") and on ADR-0011's precedent: a Phase 6 that closes against §5's scope list cannot tick a
line nobody decided. It would also leave the versioning half undone, which is the half with five
playtest scripts waiting on it.

### A version typed into the page by hand at release
The zero-toolchain answer, and it does satisfy "a player can read it". Rejected: two places to bump,
and the failure mode is silent — the page says `0.1.0` for a phase after `package.json` says `0.6.0`
and nothing goes red. `define` is config rather than a plugin, so ADR-0007's "one config, no custom
plugins" is intact.

### Stamp a build timestamp as well as the commit
Considered and dropped. It makes every artefact unique, so "is this the same bundle?" — a question
`check:vendor` and the size gate both ask in their own way — stops having an answer. The commit
already identifies the build, and the deploy time is in the Actions log.
