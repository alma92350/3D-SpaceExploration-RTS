# Playtest script — the long game (Phase 5)

**Status: WRITTEN, UNRUN.** Under ADR-0011 a phase closes on its automated criteria and the human
gates are deferred into the standing table in `planning/TASKS.md`. This script is the deferred human
gate for Phase 5, written now, while the reasoning behind each cue is still fresh.

**It is the fifth unrun script, and that backlog is now itself the finding.** `mvp.md`, `economy.md`,
`combat.md` and `galaxy.md` are all written and none has met a tester. Five scripts asking questions
no machine can answer, deferred one phase at a time, is not four deferrals plus this one — it is a
project that has never once checked its work against a person. That belongs in Phase 6's planning as
a first-class item, not as a footnote at the bottom of a table, and this script says so here because
it is the last one that can.

## What this script is really testing

The first four asked whether a player can **play**. This one asks whether a player can **keep**
playing, and every task under it is one of two questions:

- **Can they tell that a run they think is lost is not?** The Odyssey has no defeat. A wiped-out
  player is sent a colony ship (`checkGalaxyRescue`) and the run continues. If that does not read,
  the player closes the tab — and a game that ends because the interface failed to mention it had
  not ended is the worst failure in this document.
- **Can they tell they are losing a race whose only mark disappears at the moment they lose it?**
  `checkRivalGate` ascends the rival's world and sets `galaxy.rivalGate = null` in the same breath,
  so `galaxyStatus().rivalGate` — which is the starmap's alert — goes quiet exactly when the race is
  lost. A galaxy where a rival won and a galaxy where nobody ever built one are the same picture on
  the map. P5-T05 found this by testing; only a person can say whether the replacement reads.

Everything else here — tribute's escalating price, a 90-second favour window, a score with three
components, a save slot's name — is legibility of the ordinary kind, and it is measured the way
Phases 2 and 3 measured theirs.

## Run this in its own sitting, and run task 1 before anything else in the project

**Not in the three-script afternoon.** `economy.md`, `combat.md` and `galaxy.md` are one sitting by
design and this is not a fourth: two of its scenes (a wipeout, a charged Gate) cannot be reached by
playing forwards inside a session, so this script runs on **prepared saves**, and a script that
starts by loading somebody else's game has nothing to gain from three hours of the tester's own.

Budget **50–60 minutes**. Take testers who have run the earlier scripts where you can — every task
except task 1 is better for it.

**Task 1 is the exception and it is severe: it must be the first thing a tester ever does with this
build, on a browser whose storage has never held this game.** The onboarding card retires itself on
dismissal *and* on the player having a base, so **every tester has exactly one first run, ever, and
running any other script first spends it.** A tester who has already seen the card cannot be used
for task 1 by clearing storage — they know what it said. Recruit for this: you need at least three
people who have never opened this build.

## Before the session — check these on the build under test

If any of these is not true, fix the build before booking testers. A script run against a build that
cannot show the thing being asked about measures the facilitator, not the game.

1. **The four campaign boards are on the starmap.** Open the starmap; a **Campaign** section lists
   Diplomacy, Antimatter Gate, Records, Saves & settings. Each opens on click and closes on the same
   button. *(`test/ui/phase5-wiring.test.ts` proves this mechanically — this is the human check that
   the build in front of you is that build.)*
2. **The onboarding card is on screen on a cleared browser** and is gone for good after "Got it",
   including across a reload.
3. **Save writes a slot that appears in the list** and can be loaded back.
4. **Prepared saves exist** — see Setup. Load each one before the tester arrives and confirm it opens
   on the state described.

## Setup — four prepared saves

Prepare these yourself, save each under the given name, and **verify each opens on the described
state**. Times are sim seconds shown on the HUD clock.

| Slot | State it must be in | What it is for |
|---|---|---|
| `WIPED` | Player holds **nothing anywhere**: no Command Center on any world, no undeployed colony ship. Save within **5 seconds** of the last base falling, so the relief cooldown is still visibly running. | Tasks 4, 5 |
| `RACE` | A rival Gate charging on another world, between **40 % and 60 %**, with the player holding no Gate and lacking at least one Strategic prerequisite. | Tasks 6, 7 |
| `LOST-RACE` | The same galaxy after `checkRivalGate` has ascended that world. **Nothing about the save may be edited by hand** — play it forward until it happens. | Task 8 |
| `MIDGAME` | Two worlds settled, a neighbour whose stance is inside the Wary band, credits **exactly 500**, and **no tribute yet paid**. | Tasks 9–12, 14–16 |

**Why 500 credits, exactly.** The first tribute costs `TRIBUTE_BASE_COST` = **200** and the second
costs `tributeCost` after one payment = **310**. So 500 buys one and not two, by ten credits. That is
the escalation made into a thing a player can walk into, and task 10 is the whole reason this number
is pinned rather than "enough".

## Tasks (do not read the parenthetical or the verdict lines to the tester)

**Start A — the first sixty seconds.** *(Cleared browser, no save loaded, nothing said. Hand it over
and start a stopwatch. Say nothing at all until they either found a base or two minutes elapse — not
even encouragement.)*

1. *(Say only: "Play.")* *(**The question every previous script has asked and none could test.**
   `mvp.md` task 1 has recorded "the tester does not know what to click" three scripts running, and
   the card is the answer to it. Do not name the card, do not point at it, and do not answer a
   question with anything but "whatever you think".)*
   - **Tests:** P5-T10 — the card, against S6's "work it out without documentation".
   - **Pass:** a Command Center is founded within **90 seconds** without the facilitator speaking.
   - **Fail:** longer, or any prompt was needed. Record the time: ____ s, and **record whether they
     read the card at all** — watch their eyes, not their mouse. A pass in which the card was never
     looked at is a pass for the game and a **fail for the card**, and it must be written down as
     one.
2. "What is on the screen telling you to do next?" *(Asked immediately after task 1, before anything
   is dismissed. The card marks one step with `▸` and the rest with `·` or a blank; a step the
   snapshot cannot honestly answer for — did you rotate the camera? — is deliberately blank rather
   than unticked.)*
   - **Tests:** whether `nextStepId` reads as "you are here".
   - **Pass:** they name the step the card marks with `▸`.
   - **Fail:** they name a different step, or read the whole list back. **Watch for**: reading a
     blank mark as "I failed that one" — record verbatim if it happens, because that is the exact
     failure the blank exists to avoid and it would mean it does not.
3. "Get rid of it." *(No further instruction. Then reload the page.)*
   - **Tests:** P5-T10 — a card that cannot be dismissed, or that comes back, is worse than none.
   - **Pass:** dismissed in one action, and **absent after the reload**.
   - **Fail:** they hunt for it, or it returns. A card that returns after a reload is a **stop-the-
     session bug**: end Start A, record it, and do not run tasks 4 onward with this tester — they
     have been taught the interface lies.

**Start B — the wipeout.** *(Load `WIPED`. Say: "You were playing this. You just lost your last
base." Then stop talking and watch for **60 seconds** before asking anything.)*

4. *(Ask nothing. Watch.)* *(**The most important observation in this script, and it is an
   observation rather than a task.** What you are recording is whether they reach for the browser's
   close button, the menu, or the game. Write down the first thing they do and the first thing they
   say.)*
   - **Tests:** P5-T07 — whether "you have lost everything but the run is not lost" reaches anyone.
   - **Pass:** they keep looking at the game and do **not** say any of "I lost", "it's over",
     "start again", "quit".
   - **Fail:** any of those, or they stop interacting. **Record the sentence verbatim.**
5. "Is this run over?" *(Now ask. The relief section is on the galaxy drawer without a button
   precisely for this moment; it says the run is not lost and counts down `RELIEF_COOLDOWN` = 20 sim
   seconds. But it is on the **starmap**, and getting there is part of the measurement.)*
   - **Tests:** P5-T07 — the cooldown as a rate limit rather than as a broken game.
   - **Pass:** "no", **and** they can say why — a ship is coming — within **20 seconds** of being
     asked.
   - **Fail:** "yes", or "no" with no reason, or longer than 20 seconds. Record where they looked:
     ____________. **If they never opened the starmap, that is the finding**, and it says the relief
     notice is on the wrong screen.
6. *(Let the ship arrive. Then:)* "Use it." *(**The dead-click check, on the one object in the game a
   player is sent rather than builds.** The relief ship carries a `g` id; until the codec fix a
   box-select over it selected nothing at all. That is fixed and tested, and this is the check that
   the fix is in the build a person is holding.)*
   - **Tests:** P5-T07 and the id codec, from the player's side.
   - **Pass:** selected and deployed. **Fail:** any click that appears to do nothing — **stop and
     record which gesture**, because it means a namespace is packed wrong again.

**Start C — the race.** *(Load `RACE`.)*

7. "Is anything working against you right now?" *(Nothing leading. The rival Gate carries a starmap
   alert and a charge readout.)*
   - **Tests:** P5-T05 — the race is a race only if the player knows they are in one.
   - **Pass:** they name the rival Gate, from the map or the board, within **30 seconds**.
   - **Fail:** anything else. Record what they name instead.
8. "How long have you got?" *(The board reports `secondsRemaining` from the rival's own charge rate.)*
   - **Pass:** a number, within a factor of two of the board's.
   - **Fail:** "no idea", or a number with no source. Ask where they read it and record: __________.
9. *(Load `LOST-RACE`. Say: "Same game, later.")* **"Has anything changed?"** *(**The task this
   script exists for.** `checkRivalGate` nulls its own record on ascension, so the mark the previous
   two tasks were about is **gone from the map**. The only thing that separates "a rival finished"
   from "nobody was ever racing you" is the `rivalAscended` latch on the Gate board. If that does
   not read, this build tells a player who has just lost the race that the race is off.)*
   - **Tests:** P5-T05's own finding, against comprehension.
   - **Pass:** they say a rival finished / won / built it, within **45 seconds**.
   - **Fail:** "no", "the threat is gone", "I'm safe now", or silence. **"The threat is gone" is the
     specific wrong answer to watch for and it must be recorded verbatim** — it is not a shrug, it is
     the interface having said the opposite of the truth.

**Start D — the neighbour.** *(Load `MIDGAME`. Open the Diplomacy board for them once, then hand it
over.)*

10. "Buy them off. Then do it again." *(**500 credits, 200 then 310.** The second refusal is the
    escalation arriving, and the question is whether the interface said it was coming.)*
    - **Tests:** P5-T04 — `tributeCost` shown rather than `TRIBUTE_BASE_COST`.
    - **Pass:** the second refusal surprises nobody: they can say, before or immediately after, that
      the price went up.
    - **Fail:** they read the second refusal as a bug, or as the same price being refused. Record
      which: ____________.
11. "How long does that buy you?" *(`APPEASE_TIME` = 120 s.)*
    - **Pass:** a number, or "about two minutes".
    - **Fail:** no source. Where did they look: ____________.
12. *(Wait for a favour to be asked — `FAVOR_INTERVAL` = 240 s, and not every roll produces one, so
    this may take two intervals. While waiting, run tasks 14–16, then come back.)* **"They want
    something. What happens if you ignore it?"** *(`FAVOR_WINDOW` = **90 seconds**, and the panel
    counts it down. An ask that expires with no visible clock is indistinguishable from one that was
    never offered — the row's own stated risk.)*
    - **Tests:** P5-T04 — the window, in the shape P4-T07's lane countdown established.
    - **Pass:** they say it expires, **and** can point at how long is left.
    - **Fail:** either half missing. **If the ask expires while they are still looking for the clock,
      record the elapsed time** — that is the measurement, not the answer.
13. *(If a favour is live and affordable:)* "Do it." Then: "What did that get you?"
    - **Pass:** they connect it to the stance or the goodwill pool.
    - **Fail:** "nothing" or "not sure". Goodwill is a decaying pool (`FAVOR_GOODWILL` = 0.15 against
      a cap of 0.8) and a reward nobody can see is not a reward.

**Start E — records and storage.** *(Still on `MIDGAME`.)*

14. "How well are you doing?" *(The Score board carries army, structures and bank separately because
    upstream's own comment says the breakdown exists "so a HUD can show WHY".)*
    - **Tests:** P5-T08 — a score with a reason.
    - **Pass:** a number **and** a component — "ahead, mostly on buildings".
    - **Fail:** a bare number, or "I can't tell".
15. "When does this end?" *(**Every galaxy world is created `endless`, so `rules.clock` is null and
    there is no time limit at all.** `DEFAULT_MATCH_TIME_LIMIT` = 2400 s is skirmish-only. The board
    says so in words.)*
    - **Tests:** P5-T08 — the absence of a clock, stated rather than left blank.
    - **Pass:** "it doesn't" / "when I end it".
    - **Fail:** they name a time limit, or they hunt for a clock. **A tester who invents a deadline
      has been told one by the layout** — record where they looked.
16. "What have you achieved so far?" *(Milestones. `DOMINATION_TARGET` = 4, and `MILESTONE_IDS` is
    five named ones plus the `world:N` family.)*
    - **Pass:** they read at least one reached milestone off the board.
    - **Fail:** they describe their own progress instead of the board's. Not a serious fail — record
      it as a note on whether the board is worth its space.
17. "Save this game, then load it back." *(Unassisted, both halves.)*
    - **Tests:** P5-T09 — save, list, load, as one round trip a person performs.
    - **Pass:** both, unassisted, within **60 seconds**.
    - **Fail:** either half. Record which: ____________.
18. *(After the load:)* "Is this the same game you saved?"
    - **Tests:** P5-T09 — whether a save row identifies a save. The row reads
      *Helix Belt · 2 worlds · 1,340 cr · 12m*.
    - **Pass:** yes, with a reason drawn from the row or the world.
    - **Fail:** uncertainty. **If they could not tell two saves apart, that is the finding**, and it
      is about the row's fields rather than about the round trip.

## Observations to record throughout

- **Every dead click.** Any gesture that appears to the tester to do nothing, with the screen and the
  object named. Phase 5 shipped a fix for two whole id namespaces that could not be clicked; the
  cheapest way to find the third is to write down every time somebody clicks twice.
- **Where they look for the campaign boards.** The four boards live behind the starmap. Every time a
  tester looks on the battlefield first, note it — four instances and the boards are on the wrong
  screen.
- **Anything they call a bug that is not.** Especially the second tribute refusal and the vanished
  rival mark. Both are the game working as designed and both are candidates for being redesigned
  anyway, which is a different sentence from "fix the bug".
- **Verbatim quotes for tasks 4, 9 and 15.** The three questions in this script whose wrong answers
  are informative in a way a tick box destroys.

## Gate rules

Written in advance, as Phases 2, 3 and 4's were, so a result cannot be argued into a pass afterwards.
Five testers, at least three of whom have never opened this build.

- **G1 — nobody quits a run they have not lost.** **5 of 5** pass task 4. This is the only gate in
  any script in this project set at five of five, and it is deliberate: the failure it guards is a
  player closing the tab on a game that was still going, which no later polish can recover. One
  tester saying "it's over" fails this gate.
- **G2 — the first sixty seconds work.** **4 of 5** found a base inside 90 seconds unprompted (task
  1) **and** 5 of 5 dismissed the card in one action and never saw it again (task 3). The second
  half is at five of five because a card that comes back is a worse outcome than a card that never
  helped.
- **G3 — a lost race is legible as a lost race.** **3 of 5** pass task 9. **If it fails, the fix is
  named here and this script does not get to improvise**: the Gate board's `rivalAscended` latch is
  already the only surface carrying the fact, so the change belongs on the **starmap** — the plate
  keeps drawing a mark on an ascended world, in a different state, rather than clearing it. That is
  a P6 row, and it is a change to `bridge/galaxy-snapshot.ts` and the plate, not to the panel.
- **G4 — the escalation is not a bug.** **4 of 5** pass task 10. Below that, the tribute button shows
  the next price on its face rather than in the panel beside it.
- **G5 — a favour has a visible clock.** **4 of 5** pass task 12. This is the row's own stated risk
  and the bar is the same one P4-T07's lane countdown met.
- **G6 — a save can be told apart from another save.** **4 of 5** pass tasks 17 and 18 together.

A gate that fails is a Phase 6 row with the fix named, not a re-run. A gate that cannot be scored
because fewer than three blind testers were in the room is **INCONCLUSIVE**, and the session is
re-run with blind testers rather than argued either way.

## What this script cannot test, and why

- **A ten-hour campaign.** Every scene here is loaded from a prepared save, which is the only way to
  put a tester in front of a wipeout or a charged Gate inside an hour. What that cannot measure is
  whether any of this holds up over the run it is actually for — whether the milestone board is worth
  opening at hour four, whether the score is still being read at hour six. That needs a diary study,
  it is out of scope for a scripted session, and it should be said plainly rather than implied by an
  hour-long script's silence.
- **Whether the Gate race is *tense*.** Task 7 and 8 measure whether it is legible. Nothing here
  measures whether it is exciting, and a legible race that nobody cares about is a different failure
  with a different fix.
- **The audio it does not have.** ADR-0020 rules audio out for now because the bridge discards the
  events it would speak for. Several tasks here — the relief ship arriving, a milestone firing — are
  exactly the moments a sound would carry, and their failure modes in this script are partly a
  measurement of that absence. Record it as a note under task 4 and task 16 if it comes up
  unprompted; do not ask about it.
