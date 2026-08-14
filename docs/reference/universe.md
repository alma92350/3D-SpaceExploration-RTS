# The universe — a working digest

**This is a copy. The canonical source is
[`alma92350/SpaceExploration-RTS`](https://github.com/alma92350/SpaceExploration-RTS).**
Where this file and that repo disagree, that repo is right and this file has a bug — fix it here,
never "fix" the engine to match. Numbers below are as of source-repo `main`, 2026-08-14
(post-`93f607a`).

The point of this digest is that an agent implementing a view does not need to read 15k lines of
simulation to know what they are drawing.

---

## 1. What the Odyssey is

An open-ended campaign across a galaxy of **11 worlds**. You are one commander with **one
relocatable capital**. You land with a colony ship, deploy it into a Command Center, mine, build,
trade, fight or befriend the world's neighbour, raise a Spaceport, and jump on. Worlds you leave
become **background colonies** that keep simulating and pay you passive income.

- **No victory.** The Odyssey never resolves by conquest or clock. Progress is marked by
  **milestone fireworks**: worlds settled, first Capital fortified, an Antimatter Gate coming
  online, 4 worlds pacified ("domination"), all 11 pacified ("domination:all").
- **No permanent defeat.** Lose every foothold and a relief colony ship is dispatched
  (`checkGalaxyRescue`). The only ending is a deliberate **surrender**.
- **Determinism.** Same seed ⇒ same galaxy, byte for byte. All randomness comes from a seeded
  `mulberry32`; the engine never touches `Math.random` or a clock.

---

## 2. The galaxy layer

| Concept | Rule |
|---|---|
| **Roster** | 11 worlds: `korrath, ferros, vesper, glacius, nimbus, pyralis, helix, oort, forge, kybernet, verdani` (order matters — the background scheduler keys on roster index) |
| **Seat** | The world you are on. Ticks at full rate, is rendered, takes your orders |
| **Living galaxy** | Your seat **plus a seeded pseudo-random draw of 3 other worlds** (`BACKGROUND_WORLDS`, `backgroundWorldIds`) exist and simulate from turn one. The rest are **dormant** — on the starmap, jumpable, generated on arrival, and simulating from then on |
| **Background tick** | A background world ticks once every `BG_STEP` (4) galaxy ticks, by 4× the step — same total sim time, a quarter of the work, spread round-robin by roster index |
| **Credits** | Universal, galaxy-wide, travel with you. Fund jumps; earned by trading and by colonies |
| **Jump** | Launched from a completed Spaceport. Carries the units staged within `JUMP_LOAD_RADIUS` (150) of a pad, capped by pad tier capacity (12 / 24 / 40 supply at T1/T2/T3, additive across pads). Deployed bases never move |
| **Jump cost** | Free to a world you have reached before or still hold; otherwise `JUMP_COST` (400) scaled by distance across the starmap and discounted by your best pad tier (×1 / ×0.85 / ×0.7) |
| **Landing** | At your own most-recently-used Spaceport if one stands there; else a **blind minimap pick** by the player, snapped to a 160-unit grid; else the world's fixed base anchor |
| **Colony income** | 0.3 credits/s per income-earning player building (turrets excluded), capped at 6 buildings per world. Pacified worlds pay a flat 0.1/s occupation dividend |
| **Freight lanes** | Standing routes between held worlds; assigned freighters move cargo every `LANE_PERIOD` (200 ticks ≈ 10 s) |
| **Faction spread** | Developed AI worlds claim their homeworld, then colonise the nearest unclaimed world, one per ~1 s scan. Claims cover the whole roster, dormant worlds included |
| **Pacified** | A world whose AI has no standing Command Center **and** no colony ship. Sticky and permanent |
| **Rival Gate** | A developed neighbour (Hard, or a patient temperament) can race its own Antimatter Gate. On completion it "ascends": a claims burst, a permanent combat upgrade, and its stance toward you is capped at Wary forever |

**Per-world AI profile.** Only your **start** world's neighbour uses the difficulty and strategy you
picked at setup. Every other world draws its own (`neighbourAiProfile`, seeded) — roughly a third
each of Easy/Medium/Hard crossed with one of four strategies.

---

## 3. The worlds

`x` is the starmap coordinate (drives jump distance). Industry drives factory speed and produced-good
prices; Tech drives research speed.

| id | Name | Tag | x | Ind | Tech | Faction | Deposits |
|---|---|---|---|---|---|---|---|
| `glacius` | Glacius | Ice World | 2 | 2 | 3 | Core | ice 2.0, gas 0.4 |
| `ferros` | Ferros Prime | Mining World | 3 | 4 | 3 | Miners | ore 2.0, crystals 0.7, radioactives 1.0 |
| `verdani` | Verdani | Agri-World | 5 | 3 | 4 | Agri | biomass 2.0, spice 1.0 |
| `helix` | Helix Belt | Asteroid Belt | 6 | 3 | 4 | Miners | ore 1.6, crystals 1.4, radioactives 1.0 |
| `pyralis` | Pyralis | Desert World | 7 | 4 | 5 | Core | crystals 1.4, radioactives 0.8 |
| `kybernet` | Kybernet | Tech Hub | 8 | 8 | 10 | Syndicate | crystals 1.2 |
| `nimbus` | Nimbus | Gas Giant | 9 | 3 | 5 | Frontier | gas 2.0 |
| `forge` | Forge Station | Industrial World | 11 | 10 | 6 | Miners | ore 1.0 |
| `korrath` | Korrath | Warlord World | 14 | 3 | 2 | Frontier | ore 1.3, radioactives 1.1, relics 0.7 |
| `oort` | Oort Reach | Frontier Outpost | 15 | 2 | 2 | Frontier | ore 1.2, radioactives 1.2, relics 0.6 |
| `vesper` | Vesper | Twilight World | 17 | 5 | 4 | Miners | ore 1.5, crystals 1.0, gas 0.6 |

Six worlds carry **planet modifiers** — speed / sight / build-time / richness tweaks plus
rectangular rough- and high-ground terrain stamps. Two (Oort, Nimbus) are asymmetric per side.

**Map**: 1600 × 1000 world units at size ×1, scaling self-similarly to ×4 (Gigantic). Bases sit at
(0.1, 0.5) and (0.9, 0.5) of the field. Terrain and fog share a **40-unit cell grid**; terrain cells
are `0` open, `1` rough (slower, unbuildable), `2` high ground (attacker damage bonus, better
sight). **This grid is the heightmap the 3D view derives elevation from** (PRD ADR-0004).

---

## 4. Sides, factions, resources

**Two sides per world**: `player` and `ai`. Faction is a small passive trait bundle:

| Faction | Traits |
|---|---|
| Frontier Coalition | speed ×1.08, sight ×1.06 |
| Miners' Union | gather ×1.15, build time ×0.90 |
| Vanguard Syndicate | damage dealt ×1.10, gather ×0.92 |
| Unaligned (`neutral`) | none |

**Commodities** (subset that matters in the RTS): raw — `ore`, `crystals`, `radioactives`, `ice`,
`biomass`, `spice`, `gas` (Helium-3), `relics`; refined/made — `metals`, `alloys`, `electronics`,
`machinery`, `energy`, `fuel`, `chemicals`, `goods`, `antimatter`, `plasmatorp`. Cargo worth hauling
between worlds, most valuable first: machinery, electronics, alloys, spice, metals.

---

## 5. Units

| id | Role | Notes for the view |
|---|---|---|
| `worker` | economy | gathers, hauls, builds, repairs; carries visible cargo |
| `colonyship` | economy | deploys into a Command Center; rides jumps |
| `skiff` | combat | fast, cheap; beats Lancer |
| `bastion` | combat | slow, tanky, short-ranged; beats Skiff |
| `lancer` | combat | long-ranged, armour-piercing; beats Bastion |
| `breacher` | siege | outranges static defence, wrecks buildings, folds to massed Skiffs |
| `ranger` | scout | vision |
| `mender` | support | repairs units |
| `dreadnought`, `colossus`, `leviathan`, `wraith`, `aegis` | late/elite | rare, large silhouettes |
| `freighter`, `hauler`, `heavyhauler`, `bulkfreighter` | logistics | cargo holds; freight lanes |
| `heliumbomb` | superweapon | armed/fused, leaves a crater |

Combat is a genuine rock-paper-scissors triangle (Skiff → Lancer → Bastion → Skiff) with the
Breacher deliberately outside it. **Veterancy**: 3 permanent ranks at 3/8/18 kills, ~+19 % damage
and −17 % taken at max, shown as chevrons over the health bar — the view must keep that cue.

---

## 6. Buildings

**Core**: `command` (Command Center — fortifiable into a **Capital**, ×2 HP, one per owner),
`barracks`, `habitat` (supply), `refinery` (doctrines), `foundry`, `arsenal`, `market`,
`spaceport` (3 tiers), `stardock`.

**Defence**: `turret` (Sentinel) → `bastille` → `aegisbastion` (shields nearby friendlies 20 %),
`torpedobattery`.

**Industry**: `reactor`, `combustor`, `biomassreactor`, `substation` (power/efficiency zones),
`smelter`, `assembler`, `chipfab`, `machineworks`, `datacenter`, `plasmarig`, `antimatterforge`,
`aifoundry`, `torpedoworks`, `chemplant`, `fabricator`.

**Wonder**: `antimatter_gate` — charges over time from fed strategic goods; completing it is a
milestone (and, for the AI, the "ascension").

Factories run a **finite-storage logistics loop**: inputs must be hauled in by workers and outputs
hauled out, for both sides symmetrically. Power/electrification zones raise efficiency near a
Reactor. Both of these are strong visual opportunities in 3D and strong perf risks (many small
entities in motion).

---

## 7. Diplomacy

Each world's neighbour holds a **stance** toward you in [-1, 1], drifting from a target set by
scarcity (how drained the deposits are), the AI's development, elapsed time (a late-game creep past
a 7-minute grace), and your actions (strip-mining, attacks, tribute, gifts, favours). Thresholds:
peace, allied. A **pacified** world is floored at neutral forever; an **ascended** rival is capped
at wary forever. Faction memory echoes a grievance onto a conquered world's faction-mates, and an
Allied world lifts its faction-mates a little.

The view needs: a stance readout per world, the transitions (war declared, truce, allied), and the
alerts a background colony raises (under attack, hostile, lost).

---

## 8. Simulation shape (what the renderer consumes)

- **Fixed timestep**, 20 Hz (`PLAY_HZ`), max 5 catch-up substeps per animation frame, then it
  degrades to slow motion rather than spiralling.
- **State** is a plain object graph: `units: Map<id, Unit>`, `buildings: Map<id, Building>`,
  `players: {player, ai}`, `map` (width, height, nodes, terrain grid, bases), `fog`/`fogAI`
  (`explored` + `visible` byte grids at 40-unit cells), `market`, `diplomacy`, `events` (a per-tick
  queue the UI drains), `selection`.
- **Positions are 2D** `(x, y)` floats in world units. Radii are per entity type. **There is no z.**
- **Rendering interpolates** between the last two sim ticks (`snapshotPositions` + an `alpha`) —
  the 2D client already does this and the 3D client must too.
- **Orders** go through `engine/commands.js`; nothing else may write to state.
- **Saves**: `SAVE_VERSION` 1 (skirmish), `GALAXY_SAVE_VERSION` 1 (Odyssey). Exact-match version
  gating, no migrations; every load sanitises and clamps untrusted input.

---

## 9. Where to look in the source repo

| For | File |
|---|---|
| Galaxy meta-layer, jumps, colonies, milestones | `engine/galaxy.js` |
| Per-tick orchestration | `engine/sim.js` |
| State shape and factories | `engine/state.js`, `engine/types.js` |
| Unit/building definitions and stats | `engine/entities.js` |
| Map, terrain, planet modifiers | `engine/map.js` |
| Worlds, commodities, lore factions | `data.js` |
| Fog | `engine/fog.js` |
| Combat, movement, gathering, hauling | `engine/combat.js`, `movement.js`, `gather.js`, `haul.js` |
| AI | `engine/ai*.js` |
| Diplomacy | `engine/diplomacy.js` |
| Save/load | `engine/persist.js` |
| The 2D renderer (silhouettes worth carrying over) | `render*.js` |
| Player-facing rules | `docs/player-handbook.html`, `README.md` |
| Conquest strategy, engine-sourced | `docs/odyssey-conquest-strategy.md` |
