# Release checklist — every non-functional requirement, and what actually enforces it

**Status: eight of eight requirements enforced, one of them by a process rule rather than a
command.** Nothing here is a promise: each row names the file or the command that fails when the
requirement stops being true, and the ones that cannot be automated say so in those words rather
than being quietly ticked.

This is P6-T10, and it is deliberately the same shape as P5-T01's `PARITY.md`: a checklist is only
an exit criterion if it is **derived and falsifiable**. `PARITY.md` earned that lesson the hard way —
its own headline count was three mutually inconsistent numbers because nobody had counted, and one
of its rows asserted a bridge method had no caller when it had had one since Phase 4. Both are
recorded in that file. So this one carries its commands, and §4 says what re-deriving it means.

---

## 1. The eight

PRD §6.2. The **Enforced by** column is the thing that goes red; the **Gap** column is what it does
not cover, because a guard whose limits are unstated is a guard the next reader trusts too far.

| ID | Requirement | Enforced by | Gap |
|---|---|---|---|
| **N-01** | **Determinism**: identical seed + identical input trace ⇒ identical state, on every machine and tier. The renderer may never write to sim state | `test/determinism/` — `record.test.ts` and `replay.test.ts` over committed fixtures, plus `test/architecture/layering.test.ts`, which is what makes "the renderer may never write" structural rather than a convention: `view/` cannot import `src/engine/**` at all | The fixtures are recorded on one machine. "Every machine and tier" is asserted by construction — the sim never sees a tier — and not by running the fixtures on a second architecture |
| **N-02** | **Test coverage**: no production code merges without a test that failed before it (ADR-0009) | **A process rule, and it is not automated.** It is met by every row's definition of done and by mutation testing being this project's standing bar — a test that cannot fail is caught by breaking the source and watching it stay green, which is how five phases' worth of survivors were found | Nothing mechanical stops a commit that skips it. Coverage percentage is deliberately not measured: it rewards tests that execute lines without asserting anything, which is the exact failure mutation testing exists to catch |
| **N-03** | **Load**: ≤ 5 s cold to interactive on 10 Mbit; ≤ 3 MB gzipped initial payload | `npm run check:size` (**237.2 kB** against 3 MB) and `e2e/coldload.spec.ts` | The size gate double-counted every JS chunk from Phase 0 to Phase 5 and reported exactly 2×; it never fired wrongly because the error was conservative against 14× headroom, and it was fixed the moment a decision depended on the number (P5-T02). The 10 Mbit figure is not simulated — the payload is the proxy |
| **N-04** | **Browsers**: last two versions of Chrome, Edge, Firefox, Safari. WebGL2 for 3D tiers; Canvas2D covers the rest | `npm run smoke` — `e2e/{smoke,conformance,coldload,subpath,perf}.spec.ts` — plus `src/view/renderer/conformance.ts`, which sweeps every `OVERLAY_STRIDE` kind across all three renderer implementations | **CI runs Chromium only.** Firefox and Safari are covered by the renderer port's conformance suite and by there being no browser-specific code, not by execution. That is a real gap and it is the one a release should close first |
| **N-05** | **Accessibility**: colour-blind-safe palettes, keyboard-navigable UI, a reduced-motion setting, no information by colour alone | `test/view/palette.test.ts` (Machado 2009 + CIEDE2000, three controls that must each be rejected under their own deficiency), `test/ui/colour-alone.test.ts` (a sweep derived from every stylesheet, not a list), `test/ui/keyboard-nav.test.ts`, `test/view/reduced-motion.test.ts`, `test/app/motion-setting.test.ts` | **Keyboard-only PLAY is not yet true** — the HUD is navigable and the game is not, because `translateKey` produces no `select`. Filed as P6-T11. The colour sweep does not reach anything drawn to canvas rather than styled by CSS, and cannot judge whether a second channel is *legible* |
| **N-06** | **No secrets, no telemetry, no network calls** beyond loading the app itself | `test/architecture/no-network.test.ts` — and ADR-0022 records that this was true **by construction** before it was ever a policy: a sweep of `src/`, vendored engine included, found zero `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, service worker or Cache API | The test sweeps source. A dependency that called out at runtime would not be caught by it; `three` is the only runtime dependency |
| **N-07** | **Documentation**: every architectural choice has an ADR; every phase has exit criteria; the board is current at the end of every session | `npm run check:adr` (**23 ADRs, all indexed with a status**) | It checks that every ADR is indexed, not that every architectural choice has one. The board being current is a habit, not a gate — though the open-questions register having eight rows reading OPEN against settled decisions (P6-T08) is what that habit failing looks like |
| **N-08** | **Save safety**: saves are untrusted input — sanitised and version-checked exactly as upstream does | `test/ui/save-panel.test.ts`, `test/app/failure.test.ts` (22 corruptions fired, every one refused with the session intact), `test/bridge/commands.test.ts` | Upstream does the sanitising; this project's job is not to defeat it. `describeSave` reads the payload's own `v` and never our envelope, so a version gate cannot be bypassed by the wrapper |

---

## 2. What runs in CI, and what does not

Six jobs on every push (`.github/workflows/ci.yml`): typecheck + tests + **the vendored upstream
simulation suite** + build; the vendor drift check; the CPU perf gate; browser smoke, conformance
and the T0 budget; the payload budget; the ADR index.

Three things are **not** in CI and each is deliberate:

- **The five playtest scripts.** They need people (P6-T09, ADR-0011).
- **Firefox and Safari.** See N-04.
- **Mutation testing.** It is run by hand, per row, and reported in the board. Automating it would
  cost more wall-clock than the whole suite and would tempt the number to become a target.

---

## 3. The one requirement that cannot be met by machine

**P6-T09: five playtest scripts, written and none run.** `mvp.md`, `economy.md`, `combat.md`,
`galaxy.md` and `longgame.md` are complete, carry gates written in advance so a result cannot be
argued into a pass afterwards, and have never met a tester.

Under ADR-0011 a phase closes on its automated criteria and human gates are deferred into the
standing table. That is the rule this project has followed since Phase 3 and it is followed here.
**But five deferrals is not four deferrals plus one** — it is a project that has never once checked
its work against a person, and `longgame.md` says so in its own header because it is the last script
that can. Two of its gates are set at five of five, above this project's usual bar, and one of them
guards a failure no later polish recovers: a player closing the tab on a run the engine has not
ended.

So this checklist records P6-T09 as **BLOCKED ON HUMANS**, not as done and not as deferred without
comment. It is the largest single risk to "it feels finished", and it is the one row on this board
that more engineering cannot close.

---

## 4. Re-deriving this file

Do not trust the table. Run:

```sh
npm run typecheck && npm test && npm run test:sim   # N-01, N-02, N-05, N-08
npm run check:size                                  # N-03
npm run smoke                                       # N-04
npm run perf                                        # ADR-0006
npm run check:vendor                                # ADR-0003
npm run check:adr                                   # N-07
```

`npm run perf` is **wall-clock and the host matters**: two agents measured it red on an unmodified
checkout under concurrent load and green on a quiet one within the same hour. A red perf gate is a
question, not an answer — re-run it on an idle machine before believing it, and never re-record
`perf/baseline.json` off a single run.

If a row here disagrees with the command beside it, **the command is right**.
