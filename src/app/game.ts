// The app shell: wires the bridge, the view, the input and the HUD into one running game.
//
// Everything interesting happens elsewhere — this module's whole job is to hold the pieces and
// forward between them in the right order. It is deliberately the least clever file in the project:
// when something goes wrong at runtime, this is where you read the sequence.

import { BUILD_REACH, BUILDINGS, NODE_RADIUS, UNITS } from "../engine/index.js";
import { WorldBridge, type WorldOptions } from "../bridge/world.js";
import { checkPlacement } from "../bridge/commands.js";
import { GalaxySnapshotExtractor, type GalaxySnapshot } from "../bridge/galaxy-snapshot.js";
import { FLAG_BUILDING_KIND, engineId, type Snapshot } from "../bridge/snapshot.js";
import { FixedStepLoop, STEP_SECONDS } from "./loop.js";
import { type Settings, applyMotion, saveSettings } from "./settings.js";
import { CameraRig, clamp } from "../input/camera.js";
import { pickGround, projectToScreen } from "../input/picking.js";
import { type PendingMode, type PointerGesture, translateKey, translatePointer } from "../input/intents.js";
import { ControlGroups } from "../input/control-groups.js";
import { AlertFeed } from "../view/alerts.js";
import { ApproachView } from "../view/landing.js";
import {
  AUTHORED_VIEW, StarmapComposer, authoredCamera, plateMidX, plateX, plateZ,
} from "../view/starmap.js";
import { approachBrief } from "../ui/landing-panel.js";
import { type ElevationField, elevationFieldFrom } from "../view/terrain/elevation.js";
import { buildTerrainMesh } from "../view/terrain/mesh.js";
import { buildMeshes, meshIdForType } from "../view/meshes/generators.js";
import { SceneComposer, type GhostState } from "../view/scene.js";
import { type FogField, type Renderer, type TerrainMesh, type Tier } from "../view/renderer/port.js";
import { TIERS, TierMonitor } from "../view/renderer/tiers.js";
import {
  type EconomyBoard, type EconomyModel, type GalaxyBoard, type HudAction, type HudCommand,
  type HudModel, EconomyCache, GalaxyCache, HudView, hudModel,
} from "../ui/hud.js";
import { HudFocus } from "../ui/hud-focus.js";
import { NewsFeed, newsModel } from "../ui/news.js";
import { loadOnboardingSeen, markOnboardingSeen } from "../ui/onboarding.js";
import { type SaveCatalog, deleteSave, newSaveId, readCatalog, writeSave } from "../ui/save-panel.js";
import { MinimapView, minimapToWorld } from "../ui/minimap.js";

export interface GameElements {
  readonly viewport: HTMLElement;
  readonly hudRoot: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
}

const EDGE_SCROLL_MARGIN = 18;
const EDGE_SCROLL_SPEED = 900;      // world units per second at full tilt
const KEY_PAN_SPEED = 900;
const ENTITY_PICK_SLACK = 6;        // extra world units around an entity that still counts as a click
const OPENING_DISTANCE = 210;       // see the constructor

/**
 * Which screen the player is looking at (P4-T13).
 *
 * Three, and the starmap REPLACES the battlefield's frame rather than floating over it — ADR-0019
 * §1 priced both (8 draw calls against 30, neither binding) and chose replacement because a diagram
 * read over a scene is two things competing for the same eye.
 *
 * The approach view owns real objects — a rig, a brief, a terrain mesh — so it is a variant with
 * fields rather than a string plus four nullable properties on the class. A screen that is closed
 * then holds nothing at all, which is the only way to be sure a stale brief cannot be drawn.
 */
type Screen =
  | { readonly kind: "world" }
  | { readonly kind: "starmap" }
  | {
    readonly kind: "approach";
    readonly destId: string;
    readonly view: ApproachView;
    /** Built from `brief.field` when the screen opens, never per frame (ADR-0006). */
    readonly terrain: TerrainMesh;
    /** See `approachFog` — the destination's ground is known, and nothing on it is. */
    readonly fog: FogField;
  };

/**
 * How near a click has to be to a world marker, in pixels.
 *
 * `perf/starmap-probe.mjs` measured the plate's zero marker collisions against a **28 px** marker
 * radius, so two markers are never closer than 56 px at the authored view and a pick radius of 28
 * can never claim two of them. Widening it would trade the probe's guarantee for a fatter target.
 */
const STARMAP_PICK_RADIUS = 28;

/**
 * The starmap rig's bounds.
 *
 * `CameraRig` clamps a target to `[0, limit]`, and the plate is centred on `AUTHORED_VIEW`'s own
 * coordinates — so anything at least twice that keeps the authored view well inside them. Nothing
 * on this screen pans or rotates in any case (ADR-0019 §3: a diagram is read at one orientation).
 */
const PLATE_LIMIT = AUTHORED_VIEW.centreX * 2;

export class Game {
  readonly bridge: WorldBridge;
  /**
   * The battlefield camera. Rebuilt on a jump, because `CameraRig` clamps its target to the map it
   * was constructed with and the next world is a different size — see `adoptSeat`.
   */
  camera: CameraRig;

  private field: ElevationField;
  private composer: SceneComposer;
  private readonly loop: FixedStepLoop;
  private readonly hud: HudView;
  private minimap: MinimapView;
  private readonly tierMonitor: TierMonitor;
  private terrain: TerrainMesh;
  /** The world the shell is set up for. A jump moves the seat under it — see `adoptSeat`. */
  private seatId: string;

  private mode: PendingMode = { kind: "none" };
  /**
   * Control groups (P3-T13). Held HERE, in the application, and never in the bridge — the whole
   * task is that a group is client state, because `state.selection` is sim state that `hashState`
   * hashes and every recorded fixture replays against.
   */
  private readonly groups = new ControlGroups();
  /** The alert board (P3-T14). Client state, like the control groups beside it. */
  private readonly alerts = new AlertFeed();
  /**
   * Where the selection cycle is standing (P6-T11) — the ids the last Q press ASKED for, and the
   * simulation tick it asked on.
   *
   * Client state for the control groups' reason, and it exists for one specific case: a `select` is
   * an intent, so it lands on the next TICK, and two Q presses inside one 50 ms tick would both read
   * the same stale `state.selection` and pick the same type twice. Key repeat does exactly that.
   *
   * **The stamp is the tick and not the selection**, and the difference is a bug found by writing
   * the test: comparing against the selection this press started from cannot tell "my `select` has
   * not landed yet" from "something put the selection back to where it was", so a control-group
   * recall onto the group the player had just cycled off would leave the cycle a step behind
   * forever. Within one tick nothing else can have moved the selection; after it, the simulation is
   * the position of record, and it holds this cycle's own answer anyway.
   */
  private cycleAsked: readonly string[] = [];
  private cycleTick = -1;
  private readonly keys = new Set<string>();
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private dragStart: { x: number; y: number; worldX: number; worldY: number } | null = null;
  private ghost: GhostState | null = null;
  /** Power-grid overlay, toggled with `G`. View state: nothing in the simulation knows about it. */
  private showPower = false;
  /** Which base-wide economy board is open, if any (P4-T01). View state, like `showPower`. */
  private board: EconomyBoard | null = null;
  /** Which campaign board is open on the galaxy screen (P5-T12). View state, like `board`. */
  private galaxyBoard: GalaxyBoard | null = null;
  /**
   * Whether the onboarding card has been dismissed, read ONCE at construction.
   *
   * `loadOnboardingSeen` touches `localStorage`, and the model that reads this is built per tick.
   * Held here so the drawer never asks storage a question it has already answered.
   */
  private onboardingSeen = loadOnboardingSeen();
  /**
   * The save catalog, refreshed only when it can have changed — when the board opens, and after a
   * write or a delete. `readCatalog` walks every key in storage and parses every payload, which is
   * not a thing to do on a tick.
   */
  private savesCatalog: SaveCatalog = { available: false, saves: [] };
  /**
   * News from the worlds the player is not standing on (P5-T16).
   *
   * Galaxy-scoped, and deliberately NOT cleared on a jump — unlike `alerts`, which is, because an
   * alert is a place on the map you just left. This is about the worlds you are not on, so a jump
   * is the moment it becomes the only thing worth knowing.
   */
  private readonly news = new NewsFeed();
  /**
   * The buttons the HUD is currently showing, in order — what a positional key press indexes into.
   *
   * Held rather than recomputed on the key press, and that is deliberate: the answer must be the
   * row the player is LOOKING at. Rebuilding it from a fresher snapshot would let Z fire a button
   * that appeared between the frame they read and the key they pressed.
   */
  private actions: readonly HudAction[] = [];
  /**
   * The HUD's keyboard ring (P6-T03, N-05).
   *
   * Constructed with the HUD root and asked before every other key handler. It claims Tab, and
   * Enter/Space only while it holds focus — see `ui/hud-focus.ts` for why Space in particular
   * cannot be left to the browser here.
   */
  private readonly hudFocus: HudFocus;
  /**
   * The economy model, rebuilt on a tick rather than on a frame.
   *
   * The panels behind it are dry runs of the engine's own gating (`researchPanelModel` calls
   * `researchTech` for real and undoes it) and full sweeps of the unit table. All of that is correct
   * and none of it belongs in a 60 Hz frame, so the cache owns when it is rebuilt — see `EconomyCache`.
   */
  private readonly economyCache = new EconomyCache();
  /**
   * Which screen is up (P4-T13). View state, like `board` and `showPower` above it: nothing in the
   * simulation knows, and a determinism replay must not depend on it.
   */
  private screen: Screen = { kind: "world" };
  /**
   * The starmap's own rig, so opening the galaxy does not throw away where the player was looking.
   *
   * A second rig rather than a saved-and-restored pose because `authoredCamera` writes four fields
   * the battlefield also owns, and "restore it afterwards" is the kind of bookkeeping that is right
   * until the day something returns early. It carries no elevation field, which is exactly true of
   * the plate: there is no ground there.
   */
  private readonly starmapCamera = new CameraRig({ mapWidth: PLATE_LIMIT, mapHeight: PLATE_LIMIT });
  private readonly starmap = new StarmapComposer();
  private readonly galaxyExtractor = new GalaxySnapshotExtractor();
  /** The galaxy tick the starmap's snapshot was extracted on. Extraction is per TICK, not per frame. */
  private galaxySnapTick = -1;
  private readonly galaxyCache = new GalaxyCache();
  /**
   * Version counter for the synthetic fog an approach screen uploads.
   *
   * Counts DOWN from zero, so it can never collide with the world's own fog version, which counts
   * up from it. Both renderers skip a `setFog` whose version they have already seen, so a collision
   * would leave one screen wearing the other's fog until the next tick that happened to change it.
   */
  private approachFogVersion = 0;
  private running = false;
  private rafHandle = 0;
  /** Told whenever the tier changes, however it changed. Set by the shell so the picker tracks it. */
  private tierListener: ((tier: Tier) => void) | null = null;

  constructor(
    private readonly elements: GameElements,
    private renderer: Renderer,
    private tier: Tier,
    private readonly settings: Settings,
    worldOptions: WorldOptions = {},
  ) {
    this.bridge = new WorldBridge(worldOptions);
    const map = this.bridge.state.map;
    this.seatId = this.bridge.worldId;
    this.field = elevationFieldFrom(map.terrain, map.width, map.height);
    this.camera = new CameraRig({ mapWidth: map.width, mapHeight: map.height }, this.field);
    this.camera.focusOn(map.bases.player.x, map.bases.player.y);
    // Start close. The rig's own default is a mid-range 420, which is right once you have a base
    // to look at and wrong for the opening: at t=0 the player owns one colony ship and can see
    // about 200 units around it, so 420 frames a lone speck in a mostly unexplored map. Opening
    // near enough to read the ship is the difference between "a world" and "a loading screen".
    this.camera.distance = OPENING_DISTANCE;
    this.composer = new SceneComposer(this.field);
    this.terrain = this.terrainFor(this.field);
    this.tierMonitor = new TierMonitor(tier);
    if (settings.tierOverride) this.tierMonitor.setManual(settings.tierOverride);
    // The motion preference, applied before the first frame (P6-T04): it reaches the effect pool
    // and the stylesheet at once, and `auto` is where it asks the machine.
    applyMotion(settings);

    this.renderer.registerMeshes(buildMeshes());
    this.renderer.setTier(tier);

    this.hud = new HudView(elements.hudRoot, {
      onCommand: (command) => this.runCommand(command),
    });
    this.hudFocus = new HudFocus(elements.hudRoot);
    this.minimap = new MinimapView(elements.minimapCanvas, {
      pixelWidth: elements.minimapCanvas.width || 200,
      pixelHeight: elements.minimapCanvas.height || 125,
      worldWidth: map.width,
      worldHeight: map.height,
    });

    this.loop = new FixedStepLoop({
      step: (dt) => {
        this.bridge.step(dt);
        // Once per SIM step, not per frame: the snapshot object is the same across the frames
        // between ticks, so ingesting from `renderFrame` would replay every shot three times.
        this.composer.ingestTick(this.bridge.snapshot);
        // Same rule, and here it is not just waste: `snap.deaths` is a per-tick table, so a second
        // pass over the same snapshot would tally one casualty as two and the alert's badge would
        // count frames instead of losses (P3-T14).
        this.alerts.ingestTick(this.bridge.snapshot);
      },
      render: (alpha, frameMs) => this.renderFrame(alpha, frameMs),
    });

    this.attachListeners();
    this.resize();
    this.hud.setScreen(this.screen.kind);
  }

  /**
   * Move the shell onto the world the player has just jumped to (P4-T13).
   *
   * Everything rebuilt here is derived from ONE map and would otherwise describe the world that was
   * left: the elevation field the picker ray-marches, the camera's clamp bounds, the terrain mesh,
   * the minimap's extent, and the interpolation/effect pools, whose entity ids belong to a world
   * that is no longer on screen. The alert board is cleared for the same reason and one more — an
   * alert carries the position "focus last alert" jumps to, and those positions are on the old map.
   *
   * The bridge does the same for its own extractor (see `WorldBridge.refresh`). Neither half was
   * reachable before this row, because nothing in the client could issue a jump.
   */
  private adoptSeat(): void {
    const map = this.bridge.state.map;
    this.seatId = this.bridge.worldId;
    this.field = elevationFieldFrom(map.terrain, map.width, map.height);
    this.camera = new CameraRig({ mapWidth: map.width, mapHeight: map.height }, this.field);
    this.camera.focusOn(map.bases.player.x, map.bases.player.y);
    this.camera.distance = OPENING_DISTANCE;
    this.composer = new SceneComposer(this.field);
    this.minimap = new MinimapView(this.elements.minimapCanvas, {
      pixelWidth: this.elements.minimapCanvas.width || 200,
      pixelHeight: this.elements.minimapCanvas.height || 125,
      worldWidth: map.width,
      worldHeight: map.height,
    });
    this.terrain = this.terrainFor(this.field);
    this.alerts.clear();
    this.ghost = null;
    this.mode = { kind: "none" };
    // The cycle's cursor is engine ids from the world just left, exactly like an alert's position —
    // and the new seat keeps its own tick count, so the stamp means nothing here either.
    this.cycleAsked = [];
    this.cycleTick = -1;
    // An approach view onto the world just arrived on is a picker for a jump that has happened.
    // Unreachable through the confirm button (it closes the screen itself) and cheap to be sure of.
    if (this.screen.kind === "approach" && this.screen.destId === this.seatId) {
      this.setScreen({ kind: "world" });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // The clock's baseline is stale after any pause — a lost WebGL context, a renderer swap, a tab
    // switch — and advancing on it charges the whole gap to `droppedSteps`, the number a reader
    // consults to decide whether a machine is behind. It also clears a halted loop, which is what
    // makes `setRenderer` + `start()` a real recovery rather than a reload (P6-T05). Nothing called
    // `stop()`/`start()` mid-session before the context guard did, so this never bit until now.
    this.loop.resume();
    const frame = (now: number): void => {
      if (!this.running) return;
      this.loop.advance(now);
      this.rafHandle = requestAnimationFrame(frame);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  /** Swap renderer implementations without losing the session (PRD F-09). */
  setRenderer(renderer: Renderer, tier: Tier): void {
    this.renderer.dispose();
    this.renderer = renderer;
    this.tier = tier;
    renderer.registerMeshes(buildMeshes());
    renderer.setTier(tier);
    this.rebuildTerrainForTier();
    this.resize();
  }

  /** Notify the shell when the tier changes — including when the monitor drops it on its own. */
  onTierChange(listener: (tier: Tier) => void): void {
    this.tierListener = listener;
  }

  get currentTier(): Tier {
    return this.tier;
  }

  setTier(tier: Tier, manual: boolean): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.renderer.setTier(tier);
    this.rebuildTerrainForTier();
    if (manual) {
      this.tierMonitor.setManual(tier);
      this.settings.tierOverride = tier;
      saveSettings(this.settings);
    }
    // An automatic drop must move the picker too. A settings control that silently disagrees with
    // the setting is worse than no control: the player reads it, believes it, and reports the
    // wrong tier in a playtest.
    this.tierListener?.(tier);
  }

  /** One terrain mesh at the current tier. The single place the tier's ground options are read. */
  private terrainFor(field: ElevationField): TerrainMesh {
    return buildTerrainMesh(field, {
      relief: TIERS[this.tier].terrain === "relief", apron: TIERS[this.tier].apron,
    });
  }

  private rebuildTerrainForTier(): void {
    // The terrain mesh is the one asset a tier switch genuinely changes (T0 collapses it flat,
    // ADR-0004). Rebuilding here — and only here — keeps the "rebuilt only on change" contract.
    this.terrain = this.terrainFor(this.field);
    // The approach view draws the DESTINATION's ground through the same tier settings, so a tier
    // change while the picker is open has to reach it too — otherwise the world the player is about
    // to land on keeps the relief of a tier they have left. Re-opening costs the mark they had
    // placed (`ApproachView` takes a pick through `pointAt` and has no setter for one, and
    // `view/landing.ts` is not this row's to change) — an acceptable price for a keystroke, and for
    // the automatic tier drop that is the only other way to get here.
    if (this.screen.kind === "approach") this.openApproach(this.screen.destId);
  }

  private renderFrame(alpha: number, frameMs: number): void {
    // A jump lands inside `bridge.step` — it is an intent like any other, drained at the top of a
    // tick — so the seat can be a different world by the time a frame runs, and the field, the rig
    // and the terrain below are all built from the seat's map.
    //
    // Checked HERE rather than beside the step that caused it, because this is where the staleness
    // would actually show: whatever moves the seat — a jump, a load, a test driving the bridge
    // directly — cannot reach the screen without passing this line.
    if (this.bridge.worldId !== this.seatId) this.adoptSeat();
    const snap = this.bridge.snapshot;
    const rect = this.elements.viewport.getBoundingClientRect();
    const screen = this.screen;

    // The effect pool ages on every screen, not only on the battlefield: it is a clock, and a clock
    // that stops while the starmap is open would dump a minute of tracers the moment it closes.
    this.composer.ageEffects(frameMs / 1000);

    if (screen.kind === "world") {
      this.applyContinuousPan(frameMs / 1000);
      this.updateGhost();
      const camera = this.camera.update(rect.width, rect.height);
      this.renderer.setFog(snap.fog);
      // The power grid is a placement cue first and a toggle second (ADR-0012 §2): it is on while a
      // build ghost is up, because "will this run efficiently here?" is a question asked at exactly
      // that moment, and otherwise only when the player asked for it with `G`.
      this.renderer.setPower(this.ghost || this.showPower ? snap.power : null);
      this.composer.compose(this.renderer, snap, camera, TIERS[this.tier], this.terrain, alpha, this.ghost);
      this.minimap.draw(snap, camera);
    } else {
      // The grid belongs to the world being built on, and neither galaxy screen is one.
      this.renderer.setPower(null);
      if (screen.kind === "starmap") {
        this.starmap.compose(
          this.renderer, this.galaxySnapshot(), this.starmapCamera.update(rect.width, rect.height),
        );
      } else {
        // The destination's own fog, not the seat's. Both renderers paint terrain through whatever
        // fog they last received, so without this the world the player is about to land on wears the
        // explored shape of the world they are standing on — a pattern that means nothing here.
        this.renderer.setFog(screen.fog);
        screen.view.compose(
          this.renderer, screen.terrain, screen.view.camera(rect.width, rect.height),
        );
      }
    }

    const hud = hudModel(snap, this.bridge.state);
    // A colony's news, which does NOT fit the alert board — see `takeColonyNotes`, and `news.ts`'s
    // header for why it is beside `view/alerts.ts` rather than in it.
    //
    // **This used to go straight into `hud.notice`, and that was the defect.** The notice is ONE
    // shared line, cleared only by the next notice and shared with the command error below it — so
    // a colony falling was erased by the next refused order, several notes on one frame showed only
    // the last, and the line then sat there forever because `notice` is only called when there is
    // something to say. The feed gives it memory; the toast keeps the transient half.
    //
    // Once per frame is correct: `ingest` is idempotent with respect to the galaxy (it reads the
    // engine's queues through a cursor and writes none of them), and the colony notes are already
    // destroyed by the drain, which is why the shell does the draining and the model never does.
    //
    // **It has to come BEFORE the model is built, and that is not a nicety.** Reading first would
    // put every toast one frame behind the event, which is invisible in a 60 Hz eyeball test and
    // exactly the kind of thing that is never noticed again once it ships.
    this.news.ingest({
      galaxy: this.bridge.galaxy,
      colonyNotes: this.bridge.takeColonyNotes(),
      now: this.bridge.galaxy.time || 0,
    });
    // Built on EVERY screen, not only the galaxy one: the toast is how news from the worlds you are
    // not standing on reaches a player standing on a battlefield, which is where they mostly are.
    const news = newsModel(this.news, this.bridge.galaxy.time || 0);
    const drawer = screen.kind === "world"
      ? this.refreshEconomy(hud, snap)
      : this.galaxyCache.get({
        galaxy: this.bridge.galaxy,
        stepSeconds: STEP_SECONDS,
        approach: screen.kind === "approach"
          ? { brief: screen.view.brief, pick: screen.view.pick, site: screen.view.site }
          : null,
        board: this.galaxyBoard,
        saves: this.savesCatalog,
        now: this.wallClock(),
        settings: this.settings,
        currentTier: this.tier,
        news,
        newsVersion: this.news.version,
      });
    // The world's own action row is emptied on a galaxy screen. The positional keys must address
    // what the player is LOOKING at, and a Deploy button from the world behind the starmap would
    // sit on Z and push the jump controls off the row.
    this.hud.render(screen.kind === "world" ? hud : { ...hud, actions: NO_ACTIONS });
    this.hud.renderEconomy(drawer);
    // The positional row is the concatenation, in the order the two rows are drawn. Z is the first
    // button the player can see and N is the fifth, whichever panel it came from.
    this.actions = screen.kind === "world" ? [...hud.actions, ...drawer.actions] : drawer.actions;
    // The same row, handed to the keyboard ring (P6-T03). Costs two property reads unless a
    // rebuild has just destroyed the control the player was standing on.
    this.hudFocus.sync(this.actions);
    // The notice line, and who wins it. A refused order beats a toast every time: it is a direct
    // answer to something the player just pressed, and the toast is a query — `NewsModel.toast` is
    // the newest unread entry whose window is still open, so asking twice gives the same answer and
    // skipping a frame loses nothing. A toast that overwrote a refusal would be the news board's own
    // defect in reverse.
    //
    // **The toast was computed and rendered nowhere until P6-T03 found it** — a field-level orphan
    // that the module-level import scan cannot see, because `news.ts` was reached and this one
    // property of its model was not. The toast is the half of the news that reaches a player who
    // never opens the board, which is most players.
    const error = this.bridge.takeCommandError();
    if (error) this.hud.notice(error);
    else if (news.toast !== null) this.hud.notice(news.toast.text);
    const correction = this.tierMonitor.sample(frameMs);
    if (correction.dropped) {
      this.setTier(correction.tier, false);
      this.hud.notice(correction.notice);
    }
  }

  /**
   * The galaxy snapshot the starmap draws, extracted **once per galaxy tick**.
   *
   * `galaxyStatus` allocates its own result object and array per call (it is upstream's and we do
   * not fork it), and `jumpCost`/`canJumpTo` are asked per world — so this is exactly the work
   * `bridge/galaxy-snapshot.ts`' own header says belongs on a tick and not on a frame. It is also
   * why the extraction is here rather than in `WorldBridge.step`: the starmap is closed almost all
   * of the time, and a battlefield frame should not pay for a screen nobody is looking at.
   */
  private galaxySnapshot(): GalaxySnapshot {
    const tick = this.bridge.galaxy.tick;
    if (tick !== this.galaxySnapTick) {
      this.galaxySnapTick = tick;
      this.galaxyExtractor.extract(this.bridge.galaxy);
    }
    return this.galaxyExtractor.snapshot;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private attachListeners(): void {
    const el = this.elements.viewport;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    el.addEventListener("pointerleave", () => { this.pointerInside = false; });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      // The approach view is a full rig, not a frozen pose (P4-T05): zooming in to look at a valley
      // is the same control it is on the battlefield. The plate does not zoom — its one distance is
      // the authored view the layout was priced at.
      if (this.screen.kind === "approach") this.screen.view.rig.zoom(Math.sign(e.deltaY));
      else if (this.screen.kind === "world") this.camera.zoom(Math.sign(e.deltaY));
    }, { passive: false });
    el.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("resize", () => this.resize());
    this.elements.minimapCanvas.addEventListener("pointerdown", (e) => this.onMinimapClick(e));
  }

  private resize(): void {
    const rect = this.elements.viewport.getBoundingClientRect();
    this.renderer.resize(rect.width, rect.height, globalThis.devicePixelRatio || 1);
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.screen.kind !== "world") return;
    const { x, y } = this.localPoint(e);
    const hit = pickGround(this.camera.update(...this.viewportSize()), this.field, x, y);
    if (e.button === 0) this.dragStart = { x, y, worldX: hit.x, worldY: hit.y };
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.localPoint(e);
    this.pointerX = x;
    this.pointerY = y;
    this.pointerInside = true;
    // THE APPROACH VIEW'S MARK follows the pointer (P4-T05). Hovering is the right gesture for it:
    // the whole screen exists so the player can see where a jump lands before committing, and a
    // picker that only answered on a click would make them click to ask the question.
    if (this.screen.kind === "approach") {
      const rig = this.screen.view.rig;
      // Middle-drag pans here too. The approach view is a full rig rather than a frozen pose
      // precisely so that looking into a valley before committing is the same two controls it is on
      // the battlefield (P4-T05) — the wheel is the other one, in `attachListeners`.
      if ((e.buttons & 4) !== 0) {
        const perPixel = (rig.distance * 1.1) / Math.max(1, this.viewportSize()[1]);
        rig.pan(-e.movementX * perPixel, -e.movementY * perPixel);
      }
      const [w, h] = this.viewportSize();
      this.screen.view.pointAt(this.screen.view.camera(w, h), x, y);
      return;
    }
    if (this.screen.kind !== "world") return;
    // Middle-drag pans. Screen-space delta, so it works at any yaw (see CameraRig.pan).
    if ((e.buttons & 4) !== 0) this.camera.pan(-e.movementX * this.worldPerPixel(), -e.movementY * this.worldPerPixel());
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.screen.kind === "starmap") {
      // A click on a world is how the starmap becomes more than a picture: the plate is where a
      // destination is chosen, and the approach view is what that choice opens.
      if (e.button === 0) {
        const { x, y } = this.localPoint(e);
        const world = this.worldAtPixel(x, y);
        if (world) this.openApproach(world);
      }
      return;
    }
    if (this.screen.kind === "approach") {
      // The same call `pointermove` makes: a deliberate click marks the spot, and then moving the
      // pointer off the world (toward the confirm button) leaves the mark where it was put, because
      // `pointAt` refuses a ray that has left the map rather than clamping it.
      if (e.button === 0) {
        const { x, y } = this.localPoint(e);
        const [w, h] = this.viewportSize();
        this.screen.view.pointAt(this.screen.view.camera(w, h), x, y);
      }
      return;
    }

    const { x, y } = this.localPoint(e);
    const camera = this.camera.update(...this.viewportSize());
    const hit = pickGround(camera, this.field, x, y);
    const worldX = clamp(hit.x, 0, this.bridge.state.map.width);
    const worldY = clamp(hit.y, 0, this.bridge.state.map.height);

    if (e.button === 2) {
      this.emit({
        type: "contextClick", button: "right", worldX, worldY,
        entityId: this.entityAt(worldX, worldY), nodeId: this.nodeAt(worldX, worldY),
        shift: e.shiftKey, ctrl: e.ctrlKey,
      });
      return;
    }

    if (e.button !== 0) return;
    const drag = this.dragStart;
    this.dragStart = null;
    const dragged = drag && Math.hypot(x - drag.x, y - drag.y) > 6;

    if (dragged && this.mode.kind === "none") {
      this.emit({
        type: "boxSelect", button: "left",
        worldX: drag.worldX, worldY: drag.worldY, worldX2: worldX, worldY2: worldY,
        shift: e.shiftKey, ctrl: e.ctrlKey,
      });
      return;
    }

    this.emit({
      type: "click", button: "left", worldX, worldY,
      entityId: this.entityAt(worldX, worldY), nodeId: this.nodeAt(worldX, worldY),
      shift: e.shiftKey, ctrl: e.ctrlKey,
    });
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.screen.kind !== "world") return;
    const { x, y } = this.localPoint(e);
    const hit = pickGround(this.camera.update(...this.viewportSize()), this.field, x, y);
    this.emit({
      type: "doubleClick", button: "left", worldX: hit.x, worldY: hit.y,
      entityId: this.entityAt(hit.x, hit.y), shift: e.shiftKey, ctrl: e.ctrlKey,
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    // The HUD's keyboard ring first (P6-T03). It claims Tab, and Enter/Space only while it holds
    // focus — so Space is still "focus last alert" for a player who never pressed Tab, and a
    // focused button can never be fired by the same press that jumps the camera.
    if (this.hudFocus.handleKey(e)) return;
    this.keys.add(e.key.toLowerCase());
    const result = translateKey({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey }, this.mode);
    // The galaxy screen (P4-T13). A toggle, like the economy boards: the same key closes what it
    // opened, because a second key to close is one a player has to be told about.
    if (result.screen === "starmap") {
      this.setScreen(this.screen.kind === "world" ? { kind: "starmap" } : { kind: "world" });
    }
    if (result.mode) this.mode = result.mode;
    if (result.togglePower) this.showPower = !this.showPower;
    // Escape backs out ONE level — the approach view to the starmap it was opened from, the starmap
    // to the world — rather than dropping straight to the battlefield. Backing out of a mis-clicked
    // destination should not also close the screen the player was choosing on.
    if (result.cancel) {
      this.ghost = null;
      if (this.screen.kind === "approach") this.setScreen({ kind: "starmap" });
      else if (this.screen.kind === "starmap") this.setScreen({ kind: "world" });
    }
    if (result.intent) this.bridge.enqueue(result.intent);
    if (result.group) this.applyGroup(result.group.n, result.group.op);
    if (result.bomb) this.applyBomb(result.bomb);
    // P6-T11's two keys. Both belong to the battlefield for the same reason the camera commands
    // below it do: the cycle MOVES the camera and the crosshair IS the camera, and neither means
    // anything on a screen that camera is not being drawn through.
    if (this.screen.kind === "world") {
      if (result.select) this.applySelect(result.select.scope);
      if (result.crosshair) this.pressCrosshair(result.crosshair);
    }
    // A positional key fires the Nth button the HUD is showing, or nothing at all when the row is
    // shorter than that — never the last button, which is how a player learns to distrust the row.
    if (result.action) {
      const action = this.actions[result.action.index];
      if (action) this.runCommand(action.command);
    }
    // Toggling: the same key closes the board it opened. A second key to close is one a player has
    // to be told about, and this client has no place to tell them.
    if (result.board) this.board = this.board === result.board ? null : result.board;
    // Camera commands belong to the battlefield. Neither galaxy screen has a base to go home to and
    // the plate is read at one authored orientation (ADR-0019 §3), so a rotate here would be a
    // control that does nothing visible — or worse, moves a camera nobody is looking through.
    if (this.screen.kind !== "world") return;
    switch (result.camera) {
      case "focusBase": {
        const base = this.bridge.state.map.bases.player;
        this.camera.focusOn(base.x, base.y);
        break;
      }
      case "focusAlert": {
        // PRD §4's "focus last alert". Jumping DISMISSES what it jumped to: the player has now seen
        // it, and a board that needs a second key to clear fills up and stops being read.
        const i = this.alerts.latest();
        if (i < 0) {
          const base = this.bridge.state.map.bases.player;
          this.camera.focusOn(base.x, base.y);
          break;
        }
        this.camera.focusOn(this.alerts.x[i]!, this.alerts.y[i]!);
        this.alerts.dismiss(this.alerts.id[i]!);
        break;
      }
      case "rotateLeft": this.camera.rotate(-1); break;
      case "rotateRight": this.camera.rotate(1); break;
      case null: break;
    }
  }

  private onMinimapClick(e: PointerEvent): void {
    if (this.screen.kind !== "world") return;
    const rect = this.elements.minimapCanvas.getBoundingClientRect();
    const canvas = this.elements.minimapCanvas;
    const world = minimapToWorld(
      { pixelWidth: canvas.width, pixelHeight: canvas.height, worldWidth: this.bridge.state.map.width, worldHeight: this.bridge.state.map.height },
      ((e.clientX - rect.left) / rect.width) * canvas.width,
      ((e.clientY - rect.top) / rect.height) * canvas.height,
    );
    this.camera.focusOn(world.x, world.y);
  }

  private emit(gesture: PointerGesture): void {
    const result = translatePointer(gesture, this.mode, this.bridge.snapshot);
    this.mode = result.mode;
    if (result.intent) this.bridge.enqueue(result.intent);
  }

  private applyContinuousPan(dt: number): void {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("arrowleft") || this.keys.has("a")) dx -= 1;
    if (this.keys.has("arrowright") || this.keys.has("d")) dx += 1;
    if (this.keys.has("arrowup") || this.keys.has("w")) dy -= 1;
    // `s` was missing from this line from Phase 1 until P5-T10 found it. Three of the four WASD keys
    // were bound and the fourth was not, `index.html` advertised all four, and nothing could catch
    // it because the sidebar's list is hand-written prose. It is the reason the onboarding card
    // names every key as DATA and puts each one through `translateKey` or this set.
    //
    // The fix belongs here rather than in the paragraph, because `src/input/intents.ts`'s own header
    // records why stop is X and not S — "W/A/S/D pan the camera (PRD §5) and upstream gave the pan
    // keys priority". S was already spent on panning by that decision; it just never arrived.
    if (this.keys.has("arrowdown") || this.keys.has("s")) dy += 1;

    if (this.settings.edgeScroll && this.pointerInside) {
      const [w, h] = this.viewportSize();
      if (this.pointerX < EDGE_SCROLL_MARGIN) dx -= 1;
      if (this.pointerX > w - EDGE_SCROLL_MARGIN) dx += 1;
      if (this.pointerY < EDGE_SCROLL_MARGIN) dy -= 1;
      if (this.pointerY > h - EDGE_SCROLL_MARGIN) dy += 1;
    }

    if (dx === 0 && dy === 0) return;
    const speed = (this.keys.size > 0 ? KEY_PAN_SPEED : EDGE_SCROLL_SPEED) * dt;
    this.camera.pan(dx * speed, dy * speed);
  }

  private updateGhost(): void {
    if (this.mode.kind !== "build") { this.ghost = null; return; }
    const camera = this.camera.update(...this.viewportSize());
    // **No pointer in the window means no pointer to follow** (P6-T11). `pointerX/pointerY` are 0,0
    // until the first `pointermove`, so a keyboard-only player armed a build and was shown a ghost
    // pinned to the top-left corner of the viewport — the wrong validity, the wrong Plasma Rig
    // survey (`refreshEconomy` reads this position), and, once `K` could place, the wrong spot. The
    // camera centre is where their crosshair is, so it is where the preview belongs.
    const hit = this.pointerInside
      ? pickGround(camera, this.field, this.pointerX, this.pointerY)
      : this.cameraPoint();
    const state = this.bridge.state;
    const check = checkPlacement(state, this.mode.buildingType, hit.x, hit.y);
    const def = BUILDINGS[this.mode.buildingType];
    this.ghost = {
      active: true,
      x: hit.x,
      y: hit.y,
      radius: def?.radius ?? 16,
      valid: check.valid,
      meshId: meshIdForType(this.mode.buildingType),
      reach: BUILD_REACH + (def?.radius ?? 16),
    };
  }

  /**
   * A control-group press (P3-T13).
   *
   * The one line that matters is the last one: a recall reaches the simulation as an ordinary
   * `select` intent, the same path a mouse drag takes. Nothing here writes `state.selection`.
   *
   * Recall prunes against the snapshot rather than against engine state, deliberately — the group
   * should hold what the PLAYER can see, and a group that quietly re-selected a ship inside fog
   * would be a small map hack.
   */
  private applyGroup(n: number, op: "assign" | "append" | "recall"): void {
    const selection = [...this.bridge.state.selection];
    if (op === "assign") { this.groups.assign(n, selection); return; }
    if (op === "append") { this.groups.append(n, selection); return; }
    const live = new Set<string>();
    const e = this.bridge.snapshot.entities;
    for (let i = 0; i < e.count; i++) live.add(engineId(e.ids[i]!));
    const ids = this.groups.recall(n, (id) => live.has(id));
    if (ids.length > 0) this.bridge.enqueue({ kind: "select", ids, additive: false });
  }

  /**
   * A Helium Bomb key (P3-T10), aimed at the selection.
   *
   * `armBomb`/`detonate` address one unit by id, so the fan-out happens here. It is a *filter*, not
   * a broadcast: only selected units the engine calls bombs get the intent, so pressing the key
   * with an army selected does nothing rather than something surprising.
   *
   * The toggle reads the CURRENT armed state per bomb rather than tracking one flag for all of
   * them — with a mixed selection a single flag would disarm half the group and arm the other half
   * on every press, and the player would never be sure which state they were in.
   */
  private applyBomb(op: "toggleArm" | "detonate"): void {
    for (const id of this.bridge.state.selection) {
      const u = this.bridge.state.units.get(id);
      if (!u || u.owner !== "player" || UNITS[u.type]?.role !== "bomb") continue;
      this.bridge.enqueue(op === "detonate"
        ? { kind: "detonate", unitId: id }
        : { kind: "armBomb", unitId: id, armed: !u.armed });
    }
  }

  /* ---------------------------------------------------------------------------------------------
     Keyboard-only play (P6-T11)

     Two presses, resolved here for `applyGroup`'s reason: `input/intents.ts` is pure and can see
     neither the roster nor the camera, so it says WHICH WAY to step and WHICH BUTTON to press, and
     the snapshot answers the rest. Nothing below writes simulation state — a cycle becomes an
     ordinary `select` intent and a crosshair press becomes an ordinary gesture, both through the
     same queue a mouse uses.
     --------------------------------------------------------------------------------------------- */

  /**
   * A selection-cycle press — Q takes the next TYPE, Shift+Q the next MEMBER of the type held now.
   *
   * Read from the SNAPSHOT rather than from engine state, and that is the same small map hack
   * `applyGroup`'s recall guards against: the snapshot is fog-filtered, so a cycle can only ever
   * reach something the player can actually see.
   *
   * The roster is taken in the snapshot's own order — buildings before units, then the engine's own
   * insertion order — rather than re-sorted here. That order is already stable and already the
   * engine's (ADR-0012 §5), so the cycle visits the same types in the same sequence every lap, and
   * a second Barracks appearing does not renumber the one the player was standing on.
   */
  private applySelect(scope: "type" | "member"): void {
    const e = this.bridge.snapshot.entities;
    const roster: number[] = [];
    for (let i = 0; i < e.count; i++) if (e.owner[i] === 0) roster.push(i);
    if (roster.length === 0) return;                   // nothing left alive: say nothing, do nothing

    const from = new Set(this.cycleFrom());
    const at = roster.find((i) => from.has(engineId(e.ids[i]!)));
    // -1 when the selection is empty, the enemy's, or dead. `indexOf(-1)` is -1 and the wrap below
    // turns that into 0, so "nothing selected" starts the lap at the first type — no second branch.
    const held = at === undefined ? -1 : e.typeIndex[at]!;

    // Kept as roster INDICES rather than ids until the last moment, so the camera below reads the
    // position of a thing that was actually chosen instead of looking one back up by name.
    let picked: number[];
    if (scope === "type") {
      const types: number[] = [];
      for (const i of roster) if (!types.includes(e.typeIndex[i]!)) types.push(e.typeIndex[i]!);
      const next = types[(types.indexOf(held) + 1) % types.length]!;
      picked = roster.filter((i) => e.typeIndex[i] === next);
    } else {
      // Narrow, then step. The type is whatever is selected now — or the first one the player owns,
      // so Shift+Q from nothing still lands on something rather than being a dead key.
      const type = held < 0 ? e.typeIndex[roster[0]!]! : held;
      const members = roster.filter((i) => e.typeIndex[i] === type);
      // Stepping only makes sense from ONE member. From the whole group (what Q just gave them, and
      // the common case) this narrows to the first rather than skipping it.
      const step = from.size === 1 ? members.findIndex((i) => from.has(engineId(e.ids[i]!))) : -1;
      picked = [members[(step + 1) % members.length]!];
    }

    const ids = picked.map((i) => engineId(e.ids[i]!));
    this.bridge.enqueue({ kind: "select", ids, additive: false });
    // **And the camera goes with it**, which is the other half of this row: the minimap's
    // click-to-jump had no keyboard equivalent beyond Home and Space, and a player who cannot travel
    // to their own units cannot order them. The FIRST of the new selection rather than its centroid
    // — a centroid of two ships at opposite corners is empty ground, and this way the camera always
    // lands on something real.
    this.camera.focusOn(e.x[picked[0]!]!, e.y[picked[0]!]!);
    this.cycleAsked = ids;
    this.cycleTick = this.bridge.state.tick;
  }

  /** Where the cycle steps from — see `cycleAsked` for why this is not simply the selection. */
  private cycleFrom(): readonly string[] {
    const state = this.bridge.state;
    return this.cycleTick === state.tick && this.cycleAsked.length > 0
      ? this.cycleAsked
      : state.selection;
  }

  /**
   * A crosshair press — the keyboard's "here".
   *
   * One synthesised `PointerGesture` back through `translatePointer`, deliberately: the twelve
   * pending modes, the context order's move/attack/gather branch and the shift modifier are all
   * already written there and tested there, and a second copy for the keyboard is a second copy to
   * drift. `emit` is the same call the mouse handlers make.
   */
  private pressCrosshair(press: { button: "left" | "right"; shift: boolean }): void {
    const { x, y } = this.crosshair();
    this.emit({
      // `type` DESCRIBES the gesture here rather than deciding anything, and mutation testing says
      // so out loud: mislabelling it changes no behaviour that any test can see, because
      // `translatePointer` reads `type` only inside the left-button branch and a left crosshair
      // press only ever happens with a mode armed — which consumes the click before the type
      // switch. Written truthfully anyway; recorded here so the next reader does not take the line
      // for a decision, or go looking for the test that pins it.
      type: press.button === "right" ? "contextClick" : "click",
      button: press.button, worldX: x, worldY: y,
      entityId: this.entityAt(x, y), nodeId: this.nodeAt(x, y),
      shift: press.shift, ctrl: false,
    });
  }

  /**
   * Where a crosshair press acts: **the build ghost when one is up, and the camera centre when it
   * is not.**
   *
   * The ghost case is not a special rule so much as the absence of a lie. The ghost is the
   * interface's own statement of where a building lands (P1-T18 draws its validity in shape and
   * colour), and while the pointer is inside the viewport the ghost follows the pointer — so a key
   * that placed the building anywhere else would contradict the picture the player is looking at.
   * With no pointer in the window the ghost is already at the camera centre (`updateGhost`), and
   * the two answers are the same one.
   */
  private crosshair(): { x: number; y: number } {
    const ghost = this.ghost;
    if (!ghost) return this.cameraPoint();
    CROSSHAIR_POINT.x = ghost.x;
    CROSSHAIR_POINT.y = ghost.y;
    return CROSSHAIR_POINT;
  }

  /**
   * The camera's centre, clamped to the map exactly as a picked click is (`onPointerUp`).
   *
   * Returns the shared scratch rather than a fresh point, and that is `pickGround`'s own rule
   * ("allocation in a mousemove handler at 60 Hz is exactly the GC pressure ADR-0006 forbids") —
   * this one is called from `updateGhost`, which runs on every frame a build is armed.
   */
  private cameraPoint(): { x: number; y: number } {
    const map = this.bridge.state.map;
    CROSSHAIR_POINT.x = clamp(this.camera.targetX, 0, map.width);
    CROSSHAIR_POINT.y = clamp(this.camera.targetY, 0, map.height);
    return CROSSHAIR_POINT;
  }

  /* ---------------------------------------------------------------------------------------------
     The galaxy screens (P4-T13)
     --------------------------------------------------------------------------------------------- */

  /**
   * Show a screen, and tell the camera and the stylesheet about it.
   *
   * **`authoredCamera` is called HERE, at the switch**, which is where ADR-0019 leaves it: the
   * composer owns the layout and never touches a rig, and the layout is only priced at one
   * orientation, so somebody has to put the rig there. Doing it on the switch rather than per frame
   * means a starmap rig that has somehow been moved is corrected the next time the screen opens,
   * and a frame costs four assignments fewer.
   */
  private setScreen(next: Screen): void {
    this.screen = next;
    if (next.kind === "starmap") authoredCamera(this.starmapCamera);
    this.hud.setScreen(next.kind);
  }

  /**
   * Open the approach view on a destination (P4-T05).
   *
   * The brief is built ONCE per screen, as `approachBrief`'s own header insists: `previewPlanet`
   * generates a dormant world's whole state to look at, and it re-seeds the engine's global entity
   * id counter on the way through. Repeated calls are idempotent rather than cumulative, which is
   * why re-opening on a tier change (see `rebuildTerrainForTier`) is safe.
   *
   * The terrain mesh and the fog field are built here for the same reason and a plainer one: they
   * are the two pieces of a frame that must never be rebuilt inside one (ADR-0006).
   */
  private openApproach(destId: string): void {
    if (destId === this.bridge.worldId) return;          // the seat is not a destination
    const view = new ApproachView(approachBrief(this.bridge.galaxy, destId));
    this.setScreen({
      kind: "approach",
      destId,
      view,
      terrain: this.terrainFor(view.brief.field),
      fog: this.approachFog(view.brief.field.width, view.brief.field.height),
    });
  }

  /**
   * The fog an approach screen is drawn under: **explored everywhere, visible nowhere.**
   *
   * That is not a shortcut around the destination's real fog — it is the honest description of what
   * this screen knows. The brief carries terrain, the player's own pads and the world's anchor, and
   * it has no channel for anything alive there (see `view/landing.ts`'s "a blind landing stays
   * blind"), so the ground reads as known and nothing on it reads as watched. The alternative is
   * whatever the renderer last uploaded, which is the SEAT's fog: another world's explored shape
   * stamped onto this one's ground.
   */
  private approachFog(width: number, height: number): FogField {
    const cell = this.bridge.snapshot.fog.cell;   // the engine's own cell size, transported not copied
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    return {
      cols, rows, cell,
      state: new Uint8Array(cols * rows).fill(FOG_EXPLORED_NOT_VISIBLE),
      version: --this.approachFogVersion,
    };
  }

  /**
   * Which world the player clicked on the plate, or null.
   *
   * Screen-space, because that is the question: the plate is a diagram and a marker's identity is
   * where it is (ADR-0019 §6). It projects each world through the very matrix the frame was drawn
   * with — `projectToScreen`, the same function the overlay renderers use — so the pick cannot
   * disagree with the picture the way a second layout would.
   */
  private worldAtPixel(px: number, py: number): string | null {
    const snap = this.galaxySnapshot();
    const w = snap.worlds;
    const camera = this.starmapCamera.update(...this.viewportSize());
    const midX = plateMidX(w.x, w.count);
    let best: string | null = null;
    let bestDistance = STARMAP_PICK_RADIUS;
    for (let i = 0; i < w.count; i++) {
      projectToScreen(camera, plateX(w.x[i]!, midX), 0, plateZ(i), SCREEN_POINT);
      if (SCREEN_POINT.behind) continue;
      const d = Math.hypot(SCREEN_POINT.x - px, SCREEN_POINT.y - py);
      if (d < bestDistance) { bestDistance = d; best = w.ids[i]!; }
    }
    return best;
  }

  /**
   * Run one HUD command, from a click or from a positional key. The single path (P4-T01).
   *
   * **Every order goes through `bridge.enqueue`**, including all nine of Phase 2's economy intents.
   * Nothing here calls the engine: a direct call would land mid-frame instead of on a tick boundary,
   * and a recorded intent stream would no longer replay — which is the whole reason the bridge
   * queues rather than applies. The refusal comes back through `takeCommandError` on the next frame
   * and lands in `hud.notice`, the same way a rejected build order always has.
   */
  private runCommand(command: HudCommand): void {
    if (command.kind === "buildMode") {
      this.mode = { kind: "build", buildingType: command.buildingType };
      return;
    }
    if (command.kind === "screen") {
      this.setScreen(command.screen === "starmap" ? { kind: "starmap" } : { kind: "world" });
      return;
    }
    if (command.kind === "approach") {
      this.openApproach(command.destId);
      return;
    }
    // --- Phase 5's non-order commands (P5-T12) ---------------------------------------------------
    if (command.kind === "galaxyBoard") {
      this.galaxyBoard = command.board;
      // Storage is read when the board OPENS, not per tick: `readCatalog` walks every key and parses
      // every payload, and the answer cannot change while nothing in this tab has written one.
      if (command.board === "system") this.savesCatalog = readCatalog();
      return;
    }
    if (command.kind === "save") {
      const result = writeSave({
        id: newSaveId(this.wallClock(), this.savesCatalog),
        name: command.name,
        // `bridge.save()`, so the round trip is P4-T09's and this shell never touches
        // `serializeGalaxy` — which is also what stops it rewinding the engine's entity-id counter.
        payload: this.bridge.save(),
        now: this.wallClock(),
      });
      this.savesCatalog = readCatalog();
      this.hud.notice(result.problem ?? `Saved as “${command.name}”`);
      return;
    }
    if (command.kind === "loadSave") {
      const save = this.savesCatalog.saves.find((s) => s.id === command.id);
      // The panel already disabled the button for a payload this build cannot open; this is the
      // second half of the same rule, so a load that fails says so instead of doing nothing.
      const ok = save ? this.bridge.load(save.payload) : false;
      if (!ok) {
        // The reason, not just the refusal. Upstream writes eight distinguishable ones and the
        // bridge used to throw all of them away (P6-T05).
        const why = this.bridge.takeLoadError();
        this.hud.notice(why ? `That save could not be loaded: ${why}` : "That save could not be loaded.");
        return;
      }
      this.adoptSeat();
      this.setScreen({ kind: "world" });
      return;
    }
    if (command.kind === "deleteSave") {
      const result = deleteSave(command.id);
      this.savesCatalog = readCatalog();
      if (result.problem) this.hud.notice(result.problem);
      return;
    }
    if (command.kind === "settings") {
      // Each option carries a WHOLE `Settings`, so there is nothing to merge here — which is what
      // keeps the decision in the panel that made it.
      Object.assign(this.settings, command.settings);
      saveSettings(this.settings);
      applyMotion(this.settings);
      if (command.settings.tierOverride) this.setTier(command.settings.tierOverride, true);
      else this.tierMonitor.clearManual();
      return;
    }
    if (command.kind === "readNews") {
      this.news.markAllSeen();
      return;
    }
    if (command.kind === "dismissOnboarding") {
      this.onboardingSeen = true;
      markOnboardingSeen();
      return;
    }
    this.bridge.enqueue(command.intent);
    // A confirmed jump ends the screen that confirmed it. The intent is queued, not applied, so the
    // seat is still the old world for one more tick — `adoptSeat` handles the arrival, and going
    // back to the battlefield now is what shows the player they have arrived.
    if (command.intent.kind === "jump") this.setScreen({ kind: "world" });
  }

  /** Assemble the economy model's inputs. The cache decides whether it is actually rebuilt. */
  private refreshEconomy(hud: HudModel, snap: Snapshot): EconomyModel {
    return this.economyCache.get({
      hud,
      state: this.bridge.state,
      snap,
      credits: this.bridge.galaxyCredits,
      board: this.board,
      // The Rig's survey is a PLACEMENT reading (P2-T16) — it belongs to the ghost, not to a
      // selection, because the question it answers is asked before 200 ore is committed.
      ghost: this.mode.kind === "build" && this.ghost
        ? { buildingType: this.mode.buildingType, x: this.ghost.x, y: this.ghost.y }
        : null,
      onboardingSeen: this.onboardingSeen,
    });
  }

  /**
   * Wall-clock milliseconds, for the save panel's "12 minutes ago" and a save slot's timestamp.
   *
   * The one place in the app that reads a real clock, and it is deliberately NOT inside any model:
   * every string those produce stays a pure function of its inputs, which is what makes them
   * testable without freezing time. Nothing in the simulation ever sees this.
   */
  private wallClock(): number {
    return Date.now();
  }

  /** Nearest entity whose footprint contains the point. Buildings win ties — they are bigger. */
  private entityAt(x: number, y: number): string | null {
    const e = this.bridge.snapshot.entities;
    let best: string | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < e.count; i++) {
      const r = e.radius[i]! + ENTITY_PICK_SLACK;
      const d = Math.hypot(e.x[i]! - x, e.y[i]! - y);
      if (d > r) continue;
      const isBuilding = (e.flags[i]! & FLAG_BUILDING_KIND) !== 0;
      const score = d - (isBuilding ? 4 : 0);
      if (score < bestScore) { bestScore = score; best = engineId(e.ids[i]!); }
    }
    return best;
  }

  private nodeAt(x: number, y: number): string | null {
    const nodes = this.bridge.snapshot.nodes;
    for (let i = 0; i < nodes.count; i++) {
      // `engineId`, not `n${id - 1}`: a salvage or crater deposit is named off the entity that died
      // there (`wreck-u12-ore`), so it has no number to rebuild from and the arithmetic answered
      // `n-1` for every one of them. Right-clicking any of them ordered a gather on nothing.
      if (Math.hypot(nodes.x[i]! - x, nodes.y[i]! - y) <= NODE_RADIUS + ENTITY_PICK_SLACK)
        return engineId(nodes.ids[i]!);
    }
    return null;
  }

  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.elements.viewport.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private viewportSize(): [number, number] {
    const rect = this.elements.viewport.getBoundingClientRect();
    return [rect.width, rect.height];
  }

  /** Rough world-units-per-pixel at the current zoom, for drag panning. */
  private worldPerPixel(): number {
    const [, h] = this.viewportSize();
    return (this.camera.distance * 1.1) / Math.max(1, h);
  }
}


/** `FogField.state`'s "explored but not visible" — the port's own middle value. */
const FOG_EXPLORED_NOT_VISIBLE = 1;

/** Scratch for `worldAtPixel`. Reused: a starmap click must not allocate any more than a world one. */
const SCREEN_POINT = { x: 0, y: 0, behind: false };

/** Scratch for the keyboard's crosshair (P6-T11), for the same reason and one more: `updateGhost`. */
const CROSSHAIR_POINT = { x: 0, y: 0 };

/** The empty action row a galaxy screen renders the world's HUD with. Shared, so it costs nothing. */
const NO_ACTIONS: readonly HudAction[] = [];

/**
 * A colony's news, in the player's words (P4-T13).
 *
 * The engine's three note types, phrased and not re-decided: `lost` is the only one that reports a
 * world gone, `hostile` is a declaration the diplomacy layer latches once, and `attacked` is a raid
 * in progress. An unrecognised type is reported as itself rather than dropped — a fourth kind
 * upstream should reach the player looking odd, not silently not reach them at all.
 */

