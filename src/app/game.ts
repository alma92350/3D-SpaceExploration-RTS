// The app shell: wires the bridge, the view, the input and the HUD into one running game.
//
// Everything interesting happens elsewhere — this module's whole job is to hold the pieces and
// forward between them in the right order. It is deliberately the least clever file in the project:
// when something goes wrong at runtime, this is where you read the sequence.

import { BUILD_REACH, BUILDINGS, NODE_RADIUS, UNITS } from "../engine/index.js";
import { WorldBridge, type WorldOptions } from "../bridge/world.js";
import { checkPlacement } from "../bridge/commands.js";
import { FLAG_BUILDING_KIND, type Snapshot } from "../bridge/snapshot.js";
import { FixedStepLoop } from "./loop.js";
import { type Settings, saveSettings } from "./settings.js";
import { CameraRig, clamp } from "../input/camera.js";
import { pickGround } from "../input/picking.js";
import { type PendingMode, type PointerGesture, translateKey, translatePointer } from "../input/intents.js";
import { ControlGroups } from "../input/control-groups.js";
import { AlertFeed } from "../view/alerts.js";
import { type ElevationField, elevationFieldFrom } from "../view/terrain/elevation.js";
import { buildTerrainMesh } from "../view/terrain/mesh.js";
import { buildMeshes, meshIdForType } from "../view/meshes/generators.js";
import { SceneComposer, type GhostState } from "../view/scene.js";
import { type Renderer, type TerrainMesh, type Tier } from "../view/renderer/port.js";
import { TIERS, TierMonitor } from "../view/renderer/tiers.js";
import {
  type EconomyBoard, type EconomyModel, type HudAction, type HudCommand, type HudModel,
  EconomyCache, HudView, hudModel,
} from "../ui/hud.js";
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

export class Game {
  readonly bridge: WorldBridge;
  readonly camera: CameraRig;

  private readonly field: ElevationField;
  private readonly composer: SceneComposer;
  private readonly loop: FixedStepLoop;
  private readonly hud: HudView;
  private readonly minimap: MinimapView;
  private readonly tierMonitor: TierMonitor;
  private terrain: TerrainMesh;

  private mode: PendingMode = { kind: "none" };
  /**
   * Control groups (P3-T13). Held HERE, in the application, and never in the bridge — the whole
   * task is that a group is client state, because `state.selection` is sim state that `hashState`
   * hashes and every recorded fixture replays against.
   */
  private readonly groups = new ControlGroups();
  /** The alert board (P3-T14). Client state, like the control groups beside it. */
  private readonly alerts = new AlertFeed();
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
  /**
   * The buttons the HUD is currently showing, in order — what a positional key press indexes into.
   *
   * Held rather than recomputed on the key press, and that is deliberate: the answer must be the
   * row the player is LOOKING at. Rebuilding it from a fresher snapshot would let Z fire a button
   * that appeared between the frame they read and the key they pressed.
   */
  private actions: readonly HudAction[] = [];
  /**
   * The economy model, rebuilt on a tick rather than on a frame.
   *
   * The panels behind it are dry runs of the engine's own gating (`researchPanelModel` calls
   * `researchTech` for real and undoes it) and full sweeps of the unit table. All of that is correct
   * and none of it belongs in a 60 Hz frame, so the cache owns when it is rebuilt — see `EconomyCache`.
   */
  private readonly economyCache = new EconomyCache();
  private economy: EconomyModel = { sections: [], actions: [] };
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
    this.field = elevationFieldFrom(map.terrain, map.width, map.height);
    this.camera = new CameraRig({ mapWidth: map.width, mapHeight: map.height }, this.field);
    this.camera.focusOn(map.bases.player.x, map.bases.player.y);
    // Start close. The rig's own default is a mid-range 420, which is right once you have a base
    // to look at and wrong for the opening: at t=0 the player owns one colony ship and can see
    // about 200 units around it, so 420 frames a lone speck in a mostly unexplored map. Opening
    // near enough to read the ship is the difference between "a world" and "a loading screen".
    this.camera.distance = OPENING_DISTANCE;
    this.composer = new SceneComposer(this.field);
    this.terrain = buildTerrainMesh(this.field, {
      relief: TIERS[tier].terrain === "relief", apron: TIERS[tier].apron,
    });
    this.tierMonitor = new TierMonitor(tier);
    if (settings.tierOverride) this.tierMonitor.setManual(settings.tierOverride);

    this.renderer.registerMeshes(buildMeshes());
    this.renderer.setTier(tier);

    this.hud = new HudView(elements.hudRoot, {
      onCommand: (command) => this.runCommand(command),
    });
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
  }

  start(): void {
    if (this.running) return;
    this.running = true;
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

  private rebuildTerrainForTier(): void {
    // The terrain mesh is the one asset a tier switch genuinely changes (T0 collapses it flat,
    // ADR-0004). Rebuilding here — and only here — keeps the "rebuilt only on change" contract.
    this.terrain = buildTerrainMesh(this.field, {
      relief: TIERS[this.tier].terrain === "relief", apron: TIERS[this.tier].apron,
    });
  }

  private renderFrame(alpha: number, frameMs: number): void {
    const snap = this.bridge.snapshot;
    this.applyContinuousPan(frameMs / 1000);
    this.composer.ageEffects(frameMs / 1000);
    this.updateGhost();

    const rect = this.elements.viewport.getBoundingClientRect();
    const camera = this.camera.update(rect.width, rect.height);

    this.renderer.setFog(snap.fog);
    // The power grid is a placement cue first and a toggle second (ADR-0012 §2): it is on while a
    // build ghost is up, because "will this run efficiently here?" is a question asked at exactly
    // that moment, and otherwise only when the player asked for it with `G`.
    this.renderer.setPower(this.ghost || this.showPower ? snap.power : null);
    this.composer.compose(this.renderer, snap, camera, TIERS[this.tier], this.terrain, alpha, this.ghost);

    const hud = hudModel(snap, this.bridge.state);
    this.hud.render(hud);
    this.refreshEconomy(hud, snap);
    this.hud.renderEconomy(this.economy);
    // The positional row is the concatenation, in the order the two rows are drawn. Z is the first
    // button the player can see and N is the fifth, whichever panel it came from.
    this.actions = [...hud.actions, ...this.economy.actions];
    const error = this.bridge.takeCommandError();
    if (error) this.hud.notice(error);
    this.minimap.draw(snap, camera);

    const correction = this.tierMonitor.sample(frameMs);
    if (correction.dropped) {
      this.setTier(correction.tier, false);
      this.hud.notice(correction.notice);
    }
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
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.camera.zoom(Math.sign(e.deltaY)); }, { passive: false });
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
    const { x, y } = this.localPoint(e);
    const hit = pickGround(this.camera.update(...this.viewportSize()), this.field, x, y);
    if (e.button === 0) this.dragStart = { x, y, worldX: hit.x, worldY: hit.y };
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.localPoint(e);
    this.pointerX = x;
    this.pointerY = y;
    this.pointerInside = true;
    // Middle-drag pans. Screen-space delta, so it works at any yaw (see CameraRig.pan).
    if ((e.buttons & 4) !== 0) this.camera.pan(-e.movementX * this.worldPerPixel(), -e.movementY * this.worldPerPixel());
  }

  private onPointerUp(e: PointerEvent): void {
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
    const { x, y } = this.localPoint(e);
    const hit = pickGround(this.camera.update(...this.viewportSize()), this.field, x, y);
    this.emit({
      type: "doubleClick", button: "left", worldX: hit.x, worldY: hit.y,
      entityId: this.entityAt(hit.x, hit.y), shift: e.shiftKey, ctrl: e.ctrlKey,
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.key.toLowerCase());
    const result = translateKey({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey }, this.mode);
    if (result.mode) this.mode = result.mode;
    if (result.togglePower) this.showPower = !this.showPower;
    if (result.cancel) this.ghost = null;
    if (result.intent) this.bridge.enqueue(result.intent);
    if (result.group) this.applyGroup(result.group.n, result.group.op);
    if (result.bomb) this.applyBomb(result.bomb);
    // A positional key fires the Nth button the HUD is showing, or nothing at all when the row is
    // shorter than that — never the last button, which is how a player learns to distrust the row.
    if (result.action) {
      const action = this.actions[result.action.index];
      if (action) this.runCommand(action.command);
    }
    // Toggling: the same key closes the board it opened. A second key to close is one a player has
    // to be told about, and this client has no place to tell them.
    if (result.board) this.board = this.board === result.board ? null : result.board;
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
    if (this.keys.has("arrowdown")) dy += 1;

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
    const hit = pickGround(camera, this.field, this.pointerX, this.pointerY);
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
    this.bridge.enqueue(command.intent);
  }

  /** Assemble the economy model's inputs. The cache decides whether it is actually rebuilt. */
  private refreshEconomy(hud: HudModel, snap: Snapshot): void {
    this.economy = this.economyCache.get({
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
    });
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
      if (Math.hypot(nodes.x[i]! - x, nodes.y[i]! - y) <= NODE_RADIUS + ENTITY_PICK_SLACK)
        return `n${nodes.ids[i]! - 1}`;
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

function engineId(numeric: number): string {
  return numeric < 0 ? `b${-numeric - 1}` : `u${numeric - 1}`;
}
