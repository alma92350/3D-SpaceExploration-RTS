# Playtest script — MVP (Phase 1)

The automated suite cannot tell us whether the game *reads*. This script can. Run it at the Phase 1
gate (PRD §4.2, criteria S1 and S6) and record the results at the bottom.

**Rules for the facilitator:** say nothing beyond the prompts. Do not point at the screen. Do not
answer "where do I click". Every question the tester asks that you cannot answer is a finding —
write down the question verbatim.

## Setup

- Build under test: commit hash ______, tier auto-detected ______, machine ______.
- `npm ci && npm run dev`, then open the page. The MVP always lands on **Helix Belt** with a fixed
  seed (ADR-0010), so every tester sees the same terrain, the same deposits and the same neighbour —
  which is what makes their reports comparable.
- Run at least one session on a machine with **no GPU** (or Chromium started with
  `--use-gl=swiftshader --disable-gpu`). Note frame-time readings during combat.
- Force a tier with the T0–T3 buttons in the sidebar to check the drop-a-tier path by hand; the
  choice persists across a reload.
- Five testers, at least two who have never played the 2D game.

**Controls, for the facilitator only — never read these to a tester.** Left-click selects,
left-drag box-selects, double-click selects the type on screen, right-click orders. `Z` deploy ·
`A` attack-move · `X` stop · `H` hold · `R` patrol · `WASD`/arrows/screen-edge pan · `,` `.` rotate ·
`Space` focus base · mouse wheel **or `+`/`-`** zooms (and tilts). Whether a tester finds any of
these unaided is the point of the exercise.

## Tasks (do not read the parenthetical to the tester)

1. "Have a look around." *(Camera discoverability: do they find pan and zoom without help? Time to
   first deliberate camera move: ____ s)*
2. "Find your colony ship and put a base down." *(Selection + the deploy order)*
3. "Get some ore coming in." *(Do workers gather without instruction? Do they see the resource
   counter move?)*
4. "Build a Barracks." *(**S6** — did they find the build menu unaided? YES / NO)*
5. "Make three Skiffs and send them to the far side of the map." *(Production, multi-select, move
   order at distance, camera follow)*
6. "There's someone else on this world. Go and break something of theirs." *(**S1** — combat reads?
   Do they know who is winning? Do they notice a unit dying?)*
7. "Which of your units is the most experienced?" *(Veterancy chevrons legible at their preferred
   zoom? YES / NO)*
8. "Where haven't you explored?" *(Fog states distinguishable? Do they trust the minimap?)*

## Observations to record

| Question | Answer |
|---|---|
| Time to first successful order | |
| Did they find the build menu unaided (S6)? | |
| Did they ever lose track of which units were theirs? | |
| Did they mis-click the ground (order landed somewhere they did not mean)? How often? | |
| Could they tell high ground from open ground? | |
| Did they notice combat starting without being told? | |
| Frame-time HUD, worst reading during combat | |
| What did they ask that the interface should have answered? | |
| One-sentence summary of how it felt | |

## Results log

| Date | Build | Tester | S1 | S6 | Notes |
|---|---|---|---|---|---|
| 2026-08-15 | `1208f2ee1f40` | T1 — repo owner, had played before | PASS | PASS | First run of this script against a person, after five phases of it existing unrun. Session 1 of 5. Five findings, all five verified against source afterwards rather than recorded on report alone — see below |

**Gate rule:** S6 passes when 3 of 5 testers find the build menu unaided. A failure is not a
blocker on its own — it is a task, filed on the board before the gate is declared met.

---

## Session 1 — 2026-08-15, build `1208f2ee1f40`

**Setup as run.** Windows, Intel i7-4790K, 16 GB, GTX 1060 6 GB, tier auto-detected **T1**. Facilitated
over text rather than over a shoulder, which is a real limitation and is priced at the bottom of this
section. The tester is the repo owner and had played before, so this session is **not** evidence about
first-contact discoverability — the two gates it does answer are the ones that do not depend on
novelty.

### The two gates

- **S6 — build menu found unaided: PASS.** Barracks built and deliberately placed away from the
  base's own landing point; Sentinels and Skiffs produced. No "where do I click" for this step.
- **S1 — combat reads: PASS.** Unprompted: *"enemy attacked me, i defended, then i built a new camp,
  new ships, all sorts, then attack the ennemy, they all neutralised."* Deaths noticed, the outcome
  correctly identified, no facilitator help.

### Observations

| Question | Answer |
|---|---|
| Time to first successful order | *"few minutes?"* — the tester's own estimate. Not stopwatch-timed; text facilitation cannot time this, and a guessed number is not a measurement |
| Did they find the build menu unaided (S6)? | **YES** |
| Did they ever lose track of which units were theirs? | Not raised |
| Did they mis-click the ground? How often? | *"no i do not remember missing any"* — none recalled |
| Could they tell high ground from open ground? | **Not exercisable.** *"not really applicable on this map. it s all flat."* Helix Belt's fixed seed gave this tester no elevation to read, so the question the script asks cannot be answered on the map the script mandates — a defect in the script, recorded below |
| Did they notice combat starting without being told? | **YES** — reported the enemy attacking first, unprompted |
| Frame-time HUD, worst reading during combat | **Not observed.** Asked, not answered. The one number this session was best placed to collect on real hardware — a discrete GPU at T1 — and it was not collected |
| What did they ask that the interface should have answered? | *"i cannot activate the scout feature as there is none for the ranger"* · *"cannot see any progression"* (unit production) · *"i cannot change the location where they are going to land"* |
| One-sentence summary | *"it feels good. it is fast. graphic could be improved for the skiff. some tuning needed"* |

### Findings — verbatim, then verified against source

A playtest report is a symptom, not a diagnosis. *"There is no scout feature"* can mean the feature
does not exist, or that it exists and could not be found, and those are different tasks against
different layers. So the tester's words were recorded unedited and **every verdict below was read
out of the code afterwards**, never inferred from the report.

**It changed the answer on three of five.** Two features the tester reported as missing are fully
implemented and simply unreachable through the interface, and the one hypothesis this file itself
proposed for the pan complaint — that the camera's rotation was confusing a correct control — was
tested and is wrong. That is the argument for the verification step: the report was right about the
symptom every time and right about the cause less than half the time.

| # | Verbatim | Verdict |
|---|---|---|
| 1 | *"to pan to see the left part of the map, i need to move my mouse all the way to the opposit side of the screen … same for the arrows, should be inverted"* | **CONFIRMED DEFECT, and worse than reported.** Both axes are inverted at the default orientation. Reproduced by running the project's own `CameraRig` and `pickGround`: sim X **441.6** sits under the right screen edge against **1158.4** under the left, so higher X draws leftward, and `pan` adds to X for a rightward push. **The rotation hypothesis this file proposed is refuted** — pan *is* camera-relative, and the default yaw is 0, so a player who never rotates gets the full double inversion. The basis is a *reflection* rather than an offset, so rotating scrambles the error instead of shifting it: pushing right travels LEFT · UP · **RIGHT** · DOWN · LEFT · UP · **RIGHT** · DOWN across the eight snapped yaws — accidentally correct at two of eight. See PT-01 |
| 2 | *"for the wasd, detect azerty or qwerty keyboard"* | **CONFIRMED DEFECT.** Every binding reads `event.key`; `event.code` appears nowhere in `src/`. On AZERTY the physical W and A positions emit `z` and `q`, which are not in the pan set and **are bound to other commands** — `z` fires the HUD's first button, `q` cycles the selection and flies the camera to it. So two of the four pan keys are not merely dead, they do something else. `index.html` advertises "WASD pan" three times with no caveat. See PT-02 |
| 3 | *"i cannot activate the scout feature as there is none for the ranger"* | **IMPLEMENTED, UNREACHABLE.** It is `E`, a stance needing no click, gated to `role === "scout"` — the Ranger alone — and driven by a dedicated engine module that walks the fog frontier and falls back to a quadrant circuit once charted. The word "scout" appears **zero times** in `src/ui/` and `src/app/`, and selecting a Ranger draws a **literally empty action row**, because that row is built only from deploy/train/build. The interface showed exactly what the tester reported. See PT-03 |
| 4 | *"cannot see any progression"* (unit production) | **REAL GAP, and ours.** The engine advances a `progress` fraction on every queued job; the bridge carries no queue and no progress, and `progress[]` in the snapshot is *construction*, pinned at 1 for a finished building. Research already draws `${Math.round(job.progress * 100)}% done` from an identically shaped field — so this is drawn for research and not for units. Sharper: a building **actively training wears no badge**, while an idle one does, so "working" is only distinguishable by an absence. See PT-04 |
| 5 | *"i cannot change the location where they are going to land"* | **IMPLEMENTED, UNREACHABLE** — `U`, then left-click. And the tester was set up to fail: `makeBuilding` mints *every* building with a live default rally at `(x + 60, y + 60)`, so they watched units walk to a point they never chose and correctly deduced it was a setting. `snapshot.ts` says drawing that line "is how a player learns the rally point exists at all" — which worked, and then nothing taught the key. See PT-05 |

**The common cause of 3 and 5, and it is one defect rather than two.** P5-T13 bound ten orders to
keys and neither place that teaches the controls was updated. Unadvertised today: `E`, `U`, `I`,
`Shift+I`, `Shift+R`, `Shift+F`, `Shift+H`, `Shift+P`, `Shift+L`, `Delete` — and the guard that
should have caught it checks one direction only. `test/ui/onboarding.test.ts` states its own claim as
*"every key it names is put through the app's own `translateKey`"*: named ⇒ real, never real ⇒ named.
A control list can therefore be arbitrarily incomplete and stay green.

### What this session does not establish

- **One tester, and not a naive one.** The gate rule wants five, at least two who have never played
  the 2D game. This is one, who wrote the thing. S1 and S6 are recorded as passed *by someone who
  already knew the game*, and the script's real question — whether a stranger finds the build menu —
  is still unanswered.
- **No frame-time reading**, on the one machine so far with a real GPU.
- **No no-GPU session**, which the Setup section requires and which is persona P2's actual hardware.
- **The high-ground question cannot be asked on this map.** The script mandates Helix Belt for
  comparability and then asks a question its terrain does not pose. Either the script drops the
  question or it names a second map; leaving it is how a checklist starts collecting blanks that
  look like failures.
- **Text facilitation loses the two things the rules are built for**: the pauses, and where the
  cursor hunts. *"Say nothing beyond the prompts"* is cheap in person and structurally impossible
  over chat, where the tester must narrate — and narration is already interpretation.
