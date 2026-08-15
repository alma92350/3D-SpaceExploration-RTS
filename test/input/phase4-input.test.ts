// @vitest-environment jsdom
//
// Phase 4's galaxy, reachable by a player (P4-T13) — **and the check the other two enumeration
// files structurally cannot make.**
//
// `phase2-input.test.ts` and `phase3-input.test.ts` each end by listing a phase's intent kinds and
// failing, by name, when one of them has no control producing it. Both were written after the same
// finding, one phase apart. Then it happened a third time, across four consecutive Phase 4 rows,
// and the reason it happened *again* is written into the shape of those tests: **an intent sweep
// cannot see a screen.** `view/starmap.ts` and `view/landing.ts` emit no intent at all — they are
// composers — so both files could stay green with either module deleted, and did, for four rows.
//
// So this file is in two halves.
//
//   1. **The intents**, the same way as its two siblings: driven through the REAL models, so
//      deleting the wiring in `hud.ts` makes a kind vanish from `reached` and fails with its name.
//   2. **The screens**, which needs two different questions asked, because a screen can be
//      unreachable in two unrelated ways:
//        • *Nothing imports it.* A static scan of the runtime import graph from the app's own entry
//          points. Runtime edges only: `import { type X }` is erased, so a module reached only that
//          way is a module nothing ever calls — which is exactly how `view/landing.ts` looked while
//          `ui/landing-panel.ts` "imported" it.
//        • *Nothing opens it.* A real `Game`, in a real DOM, driven by a real key press and a real
//          click, asserting on **what the renderer was actually handed** — an imported composer
//          nobody calls would pass the first check and fail this one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { Game } from "../../src/app/game.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { type Intent } from "../../src/bridge/commands.js";
import {
  type ApproachState, type HudAction, GalaxyCache, galaxyModel,
} from "../../src/ui/hud.js";
import { approachBrief } from "../../src/ui/landing-panel.js";
import { type GroundPoint, landingSite } from "../../src/view/landing.js";
import {
  AUTHORED_VIEW, STARMAP_WORLD_MESH, plateMidX, plateX, plateZ,
} from "../../src/view/starmap.js";
import { GalaxySnapshotExtractor } from "../../src/bridge/galaxy-snapshot.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import {
  ODYSSEY_WORLDS, PLANETS, assignShipToLane, createLane, makeBuilding, makeUnit,
} from "../../src/engine/index.js";

/** A world's name, as the drawer prints it. The engine's own table, not a second list. */
const planetName = (id: string): string => PLANETS.find((p) => p.id === id)?.name ?? id;

const SEED = 20260814;
const SEAT = "helix";
/** The engine's own freighter — `UNITS.hauler.cargoHold` is what makes a ship crewable at all. */
const FREIGHTER = "hauler";

/**
 * A galaxy with everything Phase 4's controls hang off: a finished pad, two freighters standing on
 * it, a colony with something on it, and one lane already open with one of the freighters crewed.
 *
 * Placed rather than built, exactly as `test/ui/colony-panel.test.ts` places colonies: none of the
 * claims below turn on how a Spaceport got there, only on the engine's own predicates finding it.
 * The one thing that IS load-bearing is that a second freighter is left uncrewed — `stagedRiders`
 * skips a lane-booked ship, so without it the lane would offer no candidate and `assignLane` would
 * be missing for a reason that has nothing to do with the wiring under test.
 */
function settled(): { bridge: WorldBridge; colonyId: string; laneId: string } {
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  const state = bridge.state;
  const base = state.map.bases.player;

  const pad = makeBuilding("spaceport", "player", base.x + 70, base.y + 70);
  pad.constructing = false;
  pad.buildProgress = 1;
  state.buildings.set(pad.id, pad);

  for (const dx of [12, 34]) {
    const ship = makeUnit(FREIGHTER, "player", pad.x + dx, pad.y + 8);
    state.units.set(ship.id, ship);
  }

  const colonyId = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
  const colony = bridge.galaxy.planets.get(colonyId)!;
  for (let i = 0; i < 3; i++) {
    const b = makeBuilding("habitat", "player", colony.map.bases.player.x + 60 + i * 40, colony.map.bases.player.y + 60);
    b.constructing = false;
    b.buildProgress = 1;
    colony.buildings.set(b.id, b);
  }

  const lane = createLane(bridge.galaxy, SEAT, colonyId, [])!;
  const crewed = [...state.units.values()].find((u) => u.type === FREIGHTER)!;
  assignShipToLane(bridge.galaxy, lane.id, crewed.id);

  // Enough to pay for a jump and an upgrade: this file is about whether a control exists and the
  // engine accepts what it carries, never about whether the treasury happens to cover it.
  bridge.galaxy.credits = 20_000;
  state.players.player.resources.ore = 5_000;
  bridge.step(STEP_SECONDS);
  return { bridge, colonyId, laneId: lane.id };
}

/**
 * The Phase 5 half of `GalaxyInput`, which this file is not about.
 *
 * Every field here is view state or a browser reading — which campaign board is open, what is in
 * `localStorage`, what the wall clock says. Named once so the galaxy tests stay about the galaxy,
 * and pinned to "no board open" so none of Phase 5's sections is on screen while Phase 4's controls
 * are being counted.
 */
const NO_CAMPAIGN = {
  board: null,
  saves: { available: false, saves: [] },
  now: 0,
  settings: { tierOverride: null, edgeScroll: true },
  currentTier: "T1",
} as const;

/** Everything the galaxy screens are showing, in the order the shell concatenates it. */
function starmapActions(bridge: WorldBridge): readonly HudAction[] {
  return galaxyModel({ ...NO_CAMPAIGN, galaxy: bridge.galaxy, stepSeconds: STEP_SECONDS, approach: null }).actions;
}

/** The approach view's state for `destId`, with `pick` put through the engine's own landing rules. */
function approachOn(bridge: WorldBridge, destId: string, pick: GroundPoint | null): ApproachState {
  const brief = approachBrief(bridge.galaxy, destId);
  return { brief, pick, site: landingSite(brief, pick) };
}

function actionsOnApproach(bridge: WorldBridge, approach: ApproachState): readonly HudAction[] {
  return galaxyModel({ ...NO_CAMPAIGN, galaxy: bridge.galaxy, stepSeconds: STEP_SECONDS, approach }).actions;
}

function findIntent(actions: readonly HudAction[], kind: string): HudAction | undefined {
  return actions.find((a) => a.command.kind === "intent" && a.command.intent.kind === kind);
}

function intentOf(action: HudAction): Intent {
  if (action.command.kind !== "intent") throw new Error(`${action.id} carries no intent`);
  return action.command.intent;
}

/* =================================================================================================
   HALF ONE — THE INTENTS
   ================================================================================================= */

describe("the galaxy's controls reach the engine (P4-T04 … P4-T08)", () => {
  it("offers a jump that carries the landing point the picker marked", () => {
    const { bridge } = settled();
    const dest = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    const approach = approachOn(bridge, dest, { x: 800, y: 500 });
    const jump = findIntent(actionsOnApproach(bridge, approach), "jump")!;

    expect(jump.enabled, "a marked landing site offered no way to commit the jump").toBe(true);
    // The RAW pick, not the snapped site: the engine snaps once, on arrival, and the snap is not
    // idempotent at the map edge (`ui/landing-panel.ts`'s header).
    expect(intentOf(jump)).toEqual({ kind: "jump", destId: dest, landingX: 800, landingY: 500 });
  });

  it("OMITS the landing fields on a world where a pad already stands", () => {
    // The rule `landingZone` forces and `landingPanelModel` reports: a jump onto a world where the
    // player holds a Spaceport comes in at the pad, and the point is discarded. An intent carrying
    // one anyway would be a promise the recorded stream keeps and the game does not — so the keys
    // must be ABSENT, not null, which is what `toEqual` with no landing fields checks.
    const { bridge } = settled();
    const dest = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    const destState = bridge.galaxy.planets.get(dest)!;
    const pad = makeBuilding("spaceport", "player", destState.map.bases.player.x, destState.map.bases.player.y);
    pad.constructing = false;
    pad.buildProgress = 1;
    destState.buildings.set(pad.id, pad);

    const approach = approachOn(bridge, dest, { x: 800, y: 500 });
    expect(approach.site.source, "the pad did not win the landing").toBe("pad");
    const jump = findIntent(actionsOnApproach(bridge, approach), "jump")!;
    expect(intentOf(jump)).toEqual({ kind: "jump", destId: dest });
    expect("landingX" in intentOf(jump), "a discarded landing point was sent anyway").toBe(false);
  });

  it("puts every destination behind an approach rather than behind a jump", () => {
    // The starmap can open the picker and cannot launch a fleet. That is the whole reason the
    // destination button carries a `screen`-shaped command instead of the intent: a jump is
    // committed after the player has seen where they land, not on one click from a map.
    const { bridge } = settled();
    const actions = starmapActions(bridge);
    const approaches = actions.filter((a) => a.command.kind === "approach");
    expect(approaches.length, "the starmap offered no destination at all").toBe(ODYSSEY_WORLDS.length - 1);
    expect(findIntent(actions, "jump"), "the starmap can launch a jump with no approach at all")
      .toBeUndefined();
  });

  it("offers the pad's upgrade with the engine's own escalating price", () => {
    const { bridge } = settled();
    const upgrade = findIntent(starmapActions(bridge), "upgradeSpaceport")!;
    expect(upgrade, "a finished Spaceport offered no way to extend it").toBeDefined();
    expect(upgrade.enabled, "5 000 ore and the upgrade still reads as unaffordable").toBe(true);
    expect(bridge.apply(intentOf(upgrade)), "the upgrade the HUD enabled was refused").toBeNull();
  });

  it("offers a lane's crew both ways round, and only ships the engine would accept", () => {
    const { bridge, laneId } = settled();
    const actions = starmapActions(bridge);
    const assign = findIntent(actions, "assignLane")!;
    const unassign = findIntent(actions, "unassignLane")!;
    expect(assign, "a freighter in the ring could not be crewed onto the lane").toBeDefined();
    expect(unassign, "a crewed freighter could not be released").toBeDefined();
    // Different ships: the candidate list is the staging ring, which SKIPS whatever is already
    // booked. Offering the same ship twice would mean the panel was reading one of them wrong.
    const assigned = intentOf(assign) as Extract<Intent, { kind: "assignLane" }>;
    const released = intentOf(unassign) as Extract<Intent, { kind: "unassignLane" }>;
    expect(assigned.laneId).toBe(laneId);
    expect(assigned.unitId).not.toBe(released.unitId);
    expect(bridge.apply(assigned), "the crew button the HUD enabled was refused").toBeNull();
  });

  it("offers a colony's standing orders, and never on the world under your feet", () => {
    const { bridge, colonyId } = settled();
    const actions = starmapActions(bridge);
    const policies = actions.filter((a) => a.command.kind === "intent" && a.command.intent.kind === "colonyPolicy");
    expect(policies.length, "no colony offered a standing order").toBeGreaterThan(0);
    const planets = new Set(policies.map((a) => (intentOf(a) as Extract<Intent, { kind: "colonyPolicy" }>).planetId));
    expect(planets.has(colonyId), "the colony with buildings on it got no controls").toBe(true);
    // `runColonyPolicies` acts on background worlds only, so an order set on the seat is inert —
    // and a button that does nothing is worse than no button (F-07).
    expect(planets.has(SEAT), "the seat was offered standing orders it cannot run").toBe(false);
  });
});

describe("no Phase 4 order is left unreachable", () => {
  it("gives every galaxy intent a control that produces it", () => {
    // The sibling of the Phase 2 and Phase 3 enumerations, one phase further on. Everything is
    // driven through the REAL models: remove the composition in `hud.ts`, or stop a panel being
    // composed, or drop an intent from a button, and the kind disappears from `reached` and this
    // fails with its name in the message.
    const { bridge } = settled();
    const reached = new Set<string>();
    const record = (actions: readonly HudAction[]): void => {
      for (const action of actions) {
        if (action.command.kind === "intent") reached.add(action.command.intent.kind);
      }
    };

    record(starmapActions(bridge));
    const dest = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    record(actionsOnApproach(bridge, approachOn(bridge, dest, { x: 800, y: 500 })));

    const PHASE_4_INTENTS = [
      "jump", "upgradeSpaceport", "createLane", "deleteLane", "assignLane", "unassignLane",
      "colonyPolicy",
    ];
    const missing = PHASE_4_INTENTS.filter((k) => !reached.has(k));
    expect(missing, `no control produces: ${missing.join(", ")} — implemented but unreachable`)
      .toEqual([]);
  });

  it("is offering orders the engine actually accepts, not buttons shaped like orders", () => {
    // The other half of the same claim, and the one that catches a control that exists and carries
    // a payload the engine throws out. Applied in an order that keeps the setup alive: the lane is
    // crewed, released and only then closed, and the jump goes last because it moves the seat.
    const { bridge } = settled();
    const actions = starmapActions(bridge);
    for (const kind of ["assignLane", "unassignLane", "createLane", "deleteLane", "upgradeSpaceport", "colonyPolicy"]) {
      const action = findIntent(actions, kind);
      expect(action, `nothing on the starmap carries ${kind}`).toBeDefined();
      expect(bridge.apply(intentOf(action!)), `the ${kind} button was refused by the engine`).toBeNull();
    }

    const dest = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    const jump = findIntent(actionsOnApproach(bridge, approachOn(bridge, dest, { x: 800, y: 500 })), "jump")!;
    expect(bridge.apply(intentOf(jump)), "the jump the picker enabled was refused").toBeNull();
    expect(bridge.worldId, "the jump was accepted and the seat did not move").toBe(dest);
  });
});

/* =================================================================================================
   HALF TWO — THE SCREENS

   The check an intent sweep cannot make.
   ================================================================================================= */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The app's own entry points. Everything a player can reach is reached from one of these two. */
const ENTRY_POINTS = ["src/main.ts", "src/harness-entry.ts"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // The vendored engine is upstream's and has its own entry point (`src/engine/index.ts`,
      // which IS scanned): its internals are checked by `npm run check:vendor`, not by us.
      if (full === join(ROOT, "src", "engine")) continue;
      sourceFiles(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(relative(ROOT, full).split(sep).join("/"));
    }
  }
  return out;
}

/**
 * The import specifiers of `source` that **survive to runtime**.
 *
 * `import type { X }` and `import { type X }` are both erased down to the module's side effects —
 * nothing in the importing file ever calls into the imported one. That distinction is the whole
 * point of this scan rather than a nicety: `ui/landing-panel.ts` imports three names from
 * `view/landing.ts` and every one of them is a `type`, so a scan that counted it would have called
 * the approach view "reached" through the entire stretch when no code path could open it.
 *
 * Comments are stripped first. These files quote import paths in their headers at length, and a
 * scan that reads its own documentation as an edge is a scan that cannot fail.
 */
export function runtimeImportsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of code.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
    if (m[1]) continue;                                   // `import type { … } from`
    const clause = m[2]!.trim();
    if (clause.startsWith("{")) {
      const names = clause.slice(1, clause.lastIndexOf("}")).split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    out.push(m[3]!);
  }
  return out;
}

describe("no Phase 4 screen is left unreachable", () => {
  it("has a runtime path from an entry point to every module in src/", () => {
    // **The check that would have caught four rows in a row.** `starmap.ts`, `landing.ts`,
    // `jump-panel.ts`, `colony-panel.ts` and `lane-panel.ts` were each complete, tested and
    // imported by nothing but their own tests — and every intent enumeration in this directory was
    // green throughout, because a composer emits no intent to enumerate.
    //
    // It is deliberately the whole of `src/` rather than a list of Phase 4's five modules. A list
    // is a thing somebody has to remember to add to, which is precisely the failure this row exists
    // to stop repeating.
    const files = new Map(sourceFiles(join(ROOT, "src")).map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]));
    expect(files.size, "the source scan found nothing to check").toBeGreaterThan(20);
    for (const entry of ENTRY_POINTS) expect(files.has(entry), `${entry} is not a source file`).toBe(true);

    const reached = new Set<string>();
    const queue = [...ENTRY_POINTS];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (reached.has(current) || !files.has(current)) continue;
      reached.add(current);
      for (const spec of runtimeImportsOf(files.get(current)!)) {
        if (!spec.startsWith(".")) continue;              // three, node:*, and the @engine alias
        queue.push(join(dirname(current), spec).split(sep).join("/").replace(/\.js$/, ".ts"));
      }
    }

    const orphans = [...files.keys()].filter((rel) => !reached.has(rel)).sort();
    expect(orphans, [
      "These modules are reachable from no entry point, so nothing a player does can run them:",
      ...orphans.map((o) => `  ${o}`),
      "",
      "A module imported only for its TYPES counts as unreached here, on purpose — the import is",
      "erased and nothing calls into it. Wire it to a control, or delete it.",
    ].join("\n")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------
   …and the other half: a gesture that opens it. Imported is not opened.
   ------------------------------------------------------------------------------------------- */

const VIEW_W = 1280;
const VIEW_H = 720;

/** A no-op 2D context, as `test/ui/hud-wiring.test.ts` uses: jsdom ships no canvas backend. */
function stubCanvas(): () => void {
  const original = HTMLCanvasElement.prototype.getContext;
  const ctx: unknown = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "canvas") return { width: 1, height: 1 };
      if (prop === "createImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as typeof original;
  return () => { HTMLCanvasElement.prototype.getContext = original; };
}

function elements() {
  const viewport = document.createElement("div");
  const hudRoot = document.createElement("div");
  const minimapCanvas = document.createElement("canvas");
  document.body.append(viewport, hudRoot, minimapCanvas);
  // jsdom lays nothing out, so every rect is 0×0 — and a camera with a zero viewport produces a
  // projection matrix full of infinities, which makes every pick a NaN. The screens under test are
  // the two that PICK (a marker on the plate, a landing site on the ground), so the one thing this
  // stub has to provide is a viewport with a size.
  viewport.getBoundingClientRect = () => ({
    width: VIEW_W, height: VIEW_H, left: 0, top: 0, right: VIEW_W, bottom: VIEW_H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return { viewport, hudRoot, minimapCanvas };
}

describe("a gesture opens each Phase 4 screen", () => {
  let restore: () => void;
  let game: Game;
  let hudRoot: HTMLElement;
  let viewport: HTMLElement;
  let renderer: RecordingRenderer;
  let queued: Intent[];

  beforeEach(() => {
    restore = stubCanvas();
    const els = elements();
    hudRoot = els.hudRoot;
    viewport = els.viewport;
    renderer = new RecordingRenderer();
    game = new Game(els, renderer, "T0", { tierOverride: null, edgeScroll: false },
      { seed: SEED, worldId: SEAT });

    // A finished pad, so the destinations are genuinely reachable rather than reachable-looking.
    const state = game.bridge.state;
    const base = state.map.bases.player;
    const pad = makeBuilding("spaceport", "player", base.x + 70, base.y + 70);
    pad.constructing = false;
    pad.buildProgress = 1;
    state.buildings.set(pad.id, pad);
    game.bridge.galaxy.credits = 20_000;

    // Every intent the shell enqueues, captured. The bridge queues rather than applies, so this is
    // the only place a jump can be observed at the moment it is issued.
    queued = [];
    const enqueue = game.bridge.enqueue.bind(game.bridge);
    game.bridge.enqueue = (intent: Intent) => { queued.push(intent); enqueue(intent); };
    step();
  });

  afterEach(() => {
    game.stop();
    document.body.replaceChildren();
    restore();
  });

  function frame(): void {
    (game as unknown as { renderFrame(alpha: number, frameMs: number): void }).renderFrame(0, 16);
  }

  function step(): void {
    game.bridge.step();
    frame();
  }

  function press(key: string): void {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  function pointer(type: string, x: number, y: number): void {
    viewport.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  }

  function buttons(): HTMLButtonElement[] {
    return [...hudRoot.querySelectorAll("button")];
  }

  function labelled(prefix: string): HTMLButtonElement | undefined {
    return buttons().find((b) => (b.querySelector(".hud-button-label")?.textContent ?? "").startsWith(prefix));
  }

  function lastFrame() {
    return renderer.frames[renderer.frames.length - 1]!;
  }

  it("opens the starmap on its key, at the orientation the layout is priced at", () => {
    press("y");
    frame();

    const drawn = lastFrame();
    // The plate, and only the plate: no terrain (there is no ground on a starmap), one marker per
    // world in the roster, all of them the shared disc mesh (ADR-0019 §6).
    expect(drawn.terrainVersion, "the starmap frame drew the battlefield's terrain").toBeNull();
    expect(drawn.batches.length, "nothing was drawn at all").toBeGreaterThan(0);
    expect(drawn.batches.every((b) => b.mesh === STARMAP_WORLD_MESH)).toBe(true);
    expect(drawn.batches.reduce((n, b) => n + b.count, 0), "the plate is not the whole roster")
      .toBe(ODYSSEY_WORLDS.length);
    // `authoredCamera` at the switch: the discordance figure in ADR-0019 §3 is measured at exactly
    // this pose, so a starmap opened anywhere else is a starmap nobody priced.
    expect(drawn.camera.targetX).toBe(AUTHORED_VIEW.centreX);
    expect(drawn.camera.targetY).toBe(AUTHORED_VIEW.centreZ);
    expect(drawn.camera.distance).toBe(AUTHORED_VIEW.distance);
    // The stylesheet's hook. It is how the minimap dims and how the drawer gets the bottom of the
    // screen, and CSS is the one part of this that no test can read — so the attribute it hangs on
    // is asserted instead.
    expect(hudRoot.dataset.screen, "nothing told the stylesheet which screen is up").toBe("starmap");

    // …and the same key closes it, which is the half a player finds out about by pressing twice.
    press("y");
    frame();
    expect(lastFrame().terrainVersion, "the galaxy key did not close what it opened").not.toBeNull();
  });

  it("backs out one level on Escape, rather than dropping straight to the battlefield", () => {
    // A screen you can only leave by remembering the key that opened it is a screen you can get
    // stuck on. Escape is the universal way out here as it is for a build ghost — and it backs out
    // ONE level, because abandoning a mis-clicked destination should not also close the map the
    // player was choosing on.
    press("y");
    frame();
    labelled("Approach ")!.click();
    frame();
    expect(lastFrame().batches.some((b) => b.mesh === "colonyship"), "the approach view never opened").toBe(true);

    press("Escape");
    frame();
    expect(lastFrame().terrainVersion, "Escape left the approach view on the battlefield, not the map")
      .toBeNull();
    expect(lastFrame().batches.every((b) => b.mesh === STARMAP_WORLD_MESH),
      "Escape did not land on the starmap").toBe(true);

    press("Escape");
    frame();
    expect(lastFrame().terrainVersion, "Escape did not close the starmap").not.toBeNull();
  });

  it("opens the approach view from a control on the starmap, and draws the destination", () => {
    // The seat's own ground, for the two "it is not the battlefield" assertions below. Read before
    // the starmap opens, because the starmap draws no terrain at all.
    const seatTerrain = lastFrame().terrainVersion;
    expect(seatTerrain, "the battlefield frame drew no terrain to compare against").not.toBeNull();
    press("y");
    frame();
    const approach = labelled("Approach ");
    expect(approach, "the starmap offered no way into the approach view").toBeDefined();
    approach!.click();
    frame();

    const drawn = lastFrame();
    // The destination's own ground, the lander standing on the site, and the ring that says where
    // it lands. None of the three is on a starmap frame and none is on a battlefield frame with no
    // build ghost up, so this is the approach view or nothing.
    expect(drawn.terrainVersion, "the approach view drew no ground").not.toBeNull();
    expect(drawn.terrainVersion, "the approach view drew the SEAT's ground").not.toBe(seatTerrain);
    const lander = drawn.batches.find((b) => b.mesh === "colonyship");
    expect(lander, "nothing was drawn standing on the landing site").toBeDefined();
    expect(lander!.count).toBe(1);
    expect(drawn.overlays.some((o) => o.kind === "ghost" && o.count > 0),
      "the landing marker was not drawn").toBe(true);
    // …and not under the seat's fog. Both renderers paint terrain through whatever fog they last
    // received, so a screen that uploads none wears another world's explored shape.
    expect(renderer.fogVersion, "the destination was drawn under the world you are standing on's fog")
      .not.toBe(game.bridge.snapshot.fog.version);
  });

  it("marks the landing on a pointer move and sends the mark with the jump", () => {
    const seatTerrain = lastFrame().terrainVersion;
    press("y");
    frame();
    labelled("Approach ")!.click();
    frame();

    // Before the mark: the panel says so in the player's own words, and refuses to commit.
    expect(hudRoot.textContent, "an unmarked approach did not say it was unmarked")
      .toMatch(/No landing site chosen/);

    pointer("pointermove", VIEW_W / 2, VIEW_H / 2);
    frame();
    const approachTerrain = lastFrame().terrainVersion;
    const confirm = labelled("Jump to ");
    expect(confirm, "the approach view offered no way to commit").toBeDefined();
    expect(confirm!.classList.contains("unaffordable"),
      "a marked landing site still read as un-committable").toBe(false);

    confirm!.click();
    const jump = queued.find((i) => i.kind === "jump") as Extract<Intent, { kind: "jump" }> | undefined;
    expect(jump, "the confirm button enqueued no jump").toBeDefined();
    // The mark reached the intent. A jump that arrived with no landing fields at all would be the
    // picker's whole subject falling out between the screen and the bridge.
    expect(jump!.landingX, "the jump carried no landing point").toBeGreaterThan(0);
    expect(jump!.landingY).toBeGreaterThan(0);

    // …and the engine takes it: the seat moves on the next tick and the shell follows it onto the
    // world it landed on. The ground drawn afterwards is neither the approach's nor the world it
    // left — a shell that kept the old seat's field would ray-march the wrong heightfield for every
    // order the player gave next.
    const rigBefore = game.camera;
    step();
    expect(game.bridge.worldId, "the jump the player confirmed was refused").toBe(jump!.destId);
    const arrived = lastFrame().terrainVersion;
    expect(arrived, "nothing was drawn after the jump").not.toBeNull();
    expect(arrived, "the shell kept drawing the world it jumped away from").not.toBe(seatTerrain);
    // …and it is the BATTLEFIELD's ground, not the picker's. Both are built from the destination's
    // field and each build takes its own version, so this is what separates "arrived" from "still
    // standing on the confirm screen".
    expect(arrived, "the confirm left the player on the approach view").not.toBe(approachTerrain);

    // **And the rig went with it.** A rebuilt terrain proves a rebuild happened, not what it was
    // built FROM — the honest observable for that is the camera, which is public, is constructed
    // around the elevation field the picker ray-marches, and clamps to the map it was given. A
    // shell that kept the old rig would be ray-marching the ground of the world the player left for
    // every order they gave next.
    expect(game.camera, "the shell kept the camera rig built for the world it jumped away from")
      .not.toBe(rigBefore);
    expect(rigBefore.distance, "the old rig is the current one under another name").toBeDefined();
  });

  it("puts the galaxy's controls on the positional row, and the world's nowhere near it", () => {
    // The convention P4-T01 made real, applied to a screen it did not exist for: Z fires the first
    // button on screen. The half that needs asserting is the OTHER one — the world's own action row
    // is suppressed while a galaxy screen is up, or a Deploy button from the battlefield behind it
    // would sit on Z and push the jump controls off the five keys the board has.
    //
    // **So the battlefield has to have a button for this to be a test at all.** With nothing
    // selected the world's row is empty, concatenating it changes nothing, and removing the
    // suppression would leave every assertion below still passing — a green test measuring the
    // absence of a thing it forgot to set up.
    const ship = [...game.bridge.state.units.values()].find((u) => u.type === "colonyship" && u.owner === "player")!;
    game.bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    step();
    expect(labelled("Deploy base"), "the battlefield row is empty, so suppressing it proves nothing")
      .toBeDefined();

    press("y");
    frame();
    labelled("Approach ")!.click();
    pointer("pointermove", VIEW_W / 2, VIEW_H / 2);
    frame();

    const row = [...hudRoot.querySelectorAll('[data-econ-actions="approach"] button')];
    expect(row.length, "the approach view put no buttons on the row").toBeGreaterThan(0);
    expect((row[0]!.querySelector(".hud-button-label")?.textContent ?? ""),
      "the first positional key does not reach the jump").toMatch(/^Jump to /);

    press("z");
    expect(queued.some((i) => i.kind === "jump"), "Z reached no galaxy control at all").toBe(true);
  });

  it("tells the player when a colony is lost, on the line a refused order uses", () => {
    // Where `sweepColonies`' notifications land, and the reason they land THERE. They are not
    // alerts in `view/alerts.ts`' sense: an alert carries the world position that "focus last alert"
    // jumps the camera to, and a colony note is about a world that is not on screen and has no
    // position on the seat's map to jump to. The transient notice is the line this client already
    // uses for news with nowhere to point — a refused order, a tier drop.
    const colonyId = [...game.bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    const colony = game.bridge.galaxy.planets.get(colonyId)!;
    const b = makeBuilding("habitat", "player", colony.map.bases.player.x + 60, colony.map.bases.player.y + 60);
    b.constructing = false;
    b.buildProgress = 1;
    colony.buildings.set(b.id, b);
    step();                                            // the sweep records that a colony stood here
    colony.buildings.delete(b.id);
    step();                                            // …and now it does not

    const notice = hudRoot.querySelector('[data-hud="notice"]')!;
    expect(notice.textContent, `losing a colony said nothing to the player`).toMatch(/lost/i);
    expect(notice.textContent).toContain(colonyId);
    expect(notice.classList.contains("visible")).toBe(true);
  });

  it("reads a button's payload at the press, not at the moment its node was built", () => {
    // **The mechanism the confirm button above depends on, and a defect it uncovered.** The drawer
    // rebuilds its nodes only when the button IDS change (P4-T01's frame budget), and a button used
    // to capture its command when it was created — so any button whose id is stable while its
    // payload moves kept the payload it was born with. The landing point is one: it changes on every
    // pointer move and changes nothing's id.
    //
    // It was never only Phase 4's. `pause:<id>` carries `paused: !building.paused`, so the oldest
    // economy button in the client had the same fault: pausing a factory left a button still saying
    // "Pause" and still sending "pause", and the DOM had no way back. Asserted here rather than next
    // door because this row is where it was found and this is the row whose screen needs it.
    const smelter = makeBuilding("smelter", "player", 620, 620);
    game.bridge.state.buildings.set(smelter.id, smelter);
    game.bridge.enqueue({ kind: "select", ids: [smelter.id], additive: false });
    step();

    const pause = labelled("Pause")!;
    expect(pause, "the selected factory showed no Pause button").toBeDefined();
    pause.click();
    step();

    // The SAME node — nothing was rebuilt, because the id did not change — now says the other thing
    // and carries the other payload.
    expect(labelled("Resume"), "the paused factory's button still said Pause").toBe(pause);
    pause.click();
    step();
    expect(smelter.paused, "the button could pause but never resume").toBe(false);
  });

  it("keeps the plate in step with the galaxy underneath it", () => {
    // The starmap's snapshot is extracted once per galaxy TICK rather than once per frame, which is
    // the right budget and the wrong answer if the "once" is ever taken literally. The seat's own
    // ring is what moves when the galaxy does: "you are here" is drawn on `activeIndex`, and a jump
    // is the one thing that changes it.
    press("y");
    frame();
    const here = (): number => {
      const ring = lastFrame().overlays.find((o) => o.kind === "selection" && o.count > 0);
      expect(ring, "the plate drew no 'you are here' ring").toBeDefined();
      return ring!.data[0]!;
    };
    const before = here();

    const dest = [...game.bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    game.bridge.enqueue({ kind: "jump", destId: dest });
    step();                                            // the seat moves; the starmap stays up
    frame();

    expect(game.bridge.worldId, "the jump was refused, so nothing below is a test").toBe(dest);
    expect(here(), "the plate is still drawing the seat the player left").not.toBe(before);
  });

  it("picks the world it was pointed at, by clicking the plate", () => {
    // The starmap's own gesture. Without it the plate is a picture beside a menu, and ADR-0019's
    // case — that a marker's identity is WHERE IT IS — would not survive contact with a player.
    //
    // The world clicked is named in the assertion, not just "an approach opened". A picker that
    // ignored the plate's cross-axis would still open SOMETHING for most clicks (the roster is
    // spread along the other axis, so the x-nearest marker is usually the right one), so a test
    // that only checked "a screen opened" would pass with the stagger thrown away — which is the
    // one thing ADR-0019 §2 says must never be quietly dropped.
    press("y");
    frame();

    // The plate as the bridge describes it, so the test knows which marker is which world. Reading
    // the ids from the same extractor the shell uses is the point: it is the drawn plate that is
    // being clicked, not a layout this test invented.
    const galaxy = new GalaxySnapshotExtractor().extract(game.bridge.galaxy);
    const w = galaxy.worlds;
    const midX = plateMidX(w.x, w.count);
    const pixelOf = (i: number): [number, number] => {
      const clip = project(lastFrame().camera.viewProj, plateX(w.x[i]!, midX), 0, plateZ(i));
      return [(clip.x * 0.5 + 0.5) * VIEW_W, (0.5 - clip.y * 0.5) * VIEW_H];
    };

    // **One world per stagger row.** `plateZ` keys on the roster index and there are three rows, so
    // a picker that used any single constant for the cross-axis would still land the right world
    // for the row it happened to pick — one click cannot tell the difference, and three can.
    const rows = [0, 1, 2].map((row) => [...Array(w.count).keys()]
      .find((i) => i !== galaxy.activeIndex && i % 3 === row)!);
    expect(new Set(rows).size, "the roster does not fill all three stagger rows").toBe(3);

    for (const index of rows) {
      pointer("pointerup", ...pixelOf(index));
      frame();
      expect(hudRoot.textContent, `clicking row ${index % 3} opened the wrong world's approach`)
        .toContain(`Approach · ${planetName(w.ids[index]!)}`);
      press("Escape");                                 // back to the plate for the next click
      frame();
    }

    // …and a click on empty plate opens nothing. Without this, a pick radius of any size at all
    // passes the three assertions above, because every one of them clicks a marker dead centre.
    const [mx, my] = pixelOf(rows[0]!);
    const empty: [number, number] = [mx, my + 180];
    for (let i = 0; i < w.count; i++) {
      const [px, py] = pixelOf(i);
      expect(Math.hypot(px - empty[0], py - empty[1]), `world ${i} is under the "empty" point`)
        .toBeGreaterThan(60);
    }
    pointer("pointerup", ...empty);
    frame();
    expect(lastFrame().terrainVersion, "a click on empty plate opened a world anyway").toBeNull();
  });
});

/** World point → clip space, for the plate click above. `projectToScreen`'s arithmetic, inlined. */
function project(m: Float32Array, x: number, y: number, z: number): { x: number; y: number } {
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const iw = cw === 0 ? 1 : 1 / cw;
  return { x: cx * iw, y: cy * iw };
}

/* =================================================================================================
   THE FRAME BUDGET

   `HudView` only touches DOM nodes whose text changed (P1-T16) and the economy drawer is rebuilt on
   a tick rather than on a frame (P4-T01). The galaxy drawer is the more expensive of the two — a
   jump board prices every destination and a colony board walks every world's buildings — so it gets
   the same treatment and the same test.
   ================================================================================================= */

describe("the galaxy drawer is built on a tick, not on a frame", () => {
  it("returns the very same model until the galaxy moves", () => {
    const { bridge } = settled();
    const cache = new GalaxyCache();
    const input = { ...NO_CAMPAIGN, galaxy: bridge.galaxy, stepSeconds: STEP_SECONDS, approach: null };

    const first = cache.get(input);
    expect(cache.get(input), "the drawer was rebuilt inside one tick").toBe(first);

    bridge.step(STEP_SECONDS);
    expect(cache.get(input), "the drawer survived a tick it should have been rebuilt on")
      .not.toBe(first);
  });

  it("rebuilds the approach panel when the mark moves, and not when it has not", () => {
    const { bridge } = settled();
    const dest = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    const cache = new GalaxyCache();
    const at = (x: number, y: number) => ({
      ...NO_CAMPAIGN,
      galaxy: bridge.galaxy, stepSeconds: STEP_SECONDS, approach: approachOn(bridge, dest, { x, y }),
    });

    const first = cache.get(at(800, 500));
    expect(cache.get(at(800.4, 500.2)), "a sub-unit pointer twitch rebuilt the panel").toBe(first);
    expect(cache.get(at(900, 500)), "moving the mark did not rebuild the panel").not.toBe(first);
  });
});
