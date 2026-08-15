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
import { STEP_SECONDS } from "../src/app/loop.js";
import { SnapshotExtractor } from "../src/bridge/snapshot.js";
import { BUILDINGS, makeBuilding, makeUnit } from "../src/engine/index.js";
import { CameraRig } from "../src/input/camera.js";
import { SceneComposer } from "../src/view/scene.js";
import { elevationFieldFrom, type ElevationField } from "../src/view/terrain/elevation.js";
import { buildTerrainMesh } from "../src/view/terrain/mesh.js";
import { buildMeshes } from "../src/view/meshes/generators.js";
import { type FrameStats, type Renderer, type TerrainMesh, type Tier } from "../src/view/renderer/port.js";
import { TIERS } from "../src/view/renderer/tiers.js";

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
}

/** The gated scenes. PRD §6.2's own numbers; changing one is a PRD change, not a tuning knob. */
export const SCENES: Readonly<Record<string, SceneSpec>> = {
  T0: { tier: "T0", units: 200, buildings: 80, width: 1280, height: 720 },
  T2: { tier: "T2", units: 400, buildings: 200, width: 1600, height: 900 },
  // PRD §5's Phase 2 exit criterion — "perf budgets hold with 300 buildings on screen" — at the T0
  // tier, because CPU-only is the whole target (ADR-0011). Every one of the 29 building types is
  // present: the point is to measure what the six silhouette families actually cost, not to
  // measure 300 copies of one mesh.
  P2: { tier: "T0", units: 200, buildings: 300, width: 1280, height: 720, buildingTypes: "all" },
};

const UNIT_MIX = ["skiff", "bastion", "lancer", "worker"] as const;
const BUILDING_MIX = ["barracks", "habitat", "turret", "refinery"] as const;

export class PerfScene {
  readonly composer: SceneComposer;
  readonly rig: CameraRig;
  readonly terrain: TerrainMesh;
  readonly field: ElevationField;
  private readonly bridge: WorldBridge;
  private readonly extractor: SnapshotExtractor;
  private frame = 0;

  constructor(readonly spec: SceneSpec) {
    this.bridge = new WorldBridge({ seed: PERF_SEED, worldId: MVP_WORLD });
    const state = this.bridge.state;

    // Populate to the budgeted counts directly rather than playing the game up to them: a scripted
    // 60-second match reaches a different army every time upstream touches the AI, and the gate
    // would then measure balance changes as perf regressions.
    populate(state, spec);
    // Reveal the whole map so fog does not quietly cull half the scene away — the budget is written
    // for what is ON SCREEN, and a fogged perf run flatters the renderer.
    state.fogs.player.explored.fill(1);
    state.fogs.player.visible.fill(1);

    this.extractor = new SnapshotExtractor(state.map, 1024);
    this.field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
    this.terrain = buildTerrainMesh(this.field, {
      relief: TIERS[spec.tier].terrain === "relief", apron: TIERS[spec.tier].apron,
    });
    this.composer = new SceneComposer(this.field);
    this.rig = new CameraRig({ mapWidth: state.map.width, mapHeight: state.map.height }, this.field);
  }

  /** Advance the simulation one tick and re-extract. Called at 20 Hz, as in the real loop. */
  tick(): void {
    this.bridge.step(STEP_SECONDS);
    this.extractor.extract(this.bridge.state, {
      viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0,
    });
    // Combat feedback is ingested here and nowhere else, exactly as `game.ts` does it (P3-T06).
    // Without this line the perf gate would never see a tracer and would silently report that
    // combat feedback is free — the harness has to run the same path the game runs.
    this.composer.ingestTick(this.extractor.snapshot);
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
    this.rig.yawIndex = Math.floor(t / 6) % 8;

    const camera = this.rig.update(this.spec.width, this.spec.height);
    renderer.setFog(this.extractor.snapshot.fog);
    return this.composer.compose(
      renderer, this.extractor.snapshot, camera, TIERS[this.spec.tier], this.terrain, alpha, null,
    );
  }

  setup(renderer: Renderer): void {
    renderer.registerMeshes(buildMeshes());
    renderer.setTier(this.spec.tier);
    renderer.resize(this.spec.width, this.spec.height, 1);
  }
}

function populate(state: State, spec: SceneSpec): void {
  const { width, height } = state.map;
  // Deterministic placement from an integer lattice — no PRNG, so the scene is byte-identical on
  // every machine and the numbers from two runs are comparable.
  for (let i = 0; i < spec.units; i++) {
    const type = UNIT_MIX[i % UNIT_MIX.length]!;
    const owner: OwnerId = i % 2 === 0 ? "player" : "ai";
    const u = makeUnit(type, owner, 80 + ((i * 137) % (width - 160)), 80 + ((i * 89) % (height - 160)));
    state.units.set(u.id, u);
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
}
