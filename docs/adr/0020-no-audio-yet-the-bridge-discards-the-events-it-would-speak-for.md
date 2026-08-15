# ADR-0020: No audio yet, because the bridge discards fifteen of the sixteen events it would speak for

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Answers:** Q-06
**Relates to:** PRD §5 (Phase 5 scope), §7 (N-03, N-05, N-06), §10 (Q-06); ADR-0003, ADR-0006,
ADR-0008, ADR-0011, ADR-0017, P5-T01, P5-T02

## Context

Q-06 has been open since Phase 0 and is now due: *"reuse the source repo's procedural WebAudio, or
none for now?"* P5-T02 requires it answered on evidence, and warns that the first half of the
question may not be an available option. It is not. Checking that is where this ADR starts, and it
is not where it ends — because checking it turned up a larger fact about the bridge.

### 1. The premise is half true, and the record says exactly which half

`grep -rn "AudioContext\|createOscillator\|GainNode\|new Audio(" src/` returns **nothing** outside
this repo's own planning documents. There is no audio anywhere in the tree, vendored or ours.

But absence is not evidence of absence upstream, and the manifest settles it. `src/engine/VENDOR.json`
records **44 upstream tests that were not vendored**, each with the exact path that disqualified it.
**Six of them name `../sound.js`:**

```
hud.test.js   hudSelection.test.js   hudSelection-golden.test.js
input.test.js   overlays.test.js      techChart.test.js
```

**Upstream's audio exists.** It sits at the repo root as `sound.js`, next to `boot.js` and
`main.js` — it is *client* code, and ADR-0003 vendors the simulation and not the client. It was
excluded by the mechanical rule in `vendor-manifest.mjs`, not by anyone's judgement, and the
exclusion has been a reviewable line in the manifest since Phase 0. Nobody hid it; nobody looked.

The vendored simulation talks about it in four places, and those comments are inside files
`check:vendor` hashes at `main@93f607ae46fb`:

| | |
|---|---|
| `engine/state.js:260` | events are *"drained and turned into **sound** by main.js each render frame"* |
| `engine/bomb.js:159` | *"One bombDetonated event drives the explosion VFX + sound (boot.js/effects.js/**sound.js**)"* |
| `engine/combat.js:211` | *"boot.js/effects.js/renderEffects.js/**sound.js** scale the death's visuals and audio by what actually died"* |
| `engine/bomb.js:247` | the `bombFused` event exists *"so the VFX/sound layer"* can warn once, the moment the fuse is lit |

So **"reuse upstream's procedural WebAudio" is not available — but its *contract* is vendored, and
it is `state.events`.** Upstream's design is one line long: the sim pushes events, the client drains
them each render frame and turns them into sound. That is the seam. It is here, in a file we may not
edit and do not need to.

### 2. Measured: one of sixteen events reaches the view

Every `state.events.push` in the vendored engine, and whether the type it pushes crosses this
project's bridge:

| Event | Crosses? | Event | Crosses? |
|---|---|---|---|
| `entityKilled` | **yes** — `snap.deaths` | `attackHit` | no |
| `bombDetonated` | no | `bombFused` | no |
| `buildingComplete` | no | `unitSpawned` | no |
| `researchComplete` | no | `productionBlocked` | no |
| `recycled` | no | `rigDig` | no |
| `neighbourHostile` | no | `deployBlocked` | no |
| `wonderCharging` | no | `rivalGateComplete` | no |
| `wreckMatured` | no | `craterMatured` | no |

**Sixteen types. One crosses.** `WorldBridge.step` extracts and then runs
`this.state.events.length = 0` (`bridge/world.ts:214`), and `extractDeaths` copies exactly
`entityKilled` — fog-gated on *explored* ground. Everything else is raised and discarded inside the
same tick, deliberately and correctly: nothing above the bridge consumed it, and an undrained array
grows for the length of a session.

**This is the whole cost of audio, and it is not the oscillators.** A sound layer that can only say
"something died" is not worth building — the death already has a blast mark (`view/effects.ts`), a
minimap dot and, for the player's own losses, a HUD alert (`view/alerts.ts`). The cues audio is
uniquely good at are precisely the fifteen that never arrive: a factory that has *stopped*
(`productionBlocked`), research landing while the player is looking at the other side of the map
(`researchComplete`), an enemy fuse lit off-screen (`bombFused`), the rival Gate finishing
(`rivalGateComplete`). Every one of those is a bridge-widening task before it is an audio task, and
**every new channel across the bridge needs a fog rule decided** — the bridge already runs seven
distinct visibility rules over three predicates (see ADR-0021 §2). Fifteen more channels is fifteen
more of those decisions, each of which can leak.

### 2b. Found while counting: `attackHit` exists, and ADR-0017 says it does not

Counting the event types turned up something outside this ADR's question, recorded here because
finding it and not saying so would be worse than saying it in the wrong place.

**ADR-0017 opens with "There is no such event. The simulation emits thirteen event types in total
and exactly one of them is about combat — `entityKilled`. No shot, no impact, no damage-dealt."**
The count above is **sixteen**, and `combat.js:187` pushes:

```js
state.events.push({
  type: "attackHit", x: target.x, y: target.y,
  fromX: attacker.x, fromY: attacker.y, unitType: attacker.type, owner: attacker.owner,
  heavy: …, bonus: …, splashRadius: …,
});
```

Both endpoints, the attacker's type, and three presentation flags — with a header comment saying it
carries them "so `render.js` can draw a tracer from shooter to target" and "Zero sim effect — the
flags are read only by the UI layer". It is a purpose-built tracer event, and it also carries the
dying target's position before removal, which is the case ADR-0017's §4 built the whole diff around.

**This is not a re-sync artefact.** `git log -- src/engine/engine/combat.js` shows one commit,
`4a5c169` (the Phase 1 MVP), `check:vendor` reports the tree in sync at `main@93f607ae46fb`, and the
file has not changed since. **The premise was wrong when it was written**, and ADR-0017's *decision*
may still be right for reasons it did not give — but that is a separate ADR with its own
measurement, and it is not this one's to make. Recorded, unresolved, and it belongs on the board.

For Q-06 it cuts one way only, and it sharpens §2 rather than softening it: the single richest
event upstream's `sound.js` keys on is among the fifteen this bridge discards.

### 3. Measured: the payload budget has no opinion, and the gate that measures it is over-counting

| | gzipped |
|---|---|
| `three` chunk | 124.6 kB |
| WebGL renderer chunk | 69.6 kB |
| **all 44 of our TypeScript files — 13 302 lines** | **21.8 kB** |
| entry HTML + CSS | 3.6 kB |
| **TRUE TOTAL** | **219.6 kB against N-03's 3 072.0 kB — 7.1 %** |

That is 1.7 gzipped bytes per line of our source. A procedural sound module the size of
`view/alerts.ts` (374 lines, the closest structural analogue in the repo) would add roughly
**0.6 kB — 0.02 % of the budget**, and procedural audio ships **zero assets**, so nothing else
follows it in. There is 2 852 kB of headroom.

> **`npm run check:size` reports 435.8 kB, and that figure is wrong.** Vite emits the entry's
> references as `./assets/…`, and `check-bundle-size.mjs`'s scrape (`/(?:src|href)="\/?([^"]+)"/`)
> strips only a leading `/`, so `referenced` holds `./assets/x.js` while the `walk(DIST)` pass that
> follows yields `assets/x.js`. `referenced.has()` misses, the transitive-chunk branch counts it a
> second time, and **every JS chunk lands in the total twice** — 219.6 + 216.2 = 435.8, exactly.
> The gate has never fired wrongly because the error is conservative: it over-reports, against a
> budget with fourteen times the headroom either way — but the number P5-T02 was told to weigh audio
> against was double the real one, and the direction of the error means the conclusion below only
> gets stronger.
>
> **Fixed when this ADR was reviewed** (`scripts/check-bundle-size.mjs` now normalises `./` as well
> as `/`), and the corrected gate reports **219.7 kB**, which is this table's independently-derived
> figure to within rounding. The analysis above is left as written because it is the evidence for
> the fix, not a description of current behaviour.

**Recorded because P5-T02 named the payload budget, and it does not decide this.** It is the same
finding ADR-0019 made about draw calls, in the same place: the budget stopped being the binding
constraint somewhere around Phase 3, and answering a legibility question with an arithmetic that has
no opinion would be manufacturing a rationale. N-06 does not decide it either — procedural audio
makes no network call, which is exactly why *procedural* is the only shape that was ever on the
table.

### 4. What does bind: ADR-0006's allocation rule, and ADR-0011 §4

Two constraints are real, and only one of them is about cost.

**Allocation.** PRD §5 forbids per-frame allocation in the render path and
`test/architecture/layering.test.ts` enforces it ("only constructors and `ensure*` helpers allocate
typed arrays in the render path"). A WebAudio voice is an object per sound; at ADR-0017's measured
combat volume — p50 1 shot/tick, p95 6, max 33 — a node per event is an allocation storm on exactly
the frames that are already worst. This is a solved shape here, twice: `view/effects.ts` pools and
`view/alerts.ts` coalesces. Audio would have to do both. That is a known cost, not a blocker.

**Verification.** ADR-0011 §4 requires a deferred human gate to get "the strongest automated proxy
that is honestly available, and the proxy is never described as the criterion". **For audio there
is no proxy at all.** A silhouette at least has a distinguishability test that fails the cases a
person would obviously fail. A sound has nothing comparable: you can assert that a cue *fires*, and
that assertion tells you nothing about whether it *communicates*. Meanwhile **five playtest scripts
are written and unrun** (`docs/playtests/`, P1-T24 onward) and legibility is this project's declared
accumulated debt. Adding an unverifiable channel while the verifiable ones sit unmeasured spends
bridge width on a guess.

## Decision

**We will ship no audio, and PRD §5 is amended to say so rather than leaving audio in a phase scope
that nothing implements.**

1. **"Reuse upstream's procedural WebAudio" is formally off the table**, and the reason is recorded
   so it is not re-proposed: `sound.js` is outside the vendored boundary by ADR-0003's rule, and
   pulling it in would mean vendoring the 2D client — its DOM, its `boot.js`, its `renderEffects.js`
   — which is the whole thing this project exists to replace.

2. **`docs/planning/PARITY.md` (P5-T01) lists audio as *deliberately absent*, citing this ADR**, with
   the fifteen discarded event types named. Phase 5's exit criterion is a fully ticked parity
   checklist; an unticked row with no ruling is what would make that criterion a lie.

3. **The contract, when audio does arrive, is already decided and is written here** so the next
   attempt starts from the answer rather than from the question:
   - Audio is a **consumer of the snapshot**, on the view side of ADR-0008. It may not import the
     engine, for the reason `view/alerts.ts` states: a module that cannot see the simulation cannot
     leak it.
   - It is **pooled and coalesced**, on `view/effects.ts`'s and `view/alerts.ts`'s patterns, because
     PRD §5's no-per-frame-allocation rule applies to it exactly as it applied to tracers.
   - It is **procedural — oscillators and envelopes, no sample assets**, so N-03 and N-06 stay
     uninteresting and the Canvas2D tier loses nothing.
   - It is **off by default with a persisted setting**, in `app/settings.ts` alongside
     `tierOverride` and `edgeScroll` (P5-T10). A game that makes noise before it is asked is a game
     people mute at the operating system, and then the channel is gone.

4. **The events are not the audio decision.** If a future row widens the bridge for a *visual* need,
   it should widen it properly — one event channel, fog rule stated — and not decline to because
   "audio was cancelled". Two Phase 5 rows are already candidates: P5-T05 needs the Antimatter
   Gate's charge visible on both sides (`wonderCharging`, `rivalGateComplete`) and P5-T04 needs a
   favour's window visible before it expires (`neighbourHostile`).

## Consequences

**This makes easy:**
- P5-T01's ruling on audio, which is now a citation rather than an argument.
- Nothing else. This decision buys no capability; it declines to spend on one.

**This makes hard / gives up — and this is the real cost:**
- **The one information channel that adds nothing to the screen stays unused**, in a project whose
  single declared debt is legibility (ADR-0011) and whose whole justification for 3D was that it
  reads better. A HUD row competes for pixels with the battlefield; a sound does not. Every cue that
  loses the argument for screen space — and Phase 5 adds diplomacy, the Gate, milestones, relief and
  victory to a HUD that already has thirteen panels — is a cue audio could have carried for free.
- **N-05 will want this back.** "No information conveyed by colour alone" is an accessibility
  requirement, and Phase 6's accessibility row is where a non-visual channel stops being polish. The
  PRD's own Q-06 entry said *[Phase 6]* while its Phase 5 scope list said audio; this ADR resolves
  that contradiction in the direction the open-questions table already pointed.
- **`attackHit`'s discovery does not get acted on here** (§2b), and a purpose-built impact event
  keeps being thrown away every tick while a diff reconstructs part of it.

**Obligations it creates:**
- **A test that the sixteen event types are still sixteen.** This ADR's central number is a fact
  about vendored JavaScript that `scripts/sync-engine.mjs` can change in a single `--ref` bump with
  nobody noticing — the same exposure ADR-0019 pinned with its one-coordinate test, and the same
  fix. Without it, trigger 2 below rots instead of firing.
- P5-T01 must carry the ruling, not a blank.
- Any row that widens the bridge for an event states its fog rule in the same commit.

## The trigger, stated in advance

**This ADR is superseded when either of these happens:**

1. **A playtest reports a *missed* cue rather than a *misread* one.** The distinction is the whole
   trigger and it is the question the scripts must be made to ask: a player who says "I didn't
   understand what that was" has a silhouette or HUD problem, and audio would not have helped; a
   player who says "I didn't know that had happened" has a *notification* problem, which is the
   failure a sound fixes and the only one it fixes. Five scripts are written and unrun (ADR-0011);
   this is one of the things they are holding.
2. **The bridge widens for a second event type, for any reason.** At that point the marginal cost of
   audio collapses to the module itself — ~0.6 kB, measured — and this ADR should be **re-priced
   rather than re-argued**, because §3 already establishes that nothing in the budget objects.
   P5-T04 and P5-T05 are the likely occasions.

Note what is deliberately **not** a trigger: *"the game feels quiet."* It does, and that is the
argument this ADR was written to answer, with §2's table.

## Alternatives considered

### Vendor `sound.js` and reuse it — the option Q-06 names
Unavailable, and the reason is structural rather than incidental. `sound.js` is client code and
ADR-0003 draws the vendoring line at the simulation; the six upstream tests that reach for it are
already recorded as excluded. Vendoring it would mean vendoring what it is wired into —
`boot.js`, `main.js`, `renderEffects.js`, the 2D client's DOM — which is the codebase this project
replaces. Rejected as not on offer, which is what P5-T02 asked to have checked.

### Write a small procedural layer now, on the one event that crosses
The tempting cheap version: a pop on `snap.deaths`, a crack on `snap.shots`. Rejected because it
sounds the two things the screen *already* says loudest — a tracer and a blast mark are on screen at
that exact moment — and says nothing about the fourteen events that happen where nobody is looking.
It would ship the appearance of an audio system and none of its value, and it would make trigger 1
harder to read: a playtester who hears combat would report the game as "having sound", and the
missed-cue question would never get asked.

### Widen the bridge for all fifteen events now, then add audio
The thorough version, and the honest reason it loses is sequencing, not merit. Each channel needs a
fog rule (ADR-0021 §2 counts seven distinct ones already), a table, a `version` discipline and a
test — and the *visual* need for each is P5-T04's and P5-T05's to state, at which point the rule is
decided by someone who knows what the screen must show. Widening fifteen channels speculatively, for
a consumer that has never been verified to help, inverts that. It is also the largest single bridge
change in the project, proposed for the one feature with no automated proxy.

### Sample assets instead of procedural synthesis
Rejected on N-03 arithmetic that, unlike §3's, does bind eventually: a modest cue set is 200–800 kB
of compressed audio, which is 7–26 % of the whole payload budget for a channel that procedural
synthesis delivers for 0.02 %. It would also be the first asset pipeline in the project. Recorded
because it is what "add sound" usually means, and it is not what this ADR would ever have meant.

### Leave Q-06 open
The status quo, and it is what has happened for five phases. Rejected because an open question that
nobody is scheduled to close is indistinguishable from a decision to do nothing, taken silently —
and PRD §5's Phase 5 scope currently lists audio as in-scope, so the board and the PRD disagree
today. Deciding "none" makes the disagreement go away in the direction the evidence points; leaving
it open makes Phase 5's exit criterion unmeetable on a technicality nobody meant.
