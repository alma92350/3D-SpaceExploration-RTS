// The 20-minute match, measured (P7-T06). Driven by `perf/soak.mjs`; see that file for why this
// is a different test from `npm run perf` rather than a longer one.
//
// **What this instrument is careful about, because a soak is easy to fake.**
//
// A long run that measures nothing is the most convincing green in a repo — it takes minutes, it
// prints big numbers, and it passes. So every assertion here is written against something that can
// actually go wrong, and the run itself is checked for having happened at all: if the AI never
// fights, the population never moves and the whole thing is a very slow no-op. `problems` collects
// vacuity failures with the same weight as budget failures, because a soak that proves nothing and
// a soak that fails are the same outcome for a reader.
//
// The frame is composed on a **sampled** schedule rather than every tick. The sim runs at 20 Hz and
// the view at 60, so composing every tick would measure a frame rate no player has; and composing
// every tick for 24 000 ticks would spend most of the run's wall clock inside the renderer rather
// than the simulation, which is not what "does a 20-minute match hold up" is asking.

import { STEP_SECONDS } from "../src/app/loop.js";
import { internedIdCount } from "../src/bridge/snapshot.js";
import { PerfScene, SCENES } from "./scene.js";
import { RecordingRenderer } from "../src/view/renderer/recording.js";
import { TIERS, percentile } from "../src/view/renderer/tiers.js";

/** Same seed and world as every other measurement in this directory (ADR-0010 §2). */
const SEED = 20260814;

/** The tier a soak should be judged at: T0 is the slowest thing this game promises to run on. */
const TIER = "T0" as const;

/** One composed frame per this many sim ticks. See the header. */
const COMPOSE_EVERY = 3;

/** How often the growable structures are sampled. Coarse: this is a trend, not a trace. */
const SAMPLE_EVERY = 600;

export interface GrowthRow {
  readonly name: string;
  readonly first: number;
  readonly last: number;
  readonly leaked: boolean;
}

export interface SoakReport {
  readonly seed: number;
  readonly ticks: number;
  readonly budgetMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly p95First: number;
  readonly p95Last: number;
  readonly built: number;
  readonly killed: number;
  readonly peakEntities: number;
  readonly wreckNodes: number;
  /** Sim-minutes from the start to the last death seen. See `combatMinutes` in the header. */
  readonly combatMinutes: number;
  readonly totalMinutes: number;
  readonly growth: readonly GrowthRow[];
  readonly problems: readonly string[];
  /** True things a reader would otherwise assume away. Not failures. */
  readonly notes: readonly string[];
}

export function runSoak(opts: { minutes: number }): SoakReport {
  const ticks = Math.round((opts.minutes * 60) / STEP_SECONDS);
  const config = TIERS[TIER];

  // **P3's scene, sustained** — not a world built by hand here. That scene is the one whose realism
  // has already been argued and gated (P3-T16): every unit type on the field, both sides packed into
  // weapons range so shots and deaths actually happen, deterministic placement from an integer
  // lattice, and the fog lifted so the snapshot sees what is there. Rebuilding any of that here
  // would be a second opinion about what a combat scene looks like, and the first version of this
  // file was exactly that — it ran a bare bridge, and the vacuity checks below caught it at a peak
  // population of ONE with nothing dying, which is what they are for.
  //
  // What this scene is NOT is a match with production: `populate` places a fixed force and the
  // engine's AI plays from there, so over twenty minutes the population falls as units die and is
  // only partly replaced. That is stated rather than papered over — it makes the run a sustained
  // ENGAGEMENT rather than a full economy, and it is still the only thing in this repo that runs
  // the death, wreckage and salvage paths for twenty minutes without stopping.
  const scene = new PerfScene(SCENES.P3!);
  const renderer = new RecordingRenderer();
  scene.setup(renderer);
  scene.beginMeasurement();

  const frameTimes: number[] = [];
  const samples: Array<Record<string, number>> = [];

  // Population is tracked as a TREND, not a total: the interesting question is whether the fight
  // is live at the end, and a cumulative counter cannot tell a stalemate from a war.
  let peakEntities = 0;
  let seenUnitIds = new Set<string>();
  let built = 0;
  let killed = 0;
  let everAlive = new Set<string>();
  const depositsSeen = new Set<string>();
  let lastDeathTick = 0;

  for (let tick = 0; tick < ticks; tick++) {
    scene.tick();

    if (tick % COMPOSE_EVERY === 0) {
      const t0 = performance.now();
      const stats = scene.render(renderer, 0);
      frameTimes.push(performance.now() - t0);
      // The recording renderer keeps every frame it is handed. Over 8 000 frames that is the
      // harness's own leak, and it would sit inside the numbers this run is trying to read.
      renderer.frames.length = 0;
      peakEntities = Math.max(peakEntities, stats.instances);
    }

    if (tick % SAMPLE_EVERY === 0) {
      const snap = scene.snapshot;
      const units = scene.units;
      for (const id of units.keys()) {
        if (!everAlive.has(id)) { everAlive.add(id); built++; }
      }
      const live = new Set(units.keys());
      let diedThisSample = 0;
      for (const id of seenUnitIds) if (!live.has(id)) diedThisSample++;
      if (diedThisSample > 0) lastDeathTick = tick;
      killed += diedThisSample;
      seenUnitIds = live;

      // Every distinct opaque-id deposit this run has ever SEEN in a snapshot. That is the exact
      // thing the intern table holds one entry for, so the two are directly comparable — which is
      // what turns "the table grew" into "the table grew for a reason".
      for (const node of scene.opaqueNodeIds()) depositsSeen.add(node);

      samples.push({
        entityCapacity: snap.entities.capacity,
        nodeCount: snap.nodes.count,
        internedIds: internedIdCount(),
        depositsSeen: depositsSeen.size,
        shotCapacity: snap.shots.capacity,
        impactCapacity: snap.impacts.capacity,
        units: units.size,
      });
    }
  }

  const problems: string[] = [];
  const notes: string[] = [];

  // ---- Did the match happen? ------------------------------------------------------------------
  //
  // Checked FIRST and weighted the same as a budget failure. A soak that deadlocks passes every
  // performance assertion by simulating nothing, and this project has caught that shape of
  // false green in five other places.
  if (killed === 0) {
    problems.push(
      `nothing died in ${opts.minutes} sim-minutes, so this run measured a stalemate rather than a `
      + `match — the budget numbers below are not evidence about combat`,
    );
  }
  if (built === 0) problems.push("no unit was ever produced, so the economy never ran");

  // **How much of the run was actually a fight, reported rather than implied.** P3's scene places a
  // fixed force and nothing replaces losses, so the engagement resolves and the survivors stand
  // around. Measured: combat ends around minute three and the remaining seventeen are a quiet world
  // of ~52 units. That does NOT invalidate the two things this run is for — the budget over 24 000
  // ticks and the growth check both need duration, not violence — but it does mean this is not
  // twenty minutes of combat, and a reader who assumed it was would be wrong. Closing that gap needs
  // a scene with production replacing losses, which is a different scene and a different row.
  if (lastDeathTick > 0 && (lastDeathTick * STEP_SECONDS) / 60 < opts.minutes * 0.5) {
    notes.push(
      `combat resolved after ${((lastDeathTick * STEP_SECONDS) / 60).toFixed(1)} of `
      + `${opts.minutes} sim-minutes — the rest is a quiet world, so the budget number is a `
      + `duration result and not a sustained-combat one`,
    );
  }
  if (peakEntities < 10) {
    problems.push(`peak population was ${peakEntities}; a match this empty tests nothing`);
  }

  // ---- Did the budget hold, and did it hold to the END? ---------------------------------------
  // `percentile` takes a FRACTION, not a percent — `Math.ceil(p * length)`. The first draft of this
  // file passed 95 and 50, which clamps to the last index, so "p50" and "p95" were both silently the
  // MAXIMUM and were identical to two decimal places over 1 200 samples. That is the whole reason
  // this file prints p50 beside p95: two numbers that are always equal is a question a reader asks,
  // and one number alone is a question nobody asks.
  const quarter = Math.floor(frameTimes.length / 4);
  const p95First = percentile(frameTimes.slice(0, quarter), 0.95);
  const p95Last = percentile(frameTimes.slice(-quarter), 0.95);
  const p95 = percentile(frameTimes, 0.95);
  const p50 = percentile(frameTimes, 0.5);

  if (p95 > config.frameBudgetMs) {
    problems.push(`frame p95 ${p95.toFixed(2)} ms exceeds the ${TIER} budget of ${config.frameBudgetMs} ms`);
  }

  // ---- Did anything grow without bound? -------------------------------------------------------
  //
  // The rule is not "nothing grew" — a table SHOULD grow to fit the biggest fight, and the node
  // count genuinely rises for the whole match because wreckage accumulates. The rule is that
  // growth stops: whatever a structure is at the three-quarter mark, it must not have moved by the
  // end, once the population has stopped climbing.
  const growth: GrowthRow[] = [];
  if (samples.length >= 4) {
    const late = samples[Math.floor(samples.length * 0.75)]!;
    const last = samples[samples.length - 1]!;
    const first = samples[0]!;
    // Three structures are exempt from "must stop growing", each for a stated reason rather than
    // because it was inconvenient. `nodeCount` and `depositsSeen` climb for as long as the fight
    // lasts by design — `wreckage.js` and `bomb.js` push a node per death (ADR-0018) — and `units`
    // is the population, which is the thing the run is about.
    // `internedIds` joins them, and the invariant below is its guard instead. Holding it to a
    // plateau would be holding it to the wrong rule: it is SUPPOSED to grow while combat creates
    // deposits, and the question that matters is whether it grows for that reason or some other.
    const exempt = new Set(["nodeCount", "units", "depositsSeen", "internedIds"]);
    for (const name of Object.keys(first)) {
      const leaked = !exempt.has(name) && last[name]! > late[name]!;
      growth.push({ name, first: first[name]!, last: last[name]!, leaked });
      if (leaked) {
        problems.push(
          `${name} was still growing in the last quarter (${late[name]} → ${last[name]}), so it is `
          + `not bounded by the scene — it is bounded by how long you run`,
        );
      }
    }

    // **The intern table is the one structure with a real invariant rather than a plateau**, and it
    // needs its own check because "it stopped growing" is the wrong question for it. `snapshot.ts`
    // interns one entry per opaque id it has ever packed, and the only opaque ids the engine mints
    // are wreck and crater deposits — so the table is allowed to grow for exactly as long as combat
    // creates deposits, and is bounded by the number of distinct deposits this run has SEEN.
    //
    // It is never reclaimed: a deposit that is mined out and removed from the map keeps its entry
    // forever. That is acceptable and it is now measured rather than assumed — see the note this
    // run's finding put on `internedIdCount`.
    if (last["internedIds"]! > last["depositsSeen"]!) {
      problems.push(
        `the intern table holds ${last["internedIds"]} entries against ${last["depositsSeen"]} `
        + `distinct deposits ever seen — it is interning something that is not a deposit, which is `
        + `the one way its growth stops being explainable`,
      );
    }
  }

  const wreckNodes = scene.wreckNodeCount;

  return {
    seed: SEED, ticks, budgetMs: config.frameBudgetMs,
    p50, p95, p95First, p95Last,
    built, killed, peakEntities, wreckNodes,
    combatMinutes: (lastDeathTick * STEP_SECONDS) / 60,
    totalMinutes: opts.minutes,
    growth, problems, notes,
  };
}
