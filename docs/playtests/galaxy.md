# Playtest script — the galaxy (Phase 4)

**Status: WRITTEN, UNRUN.** Under ADR-0011 a phase closes on its automated criteria and the human
gates are deferred into the standing table in `planning/TASKS.md`. This script is the deferred human
gate for Phase 4, and it is written now, while the reasoning behind each cue is still fresh, rather
than reconstructed months later by someone reading the diff.

Phase 1's script asked whether the game reads. Phase 2's asked whether a player can run an economy
they cannot see the inside of. Phase 3's asked whether fifteen shapes are legible under time
pressure. All three were asked **on the battlefield**, which every tester had been standing on for
an hour by the time they were asked. This one is the first that is not: **the starmap is the first
screen in this project that is not the world under your feet, so the question it has to answer
before it answers anything else is "where am I".** Getting to it, knowing what it is showing, and
getting back out of it are three separate measurements: the first is the reachability check before
the session, and tasks 1 and 10 are the other two.

The second question is narrower and it belongs to an ADR. **ADR-0019 named this script as the thing
that can overturn it** — "P4-T12's playtest reports players cannot attribute a marker to a world on
the plate" is one of its two stated supersede triggers, and task 22 is the task that owns it. The
plate measured **5.219 % discordant against `jumpCost` with 0 marker collisions** (P4-T03), which
says the layout is separable by a machine. Nobody has measured whether it is separable by a person.
That is what this script is for, and it is why task 22 is written to be failed as easily as passed.

## Run this last, in the same sitting as `economy.md` and `combat.md` — and never first

Same afternoon, same tester, third of three, after the break. Budget **45–55 minutes** on top of the
other two.

**Why the same sitting.** Two reasons, and both of them are about what the earlier hours install in
a tester's hands:

- **"Where am I" is only a question if you have been somewhere.** The seat is drawn at 1.5× with a
  ring of its own precisely because it is the answer to the first question anyone asks of this
  screen. A tester who has never been on a battlefield has no *there* to recognise, so task 1 would
  measure nothing at all. It has to run after a session, not instead of one.
- **The plate does not orbit, and only a contaminated tester can test that.** ADR-0019 decision 3
  refuses yaw as a starmap control on `ui/minimap.ts`'s precedent. Whether that reads as *a diagram*
  or as *broken controls* is a question you can only ask of somebody who has spent two hours
  reaching for `,` and `.` on the battlefield and expecting the world to turn. Task 9 needs that
  reflex to already exist. A fresh tester who never tries to rotate has not passed the task; they
  have skipped it.

**Why last, and what that costs.** By the time this script starts, a tester has been working for
two and a half hours and is tired, and this is the screen where fatigue does the most damage: every
question here is a *reading* question and none of them is exciting. That cost is real and it is
being paid on purpose, because the alternative is worse — running the galaxy script first would put
the roster's names in a tester's head before `combat.md` and, more importantly, would spend the
"where am I" question on a player who has not been anywhere.

Mitigate it three ways. Take the full break first. Cut from the bottom of the named cut list below
rather than rushing. And accept that **a tester who is visibly out of patience should stop after
task 10** — the plate's own ten tasks are the half this phase actually rests on, and half a script
run honestly is worth more than a whole one run at the end of somebody's endurance.

**The one ordering rule inside this script.** Task 2 is asked before the facilitator has said a
single world's name out loud, and task 22 is asked last. They are the same measurement taken twice
on purpose — see task 22 — and putting either of them anywhere else destroys both.

## What this script is really testing

Phase 4 wrote down what it could not do, in an ADR and in six DONE rows' notes, and deferred the
measurement to here. Those admissions are why this script exists, and tasks 3–8, 12–15 and 17 are
aimed straight at them — eleven of the twenty-three. A script that skirted any of these would be a
friendlier document and a worthless one.

| Admission | Where it was taken on | What it might cost the player |
|---|---|---|
| **The plate is 5.219 % discordant with `jumpCost`** — a world can look nearer and cost more, and the stagger is why | ADR-0019 §3, P4-T03 | The screen's whole claim is "the axis IS the cost"; one ranked pair in twenty says otherwise |
| **The stance bar is banded nowhere** — monotone in the raw −1..1 number, no label, no tick, 22 px wide | P4-T03, ADR-0012 §5 | A bar can say *more* or *less* and still not say *hostile* |
| **A lane is periodic**: `runLanes` fires once per `LANE_PERIOD`, so ~398 of every 400 ticks show nothing moving — the board's own words are that it "reads as broken" | P4-T07 | A working route and a dead one look identical for nine seconds out of ten |
| **`COLONY_INCOME_CAP` is 6**, so the seventh income building on a colony earns exactly zero while still costing ore and ground | P4-T06 | A player expands into an annuity that stopped paying two buildings ago |
| **`snapLandingPoint` is not idempotent, and `landingZone` may discard the pick entirely** — a Spaceport on the destination overrules the click and the picker answers with a dead ring and a correction line | P4-T05 | The one screen whose only job is "choose where this lands" sometimes means "your choice was noted and ignored" |
| **Both alert codes draw the same 3 px dot** — `overlays2d.ts` ignores `waypoint.kind`, and the dot is the same green as the seat's own ring | P4-T03 (`ALERT_KINDS`) | The map says "look here" and never "and this is why" |
| **Colony income may still be inert** — `stepGalaxy` does not call `sweepColonies` and, at the commit this was written against, neither did `WorldBridge.step` | P4-T06, P4-T13 | The panel is right, the rate is right, and the money never arrives |

A tester who reads the plate fluently and then cannot tell a working freight lane from a broken one
has not had a bad session. That is the measurement this phase was waiting for.

## Before the session — check these on the build under test

Written while P4-T13 and P4-T14 were still in flight. Several of these will have moved; check, do
not assume.

- **Is there a way in at all?** At the commit this was written against, `view/starmap.ts`,
  `view/landing.ts`, `ui/colony-panel.ts`, `ui/lane-panel.ts` and `ui/jump-panel.ts` are complete,
  tested, mutation-proofed — and imported by nothing. No key, click or control in `app/game.ts` or
  `ui/hud.ts` opens any of them. **If the starmap cannot be opened, this entire script is
  UNREACHABLE, not FAIL** — a verdict about the build and not about the tester, and it belongs on
  the board the same day as a P4-T13 result. The same rule applies per screen: a picker with no way
  in makes tasks 11–13 UNREACHABLE and nothing else.
- **Is there a way to load a prepared galaxy?** `WorldBridge.save`/`load` exist; no control calls
  them. Every save below therefore has to be built with a short script through the engine's own
  functions and handed to the bridge, the way `test/bridge/galaxy-save.test.ts` builds its scenario.
  If the build under test has no injection path, say so and stop — the script is UNRUNNABLE, which
  is a different and more useful finding than a bad result.
- **Does colony income actually arrive?** Before the session, load Start C, note the credits, let it
  run 60 seconds of sim, and note them again. The three colonies are built to pay **5.1 credits/s =
  306 credits/min**. If the treasury does not move, `sweepColonies` is still unwired: task 14 is
  scored **INERT**, not FAIL, and what it measures is whether the tester notices the discrepancy.
  Either result is worth having; guessing which one you are in is not.
- **Run at 1280 × 720.** Every pixel figure in this script — the 99 px between the plate's tightest
  pair, the ~26 px marker radius, the 103 px and 217 px in task 4 — is measured at that viewport,
  which is the one `perf/starmap-probe.mjs` and the perf gate use. The authored view is a fixed
  target and distance, so a different window size reframes the plate and every number below drifts.
- **The build menu is now the engine's** (P4-T14), so a Spaceport, a Foundry and a Star Dock are
  buildable in play. That matters here only as a fallback: if the saves cannot be injected, a
  facilitator can reach a jump by playing, at roughly the cost P4-T11 measured — a Spaceport needs a
  Foundry, which with 342 credits of fuel is about 545 ore from a world that pays 1.7 a second.

## Setup

- Build under test: commit hash ______, tier auto-detected ______, machine ______.
- `npm ci && npm run dev`. Fixed seed, **Helix Belt** as the seat every time (ADR-0010), so reports
  compare — and so the price list and the pixel positions below are the ones the tester is looking
  at.
- At least one session with **no GPU** (`--use-gl=swiftshader --disable-gpu`). This is the first
  screen in the project where the Canvas2D path draws the *identical* picture rather than a reduced
  one (ADR-0019, consequences), so a difference between the two runs here is a bug and not a tier.
- **Four prepared saves.** None is a cold start; the cold start happened three hours ago.
  - **A — the plate.** Seat **Helix Belt**, one completed Tier-1 Spaceport standing on it.
    Discovered: Helix (seat), **Ferros Prime** (a colony you hold — five income buildings and one
    turret), **Nimbus** (contested: you were there, every player building is razed), **Glacius**
    (pacified — the neighbour's Command Center razed and in `galaxy.pacified`). A faction claim on
    **Forge Station** so one claim ring is on the plate. Stances, which only discovered worlds
    carry: Helix **+0.4**, Ferros **−0.7**, Nimbus **−0.2**, Glacius **+0.05**. Everything else
    undiscovered. **Verdani, Pyralis and Kybernet must all be undiscovered**, because a discovered
    world costs *zero* to jump to and tasks 3 and 4 are about the price of new ground. *Optional and
    worth the trouble if it can be done*: a **Rival Gate charging** on one background world, which
    puts a second alert on the plate and makes the extra question under "what this script cannot
    test" askable — `rivalGateStatus` reads `galaxy.rivalGate` and needs the building it names to
    still exist, so a hand-built one has to point at a real charging Gate.
  - **B — the approach.** Two openings of the picker, loaded one after the other. **B1: Verdani**,
    which you have never settled — no pad, so the pick is honoured and the snap is the only thing
    that moves it. **B2: Ferros Prime**, where your Spaceport stands, positioned well away from a
    distinctive ridge you will ask them to land on. The maps are 1600 × 1000; the approach grid is
    160 with a 100 margin, which is where tasks 12 and 13 live.
  - **C — the colonies, the money and the lane.** Seat Helix with its pad. Three background
    colonies: **Ferros Prime** at *five* income buildings plus a turret (below the cap by one),
    **Glacius** at *exactly six* (at the cap), **Nimbus** at *nine* (three standing buildings that
    pay nothing at all). **None of the three is pacified**, so the figure is buildings alone and the
    0.1/s occupation dividend is not in it. Counted total 5 + 6 + 6 = 17 buildings × 0.3/s = **5.1
    credits/s, 306 credits/min** — deliberately not a round number, so "it did not move" cannot be
    confused with a rounding illusion. One **Freight Lane** Helix → Ferros, crewed with one freighter
    standing
    inside `JUMP_LOAD_RADIUS` of the pad, with the source world stocked so the next run actually
    carries something. **Save it at a galaxy tick where `tick % 200 == 60`**, which puts the
    countdown at 140 ticks — **7.0 seconds** — from the next delivery. Standing orders: auto-sell
    **enabled with no floors at all** on Glacius, and a worker target of 8 stored **on Helix
    itself**, which is the seat and therefore inert.
  - **D — the stranded expedition.** Seat **Verdani**, reached by a jump, with an army on the ground
    and **no Spaceport built there**. Your Command Center still stands on **Helix Belt** — and
    nowhere else, since `playerFoothold` counts an undeployed colony ship too and a second one would
    light a second marker. This is P4-T04's own control-switch case: `canJumpTo` is false everywhere
    except Helix, so the plate dims nine markers and leaves one bright, and the jump home carries
    nobody.
- Five testers, at least two who have never played the 2D game — and here that split does more work
  than usual. **The 2D client has a starmap of its own, and its worlds are these worlds with these
  `x` values.** A veteran knows that Vesper is far out and Ferros is near in before they see
  anything, so their answers to tasks 2 and 22 are not evidence about this plate in either
  direction. Record who is who, on every attribution answer, and see G2.

**Rules for the facilitator:** say nothing beyond the prompts. Do not point at the screen except
where a task's prompt explicitly does. Do not answer "where do I click". And the rule this script
adds: **never say which marker is which.** Naming a world is fine where a prompt names one — that is
half the questions here — but pairing a name with a position, even once, ends tasks 2 and 22 for
that tester and for anybody in earshot. Task 4 is the one place a prompt pairs both, and it is
bounded on purpose: Pyralis and Kybernet sit in the middle of the plate, while task 22's cluster is
the three markers furthest to the left, and nothing said at task 4 helps there. Every question the
tester asks that you cannot answer is a finding — write it down verbatim.

**Controls, facilitator only — never read these to a tester.** As Phases 1–3, and note what is
*absent*: the plate has **no yaw control at all** (ADR-0019 decision 3), so `,` and `.` do nothing
on this screen by design. Whether a tester tries them is task 9.

**The price list, facilitator only.** `jumpCost` from Helix Belt, verified against the function and
not its comment. A world already discovered is **free** (0 credits); these are the new ones:

| Verdani | Pyralis | Kybernet | Ferros | Nimbus | Glacius | Forge | Korrath | Oort | Vesper |
|---|---|---|---|---|---|---|---|---|---|
| 342 (Δx1) | 342 (Δx1) | 364 (Δx2) | 387 (Δx3) | 387 (Δx3) | 409 (Δx4) | 431 (Δx5) | 498 (Δx8) | 520 (Δx9) | 564 (Δx11) |

And the same worlds by **screen distance from the seat**, at 1280 × 720, which is the number a
tester's eye is actually using: Kybernet **103 px**, Verdani **116**, Ferros **178**, Nimbus **190**,
Glacius **207**, Pyralis **217**, Forge **327**, Korrath **413**, Oort **467**, Vesper **578**. The
two lists disagree five times from this seat. That disagreement is the 5.219 %, and task 4 is one
pair of it.

*(A Tier-2 or Tier-3 pad multiplies every price by 0.85 or 0.7. It is a uniform multiplier, so it
changes the numbers and never the order — the saves above use Tier 1 so the printed figures match.)*

**If the sitting overruns**, cut in this order: 18, 16, 6, 12, 19. **Never cut 1, 3, 4, 14, 17 or
22** — the first five are what the phase's exit criteria rest on, and the last one is what an ADR is
waiting for.

## Tasks (do not read the parenthetical or the verdict lines to the tester)

**Start A — the plate.** *(Open it and hand it over. Say nothing about what it is. Everything in
this start is a first look, and there is exactly one of those.)*

1. "Where are you?" *(**The row's own question, asked in three words.** The seat is drawn at 1.5×
   scale with a 46 px highlight ring and full brightness while everything else is dimmer; that is
   three cues for one fact, and this is where they are worth what they cost. Time it.)*
   - **Tests:** P4-T03 / `worldScale` — the seat is the answer to the first question this screen is
     ever asked.
   - **Pass:** they point at the Helix marker within **10 seconds**, unprompted, and say it is where
     they were.
   - **Fail:** they point anywhere else, they ask what they are looking at, or they take longer than
     10 seconds. Record the time either way: ____ s.
2. "Point at Ferros Prime." *(**The control for task 22, and it must be asked before you have said
   any other world's name.** This measures whether the build gives a player *any* way to put a name
   on a marker — a hover, a label, a list — and how much work using it is. **Count the markers they
   hover or click before answering**, and write the number down; it is the datum, not the answer.
   If nothing on the screen names a world at all, stop, record UNREACHABLE, and see the note under
   task 22 — it changes what task 22 can conclude.)*
   - **Tests:** whether the plate has a name channel, and what it costs to use.
   - **Pass:** correct, in **2 hovers or fewer**.
   - **Fail:** wrong, or correct only after sweeping most of the roster. Markers touched: ____.
     **UNREACHABLE if nothing on the screen names a world.**
3. "You want to plant a colony somewhere new. Which world costs you the least to get to?"
   *(**ADR-0019 wrote this task into its own obligations**: "P4-T12's playtest script must ask
   'which world is the cheap jump?' and check the answer against `jumpCost`." Correct: **Verdani or
   Pyralis, both 342**. Ask it on the map, before anything is opened. If they name a world they
   already hold, they are not wrong about the price — a discovered world is free — but they have not
   answered the question: re-ask once, saying "somewhere you have never been", and record that it
   needed re-asking.)*
   - **Tests:** ADR-0019 decision 1 — "the axis IS the cost", from the player's side.
   - **Pass:** Verdani or Pyralis, from the map alone.
   - **Fail:** anything else. **Kybernet is the specific wrong answer to watch for**: it is the
     nearest marker on screen at 103 px and it costs 22 credits more than either right answer.
4. [Point at the Pyralis and Kybernet markers] "Those two. Which one is the cheaper jump?"
   *(**The 5.219 % made into one forced choice with a right answer.** Correct: **Pyralis, 342
   against 364** — while sitting at 217 px from the seat against Kybernet's 103, more than twice as
   far away on screen. This is the stagger's price being paid in front of you, and it is the single
   most informative question in this script about whether the plate's fidelity claim survives
   contact. Ask on the map. Then: "now open whatever the game gives you and tell me if you were
   right", and record whether the panel and the map agreed to the tester.)*
   - **Tests:** ADR-0019 §3 — 5.2 % discordance priced deliberately, measured against comprehension
     for the first time.
   - **Pass:** Pyralis, from the map.
   - **Fail:** Kybernet, or a guess. A coin-flip answer is a fail — **record which**, because five
     coin flips here and a pass on task 3 mean the axis reads as an axis but the stagger is
     eating it.
5. "What do those small bars over some of the worlds tell you?" *(**The stance bar, verbatim, and
   nothing leading.** It is 22 px wide and 3 px tall, monotone in the engine's raw −1..1 stance, and
   **banded nowhere**: `stanceLabel` and `PEACE_THRESHOLD` stop at the engine, so there is no
   "Hostile", no tick, no edge. Four worlds carry one in this save. Write the answer down word for
   word and do not react to it.)*
   - **Tests:** P4-T03 — "a stance change is visible without opening a panel" only if the thing
     being made visible is legible.
   - **Pass:** any answer in the *attitude* family — how they feel about you, whether they are
     friendly, relations.
   - **Fail:** health, population, industry, progress, "how developed it is", or a shrug. Record
     which wrong reading it was; a bar that reads as *health* is a different problem from a bar that
     reads as *nothing*.
6. "Sort those four worlds from friendliest to most hostile." *(Ferros **−0.7**, Nimbus **−0.2**,
   Glacius **+0.05**, Helix **+0.4** — so the true order is Helix, Glacius, Nimbus, Ferros, and the
   bar fills 0.70, 0.53, 0.40, 0.15 of its 22 px. A monotone map needs no thresholds to be true, and
   this is the question that checks the *true* part.)*
   - **Tests:** `stanceFraction` — monotone in the engine's own number.
   - **Pass:** the exact order, 4 of 4.
   - **Fail:** any inversion. An inversion between Glacius (0.53) and Nimbus (0.40) is the forgivable
     one — 3 px of fill apart — and an inversion involving Ferros or Helix is not.
7. "Point at the place on one of those bars where a neighbour stops being friendly and starts being
   hostile." *(**There is no answer on the screen, and that is the finding.** The engine's own bands
   — Hostile ≤ −0.5, Wary ≤ −0.15, Neutral < 0.25, Cordial < 0.6, Allied — live in `stanceLabel`,
   which is not exported past the bridge; the bar's *colour* changes at stance 0 and stance −0.5,
   which coincides with one of the five edges by accident and is relied on by nothing. Let them
   hunt. Record whether they find the colour change, and whether they trust it.)*
   - **Tests:** whether a monotone bar can carry a *state* as well as a rank.
   - **Pass (a genuine one exists):** they point at the red/amber colour change and say something
     like "here, where it goes red".
   - **Fail:** they cannot place it, or they place it in the middle of the bar because the middle
     looks like a middle. **This is a priced measurement, not a gate** — see the closing note under
     the gate rules.
8. "Is there anything on this map that needs you?" *(**The alert, which is a 3 px green dot** —
   `#7dffb0`, the same colour as the seat's own "you are here" ring — floating a few pixels above a
   52 px marker. Nimbus is contested, so exactly one dot is live in this save. Name no cue: do not
   say mark, dot, or alert.)*
   - **Tests:** P4-T03's alert channel — whether "look here" is loud enough to be looked at.
   - **Pass:** they find Nimbus unprompted and say something is wrong there.
   - **Fail:** they sweep the plate and give up; or they point at the **seat's ring** and read the
     "you are here" cue as an alert, which is the specific colour collision this question exists to
     catch. Record which.
9. "Have a look around this map." *(**The orbit question, and it needs the last two hours to work.**
   ADR-0019 decision 3: the plate does not orbit, on `ui/minimap.ts`'s precedent — "a minimap that
   rotated with the camera would be worse at its only job". So `,` and `.` do nothing here. Watch
   their hands. Whether they reach for the rotate keys is the datum; what they say when nothing
   happens is the finding.)*
   - **Tests:** ADR-0019 decision 3 — a diagram that refuses a control the battlefield has.
   - **Pass:** they pan or zoom, do not need to orbit, or try once and move on without remarking.
   - **Fail:** they report the controls as broken, or they keep trying. Record the verbatim
     sentence — **this one would go in an ADR**, because "it looks flat" is explicitly *not* a
     trigger and "the controls are broken" is a different complaint that nobody has priced.
10. "Go back to what you were doing." *(The third part of "where am I": getting out. No prompt about
    how.)*
    - **Tests:** P4-T13 — the screen is a place a player can leave as well as reach.
    - **Pass:** they are back on the battlefield within 15 seconds, unaided.
    - **Fail:** they cannot find the way out, or they reload the page. **UNREACHABLE if the starmap
      cannot be dismissed at all**, which is a build result and not a tester one.

**Start B — the approach.** *(Load B1 with the picker already open on Verdani. Say nothing about
what the rings mean, ever.)*

11. "Choose where your colony lands." *(Bare. Do they understand they are looking at a world they
    have never been to? Time to first click: ____ s.)*
    - **Tests:** P4-T05 — an approach view reads as a place, not as a menu.
    - **Pass:** they click on the ground and understand a choice has been made.
    - **Fail:** they ask what they are looking at, or they treat it as a map they can order units on.
12. "Put it as close to that corner as you can get." *(**The clamp band, and the thing that makes it
    interesting is that the game is right and looks wrong.** `snapLandingPoint` rounds onto a 160
    grid and *then* clamps 100 clear of the edge, so every click with x below 80 comes back at
    exactly 100 — the marker stops following the pointer and a dead ring opens up between the two,
    with a line across it. Let them keep clicking as long as they like.)*
    - **Tests:** P4-T05 — the correction cues read as a correction rather than as a fault.
    - **Pass:** they work out that the landing site is coarse and that there is an edge margin, and
      they stop trying to beat it.
    - **Fail:** they keep clicking; or they say the game is ignoring them, or that the cursor is
      broken. Verbatim: ____________________.
13. [Load B2 — Ferros Prime, where their Spaceport stands. Point at a ridge across the map] "Land
    the colony on that ridge." *(**The honest one, and the hardest thing this screen has to say.**
    `landingZone` prefers a player Spaceport and **discards `landingPoint` entirely** when one
    stands, so the answer to this instruction is *no*, and the picker says so with three cues at
    once: a live ring at the pad, a dead ring on the ridge, and a line between them. The panel says
    it in words too — "Your mark is ignored: a Spaceport stands here and the landing homes in on
    it." Ask them to say what will happen **before** they confirm anything.)*
    - **Tests:** P4-T05's central claim — the picker never promises a landing the engine will not
      honour.
    - **Pass:** they say the colony will not land on the ridge, and they can say why — because there
      is already a pad down there.
    - **Fail:** they believe the colony lands on the ridge; or they read the two rings and the line
      as a bug, a loading state, or a range. **A tester who confirms the jump still expecting the
      ridge is the failure this whole row was built to prevent**, and it is worth an ADR note rather
      than a task.

**Start C — the colonies, the money and the lane.** *(Hand it over on the starmap, then let them
open whatever they find.)*

14. "You have three worlds working for you. How much are they paying you?" *(**The cap's whole
    reason for existing, asked as a number.** The true figure is **5.1 credits/s — 306 a minute**.
    Take their answer, then watch the treasury for 60 seconds together and compare. Two different
    failures live here and they must not be merged: a tester who cannot find the number, and a
    number that is right while the treasury does not move.)*
    - **Tests:** P4-T06 — `sweepColonies`' income reaches a place a player can read.
    - **Pass:** they give a per-minute or per-second figure from the screen, **and** the treasury
      moves by roughly that in 60 seconds.
    - **Fail:** they cannot find a rate, or they count buildings by hand.
    - **INERT (neither pass nor fail):** the tester reads the rate correctly and **the treasury does
      not move**. That is `sweepColonies` still unwired — P4-T06 found it and P4-T13 owns it — and
      what it measures instead is whether the tester notices. **Record whether they noticed
      unprompted**, because a player who watches a stated income never arrive and says nothing is
      the more alarming of the two results.
15. "You are going to go out to one of those three colonies and put up one more building there. Which
    colony, and does it matter what you build?" *(**The cap as a decision, asked as a decision** —
    a colony is a world you are not standing on, so nothing can be built here and now, and the panel
    is a planning number rather than a button. Ferros has five income buildings and one more pays the
    full **0.3/s**; Glacius has six and is at the cap, where one more pays **exactly zero**; Nimbus
    already has three standing buildings past the cap that pay nothing at all. And a **turret pays
    nothing anywhere** — `incomeBuildingCount` excludes it, because a turret wall is not an economy.
    Both halves of the question, and do not prompt for the second.)*
    - **Tests:** P4-T06 — "what one more building is worth, shown *before* the ore is spent rather
      than after the counter stops moving".
    - **Pass:** Ferros, **and** they say a turret would earn nothing — the second half unprompted.
    - **Fail:** Glacius or Nimbus (the cap is invisible to them), or "it doesn't matter what you
      build" (the turret exclusion is). **Score the halves separately**: the cap and the exclusion
      are two different numbers on the panel and a build that fails one may pass the other.
16. "You are thinking about settling a fifth world. Is it worth it?" *(No right answer, and that is
    fine: what is being measured is whether the answer is made of numbers off the screen. A colony's
    ceiling from buildings alone is `0.3 × 6` = **1.8/s, 108 a minute**, and the panel states the
    rate, the cap and the per-colony ceiling.)*
    - **Tests:** whether the cap is a fact a player can plan against rather than one they discover.
    - **Pass:** they answer with a number they read — the ceiling, the marginal rate, or the
      fuel price against it.
    - **Fail:** "more is always better", or they answer from the ore cost alone.
17. [With the lane panel reachable, 7.0 seconds before the next delivery] "Is that shipping route
    working, or is it broken?" *(**The periodicity question, and it is written so the answer can be
    no.** `runLanes` fires once every `LANE_PERIOD` = 200 ticks = 10.0 seconds and does absolutely
    nothing in between, so ~398 of every 400 ticks show a route where nothing moves. The board's own
    words are that this "reads as broken". The countdown is the fix under test. Follow up
    immediately with: **"when will something next happen?"** and hold them to a number.)*
    - **Tests:** P4-T07 — a clock that turns "nothing is happening" into "nothing has happened for
      nine seconds and will in one".
    - **Pass:** they call it working **and** place the next delivery within **±3 seconds**.
    - **Fail:** they call it broken, or say nothing is happening, or cannot say when the next run is.
      **Both halves are required**: "it's working, I don't know why" is a fail, because it is a
      guess about a route rather than a reading of a clock.
18. "If you jumped off this world right now, who would come with you?" *(`jumpManifest` fills the
    hold **closest to the pad first and skips** a unit that does not fit rather than stopping at it,
    so who gets left is not "the last one" and cannot be guessed from a total. And the lane's
    freighter is standing at that pad as infrastructure — `stagedRiders` skips a lane-booked ship on
    purpose, so it is on neither list. Ask before they commit to anything.)*
    - **Tests:** P4-T04 — the manifest is reported whole, riders *and* overflow, before committing.
    - **Pass:** they can name who is going and who is staying, without launching.
    - **Fail:** they can only say how many; or they expect the lane's freighter to come along.
19. [The Glacius standing order — auto-sell on, no floors] "That colony is set to sell its surplus
    and it never sells anything. Why?" *(A standing order stored perfectly that does nothing.
    `runAutoSell` walks the floors, and with no floor configured there is nothing to walk — the
    panel says so in as many words. There is a second one in this save if there is time: the worker
    target stored on **Helix itself**, which is the seat, and `runColonyPolicies` acts on background
    worlds only.)*
    - **Tests:** P4-T08 — "why is nothing happening" is the only question this panel ever gets, and
      it is answered rather than left to be discovered.
    - **Pass:** they find the warning and can restate it.
    - **Fail:** they conclude the feature is broken, or they start changing unrelated settings.

**Start D — the stranded expedition.** *(Verdani, an army, no pad. Load it and hand it over on the
starmap.)*

20. "Where can you go from here?" *(**The one save where the brightness channel carries anything.**
    `canJumpTo` is not "do I have a Spaceport" — without a pad you can still fall back to a world
    where you hold a foothold, which here is Helix Belt alone. So nine markers draw at shade 0.5 and
    one draws at 0.9. That is the plate's answer; whether it is anybody else's is the question.)*
    - **Tests:** `worldShade` / `canJumpTo` — reachability as a visible channel.
    - **Pass:** Helix Belt, and only Helix Belt, from the map.
    - **Fail:** they name a dim world, or they say they can go anywhere, or they cannot tell the
      bright marker from the dim ones at all. Record which — "I can't see a difference" and "I can
      see it and don't know what it means" are two different fixes.
21. "Take your army home." *(**The trap P4-T04 flagged and the reason `fallback` is on every
    destination.** A fall-back is a control switch, not a launch: with no Spaceport here there is
    nothing to load a fleet from, so `jumpCapital` moves **no units at all** and the army stays
    standing on Verdani. Ask them what they expect to happen **before** they commit, then let them
    do it, then ask where the army is.)*
    - **Tests:** P4-T04 — a fall-back reads differently from an ordinary jump, before it is taken.
    - **Pass:** they say the army stays, or they refuse the jump and go and build a Spaceport first.
    - **Fail:** they expect the army to travel. Record the verbatim reaction after the jump — a
      player who has just abandoned an army and does not know it is the most expensive misreading
      available on this screen.

**Closing.**

22. [Reload **Start A** — the plate they have spent the session learning — and point at the three
    markers furthest to the left, which lie in a diagonal] "One of those is Korrath, one is Oort
    Reach and one is Vesper. Match them up." *(**The task that owns ADR-0019's supersede trigger,
    asked last on purpose.** Those three are undiscovered in every save here, so they draw at 0.7× in
    neutral with no ring, no bar and no dot — **nothing distinguishes them but where they are**,
    which is exactly the claim: "a starmap marker's identity is WHERE IT IS. The player is looking
    for Ferros, and Ferros is the fourth marker from the left." Korrath–Oort is **115 px** and
    Oort–Vesper **132 px**: the two tightest same-status pairs the authored view produces, with
    nothing on either marker to tell them apart. Asked last because attribution-from-position is a
    claim about a **learned** plate — asked cold it measures the tooltip, and the tooltip was already
    measured in task 2. **Do not let them hover.** Ask for all three, then let them check.)*
    - **Tests:** ADR-0019's stated trigger 2 — "P4-T12's playtest reports players cannot attribute a
      marker to a world on the plate."
    - **Pass:** **3 of 3**, from the plate, with no hovering. Under pure guessing this happens 1 time
      in 6, which is what makes a pass mean something.
    - **Fail:** 2 or fewer, or three right only after hovering. **Record the route and the tester's
      own words.**
    - **What a fail costs, stated in advance:** see **G2**. This is the one result in this script
      whose consequence is an ADR being superseded rather than a task being filed, so it is scored
      more carefully than anything else here, and it cannot fire on its own.
23. "What did this screen never tell you that you wanted to know?" *(Verbatim, unbounded, last
    question of the day. The three most likely answers are already known and none of them is drawn:
    what a jump costs, whether you can afford it, and what a faction's claim ring means — colour
    carries the claim's owner and there are three owner slots against five factions, so the plate
    deliberately does not name one.)*

## Observations to record

| Question | Answer |
|---|---|
| Time to find the seat, task 1 | |
| Markers hovered before naming Ferros Prime (task 2) | |
| Cheapest new jump named (task 3), and did it need re-asking? | |
| Pyralis vs Kybernet — correct? Guessed? (task 4) | |
| What did they say the stance bar was, verbatim (task 5) | |
| Stances sorted correctly, out of 4 (task 6) | |
| Did they find the friendly/hostile line? Where? (task 7) | |
| Did they find the alert unprompted? Did they read the seat ring as one? (task 8) | |
| Did they try to rotate the plate? What did they say? (task 9) | |
| Time to leave the starmap (task 10) | |
| What did they say the dead ring and the line were, verbatim (task 12) | |
| Did they believe the colony would land on the ridge? (task 13) | |
| Colony income: their figure, the true 306/min, and did the treasury move? | |
| The cap half and the turret half (task 15) — which did they get? | |
| Lane: working or broken, and next delivery within ±3 s? (task 17) | |
| Did they expect the lane's freighter on the manifest? (task 18) | |
| Reachable worlds named from the plate (task 20) | |
| Did they expect the army to come home? (task 21) | |
| Worlds matched to markers, out of 3 (task 22) — blind tester or 2D veteran? | |
| Frame-time HUD, worst reading on the plate | |
| Canvas2D run: any difference from the WebGL run at all? | |
| What did they ask that the interface should have answered? | |
| One-sentence summary of how it felt to be off the battlefield | |

## Results log

| Date | Build | Tester | Blind? | Seat /s | Task 22 /3 | G1 | G2 | G3 | G4 | G5 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

## Gate rules

Written in advance, as Phase 2's and Phase 3's were, so a result cannot be argued into a pass
afterwards.

- **G1 — you know where you are.** **4 of 5** testers point at the seat within 10 seconds,
  unprompted (task 1), **and** 4 of 5 leave the starmap unaided (task 10). Four rather than three,
  and this is the only gate in this script set above the usual bar: the seat is drawn at 1.5× with
  its own ring and full brightness — three channels spent on one fact — and a screen that costs
  three channels to answer its first question should answer it four times in five.
- **G2 — a marker is a world.** **3 of 5 testers score 3 of 3 on task 22.** Failing it is ADR-0019's
  supersede trigger — the one result in this script whose consequence is an accepted ADR being
  overturned — so it is the only gate here with conditions on when it is allowed to fire, and all
  three must hold:
  1. **A name channel existed.** Task 2 was not UNREACHABLE. A plate on which nothing anywhere names
     a world is an **untested** layout, not a falsified one: the tester never had the chance to learn
     which marker was which, so task 22 measured nothing about position. That failure belongs to
     **P4-T13**, it is filed there, and firing an ADR trigger on it would supersede a decision nobody
     had measured.
  2. **Fewer than 3 of 5 scored 3 of 3**, with the route recorded for each — a three-of-three reached
     by hovering is not a pass, and it is a different finding from a wrong answer.
  3. **The score is recounted over the blind testers alone, and there were at least two of them.**
     A 2D veteran knows this roster and its `x` ordering from upstream's own starmap, so prior
     knowledge can only ever inflate a score: a veteran's **pass** is not evidence about this plate,
     while a veteran's **failure** is (someone who already knows the roster and still cannot place a
     marker has said something). So discount the passes, keep the failures, and require that fewer
     than half the blind testers scored 3 of 3. With fewer than two blind testers in the room the
     result is **INCONCLUSIVE** — the trigger neither fires nor is cleared — and the session is
     re-run with blind testers rather than argued either way.
  **When it does fire**, the ADR names what to do and this script does not get to improvise: a wider
  stagger and labels, re-measured with `perf/starmap-probe.mjs` — which is committed for exactly
  this — and **not 3D**, which measured 37.6–45.9 % discordant against the plate's 5.219 % and added
  marker collisions no overlay in either renderer can disambiguate. It is an ADR, not a task, and
  the re-measurement goes in it.
- **G3 — the axis is the cost.** 3 of 5 name Verdani or Pyralis as the cheapest new jump (task 3),
  **and** 3 of 5 get the Pyralis/Kybernet forced choice right (task 4). Both halves. Passing 3 and
  failing 4 is the specific, interesting outcome: it means the axis reads as an axis and the stagger
  is eating the reading at short range, which is the 5.219 % arriving in a person's answer instead
  of in a test. **That result is the argument for re-running the probe with a wider stagger**, and it
  is the same fix G2 calls for, which is why the two are worth reporting together.
- **G4 — money is legible before it is spent.** 3 of 5 name Ferros on task 15's first half (the cap),
  **and** 3 of 5 give a figure they read off the screen on task 14. The turret half of task 15 is
  recorded and not gated: the exclusion is a rule of the engine's that the panel repeats, and one
  question is too thin a basis for a gate on it. If task 14 came back **INERT** this gate still
  stands on its other half — the cap, the marginal rate and the per-colony ceiling are readable
  whether or not the treasury is moving, and letting a wiring bug excuse a legibility result would
  hide the second behind the first.
- **G5 — a periodic lane does not read as a broken one.** **4 of 5**, not 3, call the lane working
  and place the next delivery within ±3 seconds (task 17). Four, because the board already states
  that a lane with nothing moving "reads as broken" — that is the prior, not the hypothesis — and a
  countdown that rescues it three times in five has not rescued it.

**And two measurements that are deliberately not gates.**

**The stance bar (tasks 5–7).** The bar is monotone and banded nowhere, and P4-T03 says why: the
five bands live in `stanceLabel` behind `PEACE_THRESHOLD`, neither is exported past the bridge, and
a threshold invented above the bridge would be a second answer to a question the simulation already
answers (ADR-0012 §5). So the script's job here is to **price** the gap, not to discover it. If 4 or
5 testers can rank the bars (task 6) and 4 or 5 cannot place the friendly/hostile line (task 7), the
finding is precise: **the bar carries a rank and not a state**, and the fix is to carry
`stanceLabel`'s own answer across the bridge — the engine's word, on the engine's thresholds — not
to band the bar above it. That is an ADR against the bridge's surface, with the tester count
attached.

**The alert dot (task 8).** `overlays2d.ts` ignores `waypoint.kind`, so a lost colony and a rival
Gate charging draw the identical 3 px dot in the same green as the seat's ring. P4-T03 recorded that
rather than leaving it to be found by squinting. If testers miss the dot, or read the seat ring as
an alert, the number prices a new `OverlayKind` — which means `OVERLAY_STRIDE` and all three
renderer implementations, which is why nobody has spent it yet. Report the count, not a verdict.

A failure is not a blocker on its own. It is a task, filed on the board before the gate is declared
met — and for G2, for the stance bar and for the alert dot it is an ADR, not a task.

## What this script cannot test, and why

Named here so that a green run is not read as more than it is.

- **Whether the background simulation is running.** P4-T10 measured it — 2.3 ms per background
  world-step, ~0.19 ms per world per frame amortised, and a ~7 ms lump on the frame that carries the
  galaxy tick. A tester cannot see a world they are not standing on. If somebody says "nothing seems
  to be happening out there", that is a finding about **feedback** — about what the galaxy fails to
  show of its own life — and it is not a finding about `stepGalaxy`. Only the perf row can settle
  the first and only `hashGalaxy` can settle the second.
- **The 5.219 % as a rate.** The probe measures every seat against every pair of destinations — 11
  seats, every pair from each. This script measures **one** ranked pair per tester (task 4) and one
  cheapest-of-the-seven-new-worlds (task 3), from one seat. A tester getting Pyralis right does not
  mean the plate is 5.2 % wrong to a person; it means one pair read correctly. Do not report task 4
  as a discordance figure.
- **That the two alert codes are indistinguishable, unless a Rival Gate can be arranged.**
  `ALERT_RIVAL_GATE` and `ALERT_LOST_COLONY` pack into `waypoint.kind` and both draw the same dot
  because `overlays2d.ts` ignores that field — which is read off the source, not seen. Start A raises
  one alert, not two. If the facilitator can get a Gate charging on a background world as well
  (`galaxy.rivalGate`, and `rivalGateStatus` needs the building to still exist), ask the extra
  question — "those two marks: do they mean the same thing?" — and note that it is **rigged to
  fail**, so it prices the missing `OverlayKind` and settles nothing. If they cannot, say so: the
  defect stays a source reading.
- **`galaxyStatus` reporting `income: 0` for a pacified colony that is earning.** P4-T06 found it —
  measured at 60 credits/min against a reported 0, because `else if (pacified)` short-circuits
  before the income branch — and the panel deliberately does not forward that field. So the wrong
  number is not on screen for a tester to catch, and neither is the right one. It is an engine
  defect, reported and not fixed (ADR-0003), and no human can see it from here.
- **A world's price book drifting across a save and reload.** The other engine defect P4-T09 pinned:
  a world that has been fought over reloads with every commodity quoted off a different book
  (radioactives base 29 → 31, ~7 %, growing with accumulated wreckage). Invisible without two price
  books side by side, and the tests are where it lives.
- **Anything with no way in.** If the starmap, the picker or any panel comes back UNREACHABLE, this
  script has measured that DONE rows are not reachable by a player — a real and useful result, and
  not a legibility one. It goes on the board as a P4-T13 row, and none of the gates above may be
  declared met from a session that could not open the screen they are about.
- **N-05, unless the five happen to include a colour-blind tester.** The plate leans on colour more
  than any screen before it: three owner slots carry claim, seat and neighbour; the stance bar's
  only state cue is a colour change at two of five band edges; the alert dot and the seat ring are
  the *same* green. Scale and position are the second cues and they do not cover all of that. If
  nobody in the room needs the check, the claim is untested and "nobody had trouble" is a false
  green. **Record who was in the room.**
- **The snap's worst case, if task 12 is cut.** `snapLandingPoint` is non-idempotent on 161 of 1601
  x-values — the whole clamp band, where a click at x = 30 displays at 100 and re-snaps to 160 — and
  a tester who never clicks near an edge never meets it. Task 12 is the only thing in this script
  that forces it, which is why it is fourth on the cut list and not first.
- **What a jump costs, and whether it can be afforded, from the plate alone.** `jumpCost` crosses on
  the world table and is never drawn; affordability is not a channel at all. Tasks 3 and 4 measure
  whether the *axis* substitutes for the number, which is ADR-0019's actual claim — they do not
  measure whether a player can budget, and a green G3 must not be read as though they did.
