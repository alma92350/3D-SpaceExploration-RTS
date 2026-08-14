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
`Space` focus base · mouse wheel zooms (and tilts). Whether a tester finds any of these unaided is
the point of the exercise.

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
| | | | | | |

**Gate rule:** S6 passes when 3 of 5 testers find the build menu unaided. A failure is not a
blocker on its own — it is a task, filed on the board before the gate is declared met.
