# Playtest script — the economy (Phase 2)

**Status: WRITTEN, UNRUN.** Under ADR-0011 a phase closes on its automated criteria and the human
gates are deferred into the standing table in `planning/TASKS.md`. This script is the deferred gate
for Phase 2, and it is written *now*, while the reasoning behind each cue is still fresh, rather
than reconstructed months later by someone reading the diff.

Phase 1's script asked whether the game reads. This one asks a harder question: **can a player run
an economy they cannot see the inside of?** The whole chain — nine recipes, four of them tech-gated,
a power grid, a market that slips its own price, and finite hauling — is a system whose state lives
almost entirely in panels and badges.

Run it at the Phase 2 gate (PRD §5, "a player can run the full 2D economy in 3D with no panel
missing"). Record results at the bottom.

**Rules for the facilitator:** say nothing beyond the prompts. Do not point at the screen. Do not
answer "where do I click", and in particular **do not explain a badge**. Every question the tester
asks that you cannot answer is a finding — write it down verbatim.

## What this script is really testing

Phase 2 bought its performance budget with legibility, three times, each recorded in an ADR that
admitted the cost and deferred the measurement to here. Those debts are the reason this script
exists, and tasks 6, 7 and 9 are aimed straight at them:

| Debt | Where it was taken on | What it costs the player |
|---|---|---|
| **Thirteen entity types share a silhouette** — nine chain buildings on six families, four freighters on one hull | ADR-0013, ADR-0014 | A Smelter, a Chemical Plant and a Fabricator look identical on the field |
| **Metallic and crystalline deposits look the same** | ADR-0014 | Prospecting by eye does not work; the build menu is where the decision is meant to be made |
| **Six status glyphs are a vocabulary, not a self-evident cue** | ADR-0015 | A ring means "idle" only once someone knows that |

A tester who sails through tasks 1–5 and stalls on 6 has not had a bad session. That is the
measurement this whole phase was waiting for.

## Setup

- Build under test: commit hash ______, tier auto-detected ______, machine ______.
- `npm ci && npm run dev`. Fixed seed, **Helix Belt** every time (ADR-0010), so reports compare.
- At least one session with **no GPU** (`--use-gl=swiftshader --disable-gpu`). The Phase 2 scene is
  where the sim, not the view, consumes the budget (P2-T18) — note frame time with 200+ buildings.
- **Two starting points, and run both.** A cold start measures discoverability; a prepared save
  measures whether a *going concern* is readable. Half the script is unreachable inside an hour
  from a cold start, and a tester who never reaches the Fabricator tells us nothing about it.
  - **A — cold:** the standard opening.
  - **B — prepared:** a save with a working chain, a Reactor grid, one **starved** Smelter, one
    **unpowered** Assembler, one **idle** Barracks and a Datacenter mid-research. Hand it over with
    no explanation at all.
- Five testers, at least two who have never played the 2D game, and at least two who did the Phase 1
  script (they can compare, and they are the only ones who will notice a regression in the opening).

**Controls, facilitator only — never read these to a tester.** As Phase 1, plus: `G` toggles the
power overlay (it also comes up on its own while a build ghost is held), and clicking a building
opens its panel. Whether a tester finds `G` unaided is a finding, not a failure.

## Tasks (do not read the parenthetical to the tester)

**Start A — cold.**

1. "Get an economy going." *(Deliberately vague. Where do they go first — workers, or the build
   menu? Time to first building: ____ s)*
2. "You're going to need power. Sort that out." *(**The fuel trap.** A Reactor grants nothing until
   fuel is hauled into its own larder, so a freshly built Reactor is *correctly* dead. Does the
   tester work out why, or conclude the game is broken? This is the single most likely place for a
   session to die, and the badge on the Reactor is the only thing that says so.)*
3. "Where is your power actually reaching?" *(Do they find `G`, or notice the overlay under a build
   ghost? Do the band edges read as bands — NEAREST filtering is deliberate, because a band edge is
   where the cost multiplier changes — or as a rendering artefact?)*
4. "Make some metals." *(The first chain link: Smelter, inputs, hauling. Do they connect "the
   Smelter is stopped" with "nothing is bringing it ore"?)*

**Start B — prepared save. Hand it over cold.**

5. "This is someone else's colony. Tell me what's wrong with it." *(**The core task.** Three
   buildings are in trouble and one is merely idle. How many do they find? Which one do they find
   first? Do they find the idle Barracks *at all* — nothing is wrong with it, and it is the state
   the badge vocabulary exists to make visible.)*
   - Found starved Smelter: Y/N · unpowered Assembler: Y/N · idle Barracks: Y/N
   - Did they read a badge, or did they open every panel one by one? ______
6. "Without clicking anything, point at the building that makes chemicals." *(**The silhouette
   debt.** Nine chain buildings share six families. Expect failure; record how they *react* — do
   they treat it as their own mistake, or as the game's? A tester who says "they all look the same"
   has diagnosed ADR-0013 unprompted.)*
7. "Point at a crystal deposit." *(**ADR-0014's admitted cost.** Metallic and crystalline share the
   rock mesh. Same question: do they blame themselves or the game?)*
8. "Something in this colony is producing more slowly than it should. Find it." *(Throttled — a
   warning, not a stop: the factory *is* producing. Is "slower than it should be" distinguishable
   from "stopped" at a glance, or only in a panel?)*
9. "What do the little marks above the buildings mean?" *(Ask this **after** task 5, never before.
   Record their guess for each glyph they can find, verbatim. This is the ADR-0015 vocabulary
   measurement, and a wrong guess is more informative than a shrug.)*
10. "Sell 500 ore." *(**The market's honest number.** A big order earns strictly less than
    price × quantity because `sell` slips between lots. Does the panel's quote match what they
    expected? If they are surprised, was it the panel's fault or the mechanic's?)*
11. "Research something useful." *(Available / queued / locked — does the gating read? A prerequisite
    counts as met if it is queued ahead on the same Datacenter, which nobody expects.)*
12. "You've built something in the wrong place. Get rid of it and get your resources back."
    *(Recycle: is the preview believed? It refunds buffer contents too, which is more than a player
    guessing from the build cost would expect — do they notice they got more than they thought?)*
13. "How many haulers do you have, and are they enough?" *(The logistics panel. Does "enough" have a
    readable answer, or do they have to count units on the field?)*

## Observations to record

| Question | Answer |
|---|---|
| Time to first building (A) | |
| Did they diagnose the unfuelled Reactor unaided? | |
| Did they find `G` / the power overlay unaided? | |
| Faults found in the prepared save, out of 3 | |
| Did they find the **idle** Barracks? | |
| Did they read a badge, or open panels one by one? | |
| Glyphs guessed correctly, out of 6 | |
| Did they identify a chain building by silhouette? | |
| When they could not, did they blame themselves or the game? | |
| Did the market quote match their expectation? | |
| Frame-time HUD, worst reading in the prepared save | |
| What did they ask that the interface should have answered? | |
| One-sentence summary of how it felt to run an economy | |

## Results log

| Date | Build | Tester | Start | Faults found | Glyphs | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |

## Gate rules

Phase 1's script had one numeric gate (S6). This one has three, and they are written down in advance
so the result cannot be argued into a pass afterwards:

- **E1 — the colony reads.** 3 of 5 testers find at least 2 of the 3 faults in the prepared save
  without opening every panel in turn.
- **E2 — the vocabulary is learnable.** 3 of 5 testers correctly guess at least 3 of the 6 glyphs on
  first exposure. Failing this does **not** mean adding colour (N-05); it means the glyphs are wrong,
  or they need a legend, or the panel has to teach them.
- **E3 — the silhouette debt is survivable.** No tester abandons a task because they cannot tell two
  buildings apart. Failing this is the trigger to reopen ADR-0013 — **with a measurement**, since
  the draw-call budget that forced it has not moved.

A failure is not a blocker on its own. It is a task, filed on the board before the gate is declared
met — and for E3 it is an ADR, not a task.
