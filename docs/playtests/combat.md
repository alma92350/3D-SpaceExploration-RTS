# Playtest script — combat (Phase 3)

**Status: WRITTEN, UNRUN.** Under ADR-0011 a phase closes on its automated criteria and the human
gates are deferred into the standing table in `planning/TASKS.md`. This script is the deferred gate
for Phase 3 — the *blind readability test* PRD §5 names — and it is written now, while the reasoning
behind each cue is still fresh, rather than reconstructed months later by someone reading the diff.

Phase 1's script asked whether the game reads. Phase 2's asked whether a player can run an economy
they cannot see the inside of. This one asks the question those two were rehearsing for: **when
fifteen shapes are moving at once and some of them are lethal, does a player know what they are
looking at in time to act on it?** Every cue here is spent under time pressure, which is the one
condition neither earlier script tested.

## Run this in the same sitting as `docs/playtests/economy.md`

Not the same week — the same sitting, same tester, same afternoon, economy script first.

**Why.** Both scripts measure one thing: the silhouette debt this project has accumulated in every
phase and never once paid down until Phase 3. Phase 2 put thirteen entity types on shared shapes
(ADR-0013, ADR-0014); Phase 3 added nine of its own and left one collision standing (P3-T03). That
is a single running total, and a running total measured twice, months apart, on two different
afternoons, is two numbers that cannot be added together.

The specific damage of splitting them is **vocabulary leakage**. A tester who did the economy script
last month arrives already knowing that a dashed ring is not a selection, that shapes come in
families, that a badge means something. They will read the guard aura correctly and it will prove
nothing, because they are no longer blind — and blind is the entire specification.

**The order, and the contamination it admits.** Economy first, for three reasons: its Start A is a
cold open and is the only measurement in this project of a first-ever session, which must not be
spent on a fight; Phase 3's debt sits *on top of* Phase 2's, so the tester should meet them in the
order the game hands them over; and the leak between the two runs one way only. Economy tasks 6 and
7 teach a tester that **shared silhouettes exist in this game** — which makes task 15 below (two
defence buildings, one shape) *easier* than a cold read. So on task 15, **a pass is weaker than it
looks and a failure is worse than it looks.** Record it that way.

Budget about 60 minutes for this script on top of the economy script's, plus a break. During the
break the facilitator answers nothing. The break is when the questions get asked.

## What this script is really testing

Phase 3 wrote down what it could not do, in ADRs and in board rows, and deferred the measurement to
here. Those admissions are the reason this script exists, and tasks 6, 12, 14, 15, 16 and 21 are
aimed straight at them. A script that skirted any of these would be a friendlier document and a
worthless one.

| Admission | Where it was taken on | What it might cost the player |
|---|---|---|
| **`bastille` (32 dmg / 115 range) and `torpedobattery` (55 / 180) are the same silhouette** and differ only in reach | P3-T03, still PARTIAL | The thing that shoots hardest looks exactly like the thing that does not |
| **A crater is proportion, not depth** — the widest and flattest thing on the ground, because a concave bowl measured 60 triangles against a budget of 30 | P3-T09, ADR-0018 | The most consequential event in a match may leave a mark that reads as terrain |
| **The Colony Ship's mesh overflows its own selection ring**, 22.11 against 17.55 | P3-T02 | Either nobody notices, or the first thing a player ever selects looks broken |
| **Two silhouette pairs were near-collisions** — freighter/aegis at 0.065, mender/ranger at 0.185, both caught only after the metric was corrected and both reshaped | P3-T02 | A reshape that satisfies a number need not satisfy an eye |
| **The Mender and the Helium Bomb both have no attack** — one heals, one detonates for 3 000 damage | ADR-0016 | "The most expensive misread in the game, in both directions" |
| **Being shot from unexplored ground draws no tracer** | ADR-0017 §4 | A player under fire from the dark gets no line to follow, by design, and will read it as a bug |

A tester who sails through the fight and stalls on the ground afterwards has not had a bad session.
That is the measurement the phase was waiting for.

## Before the session — check these on the build under test

Written while P3-T14 was still in flight. Three of these may have moved since; check, do not assume.

- **Every unit draws as itself.** Load the line-up save and count fifteen distinct shapes. If a
  Dreadnought is a Worker, `meshIdForType` is falling back again (ADR-0016's obligation) and the
  session is measuring the wrong build. Stop and file it.
- **Formations, escorts and control groups need an affordance a tester can find.** P3-T11/T12/T13
  are wired at the bridge (`src/bridge/commands.ts`, `src/input/control-groups.ts`) — which is not
  the same as reachable. At the commit this was written against, `ControlGroups` is not referenced
  outside its own module and no panel in `src/ui/` mentions a formation or an escort. **If there is
  no way in, tasks 18–20 are UNREACHABLE, not FAIL** — a verdict about the build, not the tester,
  and it belongs on the board the same day.
- **The alert system (P3-T14) was TODO when this was written.** If it has not landed, task 17 is
  UNREACHABLE. Judge it against the row's own definition: *exactly one* alert per event a player must
  act on, positioned, dismissible, and none at all for an event the player cannot see.
- **Salvage and craters take time to appear.** A wreck matures 45–150 sim-seconds after the death
  (`WRECK_SPAWN_DELAY` / `WRECK_MAX_DELAY`) and a crater 60 after the blast (`CRATER_SPAWN_DELAY`).
  A save taken the moment a fight ends has neither in it. Build the Start B save early enough, then
  reload it and confirm with your own eyes that the ground has something on it.

## Setup

- Build under test: commit hash ______, tier auto-detected ______, machine ______.
- `npm ci && npm run dev`. Fixed seed, **Helix Belt** every time (ADR-0010), so reports compare.
- At least one session with **no GPU** (`--use-gl=swiftshader --disable-gpu`). Note the frame-time
  HUD during the fight in Start C: P3-T16 gates a representative frame at budgeted counts, and a
  live fight is the thing it is a proxy for.
- **Four prepared saves.** None of them is a cold start — the cold start is the economy script's job
  and it already happened an hour ago.
  - **A — the line-up.** One of every unit type, player-owned, standing still, spread on open
    ground, nothing hostile on the map. Note that the four freight types share one hull by design
    (ADR-0014): a tester calling a Bulk Freighter a Hauler is **correct**, not confused.
  - **B — the ground.** A battlefield the tester did not fight on. In one view: a matured salvage
    pile, a crater, an ordinary ore seam and a volatile deposit. Nearby, all four static defences —
    `turret`, `bastille`, `torpedobattery`, `aegisbastion` — with the Bastion's aura live.
  - **C — the fight.** Two armies of mixed types in contact, and the tester's base a screen away
    from them. Also park an enemy **Colossus** alone in ground the tester has never explored, beside
    something worth walking to. Its 185 range and 185 aggro reach well past a Worker's 110 sight or
    a Skiff's 160, so it opens fire from outside its victim's own vision — which is the arrangement
    task 15 needs, and it needs no second human player to set off.
  - **D — the bomb.** An enemy Helium Bomb parked within blast range of the tester's army and in
    their **live vision** — an enemy's rings appear only once its fuse is lit and only on live
    sight, so a bomb across the map shows nothing. Save it with `fuseUntil` set to fire about four
    seconds after load, so the warning starts when the facilitator loads it and no second human
    player is needed. Elsewhere on the same save, a **player-owned bomb, armed but not fused**,
    standing among the tester's own units: a player's own armed bomb shows its rings permanently,
    which makes that ring mostly a picture of their own army standing inside it.
- Five testers, at least two who have never played the 2D game. All five will arrive having just
  done the economy script — **none of them is blind to the building vocabulary, and that is the
  trade the same-sitting rule buys.** Note it against every answer that touches a building.

**Rules for the facilitator:** say nothing beyond the prompts. Do not point at the screen. Do not
answer "where do I click". And the one this script adds: **never name a unit.** Not once, not in
passing, not in the break. The tester's word for a shape is the datum; supply your own and it is
gone for the rest of the day. Every question the tester asks that you cannot answer is a finding —
write it down verbatim.

**Controls, facilitator only — never read these to a tester.** As Phase 1 and 2: left-click selects,
drag box-selects, double-click selects the type, right-click orders, `A` attack-move · `X` stop ·
`H` hold · `R` patrol · `Z` deploy · `G` power overlay · `Space` focus base · `,` `.` rotate. Whether
a tester reaches for `A` rather than right-click when told to attack is a finding, not a failure.

**If the sitting overruns**, cut in this order: 20, 19, 18, 13, 4, 2. **Never cut 5, 6, 8, 12, 14 or
21** — those six are the ones an ADR is waiting on.

## Tasks (do not read the parenthetical or the verdict lines to the tester)

**Start A — the line-up.** *(A still army is an easier read than a moving one. Everything here is
therefore a ceiling: whatever they cannot do standing still, they will do worse in Start C.)*

1. "Walk along that line and tell me what each one is for." *(Free naming. Write every answer
   verbatim, including the wrong ones and the shrugs. Score **role**, not name — nobody guesses
   "Breacher" — where the roles are: fights / scouts / heals / hauls / builds / detonates / carries
   a colony.)*
   - **Tests:** P3-T02 and ADR-0016 — nine new silhouettes, shape following function.
   - **Pass:** a correct role for **9 or more of the 15** shapes.
   - **Fail:** 8 or fewer, or the tester starts describing shapes ("the pointy one") because they
     have given up on function.
2. [Mender and Ranger, side by side] "One of these two is your scout. The other repairs things.
   Which is which?" *(**The 0.185 pair.** Both were reshaped after the corrected metric caught them;
   the Mender is now the only unit wider at the top than the bottom, and the Ranger is the narrowest
   spire. That is the claim. This is the question that can falsify it.)*
   - **Tests:** P3-T02's reshape actually separated them for an eye, not only for the metric.
   - **Pass:** correct, and they can say what they went on.
   - **Fail:** wrong, or correct with "I guessed". A coin-flip answer is a fail — record which.
3. [A freighter and an Aegis] "One of these is a cargo ship. The other is the toughest hull you own.
   Which is which?" *(**The 0.065 pair** — the closest collision the corrected metric found.)*
   - **Tests:** same claim, on the pair that scored worst.
   - **Pass:** correct and unhesitating.
   - **Fail:** wrong, or a visible hunt for a difference.
4. "One of those is much faster than everything else. Which?" *(The Ranger, at 115 against a Worker's
   60. Speed is not in the silhouette, so this asks whether the *scout* read carries the speed read —
   the shape's whole job is to be trackable at the edge of vision.)*
   - **Tests:** ADR-0016's "a player tracks scouts constantly".
   - **Pass:** the Ranger, from its shape, before anything moves.
   - **Fail:** any other unit, or "I'd have to move them".
5. [Mender and Helium Bomb, side by side] "Park your whole army next to one of these and it gets
   patched up. Park it next to the other and it dies. Which is which?" *(**The question ADR-0016 was
   written for.** A forced 50/50 with a right answer, testing both directions of the misread at once:
   the healer taken for the bomb, and the bomb taken for the healer. Ask nothing else about these two
   until task 21. Do not react to the answer.)*
   - **Tests:** ADR-0016 — "the most expensive misread in the game, in both directions".
   - **Pass:** correct, and they name the sphere or the dish as their reason.
   - **Fail:** anything else. There is no partial credit on this one.

**Start B — the ground.** *(Hand it over cold. This start runs **before** the fight and before the
bomb, deliberately: a tester who has watched a Helium Bomb go off knows what a crater is, and the
crater question can only be asked once in a life.)*

6. "Somewhere out there, a fight happened. Find where." *(**The salvage question, and it names no
   cue.** Do not say wreck, debris, or pile. They have a whole map. Time it.)*
   - **Tests:** P3-T08 / ADR-0018 — salvage is a *field* distinction, not a menu one.
   - **Pass:** they navigate to the salvage without being told what to look for, and say why they
     stopped there. Time to find: ____ s.
   - **Fail:** they sweep the map and stop at an ordinary seam, or they ask what a fight looks like.
7. [The four ground objects in one view] "Sort those into things that have always been there and
   things that haven't." *(**In one view, deliberately.** Salvage and crater read easily in isolation
   and that would prove nothing — the question is whether they separate from a rock and a volatile
   deposit standing beside them, which is the only place a player ever meets them.)*
   - **Tests:** ADR-0018's obligation that both are distinguishable from *both* natural meshes.
   - **Pass:** salvage and crater on one side, seam and volatile on the other. 4 of 4.
   - **Fail:** any natural deposit called new, or either new one called natural. Record which way the
     error went: a false "a fight happened here" is the worse of the two, and ADR-0018 chose the
     fallback direction on exactly that reasoning.
8. "Something made that mark on the ground. What?" *(**The crater, and the weakest cue in the phase.**
   The first draft wanted a hole; `Builder.prism` caps its top, so a bowl needed 60 triangles against
   a budget of 30, and an inverted frustum enclosed negative volume and was rejected by the winding
   test. What shipped is proportion instead of depth — the widest and flattest thing on the ground.
   Whether that reads as violence is this question, and the board says so in as many words. Record the
   answer verbatim, then stop; do not ask a second time in different words.)*
   - **Tests:** P3-T09 — that a flat scar reads as blast damage without excavation.
   - **Pass:** any answer in the explosion family — a bomb, a blast, a weapon, something burned.
   - **Fail:** terrain, a landing pad, a road, ice, "a flat rock", or a shrug. **"Is it a hole?" is
     also a fail** and the most useful one: it says the shape they expected is the one that could not
     be drawn, and it is the sentence that would justify reopening the triangle budget.
9. [The four static defences] "You have to march an army past one of those four. Which one do you
   walk past? Which do you avoid at all costs?" *(**The ladder as a decision, not as a naming test.**
   Correct: walk past the Aegis Bastion, which has no attack at all; avoid the Torpedo Battery at
   55 damage and 180 range. This is the question a player actually asks, so it is the one worth
   failing.)*
   - **Tests:** P3-T03 + P3-T04 — the ladder reads as a ladder and the Bastion does not read as a gun.
   - **Pass:** past the Aegis Bastion, avoid the Torpedo Battery.
   - **Fail:** avoiding the Aegis Bastion (the aura read as a weapon), or picking the Torpedo Battery
     as the safe one.
10. "What is that circle on the ground?" *(The guard aura. It is dashed rather than solid precisely
    so it does not read as a selection that will not clear (P3-T04); this is where that judgement is
    checked. Verbatim.)*
    - **Tests:** P3-T04 — a permanent ring reads as coverage, not as a stuck selection.
    - **Pass:** protection, shielding, cover, "that building is helping the others".
    - **Fail:** "it's selected", "I clicked something", or a range ring for a weapon it does not have.
11. "Two of those four are the same shape. What is the difference between them?" *(**Asked head on,
    because P3-T03 is PARTIAL and pretending otherwise would make this script a formality.** The
    Bastille and the Torpedo Battery differ in damage and reach and in nothing you can see. Let them
    look as long as they want. Note whether they resort to selecting one.)*
    - **Tests:** P3-T03's standing admission — that the collision is survivable, or that it is not.
    - **Pass:** they resolve it *at all*, by any route — watching one shoot further, clicking, or the
      panel — and can then say which they would rather fight. **Record the route**; if every tester
      had to click, the silhouette carried none of it and the honest score is zero.
    - **Fail:** they cannot separate them even after clicking, or they rank them backwards.
12. [Bastille and Torpedo Battery] "Which of those two would you rather fight?" *(Correct: the
    Bastille — 32 damage at 115 against 55 at 180. A forced choice with a right answer, asked after
    they have had every chance to work it out. Five coin-flips here is the finding.)*
    - **Tests:** whether the PARTIAL costs a real decision or only a tidy silhouette test.
    - **Pass:** the Bastille, with a reason.
    - **Fail:** the Torpedo Battery, or a guess. **This is the number that prices the fourth fortress
      mesh** against a buildings cap sitting at exactly 28.

**Start C — the fight.** *(Live. Let it run; do not narrate.)*

13. "That is your army. That is theirs. Go." *(Deliberately bare. Do they attack-move or right-click
    into a walk? Time to first order: ____ s. Worst frame-time reading during the fight: ____ ms.)*
    - **Tests:** that a fight starting is itself legible — Phase 1's S1, one roster later.
    - **Pass:** they know a fight has begun without being told.
    - **Fail:** they ask whether anything is happening.
14. [Take a screenshot mid-fight and show it to them] "In this picture, who is shooting whom? Pick
    three." *(**P3-T06's definition of done, read back as a question.** The row claims a still frame
    is enough. This is the still frame. Choose the three tracers yourself, before they answer.)*
    - **Tests:** P3-T06 — "who is shooting whom is readable in a still frame".
    - **Pass:** shooter and target both correct on **3 of 3**.
    - **Fail:** 2 or fewer, or they need the animation to answer.
15. "Send one unit over to that corner and tell me what is there." [The parked Colossus opens fire
    from beyond that unit's own sight. Once its health starts dropping:] "Something is happening to
    that unit. What?" *(**ADR-0017's admitted cost, and the ADR put it here rather than arguing it
    away:**
    a shot crosses only if the *shooter* is visible, because a tracer out of the dark is a line
    pointing straight at an enemy the player has not earned. So there is no tracer, on purpose, and
    it will feel like a missing cue.)*
    - **Tests:** whether "no tracer from the dark" reads as fog or as a bug.
    - **Pass:** they say the unit is under attack from something they cannot see, and go and look.
    - **Fail:** "it's glitching", "it's dying on its own", or they do not notice the health at all.
      Record the verbatim sentence either way — this one is going in an ADR.
16. "How many of your units died just now?" *(Deaths cross per tick and are gated on *explored*
    ground rather than visible (P3-T07), so a death they walked away from should still have flashed.)*
    - **Tests:** P3-T06 / P3-T07 — a death is an event the player registers, not a count they audit.
    - **Pass:** within one of the true number, without opening a panel.
    - **Fail:** out by more than one, or they go looking for a casualty list.
17. [While they are watching the fight, attack their base a screen away] "What just happened?"
    *(**P3-T14, judged against its own row:** exactly one alert, positioned, dismissible. Count the
    alerts yourself — a stream of them for one attack is a different failure from none.)*
    - **Tests:** P3-T14 — an alert is actionable, and there is exactly one of it.
    - **Pass:** they notice unprompted, reach the base without being told where, and one alert fired.
    - **Fail:** they miss it; or they see it and cannot find the place; or more than one alert fired
      for one event; or it cannot be dismissed. **UNREACHABLE if P3-T14 has not landed.**
18. "Move those six across the map so they arrive together." *(Formations, without naming the
    mechanic. The engine keeps followers stationed on the leader's live position rather than sending
    six independent moves (P3-T11) — so "arrive together" is a thing the game can actually do, and
    the question is whether a player can find it.)*
    - **Tests:** P3-T11 — the shapes and leader positions round-trip through a UI a person can find.
    - **Pass:** they arrive as a group, by a route the tester found unaided.
    - **Fail:** six units strung out across the map. **UNREACHABLE if there is no affordance.**
19. "That cargo ship has to cross the map alive. Sort it out." *(Escorts. The persistent-follow
    property is what they are relying on when they look away (P3-T12) — so let them look away.)*
    - **Tests:** P3-T12 — the guarded ship is identifiable and the escort holds after arrival.
    - **Pass:** an escort is set, and they can say afterwards which ship was being guarded.
    - **Fail:** they hand-drive the fleet, or the escort is set and they cannot tell it is still on.
      **UNREACHABLE if there is no affordance.**
20. "You are going to want those six again in a hurry." *(Control groups. Then, two minutes later and
    without warning: "get them back".)*
    - **Tests:** P3-T13 — assign, recall, and a group that survives a death.
    - **Pass:** they bind a group unaided and recall it in one action.
    - **Fail:** they re-drag a box. **UNREACHABLE if there is no affordance** — and this is the most
      likely of the three to be, since nothing outside its own module references the class.

**Start D — the bomb.** *(The last live task. Load the save, wait for the rings to appear, and say
the single word.)*

21. "Go." *(**Nothing else. Do not say bomb, do not say run.** `BOMB_FUSE_DELAY` is 4 seconds; the
    warning is two rings — flat 3 000 damage inside the core, falling to zero at the outer edge —
    plus a sweeping arc for the time left. Two circles cross the bridge rather than one precisely
    because a single ring would promise a kill at the rim that the falloff does not deliver.)*
    - **Tests:** P3-T10 — a warning that works as a warning, under four seconds of pressure.
    - **Pass:** the army is **outside the outer ring** when it goes off.
    - **Fail:** they do not move; or they move out of the core ring only and take the falloff, which
      is the specific failure the second circle exists to prevent; or they move toward it.
22. "How much time did you have?" *(The sweeping arc, chosen over a pulse so the time left survives a
    still frame.)*
    - **Tests:** P3-T10 — the fuse is a countdown, not just a warning light.
    - **Pass:** they knew it was counting down and are roughly right.
    - **Fail:** they saw a ring and had no idea it was timed.
23. "Were those two circles the same thing?"
    - **Tests:** P3-T10's two radii, asserted against `bombDamageAt` rather than copied.
    - **Pass:** inner as certain death, outer as the edge of it.
    - **Fail:** the two read as one circle, or as a decoration around it.
24. [Their own armed bomb] "You have one of these too. What is it for?" *(A player's own armed bomb
    always shows its rings, unlike an enemy's, which appear only once the fuse is lit — so this ring
    is mostly a picture of the player's own units standing inside it. Verbatim.)*
    - **Tests:** P3-T10's fog asymmetry, from the owning side.
    - **Pass:** they understand it kills their own units too.
    - **Fail:** they read the ring as protective, or as its firing range.

**Closing.**

25. "Click each of these in turn. Does the game ever draw anything wrong?" *(**Asked last, on
    purpose.** The Colony Ship's mesh overflows its own selection ring, 22.11 against 17.55, named in
    P3-T02 as a known deviation rather than reshaped in a Phase 3 commit. Asking this early would
    turn the whole session into a bug hunt, and every answer after it would be contaminated. The real
    measurement is whether anyone said so **unprompted** at any point in the last two hours; this is
    only the backstop.)*
    - **Tests:** P3-T02's known deviation — does the overflow cost anything.
    - **Pass (the deviation is free):** nobody remarked on it unprompted, and it is not found here.
    - **Fail:** anyone raises it unprompted, at any point in the sitting.
    - **Record separately:** found only when asked directly. That is neither a pass nor a fail — it
      is the number that decides whether this is worth a mesh change or a line in the ADR.

## Observations to record

| Question | Answer |
|---|---|
| Roles correctly assigned on the line-up, out of 15 | |
| Mender vs. Ranger — correct? Guessed? | |
| Freighter vs. Aegis — correct? Guessed? | |
| Mender vs. Helium Bomb — correct? | |
| Time to find the salvage, unprompted | |
| Ground objects sorted correctly, out of 4 | |
| What did they say the crater was, verbatim | |
| Did they ask whether the crater was a hole? | |
| Which defence would they walk past? Which would they avoid? | |
| What did they say the aura ring was, verbatim | |
| Bastille vs. Torpedo Battery — how did they resolve it, if at all? | |
| Would they rather fight the Bastille or the Torpedo Battery? | |
| Tracers read on a still frame, out of 3 | |
| What did they say about being shot from unexplored ground, verbatim | |
| Own losses reported vs. actual | |
| Alerts fired for the base attack (count), and did they act on one? | |
| Formations / escorts / control groups: reached, or UNREACHABLE? | |
| Outside the outer blast ring within the fuse? | |
| Did anyone remark on the Colony Ship's ring unprompted? | |
| Did they assume the AI was cheating? Verbatim | |
| Frame-time HUD, worst reading during the fight | |
| What did they ask that the interface should have answered? | |
| One-sentence summary of how it felt to fight | |

## Results log

| Date | Build | Tester | Roles /15 | C1 | C2 | C3 | C4 | C5 | Notes |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## Gate rules

Written in advance, as Phase 2's were, so a result cannot be argued into a pass afterwards.

- **C1 — the roster reads.** 3 of 5 testers assign a correct **role** to at least 9 of the 15 unit
  shapes on the line-up (task 1), and 3 of 5 get both near-collision pairs right (tasks 2 and 3).
  Failing the pairs half means the corrected metric bought a number and not a silhouette, and the
  fix is a reshape, not a looser threshold.
- **C2 — the two unarmed units are never confused with each other.** **5 of 5** on task 5. This is
  the one gate in this project set at five of five, and the reason is written in ADR-0016: it is the
  most expensive misread available in the game, in both directions. A 50/50 question that four
  testers get right is a coin landing well. Any failure at all reopens both meshes.
- **C3 — a fight is readable while it is happening.** 3 of 5 get 3 of 3 shooter/target pairs on the
  still frame (task 14), **and** 3 of 5 report their own losses within one (task 16). Both halves, not
  either — knowing who is shooting and not knowing who died is half a fight.
- **C4 — the ground after a fight tells the truth.** 3 of 5 find the salvage unprompted (task 6) and
  3 of 5 give an explosion-family answer for the crater (task 8). **Failing the crater half is the
  trigger to reopen the crater's shape — with a triangle count**, since the 30-triangle budget that
  forced a flat scar over a bowl has not moved, and neither has the precedent (P2-T17) of cutting the
  mesh rather than raising the number.
- **C5 — the blast warning works as a warning.** **4 of 5**, not 3, are outside the *outer* ring
  within the fuse (task 21). A warning that works three times in five is not a warning. Separately,
  no tester may read the aura ring as a selection (task 10) — that failure is the one dashed-not-
  solid was chosen to prevent, and it would mean the choice did not work.

**And one measurement that is deliberately not a gate.** Tasks 11 and 12 measure a gap the board
already admits: `bastille` and `torpedobattery` share the fortress silhouette, and P3-T03 is PARTIAL
because closing it costs two batches against a hand-written buildings cap sitting at exactly 28. The
script's job here is to **price** that gap, not to discover it. If 4 or 5 testers cannot separate the
two without clicking, the fourth fortress mesh has its argument and the next step is an ADR against
the cap — not a task, and not a quiet reshape that trips `test/view/aura-overlay.test.ts` on purpose.

A failure is not a blocker on its own. It is a task, filed on the board before the gate is declared
met — and for C4 and for the P3-T03 measurement it is an ADR, not a task.

## What this script cannot test, and why

Named here so that a green run is not read as more than it is.

- **Whether the AI is honest under its own fog (P3-T15).** Every tester will assume it cheats — the
  board predicts exactly this — and an assumption is not evidence. Record the sentence anyway: five
  testers saying "it knew where I was" is a finding about *feedback*, about what the game failed to
  show them of their own scouting, and it is not a finding about `state.fogAI`. Only P3-T15's test
  can settle that.
- **Any cue that correctly failed to appear.** Alerts suppressed for unseen events, enemy auras
  hidden outside live vision, un-fused enemy bombs kept off screen: a tester cannot report the
  absence of something they were never meant to see. These are facilitator observations at best and
  unit tests in truth, and they are already asserted as unit tests.
- **A 20-minute match at budget.** This script runs an hour of set pieces. The PRD's other Phase 3
  criterion wants a sustained match, and P3-T16 is explicit that a soak is a different test with
  different non-determinism. It stays on the deferred-verification table; do not let a good session
  here be read as having closed it.
- **N-05, unless the five happen to include a colour-blind tester.** The aura ring's dash and the
  blast ring's cross exist so that colour is the second cue and never the only one. If nobody in the
  room needs that, the claim is untested, and "nobody had trouble" is a false green. Record who was
  in the room.
- **Anything with no way in.** If tasks 18–20 come back UNREACHABLE, this script has measured that
  three DONE rows are not reachable by a player, which is a real and useful result — and it is not a
  readability result. It goes on the board as its own row.
