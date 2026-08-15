// The scripted perf scene (ADR-0006 §4, P0-T06, P1-T23).
//
// A perf gate needs a scene that is IDENTICAL every run — same seed, same camera path, same entity
// spawns — or the numbers measure the scene rather than the code. So this module builds a world to
// a fixed recipe and drives the camera along a fixed path, and the runner just times frames.
//
// The entity counts come straight from PRD §6.2: T0 is 200 units and 80 buildings at 1280×720; T2
// is 400 and 200 at 1600×900. Those are the loads the budget is written against, so they are the
// loads the gate runs.

import { WorldBridge, MVP_WORLD } from "../src/bridge/world.js";
import { type Snapshot } from "../src/bridge/snapshot.js";
import { STEP_SECONDS } from "../src/app/loop.js";
import {
  BUILD_REACH, BUILDINGS, ODYSSEY_WORLDS, UNITS, addPlanet, makeBuilding, makeUnit,
} from "../src/engine/index.js";
import { checkPlacement } from "../src/bridge/commands.js";
import { CameraRig } from "../src/input/camera.js";
import { pickGround } from "../src/input/picking.js";
import { SceneComposer, type GhostState } from "../src/view/scene.js";
import { elevationFieldFrom, type ElevationField } from "../src/view/terrain/elevation.js";
import { buildTerrainMesh } from "../src/view/terrain/mesh.js";
import { buildMeshes, meshIdForType } from "../src/view/meshes/generators.js";
import {
  type CameraState, type FrameStats, type Renderer, type TerrainMesh, type Tier,
} from "../src/view/renderer/port.js";
import { TIERS, percentile } from "../src/view/renderer/tiers.js";

export const PERF_SEED = 20260814;

export interface SceneSpec {
  readonly tier: Tier;
  readonly units: number;
  readonly buildings: number;
  readonly width: number;
  readonly height: number;
  /**
   * Which building types to populate with. Omitted means the MVP's four.
   *
   * `"all"` uses every type the engine defines, which is what makes the Phase 2 scene a real test
   * of ADR-0013: 300 barracks would sail through a budget that 29 distinct types must actually be
   * collapsed to meet.
   */
  readonly buildingTypes?: "mvp" | "all";
  /** `"all"` uses every unit type, so every unit mesh is exercised (P3-T16). */
  readonly unitTypes?: "mvp" | "all";
  /**
   * Cluster the two sides into contact instead of scattering them over the map.
   *
   * Without this the units are spread on a lattice, nothing is inside anything else's weapons range,
   * and a "combat" scene measures a parade — no shots, no deaths, no combat feedback at all.
   */
  readonly packed?: boolean;
  /**
   * Armed Helium Bombs with a fuse held open, for the P3-T10 overlay (default none).
   *
   * The bomb overlay is the one thing Phase 3 added that no scene was measuring: `unitTypes: "all"`
   * already puts a Helium Bomb on the P3 field, but an UNARMED one draws nothing, so the layer never
   * fired in any gated run. That is the third time a harness here has silently not measured what a
   * task shipped, and the two before it were both found late.
   *
   * **On P3 rather than on T0/T2, and the reason is what the number would MEAN.** Arming a bomb on a
   * scene whose unit mix does not already contain one costs three draw calls, not one: the overlay
   * plus the bomb's own mesh for two owners. P3 already counts that mesh, so arming there isolates
   * the overlay — the delta is exactly the thing being measured, which is the whole point of adding
   * it to a gate.
   *
   * **Placed out of the packed blocks' reach**, which is not decoration. Any hit on an armed bomb
   * detonates it (`detonateIfAttacked`), and one detonation is 3 000 damage across a 190 radius — a
   * bomb dropped into the middle of P3 would erase most of the 200 units and quietly invalidate the
   * very measurement ADR-0016 named as its own supersede trigger. So they sit on the map's edges,
   * where the camera path still passes them.
   *
   * The fuse is held open with a `fuseUntil` far past the end of the run. That is synthetic and
   * worth naming: it forces the LIT path, which is the expensive one (two rings and a swept arc
   * rather than two rings), and a real fuse lasts four seconds — 80 of the 600 frames.
   */
  readonly armedBombs?: number;
  /**
   * Producer buildings left SELECTED for the whole run, for the P5-T15 rally overlay (default none).
   *
   * The same hole `armedBombs` was added to close, one row later: a rally line is drawn only for a
   * selected producer the viewer owns, and **no perf scene has ever selected anything at all** — so
   * the layer would have shipped ungated, which is now the fourth time this harness has silently not
   * measured what a task shipped.
   *
   * **It costs TWO draw calls, not one, and that is worth saying rather than hiding.** Selecting a
   * building raises the `selection` ring as well as the rally line, and the ring is Phase 1's — so
   * this flag also puts the oldest overlay in the client onto a gate for the first time. The
   * armed-bomb entry could isolate its delta because the P3 scene already carried the bomb's mesh;
   * there is no scene with a selection to hang this off, so the delta is two layers and the reason
   * is stated instead of measured away.
   *
   * **On P2 rather than on T0/T2**, because P2 is the base-management scene: 300 buildings across
   * all 29 types is the only gated scene where enough of the roster's three producers (`command`,
   * `barracks`, `stardock`) exist for a realistic multi-building selection, and a rally line is a
   * base-management cue rather than a combat one.
   */
  readonly selectedProducers?: number;
  /**
   * Bring up the WHOLE world roster and give every world off the seat this same scene's economy,
   * so the background galaxy the bridge has been stepping since Phase 1 is finally loaded (P4-T10).
   *
   * `createGalaxy` already lives every scene: it brings up `BACKGROUND_WORLDS` (3) neighbours and
   * `stepGalaxy` has ticked them from the first perf run this repo ever recorded. So why is this
   * flag not redundant? Because of what those three worlds CONTAIN. An `unsettled` world is stripped
   * of the player and left with the AI's opening — measured, **one unit and zero buildings**. Three
   * worlds holding one colony ship each is an empty loop with a `tick()` around it, and every perf
   * number this project has published so far has quietly included it and called that "the background
   * simulation running". That is the fourth time this harness would have reported measuring
   * something it was not, and the point of this scene is to stop it being the fourth.
   *
   * So: every roster world is instantiated, and each one off the seat is populated with THIS spec's
   * own `units`/`buildings` recipe. Deliberately the same load as the active world, because PRD
   * §6.2's counts are the only entity counts this project has a budget written against — a
   * background world sized to anything else would produce a number nobody could check. It is a
   * pessimistic load and should be read as one: a real colony is smaller than a battlefield.
   *
   * Never `packed`, and never `armedBombs`. Packing exists to force a fight in front of the camera;
   * on ten unrendered worlds it would only accelerate the mutual annihilation that `PerfScene.tick`
   * already has to watch for (see `BACKGROUND_SURVIVAL_FLOOR`).
   */
  readonly settledRoster?: boolean;
  /**
   * Hold a build ghost up for the whole run, as the game does while the player is placing (P6-T07).
   *
   * The fifth hole of the same shape, and the largest of them: `PerfScene.render` passed `null` for
   * the ghost, so `pushGhost` — the `ghost` overlay AND the translucent building batch under it —
   * had never executed in any gated run at all. It is not an edge case either: build mode is where
   * a player spends the early minutes of every match, and `Game.updateGhost` runs `pickGround` and
   * `checkPlacement` on EVERY frame it is up, neither of which any gate has priced.
   *
   * Both of those are called here per frame, from the viewport centre, exactly as `updateGhost`
   * calls them from the pointer — a ghost whose validity was decided once in the constructor would
   * measure the drawing and skip the deciding.
   *
   * **It costs TWO draw calls on P2's peak frame, and the second one is the interesting one.** The
   * overlay layer is +1 unconditionally. The batch is +1 only sometimes: `pushGhost` batches at
   * `(meshId, OWNER_PLAYER, LOD_MESH)`, and the ghost sits at the viewport centre where it is always
   * at mesh LOD, while the player's own buildings of that family may every one of them be past
   * `tier.lodDistance` and drawing as imposters. So the ghost opens `factory|0|0` on exactly the
   * frames the camera is far enough out — which is what the peak frame is. Stated rather than
   * engineered away: `armedBombs` could isolate its delta because P3 carries the bomb mesh at every
   * zoom, and there is no zoom-independent way to do the same for a building.
   *
   * It also brings up the POWER field, because that is what the game does: `Game` calls
   * `setPower(snap.power)` while a ghost is up (ADR-0012 §2 — the grid is a placement cue). That
   * path was likewise never exercised, and it is version-gated, which is precisely the kind of
   * contract that regresses into a per-frame upload without anything going red.
   */
  readonly ghostBuilding?: string;
  /**
   * Units given enough kills to wear a veterancy chevron (P6-T07).
   *
   * `chevron` is Phase 1's, it is drawn per ranked unit inside the LOD distance, and across all
   * five gated scenes it fired on **ten frames of three thousand** — all ten on T2, all of them
   * because a unit happened to reach three kills mid-run. That is not coverage, it is an accident
   * that a balance change would take away silently.
   *
   * Ranks are set through `kills`, which is upstream's own input to `rankOf` (3/8/18), rather than
   * by writing a rank the engine did not compute. Spread over all three ranks, because the overlay
   * draws one chevron per rank and rank 3 is three times the work of rank 1.
   *
   * **On P3, which is its home, and on T2, which is where the accident was.** P3 is the combat scene
   * and veterancy is a combat cue. T2 is here for a different reason: those ten frames were T2's, and
   * once the camera path started sweeping all eight yaw snaps one of them landed on T2's peak batch
   * frame. A baseline whose top figure depends on whether some Lancer reached three kills this
   * balance patch is not a measurement, and it fails OPEN — the accident going away would lower the
   * real maximum to 24 while the recorded 25 kept absorbing a genuine regression in silence. T0 and
   * P4 are deliberately left alone: they have never drawn a chevron at all, so there is nothing there
   * to stop happening, and P4's whole design is to be T0's spec with exactly one field added.
   */
  readonly veterans?: number;
}

/** The gated scenes. PRD §6.2's own numbers; changing one is a PRD change, not a tuning knob. */
export const SCENES: Readonly<Record<string, SceneSpec>> = {
  T0: { tier: "T0", units: 200, buildings: 80, width: 1280, height: 720 },
  T2: { tier: "T2", units: 400, buildings: 200, width: 1600, height: 900, veterans: 12 },
  // PRD §5's Phase 2 exit criterion — "perf budgets hold with 300 buildings on screen" — at the T0
  // tier, because CPU-only is the whole target (ADR-0011). Every one of the 29 building types is
  // present: the point is to measure what the six silhouette families actually cost, not to
  // measure 300 copies of one mesh.
  P2: {
    tier: "T0", units: 200, buildings: 300, width: 1280, height: 720, buildingTypes: "all",
    selectedProducers: 8, ghostBuilding: "smelter",
  },
  // PRD §5's Phase 3 exit criterion, and the gate ADR-0016 named as its own supersede trigger
  // (P3-T16). Every unit type the engine defines, so all fifteen unit meshes are on the field at
  // once — the perf scenes above use the four-type MVP mix, which means none of ADR-0016's nine new
  // silhouettes had ever reached a perf gate despite that ADR resting on this measurement.
  //
  // `packed` is what makes it a FIGHT rather than a parade: the lattice above spreads units over
  // the whole map, where nothing is in weapons range of anything and no tracer is ever drawn.
  P3: {
    tier: "T0", units: 200, buildings: 80, width: 1280, height: 720,
    unitTypes: "all", packed: true, armedBombs: 3, veterans: 24,
  },
  // PRD §5's Phase 4 exit criterion (P4-T10): "a galaxy with the full roster settled holds the T0
  // budget while the active world renders". Deliberately T0's spec with ONE field added, so the two
  // rows of `npm run perf` output can be read against each other — the whole difference between
  // them is the ten settled worlds, which makes the aggregate background cost visible without any
  // arithmetic at all. The per-world half of the criterion needs arithmetic, and `BackgroundReport`
  // below is that.
  P4: {
    tier: "T0", units: 200, buildings: 80, width: 1280, height: 720,
    settledRoster: true,
  },
};

const UNIT_MIX = ["skiff", "bastion", "lancer", "worker"] as const;
const BUILDING_MIX = ["barracks", "habitat", "turret", "refinery"] as const;

/**
 * Kill counts that land on ranks 1, 2 and 3 of upstream's 3/8/18 ladder — see `SceneSpec.veterans`.
 *
 * One entry per rank rather than one number, because the overlay draws one chevron PER rank: a
 * field of rank-1 units would measure a third of what a field of rank-3 units costs, and the
 * cheapest of the three is exactly the one a scene would pick by accident.
 */
const KILL_COUNTS = [3, 8, 18] as const;

// ---------------------------------------------------------------------------------------------
// P4-T10 — what the settled background costs, per world.
//
// The exit criterion is a MEASUREMENT, not a build: `WorldBridge.stepWorld` has called `stepGalaxy`
// rather than `tick` since Phase 1, on purpose, so the background simulation already runs. What has
// never existed is a number for it — and the row asks for that number **per world, not in
// aggregate**, which is the part that decides how everything below is shaped.
//
// Why per-world is not just aggregate-divided-by-N: `stepGalaxy` spreads the background roster
// round-robin by fixed roster index, so a world steps once every `BG_STEP` galaxy ticks and only
// ~ceil(N/BG_STEP) of them step on any one tick. Frame N and frame N+1 therefore do DIFFERENT
// amounts of background work, and a mean over frames reports a load that no single frame ever
// carries. Sizing a phase against that mean would under-budget every frame that lands on the
// heaviest step. So the cost is bucketed by the round-robin phase and the marginal cost of one
// world is read off the difference between phases that step different numbers of worlds.
//
// The round-robin's PERIOD is measured, never imported. `BG_STEP` is upstream's constant and a
// harness that hard-codes 4 would keep reporting a tidy four-phase cycle after upstream changed it
// — which is precisely the class of silent mis-measurement this file's other comments are about.
// It is read back out of the gaps between the ticks on which each world actually advanced.
// ---------------------------------------------------------------------------------------------

/**
 * The share of its starting entities the settled background must still hold, on every tick.
 *
 * The two sides on a background world fight, exactly as they do on the rendered one, and by the end
 * of a 10-second gate run the roster is down to roughly two thirds of the units it started with.
 * That erosion is honest — it is what a settled world does — but it is also the ingredient that
 * turns a run's tail into a cheaper scene than its head, and this harness has twice shipped numbers
 * that were flattering for exactly that reason. `maxDrawCalls` had the same hole and got the same
 * treatment (see `armedBombs`): a scene that erased itself halfway would still report the peak it
 * reached first. So the floor is asserted rather than assumed, and the report carries the start and
 * end entity counts so a reader can see the erosion instead of being told about it.
 *
 * 0.4 rather than something tighter because this must fail on a COLLAPSE, not on a balance patch.
 */
const BACKGROUND_SURVIVAL_FLOOR = 0.4;

/** Galaxy ticks by which every settled world must have been scheduled at least once. */
const SCHEDULE_GRACE_TICKS = 16;

/** Samples a group needs before its median may carry the marginal-cost estimate. */
const MIN_GROUP_SAMPLES = 8;

/** One phase of the background round-robin: how many worlds it steps, and what that step costs. */
export interface BackgroundPhase {
  /** `galaxy.tick % period`. */
  readonly phase: number;
  /** Background worlds this phase steps — the round-robin's whole point is that this varies. */
  readonly worlds: number;
  readonly ticks: number;
  readonly p50: number;
  readonly p95: number;
}

export interface BackgroundReport {
  /** Settled background worlds: the roster minus the seat. */
  readonly worlds: number;
  readonly entitiesAtStart: number;
  readonly entitiesAtEnd: number;
  /** The round-robin period in galaxy ticks, MEASURED (upstream calls it `BG_STEP`). */
  readonly period: number;
  readonly galaxyTicks: number;
  readonly phases: readonly BackgroundPhase[];
  /** The most background worlds any one galaxy tick stepped — the spike, not the average. */
  readonly maxWorldsPerStep: number;
  /**
   * Cost of ONE background world-step, in milliseconds.
   *
   * Marginal, and it has to be: `stepGalaxy` ticks the seat and the scheduled colonies inside one
   * call, and nothing outside it can time the two halves apart. So this is the median step cost of
   * the ticks that ran the most worlds minus that of the ticks that ran the fewest, over the
   * difference in world count — everything the two groups share (the seat's own tick, the snapshot
   * extraction, the drain) cancels. Medians rather than means because upstream's galaxy-wide scans
   * run on a ~1/sec schedule that lands on one phase, and a mean would fold that into per-world
   * cost; a median of 50 samples shrugs off the 5% of ticks that carry it.
   *
   * Null when every tick stepped the same number of worlds, which leaves nothing to difference.
   */
  readonly perWorldStepMs: number | null;
  /** Whole-bridge-step cost, over galaxy ticks. Includes the seat — see `perWorldStepMs`. */
  readonly stepP50: number;
  readonly stepP95: number;
}

/**
 * Bring up every roster world and give the ones off the seat a real economy. Returns their ids.
 *
 * `addPlanet(..., { unsettled: true })` is upstream's own "a world the player has not landed on"
 * constructor — the same call `createGalaxy` makes for its three live neighbours — so this settles
 * the roster the way the game does, not by hand-building states the engine would never produce.
 */
function settleRoster(galaxy: Galaxy, spec: SceneSpec): string[] {
  for (const id of ODYSSEY_WORLDS) if (!galaxy.planets.has(id)) addPlanet(galaxy, id, { unsettled: true });
  const background: string[] = [];
  for (const id of ODYSSEY_WORLDS) {
    if (id === galaxy.activeId) continue;
    const state = galaxy.planets.get(id);
    if (!state) throw new Error(`perf scene: roster world ${id} did not come up`);
    populate(state, { ...spec, packed: false, armedBombs: 0, selectedProducers: 0, settledRoster: false });
    background.push(id);
  }
  return background;
}

/**
 * The bridge's galaxy, which it deliberately does not expose.
 *
 * `WorldBridge` keeps the galaxy private and hands out only the seat (`state`) — correctly, since
 * ADR-0008's whole point is that nothing above the bridge reasons about the meta-layer. This scene
 * is not above the bridge; it is a measuring instrument clamped around it, and it needs the galaxy
 * for two things neither of which the game ever wants: settling the roster, and reading each
 * colony's clock to see which ones a step actually advanced. `populate` already reaches through
 * `bridge.state` to build the world by hand, so the boundary being crossed here is the same one.
 *
 * The shape is CHECKED rather than trusted. A cast that silently produced `undefined` after a
 * rename would leave this scene settling nothing and reporting a background cost of zero — a green
 * gate proving nothing at all, which is the exact failure this file keeps a list of.
 */
function galaxyOf(bridge: WorldBridge): Galaxy {
  const galaxy = (bridge as unknown as { galaxy?: Galaxy }).galaxy;
  if (!galaxy || !(galaxy.planets instanceof Map) || typeof galaxy.tick !== "number") {
    throw new Error(
      "perf scene: WorldBridge no longer keeps its galaxy in a `galaxy` field with a `planets` map "
      + "and a `tick` counter. The P4 scene settles the roster through it and reads each colony's "
      + "clock to see which ones a step advanced; without it the scene would settle nothing and "
      + "report a background cost of zero. Re-point `galaxyOf`.",
    );
  }
  return galaxy;
}

/**
 * The instrument. Straddles `bridge.step` and records, per galaxy tick, how long the step took and
 * which background worlds it advanced.
 *
 * "Which worlds advanced" is read from each colony's own `state.time`, not predicted from the
 * schedule. Predicting it would mean reimplementing `stepGalaxy`'s round-robin here, and a
 * reimplementation agrees with the engine right up until the moment the measurement matters.
 */
class BackgroundProbe {
  private readonly states: State[];
  /** `state.time` per world, as of the top of the current step. Reused; never reallocated. */
  private readonly before: number[];
  /** The galaxy tick each world last advanced on, or -1 — the period is read off the gaps. */
  private readonly lastStep: number[];
  private readonly gaps: number[] = [];
  private readonly stepMs: number[] = [];
  private readonly stepTick: number[] = [];
  private readonly stepWorlds: number[] = [];
  private ticksSeen = 0;
  readonly entitiesAtStart: number;

  constructor(private readonly galaxy: Galaxy, private readonly ids: readonly string[]) {
    this.states = ids.map((id) => {
      const state = galaxy.planets.get(id);
      if (!state) throw new Error(`perf scene: background world ${id} is not in the galaxy`);
      return state;
    });
    this.before = this.states.map(() => 0);
    this.lastStep = this.states.map(() => -1);
    this.entitiesAtStart = this.entities();
    // PREMISE ONE: the worlds are actually inhabited. An `unsettled` world holds one colony ship
    // and nothing else, and ten of those cost almost exactly nothing to tick — a background number
    // measured against them would be a measurement of an empty loop, reported as a measurement of
    // a settled galaxy. Asserted at construction because `settledRoster` failing to reach a world
    // is silent everywhere else.
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i]!;
      if (state.units.size > 1 && state.buildings.size > 0) continue;
      throw new Error(
        `perf scene: background world ${this.ids[i]} came up with ${state.units.size} units and `
        + `${state.buildings.size} buildings — that is upstream's bare \`unsettled\` opening, not a `
        + `settled colony, and the background cost measured against it would be the cost of an `
        + `empty loop. \`settleRoster\` did not populate it.`,
      );
    }
  }

  /** Total units and buildings across the settled background. */
  private entities(): number {
    let n = 0;
    for (const state of this.states) n += state.units.size + state.buildings.size;
    return n;
  }

  beforeStep(): void {
    for (let i = 0; i < this.states.length; i++) this.before[i] = this.states[i]!.time;
  }

  afterStep(ms: number): void {
    const tick = this.galaxy.tick;
    let stepped = 0;
    for (let i = 0; i < this.states.length; i++) {
      if (this.states[i]!.time === this.before[i]) continue;
      stepped++;
      if (this.lastStep[i]! >= 0) this.gaps.push(tick - this.lastStep[i]!);
      this.lastStep[i] = tick;
    }
    this.stepMs.push(ms);
    this.stepTick.push(tick);
    this.stepWorlds.push(stepped);
    this.ticksSeen++;

    // PREMISE TWO: the galaxy really is being stepped, and every settled world is on the schedule.
    // This is the assertion the whole row rests on — `stepWorld` calling `tick` instead of
    // `stepGalaxy` would cost nothing, break nothing visible, and turn this scene into T0 with ten
    // idle worlds sitting in memory. It would also be the single easiest regression to introduce.
    if (this.ticksSeen === SCHEDULE_GRACE_TICKS) {
      const idle = this.ids.filter((_, i) => this.lastStep[i]! < 0);
      if (idle.length) {
        throw new Error(
          `perf scene: ${idle.length} settled world(s) never advanced in ${SCHEDULE_GRACE_TICKS} `
          + `galaxy ticks (${idle.join(", ")}). Either the bridge stopped calling \`stepGalaxy\`, or `
          + `the round-robin no longer reaches them. Either way the background cost this scene is `
          + `about is not being paid, and the number it would print is a fiction.`,
        );
      }
    }

    // PREMISE THREE: the load is still there. See `BACKGROUND_SURVIVAL_FLOOR`.
    const left = this.entities();
    if (left < this.entitiesAtStart * BACKGROUND_SURVIVAL_FLOOR) {
      throw new Error(
        `perf scene: the settled background has fallen from ${this.entitiesAtStart} entities to `
        + `${left} — below ${Math.round(BACKGROUND_SURVIVAL_FLOOR * 100)}% of what it started with. `
        + `The tail of this run is measuring a galaxy that annihilated itself, and averaging it with `
        + `the head produces a per-world cost no settled world ever had.`,
      );
    }
  }

  /** Drop the warm-up samples. Called once the harness starts measuring; see `runScene`. */
  restart(): void {
    this.stepMs.length = 0;
    this.stepTick.length = 0;
    this.stepWorlds.length = 0;
    this.gaps.length = 0;
  }

  report(): BackgroundReport {
    // The period, read back out of the schedule rather than imported from upstream. The gaps are
    // the distances between consecutive advances of the same world, so their mode IS `BG_STEP`.
    const period = Math.max(1, mode(this.gaps));
    const phases: BackgroundPhase[] = [];
    for (let p = 0; p < period; p++) {
      const ms: number[] = [];
      let worlds = 0;
      for (let i = 0; i < this.stepMs.length; i++) {
        if (this.stepTick[i]! % period !== p) continue;
        ms.push(this.stepMs[i]!);
        worlds = Math.max(worlds, this.stepWorlds[i]!);
      }
      if (!ms.length) continue;
      phases.push({ phase: p, worlds, ticks: ms.length, p50: round2(percentile(ms, 0.5)), p95: round2(percentile(ms, 0.95)) });
    }

    // Marginal cost, grouped by the number of worlds a tick actually stepped rather than by phase:
    // two phases can step the same count, and it is the COUNT the cost is a function of.
    const byWorlds = new Map<number, number[]>();
    for (let i = 0; i < this.stepMs.length; i++) {
      const k = this.stepWorlds[i]!;
      const bucket = byWorlds.get(k) ?? [];
      bucket.push(this.stepMs[i]!);
      byWorlds.set(k, bucket);
    }
    const usable = [...byWorlds.entries()]
      .filter(([, ms]) => ms.length >= MIN_GROUP_SAMPLES)
      .sort((a, b) => a[0] - b[0]);
    const lo = usable[0];
    const hi = usable[usable.length - 1];
    const perWorldStepMs = lo && hi && hi[0] > lo[0]
      ? round2((percentile(hi[1], 0.5) - percentile(lo[1], 0.5)) / (hi[0] - lo[0]))
      : null;

    return {
      worlds: this.ids.length,
      entitiesAtStart: this.entitiesAtStart,
      entitiesAtEnd: this.entities(),
      period,
      galaxyTicks: this.stepMs.length,
      phases,
      maxWorldsPerStep: this.stepWorlds.reduce((a, b) => Math.max(a, b), 0),
      perWorldStepMs,
      stepP50: round2(percentile(this.stepMs, 0.5)),
      stepP95: round2(percentile(this.stepMs, 0.95)),
    };
  }
}

/** The most common value in `values`, ties going to the smallest. 0 for an empty list. */
function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [v, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > bestCount) { best = v; bestCount = n; }
  }
  return best;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const NOW = (): number => performance.now();

/**
 * How long the camera path holds one of the rig's eight yaw snaps, in seconds.
 *
 * It used to be 6, and 6 is longer than the gate: `run.mjs` fixes the run at 10 s, so a gated
 * measurement reached yaw indices 0 and 1 and **never the other six**. That is not a cosmetic gap.
 * The rig snaps yaw to 8 compass directions (ADR-0010) and the imposter quad's screen area is a
 * function of which one is active — at indices 2 and 6 the quad is edge-on and projects to 0.00 px,
 * and P6-T07 found it back-facing at five of the eight. The gate could not have seen any of that,
 * because the gate only ever looked from two of them.
 *
 * 1.25 s × 8 = 10 s, so one gate run is exactly one full revolution, and the 60 warm-up frames plus
 * 600 measured ones span all eight snaps. Not shorter: a yaw change re-buckets which entities are
 * culled, so a path that spun faster than the sim ticks would measure the spin.
 */
const YAW_HOLD_SECONDS = 1.25;

/** `GhostState` with the readonly stripped — the scene mutates one instance instead of allocating. */
type MutableGhost = { -readonly [K in keyof GhostState]: GhostState[K] };

export class PerfScene {
  readonly composer: SceneComposer;
  readonly rig: CameraRig;
  readonly terrain: TerrainMesh;
  readonly field: ElevationField;
  private readonly bridge: WorldBridge;
  private frame = 0;
  /** The armed bombs' ids, so `tick` can prove the scene is still the scene. See `armedBombs`. */
  private readonly bombIds: string[] = [];
  /** P4-T10's instrument, or null for a scene that settles nothing. */
  private readonly background: BackgroundProbe | null;
  /** The held build ghost, reused every frame. Unused when `spec.ghostBuilding` is absent. */
  private readonly ghostState: MutableGhost;

  constructor(readonly spec: SceneSpec) {
    this.bridge = new WorldBridge({ seed: PERF_SEED, worldId: MVP_WORLD });
    const state = this.bridge.state;

    // The settled roster goes up BEFORE the seat is populated (P4-T10): `addPlanet` re-bases the
    // engine's global entity-id counter past everything already in the galaxy, so bringing the ten
    // colonies up first leaves the seat's own ids minted from one settled counter rather than
    // interleaved with eleven re-basings.
    let background: BackgroundProbe | null = null;
    if (spec.settledRoster) {
      const galaxy = galaxyOf(this.bridge);
      background = new BackgroundProbe(galaxy, settleRoster(galaxy, spec));
    }
    this.background = background;

    // Populate to the budgeted counts directly rather than playing the game up to them: a scripted
    // 60-second match reaches a different army every time upstream touches the AI, and the gate
    // would then measure balance changes as perf regressions.
    populate(state, spec, this.bombIds);
    // Reveal the whole map so fog does not quietly cull half the scene away — the budget is written
    // for what is ON SCREEN, and a fogged perf run flatters the renderer.
    state.fogs.player.explored.fill(1);
    state.fogs.player.visible.fill(1);

    this.field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
    this.terrain = buildTerrainMesh(this.field, {
      relief: TIERS[spec.tier].terrain === "relief", apron: TIERS[spec.tier].apron,
    });
    this.composer = new SceneComposer(this.field);
    this.rig = new CameraRig({ mapWidth: state.map.width, mapHeight: state.map.height }, this.field);

    // The held ghost, built once with the fields that never change and mutated per frame.
    // `reach` and `radius` follow `Game.updateGhost` exactly; getting them from the engine's own
    // definition rather than typing numbers is what keeps the reach ring the size the game draws.
    const def = BUILDINGS[spec.ghostBuilding ?? ""];
    this.ghostState = {
      active: true, x: 0, y: 0, radius: def?.radius ?? 16, valid: true,
      meshId: meshIdForType(spec.ghostBuilding ?? ""), reach: BUILD_REACH + (def?.radius ?? 16),
    };
    // A name the engine does not know fails SILENTLY in two directions at once: `checkPlacement`
    // answers about a building that does not exist, and `meshIdForType` falls back to the worker
    // block — so the layer this flag exists to price would be priced against the wrong mesh while
    // every count still looked healthy. (A type the engine knows but `BUILDING_FAMILY` has missed
    // takes the same fallback, and `test/view/building-meshes.test.ts` is what catches that.)
    if (spec.ghostBuilding && !def) {
      throw new Error(
        `perf scene: ghostBuilding "${spec.ghostBuilding}" is not a building type the engine defines, `
        + `so \`checkPlacement\` would answer about nothing and the ghost would draw a fallback mesh.`,
      );
    }
  }

  /**
   * Advance the simulation one tick. Called at 20 Hz, as in the real loop.
   *
   * `now` is the harness's own clock rather than a second one, so the background timing below and
   * the frame timing in `runScene` cannot drift apart or disagree about what a millisecond is.
   */
  tick(now: () => number = NOW): void {
    // The background probe straddles `bridge.step` and NOTHING else, because `bridge.step` is where
    // `stepGalaxy` runs. Timing it from inside `runScene`'s frame loop instead would fold the
    // render into the number; timing it in the constructor would put the whole background cost in
    // setup, where the criterion — "while the active world renders" — says it must not be.
    const bg = this.background;
    if (bg) {
      bg.beforeStep();
      const t0 = now();
      this.bridge.step(STEP_SECONDS);
      bg.afterStep(now() - t0);
    } else {
      this.bridge.step(STEP_SECONDS);
    }
    // A detonation would not fail this gate on its own — `maxDrawCalls` is a maximum, so a scene
    // that erased itself halfway through would still report the peak it reached before it did, and
    // the run would come out GREEN with two thirds of its frames measuring an empty map. So the
    // invariant is asserted rather than assumed. Three map lookups a tick.
    for (const id of this.bombIds) {
      if (!this.bridge.state.units.has(id)) {
        throw new Error(
          `perf scene: an armed Helium Bomb detonated (${id}). The blast is 3 000 damage across a `
          + `190 radius, so the scene is no longer the scene and its numbers mean nothing. Move the `
          + `bomb spots in \`BOMB_SPOTS\` clear of anything's weapons range.`,
        );
      }
    }
    // The bridge's own snapshot, NOT a second extractor (P3-T16).
    //
    // This used to keep its own `SnapshotExtractor` and extract again after `bridge.step` had
    // already extracted once — so every tick paid for two extractions, and the numbers included a
    // cost the game never pays. Worse, `step` drains `state.events` after refreshing, so the second
    // extraction always saw an empty event list: **no death ever reached this harness**, and the
    // gate reported combat feedback as cheaper than it is.
    this.composer.ingestTick(this.bridge.snapshot);
  }

  /**
   * Draw one frame along the fixed camera path.
   *
   * The path sweeps the map and cycles the zoom so the run exercises culling, LOD switchover and
   * the far end of the frustum — a stationary camera measures one lucky viewpoint.
   */
  render(renderer: Renderer, alpha: number): FrameStats {
    const t = this.frame++ / 60;
    // A frame's worth of effect ageing, as the real loop does before composing.
    this.composer.ageEffects(1 / 60);
    const map = this.bridge.state.map;
    this.rig.focusOn(
      map.width * (0.5 + 0.35 * Math.sin(t * 0.35)),
      map.height * (0.5 + 0.3 * Math.cos(t * 0.21)),
    );
    this.rig.distance = 220 + 380 * (0.5 + 0.5 * Math.sin(t * 0.17));
    this.rig.yawIndex = Math.floor(t / YAW_HOLD_SECONDS) % 8;

    const camera = this.rig.update(this.spec.width, this.spec.height);
    renderer.setFog(this.bridge.snapshot.fog);
    // The power grid comes up with the ghost and goes down with it, exactly as `Game` does it
    // (ADR-0012 §2: the grid is a placement cue first). Version-gated in every implementation, so a
    // run that leaves it up for 600 frames should still show a handful of uploads, not 600.
    const ghost = this.ghost(camera);
    renderer.setPower(ghost ? this.bridge.snapshot.power : null);
    return this.composer.compose(
      renderer, this.bridge.snapshot, camera, TIERS[this.spec.tier], this.terrain, alpha, ghost,
    );
  }

  /**
   * The build ghost the player is holding, or null (P6-T07). See `SceneSpec.ghostBuilding`.
   *
   * `pickGround` and `checkPlacement` are called PER FRAME, from the viewport centre, because that
   * is what `Game.updateGhost` does from the pointer — and neither had ever appeared in a gated
   * run. The ghost object is reused rather than rebuilt so the frame path still allocates nothing.
   */
  private ghost(camera: CameraState): GhostState | null {
    const type = this.spec.ghostBuilding;
    if (!type) return null;
    const hit = pickGround(camera, this.field, this.spec.width / 2, this.spec.height / 2);
    const g = this.ghostState;
    g.x = hit.x;
    g.y = hit.y;
    g.valid = checkPlacement(this.bridge.state, type, hit.x, hit.y).valid;
    return g;
  }

  /**
   * The live snapshot and unit map, for `perf/soak.ts` (P7-T06).
   *
   * A soak asks a different question from a gate — not "how fast is this frame" but "is anything
   * growing" — and it cannot ask it without seeing the structures. These are reads, and they exist
   * so the soak does not have to build a second world of its own: the first draft of `soak.ts` did
   * exactly that and measured an empty one.
   */
  get snapshot(): Snapshot {
    return this.bridge.snapshot;
  }

  get units(): ReadonlyMap<string, Unit> {
    return this.bridge.state.units;
  }

  /** The ids of every wreck/crater deposit currently on the map — the opaque-id family (P7-T06). */
  opaqueNodeIds(): string[] {
    const out: string[] = [];
    for (const node of this.bridge.state.map.nodes) if (node.wreck || node.crater) out.push(node.id);
    return out;
  }

  /** Wreck and crater deposits on the map — what combat has left behind (ADR-0018). */
  get wreckNodeCount(): number {
    let n = 0;
    for (const node of this.bridge.state.map.nodes) if (node.wreck || node.crater) n++;
    return n;
  }

  setup(renderer: Renderer): void {
    renderer.registerMeshes(buildMeshes());
    renderer.setTier(this.spec.tier);
    renderer.resize(this.spec.width, this.spec.height, 1);
  }

  /** Throw away the warm-up's background samples; the harness calls this once measuring starts. */
  beginMeasurement(): void {
    this.background?.restart();
  }

  /** P4-T10's numbers, or null for a scene with no settled roster. */
  backgroundReport(): BackgroundReport | null {
    return this.background?.report() ?? null;
  }
}

function populate(state: State, spec: SceneSpec, bombIds: string[] = []): void {
  const { width, height } = state.map;
  // Deterministic placement from an integer lattice — no PRNG, so the scene is byte-identical on
  // every machine and the numbers from two runs are comparable.
  const unitTypes: readonly string[] = spec.unitTypes === "all" ? Object.keys(UNITS) : UNIT_MIX;
  for (let i = 0; i < spec.units; i++) {
    const type = unitTypes[i % unitTypes.length]!;
    // Owner decorrelated from type. With `i % 2` and an even type count every type would land on
    // one side only, and each mesh would be counted once instead of twice — the exact bias that
    // understated ADR-0016's own batch figures until P3-T02 re-measured them.
    const owner: OwnerId = Math.floor(i / unitTypes.length) % 2 === 0 ? "player" : "ai";
    const [x, y] = spec.packed
      // Two blocks facing each other across the middle, close enough that weapons reach.
      ? [
        width * (owner === "player" ? 0.42 : 0.58) + ((i * 13) % 90) - 45,
        height * 0.5 + ((i * 29) % 180) - 90,
      ]
      : [80 + ((i * 137) % (width - 160)), 80 + ((i * 89) % (height - 160))];
    const u = makeUnit(type, owner, x, y);
    // Veterancy, for the `chevron` overlay — see `SceneSpec.veterans`. Kills rather than a rank,
    // because `rankOf` is the bridge's own function and a hand-written rank would keep passing the
    // day upstream moves its 3/8/18 thresholds. Every third unit until the quota is met, so the
    // ranked ones are spread through the lattice instead of clustered in the first block.
    const vet = Math.floor(i / 3);
    if (i % 3 === 0 && vet < (spec.veterans ?? 0)) u.kills = KILL_COUNTS[vet % KILL_COUNTS.length]!;
    state.units.set(u.id, u);
  }
  // Armed Helium Bombs (P3-T10), on the map's edges rather than in the middle — see `armedBombs`:
  // the packed blocks straddle the centre, and an armed bomb inside anyone's weapons range would
  // detonate and take the scene with it. Spread rather than clustered, so the sweeping camera path
  // passes them at different distances instead of measuring one lucky viewpoint.
  const BOMB_SPOTS: ReadonlyArray<readonly [number, number]> = [[0.10, 0.14], [0.90, 0.16], [0.12, 0.86]];
  for (let i = 0; i < (spec.armedBombs ?? 0); i++) {
    const [fx, fy] = BOMB_SPOTS[i % BOMB_SPOTS.length]!;
    const bomb = makeUnit("heliumbomb", i % 2 === 0 ? "player" : "ai", width * fx, height * fy);
    bomb.armed = true;
    // Past the end of any run, so `updateBombFuse` never reaches it. See `armedBombs` above: this
    // is a synthetic hold, and it buys the lit draw path for all 600 frames instead of 80.
    bomb.fuseUntil = state.time + 1e9;
    state.units.set(bomb.id, bomb);
    bombIds.push(bomb.id);
  }
  const buildingTypes: readonly string[] = spec.buildingTypes === "all"
    ? Object.keys(BUILDINGS)
    : BUILDING_MIX;
  for (let i = 0; i < spec.buildings; i++) {
    const type = buildingTypes[i % buildingTypes.length]!;
    const owner: OwnerId = i % 2 === 0 ? "player" : "ai";
    const b = makeBuilding(type, owner, 120 + ((i * 211) % (width - 240)), 120 + ((i * 157) % (height - 240)));
    state.buildings.set(b.id, b);
  }
  // A standing selection of the player's own producers (P5-T15) — see `selectedProducers`. Asked of
  // the engine's `produces` table rather than listing the three types, on the same rule the bridge
  // filter uses: a hand-written list here would keep passing after upstream added a fourth producer,
  // and the scene would quietly stop covering it.
  const wanted = spec.selectedProducers ?? 0;
  if (wanted > 0) {
    state.selection.length = 0;
    for (const b of state.buildings.values()) {
      if (state.selection.length >= wanted) break;
      if (b.owner !== "player") continue;
      if (!(BUILDINGS[b.type]?.produces?.length)) continue;
      state.selection.push(b.id);
    }
    if (state.selection.length < wanted) {
      throw new Error(
        `perf scene: asked for ${wanted} selected producers and the ${spec.buildings}-building `
        + `population only offered ${state.selection.length}. The rally overlay is drawn per selected `
        + `producer, so the layer this flag exists to measure would not fire.`,
      );
    }
  }
}
