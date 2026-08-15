# Parity checklist — the thing Phase 5 is measured against

**Status: DERIVED, and mostly not ticked.** Derived from the vendored engine's own export surface at
`VENDOR.json` commit `93f607a`, against this repo at `8300e53`. Not written from memory of the 2D
client, and not written from the PRD's prose — both of those have been wrong about this engine
before (Phase 2 found the recipe chain is nine, not seven; Phase 3 found the PRD listing veterancy
chevrons that Phase 1 had already built).

**The count is [117 rows: 85 present, 20 absent, 12 out of scope](#4-the-count)** — 76/29/12 when
this document was drafted, moved by Phase 5 closing nine of §5.6's eleven. A checklist that came out
mostly ticked on its first draft would be evidence that it had been written by optimism rather than
by enumeration, so the number is the point of the document, not an embarrassment in it. **§4 also
records that its own first draft reported three mutually inconsistent totals and now carries the
command that counts it**, which is the more useful lesson. The number that still matters most is
**§5.2's 18 of 28** — ten of the engine's own orders with no way in — and Phase 5 did not move it.

---

## 0. Why this file exists at all

PRD §5's Phase 5 exit criterion is *"feature parity with the 2D Odyssey; the parity checklist in
`docs/planning/PARITY.md` is fully ticked."* **That file has never existed.** So the criterion has
been unfalsifiable for five phases: there was no list to tick, and "feature parity" was whatever the
person closing the gate believed it was.

That makes this document **the phase's specification, not one of its deliverables**. Rows P5-T04 …
P5-T11 all depend on P5-T01 for exactly that reason. What is written here is what Phase 5 *is*.

---

## 1. What "the 2D Odyssey" means here

**The vendored engine IS the 2D game's simulation (ADR-0003).** It is not a re-implementation, not a
port and not a subset — `scripts/sync-engine.mjs` copies upstream's `engine/` tree byte for byte and
`npm run check:vendor` fails on drift. So parity is not a comparison against a system nobody in this
repo can see. It is a question with a countable answer:

> **How much of the vendored engine's own surface can a player of this client reach?**

That reframing is the whole reason this file can be ticked at all. "Does it feel like the 2D game"
is an opinion five people will answer five ways. "Does any gesture, button or panel in this client
reach `issueSetRally`" is a `grep`, and the answer is no.

**It has one honest limit, and it is stated here rather than discovered later.** The engine is the
2D game's *simulation*. The 2D client is engine **plus a presentation layer that was never
vendored** — `sound.js`, `boot.js`, `saveload.js`, `minimap.js`, `landingPicker.js`, `techChart.js`,
`render*.js`, `hudSelection.js`, `camera.js`, `version.js`, `update.js` and about twenty more. Those
modules are not in this repo and cannot be enumerated the same way, so §5.6 marks their capabilities
from the one artefact that *does* name them: **`VENDOR.json`'s `excludedTests` list**, which records
44 upstream tests that were skipped and, for each, the exact path outside the vendored subset that
disqualified it. That list is a directory of the 2D client's own modules, written by the sync script
rather than by a person, and it is re-derived on every `npm run sync:engine`. Where a row below
cites it, the citation is what makes the row checkable at all — see §6.3.

---

## 2. How this list was derived, and how to re-derive it

Everything below is reproducible from a clean checkout. Nothing in it is a recollection.

**Step 1 — every engine export.** 48 files under `src/engine/engine/` (`types.js` is JSDoc typedefs
and exports nothing at runtime), **430 exported names**, plus 11 from `src/engine/data.js`:

```sh
node --input-type=module -e '
import { readdirSync } from "node:fs";
for (const f of readdirSync("src/engine/engine").filter(f => f.endsWith(".js")).sort()) {
  const m = await import("./src/engine/engine/" + f);
  console.log(f, Object.keys(m).length, Object.keys(m).sort().join(", "));
}'
```

**Step 2 — what crosses the typed façade.** `src/engine/index.ts` is the only module allowed to
import vendored JS (ADR-0003, enforced by `test/architecture/layering.test.ts`). It re-exports
**179 values and 8 types** — so **less than half the engine surface is even visible above the
bridge**, before anything is asked about controls.

**Step 3 — what a player can reach.** Three questions, in order, because each can fail on its own:

| Question | Where the answer lives |
|---|---|
| Is there an intent? | the `Intent` union in `src/bridge/commands.ts` — **34 kinds** |
| Is there a gesture or a control that produces it? | `src/input/intents.ts`, `HudModel.actions` / `EconomyModel.actions` in `src/ui/hud.ts` |
| Does a test fail when that control is deleted? | `test/input/phase2-input.test.ts`, `phase3-input.test.ts`, `phase4-input.test.ts` |

**Step 4 — cross-check every `PRESENT` against the enumeration tests.** Those three files each end
by listing a phase's intent kinds and failing **by name** when one has no control producing it. They
cover **22 of the 34 intents**. The remaining twelve are Phase 1's, and **Phase 1 has no such
sweep** — `test/input/intents.test.ts` tests gestures one at a time and never asks the union
question. That gap is not a footnote: it is exactly where the two unreachable orders in §5.2 were
hiding, and they have been hiding there since the MVP.

---

## 3. What the marks mean

| Mark | Means | Bar |
|---|---|---|
| **PRESENT** | A player of this client can reach it today | There is a gesture, a button or a panel line, and a test that goes red when it is removed |
| **ABSENT** | The engine does it; nothing above the bridge reaches it | The trace column names the export that is going unused |
| **OUT** | Deliberately not ported | The trace column cites the ADR or the board row that decided it. Never a silent omission |

**`PRESENT` is not "the logic exists and is proven".** That was the bar this board met for two whole
phases before P4-T01, and the reachability section of `TASKS.md` records what it cost: eight panel
*models*, six of them imported by nothing. A row here is present when a **player** can reach it. A
row that is right at the bridge and reaches no control is `ABSENT`, and says so in its trace.

Three rows below are marked `PRESENT` with a stated qualification in the trace (the static-defence
ladder, settings, onboarding). They are counted as present because the capability is reachable; the
qualification is what the deferred playtests are for. Nothing is counted present on a promise.

---

## 4. The count

**This section was wrong in its first draft, and the way it was wrong is the argument for the rest
of the document.** It reported *104 rows: 62 present, 30 absent, 12 out of scope* — a total that
matched neither the by-area table beneath it (which summed to 114 with 72 present) nor the checklist
itself (117 rows, 76 present, at the time). Three numbers, none of them equal, in the one section of
the one document whose whole premise is that it is **derived rather than remembered**. Nobody had
counted; the header had been written and then edited.

So it is now counted, and here is the command that counts it — run it rather than trusting the table:

```sh
grep -cE '^\| [0-9]+ \|.*\| PRESENT \|$' docs/planning/PARITY.md   # and ABSENT, and OUT
```

| | Rows |
|---|---|
| **PRESENT** | **85** |
| **ABSENT** | **20** |
| **OUT of scope** | **12** |
| **Total** | **117** |

By area, so the shape is visible rather than the total. The **Was** column is where each section
stood when this document was first written, at the start of Phase 5:

| Area | Present | Absent | Out | Was | Reads |
|---|---|---|---|---|---|
| §5.1 The world and the view | 11 | 1 | — | 11 / 1 | Phase 1 is essentially complete |
| §5.2 Orders | 18 | 10 | — | 18 / 10 | **Ten of the engine's own orders still have no way in — Phase 5 did not move this at all** |
| §5.3 The economy | 20 | 2 | — | 20 / 2 | Phase 2 is complete; both gaps are in the *menus*, not the systems |
| §5.4 Combat | 16 | 3 | — | 16 / 3 | Three of the four are payload fields on an event the client does not read |
| §5.5 The galaxy | 11 | 2 | — | 11 / 2 | Phase 4 is complete except for two things nothing opens |
| §5.6 The long game | 9 | 2 | — | 0 / 11 | **Phase 5's nine. The two left are a new-game screen and audio** |
| §5.7 Out of scope | — | — | 12 | — | Each cites the decision that made it out |

**The interesting number is not 62/104, it is §5.2's 18/28.** Ten engine orders — a third of the
verb list the 2D game gives a player — have no gesture, no button and no intent. Two of them
(`setRally`, `cancelTrain`) *have* an intent and no producer, which means they have been sitting in
`bridge/commands.ts` since Phase 1 with nothing on either end of them.

---

## 5. The checklist

Columns are: what the capability is, the **engine trace** (the export that does it), the **client
trace** (the thing a reviewer can check, or the reason there is nothing to check), and the mark.

### 5.1 The world and the view

| # | Capability | Engine trace | Client trace | Mark |
|---|---|---|---|---|
| 1 | Terrain relief rendered in 3D | `sampleTerrain`, `TERRAIN` | `view/terrain/mesh.ts`; P1-T05 | PRESENT |
| 2 | Fog of war, three states | `isVisibleAt`, `isExploredAt`, `FOG_CELL_SIZE` | `snap.fog`; hidden entities absent from the snapshot, not merely undrawn (P1-T14) | PRESENT |
| 3 | Camera: pan, zoom-with-pitch, snapped yaw, focus-base | none — view state | `input/camera.ts`; `Home`, `,`/`.`, WASD | PRESENT |
| 4 | Minimap with terrain, fog, entities, click-to-move | none — view state | `ui/minimap.ts`; P1-T17 | PRESENT |
| 5 | Selection rings | `radiusOf` | `scene.ts` `selection` overlay | PRESENT |
| 6 | Health bars | `snap.entities.hp/maxHp` | `scene.ts` `health` overlay | PRESENT |
| 7 | Veterancy chevrons | `VETERANCY_RANKS`, `rankMults` | `scene.ts:274` pushes `chevron` on `e.rank[i] > 0` | PRESENT |
| 8 | **Rally lines** | `issueSetRally` writes `building.rally` | **The `rally` overlay kind exists in `renderer/port.ts` and both renderers draw it — and `SceneComposer` never pushes one.** The only caller is `view/landing.ts`, drawing a line to a landing point. A rally line for a rally point no player can set | ABSENT |
| 9 | Build ghost with validity shading | `canPlaceBuilding`, `sampleTerrain`, `prereqsMet` | `checkPlacement`; P1-T18 sweeps the map verdict-for-verdict | PRESENT |
| 10 | Canvas2D fallback renderer | — | `renderer/canvas2d.ts`; conformance suite green in all three implementations | PRESENT |
| 11 | Graphics tier, auto-detected and overridable | — | `main.ts` tier picker, persisted through `saveSettings` | PRESENT |
| 12 | An opening that says what to press | — | `HudModel.prompt`; P1-T25 | PRESENT |

### 5.2 Orders — `engine/commands.js` is 22 functions

This is the table that decides the phase. Each row is one verb the 2D game gives a player.

| # | Order | Engine trace | Client trace | Mark |
|---|---|---|---|---|
| 13 | Select / box-select / type-select | `state.selection` | `translatePointer`; swept by `phase3-input.test.ts` | PRESENT |
| 14 | Control groups (assign / append / recall) | none — client state by decision (P3-T13) | digit row → `select` intent; `input/control-groups.ts` | PRESENT |
| 15 | Move | `issueMove` | right-click ground | PRESENT |
| 16 | Attack-move | `issueAttackMove` | `A`, then click | PRESENT |
| 17 | Attack | `issueAttack` | right-click an enemy | PRESENT |
| 18 | Gather | `issueGather` | right-click a node | PRESENT |
| 19 | Stop | `issueStop` | `X` | PRESENT |
| 20 | Hold position | `issueHold` | `H` | PRESENT |
| 21 | Patrol | `issuePatrol` | `R`, then click | PRESENT |
| 22 | Build a structure | `issueBuild` | build button / positional key, then click | PRESENT |
| 23 | Deploy the colony ship | `deployColonyShip` | Deploy button (first positional action) | PRESENT |
| 24 | Train a unit | `queueProduction` | production buttons — **but see row 47: six of eighteen unit types are filtered out before they get one** | PRESENT |
| 25 | Recycle / scrap | `issueRecycle`, `recycleValue` | Scrap button; `phase2-input.test.ts` | PRESENT |
| 26 | Cancel a recycle | `issueCancelRecycle` | button; `phase2-input.test.ts` | PRESENT |
| 27 | Haulage priority | `issueSetLogiPriority`, `LOGI_PRIORITIES` | logistics board; `phase2-input.test.ts` | PRESENT |
| 28 | Escort a ship | `issueEscort` | `P`, then click a ship; `phase3-input.test.ts` | PRESENT |
| 29 | Hold a formation | `issueHoldFormation` | `T`; `phase3-input.test.ts` | PRESENT |
| 30 | Move in formation | `issueMove(…, {shape, leaderPos})` | `F` cycles the shape, then click; `phase3-input.test.ts` | PRESENT |
| 31 | **Set a rally point** | `issueSetRally` | **`{kind:"setRally"}` exists in `bridge/commands.ts` and appears nowhere else in `src/` or `test/`.** No button, no key, no test. Upstream's version also takes a `nodeId` — rally-to-node, so new workers spawn already mining — which the intent does not carry either | ABSENT |
| 32 | **Cancel a queued unit** | `cancelProduction` | **`{kind:"cancelTrain"}` exists in `bridge/commands.ts` and appears nowhere else in `src/` or `test/`.** A production queue a player can fill and cannot empty | ABSENT |
| 33 | **Repair (a manual order)** | `issueRepair` | Exported by the façade (`index.ts:38`) and **imported by nothing**. Menders auto-repair via `updateRepair`, so this is the *explicit* "go fix that" — the one a player gives when the automation picks wrong. P2-T15's panel shows who needs repairing and offers no way to send anybody | ABSENT |
| 34 | **Service a building (manual haul)** | `issueServiceBuilding` | Exported by the façade and imported by nothing. The manual counterpart to `assignHaul` | ABSENT |
| 35 | **Scout mode** | `issueScout`, `updateScoutMode` (`scout.js`) | Exported by the façade for Phase 3 and never wired. `scout.js` is a whole module — one export — that nothing reaches | ABSENT |
| 36 | **Assist build** | `issueAssistBuild` | Not in the façade. Named in the Phase 3 header as one of "eight engine commands the bridge has never exposed"; still eight | ABSENT |
| 37 | **Ferry a freighter** | `issueFerryFreighter`, `assignFerry`, `updateFerry` | Not in the façade | ABSENT |
| 38 | **Set home base** | `issueSetHomeBase` | Not in the façade. The engine's comment calls it "an explicit player override for `zoneFirst`'s usual nearest-CC guess" — the multi-base control | ABSENT |
| 39 | **Set collect point** | `issueSetCollectPoint` | Not in the façade. `nearestGatherDrop` already honours it (P2-T07 names the landed collection-point freighter that can win the drop-off) — the client reads the consequence and cannot set the cause | ABSENT |
| 40 | **AI logistics toggle** | `issueSetAILogistics`, `FREIGHTER_AI_TECH` | Not in the façade | ABSENT |

### 5.3 The economy

| # | Capability | Engine trace | Client trace | Mark |
|---|---|---|---|---|
| 41 | All 23 commodities in the stockpile | `COM` | `snap.stockpile`; P2-T01 | PRESENT |
| 42 | Supply used / cap, and being blocked said out loud | `supplyUsed`, `supplyCap` | `HudModel.supplyText/supplyBlocked`; P2-T14 | PRESENT |
| 43 | Power as four distance bands | `POWER_TIERS`, `powerEfficiency` | `snap.power`, `G`; P2-T06 | PRESENT |
| 44 | Building detail: recipe, buffers, throughput | `recipeOf`, `inputTotal`, `storeTotal` | `ui/building-panel.ts` | PRESENT |
| 45 | Why a building is stopped, in the engine's own words | `buildingConcern` | six codes → six sentences; P2-T09 | PRESENT |
| 46 | Building state readable without colour | — (ours, ADR-0015) | `ACTIVITY_*` + six glyphs; conformance-tested | PRESENT |
| 47 | **The production menu offers every unit the engine allows** | `queueProduction` gates on `def.odysseyOnly && !state.endless` | **`hud.ts:228` filters `def.odysseyOnly` outright — and this world *is* endless.** Probed: `queueProduction(state, cc, "colonyship")` returns **true** and the button does not exist. Six of eighteen hidden: `colonyship`, `hauler`, `heavyhauler`, `bulkfreighter`, `leviathan`, `heliumbomb`. `test/ui/hud.test.ts:86` **asserts** the exclusion, so it is pinned, not accidental | ABSENT |
| 48 | **Affordability read across all 23 commodities** | `canAfford` | `hud.ts:210` re-derives it and knows **ore, crystals and radioactives only**; everything else reads `have = 0`. So `wraith` (gas), `aegis` (ice), `colossus` (relics), `plasmarig` (machinery+electronics+ai) and `torpedobattery` (alloys) render as unaffordable **forever**. The buttons still fire — `bind()` only toggles a class — so this is a lie in the HUD rather than a lock, which is the harder kind to notice | ABSENT |
| 49 | Build menu covers all 29 building types | `canBuildType` + `prereqsMet` | `buildableTypes`; a Worker's three categories reach 29 of 29 (P4-T14) | PRESENT |
| 50 | Research: 12 techs, gated exactly as the engine gates them | `TECHS`, `researchTech` | `ui/research-panel.ts`; `canStart` is a dry run of `researchTech` itself | PRESENT |
| 51 | Refinery doctrines, and the irreversibility said first | `UPGRADES`, `committedDoctrine` | `ui/doctrine-panel.ts`; P2-T12 | PRESENT |
| 52 | Market: prices, lot walk, glut and pressure bounds | `unitPrice`, `quoteSell`, `buy`, `sell` | `M` board; `sellLotProceeds` is `quoteSell`'s dry run | PRESENT |
| 53 | Logistics board: haulers, priorities, upkeep | `countLogistics` (read-only), `aiUpkeepRate` | `L` board; `ui/operations-panel.ts` | PRESENT |
| 54 | Repair board: who is worn, who is healing | `NEEDS_REPAIR`, `HEALED`, `pickRepairTarget` | `ui/repair-panel.ts`, composed into the `L` board. **Read-only — see row 33** | PRESENT |
| 55 | Recycle preview before committing | `recycleValue` | Scrap button detail; counts buffers as well as build cost | PRESENT |
| 56 | Plasma Rig survey inside `SURVEY_RADIUS` | `rigSurvey` over *discovered* nodes only | `ui/rig-panel.ts`; P2-T16 | PRESENT |
| 57 | Plasma Rig rolled yield tier | `rigInfo`, `YIELD_TIERS` | `ui/rig-panel.ts`; looked up by name, never divided out | PRESENT |
| 58 | Pause / resume a factory | `building.paused` | `pause` intent; `phase2-input.test.ts` | PRESENT |
| 59 | Electrify a building | `isElectrifiable`, `ELECTRIFY_POWER` | `electrify` intent; `phase2-input.test.ts` | PRESENT |
| 60 | Visible cargo on a laden hauler | `cargoCap ?? cargoHold` | per-instance `shade`; P2-T05, P2-T07 | PRESENT |
| 61 | Structural decay, and "worn with nothing coming" | `updateDecay`, the `< HEALED` release point | `ui/repair-panel.ts`'s `worn` state | PRESENT |
| 62 | Node meshes distinguish deposit families | `snap.nodes.comIndex` | two meshes by ADR-0014's ruling | PRESENT |

### 5.4 Combat

| # | Capability | Engine trace | Client trace | Mark |
|---|---|---|---|---|
| 63 | Tracers — who is shooting whom | derived from `attackTimer` (ADR-0017) | `snap.shots`; `view/effects.ts` | PRESENT |
| 64 | Impacts / blast rings | derived | `blast` overlay | PRESENT |
| 65 | Deaths | `entityKilled` event | `snap.deaths`; P3-T07 | PRESENT |
| 66 | **A siege hit reading heavier than a normal one** | `attackHit.heavy` — `def.bonusVsBuildings && target.kind === "building"` | **Nothing reads it.** The event is not consumed at all (see §7.1) | ABSENT |
| 67 | **A counter-triangle hit telegraphing** | `attackHit.bonus` — `def.bonusVs[target.type]` | Nothing reads it. This is the cue that teaches a player the counter system without a manual | ABSENT |
| 68 | **A splash impact ring at the weapon's own radius** | `attackHit.splashRadius` — `def.splash.radius` | Nothing reads it. `combat.js:169` says it exists "so `renderEffects.js` can draw an impact ring". The Colossus is the first unit with splash and its hits look like everyone else's | ABSENT |
| 69 | Guard aura coverage | `collectAnvils` → `state.anvils` | `snap.auras`; dashed ground ring, fog-gated on live vision | PRESENT |
| 70 | Helium Bomb fuse and two blast radii | `fuseUntil`, `BOMB_CORE_RADIUS`, `BOMB_BLAST_RADIUS`, `bombDamageAt` | `snap.bombs`; sweeping arc. **The device itself is untrainable — row 47** | PRESENT |
| 71 | Arm / disarm / detonate | `lightFuse` + the `armed` flip the engine's own AI does | `O` / `Shift+O`; `phase3-input.test.ts` | PRESENT |
| 72 | Wreckage reads as salvage | `wreck` node origin | own mesh; ADR-0018 | PRESENT |
| 73 | Craters read as bomb damage | `crater` node origin | own mesh; proportion not depth (P3-T09) | PRESENT |
| 74 | Alerts: raised, positioned, dismissible, coalesced | `entityKilled`, `snap.bombs` | `view/alerts.ts`; `Space` jumps and dismisses. **Two alert kinds against sixteen engine event types** — see §7.2 | PRESENT |
| 75 | Formations: four shapes, three leader positions | `FORMATION_SHAPES`, `LEADER_POSITIONS`, `formationSlots` | `F`/`T`; the shape list is asserted equal to the engine's | PRESENT |
| 76 | Escorts keep station | `keepEscortStation`, `escortSlot` | `P`; pinned over 40 ticks after arrival | PRESENT |
| 77 | All 18 unit types have their own silhouette | `UNITS` | 15 meshes + 3 deliberate freighter shares; ADR-0016 | PRESENT |
| 78 | All 29 building types render | `BUILDINGS` | 14 meshes in six families; ADR-0013 | PRESENT |
| 79 | The static-defence ladder reads as a ladder | `turret`/`bastille`/`torpedobattery`/`aegisbastion` | Aegis Bastion closed by its aura. **`bastille` and `torpedobattery` still share the `fortress` silhouette and differ only in reach** — P3-T03, open by admission, pinned by `test/view/aura-overlay.test.ts` | PRESENT |
| 80 | The AI plays under its own fog | `state.fogs.ai`, `sightEnemy`, `INTEL_FADE` | `test/engine/ai-fog.test.ts`: source scan + three behavioural claims | PRESENT |
| 81 | Combat feedback allocates nothing per frame | — | asserted over 600 frames of a *running* firefight | PRESENT |

### 5.5 The galaxy

| # | Capability | Engine trace | Client trace | Mark |
|---|---|---|---|---|
| 82 | The starmap: 11 worlds, claims, stances, alerts | `galaxyStatus` (16 channels) | `Y`; `view/starmap.ts`, ADR-0019's measured plate | PRESENT |
| 83 | Jump to another world | `canJumpTo`, `jumpCost`, `jumpCapital` | approach view → confirm; `phase4-input.test.ts` | PRESENT |
| 84 | Spaceport staging ring and tier capacity | `stagedRiders`, `jumpManifest`, `SPACEPORT_CAPACITY` | jump board; riders **and** overflow reported | PRESENT |
| 85 | Extend a Spaceport | `upgradeSpaceport`, `SPACEPORT_MAX_TIER` | `upgradeSpaceport` intent | PRESENT |
| 86 | Choose a landing site in 3D | `snapLandingPoint`, `LANDING_PICK_GRID` | `view/landing.ts`; the snap crosses as the engine's *function* | PRESENT |
| 87 | Colonies, passive income, the cap | `sweepColonies`, `COLONY_INCOME_*`, `PACIFIED_INCOME` | `ui/colony-panel.ts`; the sweep is driven from `WorldBridge.step` (P4-T13) | PRESENT |
| 88 | Freight lanes: create, crew, run, and the clock | `createLane`, `assignShipToLane`, `runLanes`, `LANE_PERIOD` | `ui/lane-panel.ts`; the countdown is asserted true, not merely present | PRESENT |
| 89 | Colony standing orders | `getColonyPolicy`, `setColonyPolicy`, `sanitizePolicy` | `ui/colony-panel.ts`; `MAX_WORKER_TARGET` shown, not silently applied | PRESENT |
| 90 | Cargo aboard a freighter | `cargoManifest`, `freightCapacity`, `CARGO_GOODS` | lane panel | PRESENT |
| 91 | Background worlds keep simulating | `stepGalaxy`, `BG_STEP` | measured: 2.3 ms/world-step, 1.9 ms/frame for ten (P4-T10) | PRESENT |
| 92 | The galaxy save round-trips | `serializeGalaxy`, `deserializeGalaxy` | `WorldBridge.save()/load()`, 15 tests over a *diverged* galaxy. **No control calls either — row 96** | PRESENT |
| 93 | **News from a world you are not standing on** | `sweepColonies` returns `{type: "lost" \| "hostile" \| "attacked", planetId}` | `WorldBridge.takeColonyNotes()` exists, is documented, is capped at a limit — and **has no caller in `src/`.** The only channel that says a colony is being attacked while you are elsewhere is collected every tick and dropped | ABSENT |
| 94 | **Starmap toasts the engine queues for itself** | `galaxy.pacifyNotes`, `expansionNotes`, `milestones` | Three queues on the galaxy object; nothing above the bridge reads any of them | ABSENT |

### 5.6 The long game — Phase 5's own scope

**Nine of eleven now PRESENT** — this section was entirely ABSENT when the document was drafted,
which is what "Phase 5 has not started" looked like written down honestly rather than left to be
inferred. Each of the nine meets §8's three conditions: an engine trace, a control a player can
press, and a test that goes red when the control is removed (`test/ui/phase5-wiring.test.ts`,
mutation-checked). The two that remain are named rather than quietly dropped.

| # | Capability | Engine trace | Client trace | Mark |
|---|---|---|---|---|
| 95 | **Diplomacy: tribute, gifts, favours, goodwill** | `diplomacy.js` — **31 exports**: `offerTribute`, `offerGift`, `fulfillRequest`, `tributeCost`, `TRIBUTE_BASE_COST`, `FAVOR_WINDOW` (90 s), `FAVOR_GOODWILL`, `APPEASE_TIME`, `GRACE_TIME`, `hostility`, `provoked`, `atPeace`, `stanceLabel`… | `src/ui/diplomacy-panel.ts` + three intents (`tribute`, `gift`, `fulfilFavor`), on the starmap's Diplomacy board. `tributeCost` is asked of the engine so the escalation shows; `FAVOR_WINDOW` counts down against the tick `updateDiplomacy` really withdraws on, including the one tick where the clock reads zero and `fulfillRequest` already refuses. `stanceLabel`'s bands are bisected out of the engine rather than typed in, which is what lets P4-T03's unbanded stance bar finally be banded | PRESENT |
| 96 | **Save / load as something a player can press** | `serializeGalaxy`, `GALAXY_SAVE_VERSION` | `src/ui/save-panel.ts` on the Saves & settings board — save, list, load, delete. The round trip is P4-T09's: a source scan proves the panel calls neither `serializeGalaxy` nor `deserializeGalaxy`. **The price-book defect this row demanded be surfaced no longer exists** — issue #92, fixed upstream in `50ceb88`, synced, and `galaxy-save.test.ts` now asserts prices survive; a warning about it would teach players to distrust a correct save | PRESENT |
| 97 | **The Antimatter Gate's charge** | `updateWonder`, `chargingWonderOf`, `chargingPlayerWonder`; `BUILDINGS.antimatter_gate.wonder` | `src/ui/gate-panel.ts` on the Antimatter Gate board: charge, seconds remaining, the per-good feed and where a starved Gate will stop. `chargingWonderOf` answers `null` four different ways and calls a starved Gate "charging", so `status` adds the distinction the engine does not have while `chargingId` reports its verdict unchanged | PRESENT |
| 98 | **The rival Gate race** | `checkRivalGate`, `rivalGateComplete` event | The rival's charge and countdown are on the same board, read from `galaxyStatus().rivalGate` — the identical call the bridge makes. **And the enumeration's own complaint was the smaller half**: `checkRivalGate` nulls its record on ascension, so the starmap mark clears exactly when the race is lost. `rivalAscended` is the only thing separating that from "nobody is racing you", and `longgame.md` task 9 is written to fail it | PRESENT |
| 99 | **Milestones** | `checkGalaxyProgress`, `MILESTONE_IDS` (`capital`, `gate`, `domination`, `domination:all`, `rival-gate`), `isMilestoneId` | `src/ui/milestones-panel.ts` on the Records board: `MILESTONE_IDS` in the engine's own order, the `world:N` family, and `galaxy.milestones`' undrained queue. Nothing here runs a scan — opening a panel must not raise a firework, and a test proves it | PRESENT |
| 100 | **Domination progress** | `checkDomination`, `DOMINATION_TARGET` (4) | Same board. `milestoneReached` is `reached.has("domination")` and never `pacified >= target`; `pendingScan` names the second-or-so where the count says yes and the engine has raised nothing, rather than smoothing it over | PRESENT |
| 101 | **Relief after a total wipeout** | `checkGalaxyRescue`, `RELIEF_COOLDOWN` (20 s) | `src/ui/relief-panel.ts`, and it is the one panel NOT behind a button — it appears whenever the rescue clock is doing something, because a player who has just lost everything should not have to go looking. `footholds` lists every world still held where the engine returns on the first hit. `longgame.md` G1 is set at 5 of 5 on it | PRESENT |
| 102 | **Surrender** | `surrenderGalaxy` | A `surrender` intent and a button on the Records board. `surrenderGalaxy` returns **no value at all** and refuses silently on a seat already over, so `applyIntent` asks the question the engine will not answer — otherwise a second press on a struck-through button would say nothing, and this HUD keeps struck-through buttons clickable on purpose | PRESENT |
| 103 | **The score breakdown** | `scoreBreakdown` (bank / army / structures), `playerScore` | `src/ui/score-panel.ts` on the Records board, bank / army / structures shown separately because upstream's comment says the breakdown exists "so a HUD can show WHY". §6.2's ruling holds: it is a readout, never a win condition | PRESENT |
| 104 | **New-game setup: faction and difficulty** | `PLAYABLE_FACTIONS` (3), `factionTrait`, `DIFFICULTY_OPTIONS` (3, each with ~12 tuning fields) | `WorldOptions` accepts `difficulty` and `playerFaction`; **`main.ts` passes neither**, so every session is `medium` / `frontier`. There is no new-game screen at all | ABSENT |
| 105 | **Audio** | **none — `grep -ri audiocontext src/engine` finds nothing** | Not an engine capability. See §6.3: upstream *does* have a `sound.js`, it simply was not vendored, which is the evidence Q-06 (P5-T02) has been waiting for | ABSENT |

*(Row 105 is counted in §5.6's total of 11; rows 95–105 are eleven.)*

### 5.7 Out of scope — and why, in each case

A checklist that quietly drops a module is worse than one that says "out of scope, because". Each
row below names the decision.

| # | Not ported | Engine trace | Decided by | Mark |
|---|---|---|---|---|
| 106 | **Convoy Escort scenario** | `scenarios.js` — `setupEscort`, `ESCORT_DIFFICULTY` | ADR-0002 — see §6.1 | OUT |
| 107 | **Pirate Raider scenario** | `setupRaider`, `RAIDER_DIFFICULTY` | ADR-0002 | OUT |
| 108 | **Bounty scenario** | `setupBounty`, `BOUNTY_DIFFICULTY` | ADR-0002 | OUT |
| 109 | **The scenario runtime** | `updateScenario`, `departNow`, `repairConvoy`, `repairCost` | ADR-0002 | OUT |
| 110 | **Skirmish victory by elimination** | `checkWinCondition` | ADR-0002 ("skirmish mode and its victory/score/clock UI"), and the engine agrees — see §6.2 | OUT |
| 111 | **The match clock** | `DEFAULT_MATCH_TIME_LIMIT` (2400 s) | ADR-0002; `sim.js` never reaches it in a galaxy | OUT |
| 112 | **Score-tiebreak victory** | `scoreLeader` (module-private), `finish(reason)` | ADR-0002 | OUT |
| 113 | **Permanent defeat** | `checkEndlessLoss` | The engine: `if (state.inGalaxy) return;` — "In a galaxy there is NO defeat at all". Also PRD §1 | OUT |
| 114 | **Victory by completing the Gate** | `checkEndlessWin` | The engine: "a galaxy Gate online is a milestone, never a win — play forever". It is row 99, not a victory screen | OUT |
| 115 | Competitions, ELO, tournaments, the genome editor | not vendored — `VENDOR.json` excludes `competition*.test.js`, `elo.test.js`, `pairing.test.js` | ADR-0002 | OUT |
| 116 | Multiplayer, mobile/touch, VR | none | ADR-0002 | OUT |
| 117 | Elevation as a simulation input | `sampleTerrain` stays 2D | ADR-0004; asserted by `test/architecture/layering.test.ts` | OUT |

---

## 6. The three rulings this document had to make

### 6.1 `scenarios.js` — OUT OF SCOPE, and it was decided in Phase 0

**The ruling: out of scope. It is not parity surface, and the PRD's Phase 5 scope list omits it
because ADR-0002 had already removed it three phases earlier.**

The board raised this as an open question — *"either it is parity surface the checklist must cover
or it is deliberately out of scope; P5-T01 is where that gets decided"* — so here is the decision
and the citation, rather than an omission.

`scenarios.js` is **a mode, not a feature.** Its own header says so: it "swaps the *raze the enemy
Command Center* objective for a scripted mission", and `sim.js:39` reads
`if (state.scenario) updateScenario(state, dt); else runAI(state, dt);` — the scenario layer
*replaces* the AI opponent. It is three setups (Convoy Escort, Pirate Raider, Bounty), each with its
own difficulty table, win condition, mission clock, repair budget and scoring.

**ADR-0002 lists it by name in its Out clause**, alongside skirmish, competitions and multiplayer,
and closes with the sentence that settles this exactly: *"Parity is a Phase 5 goal **within the
Odyssey**, not across modes."* Reaching `setupEscort` from this client would not be closing a parity
gap — it would be reopening ADR-0002.

**Three things follow, and they are obligations rather than notes:**

1. Its 10 exports are excluded from the denominator. Counting them as absent would put a
   permanent 10-row hole in a checklist that can never be ticked, which is how a checklist stops
   being read.
2. **It must not bloat the bundle.** ADR-0002's own obligation clause says so, and `check:size`
   measures the shipped bundle. `scenarios.js` is reachable from `sim.js` by a static import, so it
   is not tree-shaken by reachability — it is dropped only if the bundler proves `state.scenario` is
   never set. **Nothing in this repo asserts that today.** That is a Phase 6 row, not a Phase 5 one,
   and it is written here because this is where the module was last thought about.
3. If anyone ever wants scenario mode in 3D, the trigger is an ADR superseding ADR-0002 — not a row
   on this checklist.

### 6.2 `victory.js` — the Odyssey has no victory, and P5-T08's definition of done says otherwise

P5-T08 asks for *"Victory, defeat and the score screen"* and names `checkWinCondition`,
`checkEndlessWin`/`Loss`, `scoreBreakdown` and `DEFAULT_MATCH_TIME_LIMIT`. **Read against the
engine, three of those five cannot fire in this game**, and the engine says so in its own comments:

- `checkWinCondition` and `DEFAULT_MATCH_TIME_LIMIT` are the **skirmish** clock and elimination
  check. ADR-0002 rules skirmish out; `sim.js` uses the endless path instead.
- `checkEndlessLoss` opens with `if (state.inGalaxy) return;` — *"In a galaxy there is NO defeat at
  all"*. Row 113.
- `checkEndlessWin` for a player-owned Gate inside a galaxy: `if (state.inGalaxy) continue;` —
  *"a galaxy Gate online is a milestone, never a win"*. Row 114. Its AI-owned branch pushes
  `rivalGateComplete`, which is row 98 — an **ascension, never a defeat**.

This agrees with PRD §1 (*"There is no win condition… and no permanent defeat"*) and disagrees with
the board row written against it. **`scoreBreakdown` survives and is row 103**: it is a readout, not
a verdict, and upstream broke it into bank/army/structures precisely so a HUD could show it. So
P5-T08 should be re-scoped to *the score readout, the milestone fireworks (row 99) and the relief
mechanic (row 101)* — the three things that actually exist here — and should stop naming a victory
screen. **This file does not edit that row; it records what the row will find.**

### 6.3 The half of the parity surface that was never vendored

ADR-0003 vendors upstream's `engine/` tree. It does not vendor upstream's *client*. So a parity
question like "is there audio" cannot be answered by enumerating engine exports — the answer would
always be no, and would be no even if upstream had a full soundtrack.

**`VENDOR.json`'s `excludedTests` is the checkable list of what is on the other side.** The sync
script records, for each upstream test it skipped, the exact path that disqualified it. Reading it
as a directory of the 2D client:

| Upstream module named there | What it tells this checklist |
|---|---|
| `../sound.js` (named by `hud.test.js`, `input.test.js`, `overlays.test.js`, `hudSelection*.test.js`, `techChart.test.js`) | **Upstream HAS an audio layer, and it is client-side.** This is the evidence P5-T02 (Q-06) asked for: "reuse upstream's procedural WebAudio" is not ruled out by the absence of `AudioContext` under `src/engine/` — that absence was always expected. What it costs is a separate question, and it needs upstream's source, not this repo's |
| `../boot.js` (named by `observer.test.js`, `starmap.test.js`) | **Observer Mode lives in the client's boot layer**, not the simulation. Q-04 / P5-T03 therefore cannot be answered by an engine reading either; the camera plus fog-off comparison the row proposes is the right shape |
| `../saveload.js`, `../saveShape.js` | The 2D client's save UI is its own module. Row 96 is a real parity gap, not an invention |
| `../landingPicker.js`, `../minimap.js`, `../camera.js` | Already rebuilt here (rows 4, 86, 3) |
| `../render*.js`, `../renderEffects.js` | The thing this project exists to replace. `renderEffects.js` is also the named consumer of `attackHit`'s three unread flags — rows 66–68 |
| `../version.js`, `../update.js` | Versioning and the update check — Phase 6 scope in PRD §5, not Phase 5 |
| `../competition*.js`, `../elo.js`, `../pairing.js`, `../tools/*` | Out by ADR-0002 (row 115) |

**Rule for this checklist:** a capability that lives only in upstream's client gets a row here only
when the PRD's Phase 5 scope names it (audio, Observer Mode, save/load UI, settings, onboarding).
Everything else on that list belongs to Phase 6 or to ADR-0002. Where a row cites `excludedTests`,
that citation is what makes it re-derivable — re-run `npm run sync:engine` and the list rebuilds.

---

## 7. What the enumeration found that the board does not say

These are not opinions about the board. Each is a claim on the board checked against the vendored
source, with the file and line that decides it.

### 7.1 The engine DOES emit a shot event, and ADR-0017's stated premise is false

ADR-0017 (Accepted, answers Q-12, cited by P3-T05, P3-T06, P3-T07) opens:

> **There is no such event.** The simulation emits thirteen event types in total and exactly one of
> them is about combat — `entityKilled`. No shot, no impact, no damage-dealt.

**The vendored engine emits sixteen event types, and `combat.js:187` pushes `attackHit` on every
landed hit:**

```js
state.events.push({
  type: "attackHit", x: target.x, y: target.y,
  fromX: attacker.x, fromY: attacker.y, unitType: attacker.type, owner: attacker.owner,
  heavy: ..., bonus: ..., splashRadius: ...,
});
```

It is inside `performAttack`, which the file's own comment says is *"Shared by mobile units and
turrets"*, and the comment above the push reads *"The `attackHit` event carries both endpoints and
the attacker's type so `render.js` can draw a tracer from shooter to target."* `state.js:259`
documents the event stream as *"unitSpawned/attackHit/entityKilled/buildingComplete"*. And
`src/engine/engine/combat.js` has exactly **one commit in this repo's history** — `4a5c169`, the
Phase 1 MVP — so it has said this since before Phase 3 was scoped. The claim was also internally
inconsistent at the time: P3-T10's own row cites `bombDetonated` as an engine event carrying two
radii, which is a second combat event.

**What this does and does not mean.** It does *not* mean ADR-0017's decision was wrong: the diff
implementation is built, mutation-tested and allocates nothing, and rebuilding it would be churn
with no measurement behind it. It means three things that belong in this checklist:

1. **Rows 66–68 exist because of it.** `heavy`, `bonus` and `splashRadius` are three combat cues
   already computed by the simulation, already carried across the tick, and read by nothing —
   invisible precisely because the decision was that there was nothing to read.
2. ADR-0017's §4 fog rule ("a shot crosses only if its shooter is visible") is a *choice*, not a
   consequence — `attackHit` carries `owner` and both endpoints, so the same rule would have to be
   applied deliberately either way. Worth knowing before `combat.md`'s tester reports the
   shot-from-the-dark question as a bug.
3. **ADR-0017's premise paragraph should be corrected, not its decision.** An ADR whose stated
   reason is checkably false is an ADR the next reader cannot use.

### 7.2 Two alert kinds against sixteen engine events

`view/alerts.ts` has `ALERT_ATTACK` and `ALERT_BOMB`. P3-T14's row is honest about this — *"Alert
kinds stop at what crosses the bridge today… nothing was invented"* — and that is the right
discipline. But the enumeration puts a number on the remainder: **`neighbourHostile`,
`productionBlocked`, `researchComplete`, `buildingComplete`, `rigDig`, `recycled`, `wonderCharging`
and `rivalGateComplete` are all raised by the simulation and none of them reaches a player.** Half
of those are Phase 5's rows (95, 97, 98). `productionBlocked` is not: it is the engine telling a
player *right now* that a factory refused an order, in a client where the HUD's affordability check
is wrong about twenty of twenty-three commodities (row 48).

### 7.3 Board rows whose status cell disagrees with the code

At `8300e53`, **P4-T01, P4-T13 and P4-T14 all read `TODO`** while the Phase 4 exit gate two screens
below marks the same criteria PASS and cites them. The code sides with the gate: `buildableTypes`
uses `canBuildType` + `prereqsMet` (P4-T14), `WorldBridge.step` calls `sweepColonies` (P4-T13),
`hud.ts` composes every economy panel (P4-T01), and `npx vitest run test/input test/ui` is **266
tests green** including all three enumeration files. The work is in; the status cells are stale.
Worth fixing before someone re-does a finished row — but this file does not edit `TASKS.md`.

### 7.4 The reachability gap has recurred a fifth time, one level below where it was last caught

> **And a sixth, in Phase 5 itself.** Four parallel agents produced seven panels in one afternoon,
> every one tested and reachable by nobody — the same shape, at the same scale, one phase after the
> scan was built to stop it. The scan caught it this time, which is the point; P5-T12 is the row
> that closed it and `test/ui/phase5-wiring.test.ts` is the human-side check the scan cannot make.
> **The pattern is not that people forget to wire panels. It is that building the panel and wiring
> the panel are separate pieces of work, and only one of them has ever been in a row's title.**
> P5-T12 has it in the title. That is the actual fix, and it is worth more than the scan.

`TASKS.md` records the pattern four times: Phase 2's panels, Phase 3's orders, Phase 4's screens,
then P4-T14's build menu ("reachability assumed the *content* was reachable; it is not"). This
enumeration found the fifth and sixth instances, and both are one level below the last fix:

- **The production menu** (row 47). P4-T14 fixed *buildings* by deleting a hand-written list; the
  *unit* menu still has its own hand-written filter, and a test pins it.
- **`takeColonyNotes`** (row 93) and the three galaxy note queues (row 94) — complete, documented,
  bridge-side APIs with no consumer.

Neither is visible to the enumeration tests, and the reason is structural and worth writing down:
**an intent sweep cannot see a menu that never offers the intent, and an import-graph scan cannot
see a method nobody calls.** `phase4-input.test.ts` already made this argument about screens and
built a second check for it. The equivalent for content would be a sweep asserting that every
`UNITS` key the engine would accept has a button — and the Phase 1 intent sweep that does not exist
(§2, step 4) would have caught rows 31 and 32 five phases ago.

---

## 8. How to tick a row

A row moves to PRESENT when **all three** are true, in this order:

1. The capability is reachable by a gesture, a button or a panel line in a running client.
2. A test fails **by name** when that control is removed — the pattern
   `test/input/phase{2,3,4}-input.test.ts` established. Phase 5's rows need their own
   `phase5-input.test.ts`; **and Phase 1 still needs the sweep it never had.**
3. The row's trace column names the engine export the client asked, not a rule the client
   re-derived. Rows 48 and 8 are what a re-derivation looks like once it has rotted.

**This file is regenerated, not maintained by hand.** If the count in §4 disagrees with §5, §5 is
right and §4 is stale — recount. If §5 disagrees with the engine, re-run §2's scripts: the vendored
ref moves, and a row that quietly stopped matching an export is exactly the failure this document
exists to prevent.

**What would make this file wrong.** A new upstream ref adding a module (§2 step 1 finds it), a new
intent with no control (the enumeration tests find it), or a row marked PRESENT on a model rather
than a control (§3's bar). The one failure none of those catch is a capability the engine has that
nobody thought to look for — which is why §2 enumerates `Object.keys` over every module rather than
listing the features anyone remembers.
