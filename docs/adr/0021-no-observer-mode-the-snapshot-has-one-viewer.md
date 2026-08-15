# ADR-0021: No Observer Mode — the snapshot has one viewer by construction, and `viewer` is not the switch it looks like

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Answers:** Q-04
**Relates to:** PRD §5 (Phase 1 deferrals, Phase 5 scope), §10 (Q-01, Q-04); ADR-0003, ADR-0008,
ADR-0010, ADR-0011, ADR-0019, P5-T01, P5-T03, P4-T03, P3-T05, P3-T07, P3-T10, P3-T14

## Context

Q-04 has been open since Phase 0: *"do we ship the 2D client's Observer Mode, or is a 3D free camera
enough?"* P5-T03 sharpens it correctly — the camera already exists, so the real question is **what
Observer Mode adds that `CameraRig` plus a fog override does not, and what that costs**.

The framing contains two assumptions. Both are wrong, and finding that out is most of the answer.

### 1. Upstream has one, and the engine does not know about it

`grep -ri observer src/engine/` returns two lines, and they are the whole story:

- `VENDOR.json` records **`observer.test.js` as an excluded upstream test, disqualified by
  `../boot.js`.** Upstream ships Observer Mode; it lives in the 2D *client*, next to `sound.js`, and
  ADR-0003 vendors the simulation and not the client. It is one of 44 tests excluded by the
  mechanical rule.
- `test/livingGalaxy.test.js:80`, an upstream test that *was* vendored, names the one contract it
  leans on: *"the contract the landing picker (`boot.js` `initiateJump`) and Observer Mode both lean
  on: a dormant world can be LOOKED at … with no entry added to the live set."* That contract is
  `previewPlanet`, and **P4-T05's landing picker already uses it.** The engine-side affordance
  Observer Mode needed, this project has already built against.

So the simulation has no notion of an observer, and never did. Whatever Observer Mode is, it is
entirely a client concern — which is what makes it look like a flag.

### 2. "Fog off" is not one switch. It is seven rules over three predicates

`ExtractOptions.viewer` carries a comment that has been an invitation since Phase 1: *"Always
`"player"` in the MVP; an argument for Observer Mode."* It is not that argument. Here is every place
the bridge decides what a viewer is entitled to:

| What | Rule | Predicate |
|---|---|---|
| **Buildings** | `visible` **or** `explored` | memory counts — a scouted base stays |
| **Units** | `visible` only | live vision — "the line that makes F-06 true" |
| **Nodes** | `explored` **and** `isNodeDiscovered(fog, node)` | the **engine's own** predicate |
| **Shots** (P3-T05) | own side always; enemy needs `visible` | live vision + owner exemption |
| **Deaths** (P3-T07) | `explored`, **owner-blind** | memory counts, for both sides |
| **Auras** (P3-T04) | own side always; enemy needs `visible` | live vision + owner exemption |
| **Bombs** (P3-T10) | own side **unconditionally**; enemy needs a **lit fuse** *and* `visible` | two gates, asymmetric |
| **Power** (Q-08) | `b.owner === viewer` | not fog at all — ownership |
| **The fog field** | the viewer's grid, three-state | it *is* the gate, drawn |

Every one of those differences is deliberate and carries a comment saying why. They are not
inconsistency to be tidied — they are seven different answers to seven different questions about
what a player has earned. **An "observer" that flipped one flag would produce a view that is
incoherent about what it reveals**, and three of the rows have no observer answer at all:

- **The owner exemption is meaningless for an observer**, because an observer has no *own*. Does an
  observer see every armed-but-unfused enemy bomb's blast ring? The player never may — P3-T10 is
  explicit that it "would hand over a number the player has not earned". An observer that sees them
  is not a superset of the player's view; it is a **different view with different rules**, and
  someone has to author them.
- **`isNodeDiscovered` is upstream's function and takes a fog.** The comment says using it is what
  keeps "what the 3D view shows, what the minimap dots and what a right-click can target" in
  agreement. Bypassing it breaks that agreement in three places at once.
- **`removed` conflates death with darkness.** `rememberPreviousPositions` rebuilds `prevPos` from
  the *gated* entity list, so an entity that walks out of vision is reported as `removed` and the
  interpolator retires it. Change the gate and the meaning of that set changes under the
  interpolator, which is not code anyone would think to look at.

### 3. Measured: `viewer` is read twice; the player is hardcoded twenty-two times

| | Sites |
|---|---|
| Reads `opts.viewer` | **2** — `state.fogs[opts.viewer]`, and `extractPower` |
| Sets it | **1** — `world.ts:251`, the literal `viewer: "player"` |
| Hardcodes the player **in the bridge** | **11** — 9 owner encodings and gates in `snapshot.ts`, plus `map.bases.player` (line 668) and `state.players.player.resources` (line 772) |
| Hardcodes the player **above the bridge** | **11** — `view/alerts.ts` ×2, `ui/hud.ts` ×5, `ui/colony-panel.ts` ×3, `app/game.ts` ×1 |

Setting `viewer: "ai"` today does not produce the AI's view. It produces the AI's **fog** and the
AI's **power grid** stapled to the **human's** resources, the **human's** base anchor, the
**human's** owner-colour encoding and the **human's** alert feed. That is not a mode; it is a
corrupt frame that would render without a single error.

**The panels are not the problem, and that is worth recording because it is the part that looks
expensive and is not.** Four `ui/` models are *already* viewer-parameterised — `rigSurveyModel`,
`logisticsModel`, `repairPanelModel` and `prereqsMet` all take an owner, and `rig-panel.ts:78`
selects `state.fog` or `state.fogAI` from it correctly, with a doc comment warning that passing the
wrong side "is the same bug as passing all nodes, one step quieter". Eleven of the twenty-two
hardcodes are *call sites* passing a literal into a function that would have accepted a variable.
**The singular thing is the snapshot**, and that is where the cost is.

**Three of the snapshot's tables are singular by construction, not by omission**: `resources` and
`stockpile` describe one economy, `power` is one field for one owner, and `map.baseX/baseY` is one
home. An observer watching two sides needs two of each. That is a **table-shape change** to the
structure ADR-0008 made allocation-free and reused between ticks — not a parameter.

### 4. The starmap's fog is not ours to flip, and faking it changes the economy

P4-T03's plate gates on world status from `galaxyStatus`, and **`galaxyStatus` takes no viewer
argument.** It reads `galaxy.discovered` directly (`galaxy.js:808`), an engine-internal set. Under
ADR-0003 we may not edit it. That leaves two routes and both are closed:

1. **Mutate `galaxy.discovered` so every world reads as reached.** `jumpCost` gates on the same set —
   *"the player-facing `discovered` set, NOT merely 'the state object exists' — else every jump would
   be free"* (`galaxy.js:971–973`). Revealing the galaxy for an observer would make **every jump
   free**, and `persist.js:842` serialises the set, so the cheat would **survive the save**. It also
   moves `visited`, which the score screen reports (P5-T08). An observer that changes the economy is
   not an observer.
2. **Re-derive world status above the bridge.** The thing this project has refused every time it has
   come up, most recently in P5-T08's own note: a number recomputed above the bridge "disagrees with
   it the first time a weight moves".

**So the one screen a spectator would most want — the galaxy — is the one where fog-off is
unavailable at any price we are willing to pay.**

### 5. And the "free camera" half of the question is not shipped either

`CameraRig` is deliberately **not** free: yaw snaps to 8 (Q-01, ADR-0010), pitch is a pure function
of zoom, the target is clamped to map bounds and distance caps at 900. ADR-0010 refused free orbit
on readability grounds with "revisit in Phase 6" attached, and ADR-0019 §5 declined to reopen it two
phases early for the starmap. **Q-04's second option therefore costs a reopened Q-01**, which is a
Phase 6 decision with a readability test attached, not a Phase 5 one.

What the rig *does* already do is most of what a spectator wants: pan anywhere on the map, zoom from
90 to 900, rotate to eight headings, follow a selection. The camera was never the missing piece.

## Decision

**We will not build Observer Mode. `docs/planning/PARITY.md` records it as deliberately out of
scope, citing this ADR, and `ExtractOptions.viewer` stops pretending to be its switch.**

1. **The snapshot has exactly one viewer, and that is now a stated invariant rather than an
   accident.** `viewer: "player"` is the only legal value until something changes it deliberately.

2. **The trap gets pinned rather than removed.** `viewer` stays a parameter — it is the correct shape
   and `extractPower` genuinely uses it — but P5-T03 owes **a test that the extractor is
   viewer-consistent**: extract with `viewer: "ai"` and assert that `resources`, `power` and
   `map.baseX/baseY` all describe the AI. **That test fails today**, which is the point: it converts
   a comment that reads as an invitation into a red build for anyone who accepts it. Skipped or
   `expect.fail`-documented is acceptable; silence is not.

3. **Nothing in Phase 5 needs a second viewpoint.** P5-T04 through P5-T10 — diplomacy, the Gate,
   milestones, relief, victory, save/load, settings — are all things the seated player does. Q-04
   was scheduled here because the PRD's Phase 5 scope names Observer Mode, not because a row needs
   it.

4. **The free-camera half stays where ADR-0010 put it.** Q-01 is revisited in Phase 6 with a
   readability test. This ADR does not reopen it and does not depend on it: Observer Mode is refused
   on the snapshot, not on the camera, so a free camera arriving in Phase 6 does not by itself
   revive it.

5. **What a spectator actually wants is named, so the next proposal starts from the right thing.**
   Watching a match is not "the same view without fog" — it is *following what the AI is doing and
   why*. That is intent, not vision: `aiIntel`, wave state, the controller's current objective. None
   of it crosses the bridge, none of it is fog-gated, and none of it would be delivered by a fog
   override. A proposal for Observer Mode that does not name that gap is proposing the wrong feature.

## Consequences

**This makes easy:**
- P5-T01's ruling on Observer Mode: a citation, with the cost priced.
- Keeping the snapshot the shape ADR-0008 designed — one viewer, reused buffers, allocation-free in
  the steady state. A second viewer is a second extraction pass or a doubled table set.
- The seven fog rules stay individually justified. Nothing forces them into a common shape they do
  not have.

**This makes hard / gives up:**
- **A parity gap, admitted.** Upstream ships Observer Mode and Phase 5's exit criterion is feature
  parity. This is the first row where the answer is "deliberately absent" rather than "present", and
  PARITY.md will show it as such. That is the honest cost of the criterion, not a way around it.
- **No spectate, no demo mode, no attract loop, no way to watch the AI play.** The self-play harness
  upstream uses for exactly that (`tools/selfplay.js`) is also unvendored, and `state.playerAi` — the
  second controller slot the engine keeps for it — stays null here.
- **Debugging keeps its blind spot.** "Why did the AI do that?" is still answered by reading
  `aiMilitary.js`, not by watching. Several Phase 3 and 4 findings would have been faster to see than
  to derive.
- **`viewer` is now a parameter with one legal value**, which is a smell we are choosing to keep and
  label rather than delete. Deleting it would make `extractPower` reach for a literal, and would
  throw away the only correctly-shaped seam a future decision would need.

**Obligations it creates:**
- The viewer-consistency test above, or the comment on `ExtractOptions.viewer` is a trap left armed.
- P5-T01 carries the ruling.
- Any row that adds a new fog-gated channel states which of the three predicates it uses and why —
  the seven rules in §2 are only defensible while each one is argued.

## The trigger, stated in advance

**This ADR is superseded, with the extractor work, when either of these happens:**

1. **`state.owners` exceeds two.** `state.js:160–190` is explicit that the owner list is a *scaffold*
   — "a future N-faction world is a change to this list, not a sweep across the engine". The moment
   there are three sides, the snapshot's singular tables are wrong for the **player's own** view, not
   merely an observer's: `resources`, `power` and the owner encoding all assume a two-sided world.
   At that point the extractor has to be made viewer-relative regardless, and Observer Mode becomes
   nearly free — the work will already have been done for a different reason. The viewer-consistency
   test in Decision §2 is what reports it.
2. **A playtest reports that players cannot tell what the opponent is doing** — not that they cannot
   *see* it, which is fog working as designed, but that they cannot *learn* the game from it. The
   first thing to try then is **not** a fog override: it is an after-action replay of a finished
   match, where nothing is secret because nothing is live, and where `previewPlanet`'s
   look-without-waking contract already does most of the work. That is a smaller feature with none
   of §2's seven decisions in it.

Note what is deliberately **not** a trigger: *"upstream has one."* Upstream also has a DOM, a setup
screen and `renderEffects.js`, and this project has replaced all three. Parity is a checklist to rule
on, not a list to copy.

## Alternatives considered

### Ship it: `viewer` becomes a mode toggle
The reading P5-T03 was written to test, and the measurement is in §3: `viewer` is read at **2** sites
and the player is hardcoded at **22**, across four layers. Flipping it produces the AI's fog with the
human's economy — a frame that renders perfectly and is wrong. Making it honest means
re-parameterising 22 sites, splitting 3 singular tables in two, authoring 7 fog rules for a viewer
that has no side, and re-checking `removed`'s meaning under the interpolator. Rejected on that cost
against a benefit nobody has asked for in five phases.

### A god-view: reveal everything, no fog at all
Simpler in principle, and it hits §4 immediately. There is no all-revealing fog to select —
`state.fogs` is keyed by owner and there are exactly two owners — so this is a new code path, not a
value. And it cannot reach the starmap at all without mutating `galaxy.discovered`, which makes every
jump free and persists into the save. Rejected: an observer that changes the economy is not an
observer, and one that reveals the battlefield but not the galaxy is the incoherence §2 warns about.

### Observer Mode as a *save-file* viewer — load a finished match, no live state
Genuinely attractive, and it is the shape trigger 2 points at. Rejected **for now** rather than on
principle: P5-T09's save/load UI does not exist yet, P4-T09 found a live defect in the round-trip
(the market price-book drift) that a viewer would faithfully reproduce, and the feature has no
customer until a playtest asks for one. Recorded so trigger 2 has somewhere to land.

### Free-orbit camera instead, and call that the answer
The literal second half of Q-04. It reopens Q-01, which ADR-0010 closed on readability with a Phase 6
revisit and ADR-0019 declined to reopen early. It is also the wrong lever: §5 shows the rig already
pans, zooms, rotates and follows, so a free orbit buys expressiveness, not information. Nothing about
Observer Mode is limited by where the camera can point.

### Leave Q-04 open
Five phases of precedent says an open question nobody is scheduled to close is a silent decision to
do nothing. Worse here than for Q-06: PRD §5 lists Observer Mode in Phase 5's scope, and Phase 5
closes on a parity checklist, so an unruled row makes the exit criterion unmeetable rather than
merely unanswered. Deciding "deliberately absent" is what lets P5-T01 tick.
