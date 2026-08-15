// @vitest-environment jsdom
//
// P6-T11 — keyboard-only PLAY, proven by PLAYING: a real `Game`, from a cold start, with **no
// pointer event of any kind reaching the interface**.
//
// P6-T03 proved the HUD is navigable. This is the other clause of PRD §5's Phase 6 scope, and it is
// a different thing: a player who can press every button in the drawer still cannot play, because
// almost every button and every order is *about the selection*, and until this row nothing on the
// keyboard could make one.
//
// **The row's premise turned out to be understated, and the first test below is the measurement.**
// It was written down as "the opening colony ship happens to start selected, which is why `Z` deploy
// works from a cold start and hides the problem". It does not start selected: `state.selection` is
// empty at t=0, `hudModel` says the quiet part out loud in its own prompt — *"Click your colony ship
// to select it"* — and the only control on screen is the onboarding card's "Got it". `Z` dismissed
// the card and then had nothing at all to fire. The cold start was not a hidden problem; it was a
// dead end.
//
// The standard here is `phase5-input.test.ts`'s: **nine of the ten engine functions behind these
// orders return `void`**, so "an intent was produced" proves nothing. Every claim below is made
// against the simulation — a Command Center exists, a worker came out of it, a Barracks stands at
// the point the camera was pointing at, a unit's own `order` names the crosshair and the unit is
// nearer to it twenty-five ticks later.
//
// ================================================================================================
// THE GUARD THAT MAKES "KEYBOARD-ONLY" A FACT
// ================================================================================================
//
// Every mouse entry point in the shell is a listener on one of three elements (`attachListeners`:
// pointer/wheel/dblclick/contextmenu on the viewport, `pointerdown` on the minimap, and the HUD's
// own buttons for clicks — including the ones `HudFocus` presses for the keyboard ring). The first
// describe registers a capture-phase recorder for every mouse and pointer event type on all three
// and asserts after each test that not one arrived, so "keyboard-only" is checked rather than
// promised and a test that reached for `button.click()` to get unstuck fails.
//
// ================================================================================================
// P7-T03 — the two controls this row named as still pointer-only, played the same way
// ================================================================================================
//
// The third describe is the remainder, under the same guard and to the same standard. Neither claim
// is "a key produced an event": **zoom is asserted as a distance that moved, by the notch the wheel
// moves and all the way to both stops**, and the landing mark as a jump that put the colony ship
// down on the point the player flew to — a hundred and sixty units from the engine's own default,
// which is where every keyboard jump landed before this row.
//
// The fourth is the trap the row was filed with: `landingZone` DISCARDS a landing point whenever a
// pad stands on the destination, so a control that promised one there would be a promise the
// recorded stream keeps and the game does not. The panel decides and the control obeys — checked by
// marking a padded world from the keyboard and reading the intent that comes out.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Game } from "../../src/app/game.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { type HudAction, type HudCommand } from "../../src/ui/hud.js";
import { FOCUS_CLASS } from "../../src/ui/hud-focus.js";
import { POSITIONAL_KEYS } from "../../src/input/intents.js";
import {
  CameraRig, MAX_DISTANCE, MIN_DISTANCE, PITCH_FAR, PITCH_NEAR,
} from "../../src/input/camera.js";
import { type ApproachView } from "../../src/view/landing.js";
import { AUTHORED_VIEW } from "../../src/view/starmap.js";
import { makeBuilding, makeUnit } from "../../src/engine/index.js";

const SEED = 20260815;
const VIEW_W = 1280;
const VIEW_H = 720;

/** Every way a mouse can reach the app. Recorded, never dispatched. */
const MOUSE_EVENTS = [
  "pointerdown", "pointerup", "pointermove", "pointerleave", "pointerenter",
  "mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "wheel",
];

/** A no-op 2D context, as every DOM test here uses: jsdom ships no canvas backend. */
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
  // A real viewport size: the arrow keys pan through the camera and the ghost is picked through its
  // projection, and a 0×0 rect is not a window anyone plays in.
  viewport.getBoundingClientRect = () => ({
    width: VIEW_W, height: VIEW_H, left: 0, top: 0, right: VIEW_W, bottom: VIEW_H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return { viewport, hudRoot, minimapCanvas };
}

/**
 * The keyboard, and only the keyboard, driving one real `Game`.
 *
 * Shared by both describes so the second one — which does need a pointer, for the one claim that is
 * about pointers — plays the same opening through the same keys rather than a second copy of it.
 */
function driver(game: Game) {
  const frame = (): void => {
    (game as unknown as { renderFrame(alpha: number, frameMs: number): void }).renderFrame(0, 16);
  };
  const step = (): void => { game.bridge.step(); frame(); };

  /** One key press, delivered where a browser delivers one. */
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    const target: EventTarget = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  };

  /** Hold a key across one rendered frame — how `applyContinuousPan` is driven for real. */
  const holdFrame = (key: string): void => {
    press(key);
    frame();
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  };

  /** Walk the camera to a world point with the arrow keys, and nothing else. */
  const panTo = (x: number, y: number): void => {
    for (let i = 0; i < 500 && Math.abs(game.camera.targetX - x) > 8; i++) {
      holdFrame(game.camera.targetX < x ? "ArrowRight" : "ArrowLeft");
    }
    for (let i = 0; i < 500 && Math.abs(game.camera.targetY - y) > 8; i++) {
      holdFrame(game.camera.targetY < y ? "ArrowDown" : "ArrowUp");
    }
    expect(Math.hypot(game.camera.targetX - x, game.camera.targetY - y),
      `the arrow keys could not walk the camera to ${Math.round(x)},${Math.round(y)}`)
      .toBeLessThan(12);
  };

  /** The ordered action row the shell holds — what the positional keys index into. */
  const actions = (): readonly HudAction[] => (game as unknown as { actions: readonly HudAction[] }).actions;

  /** Fire the positional key for an action, by id, and say so if the row does not hold it. */
  const fire = (id: string): void => {
    const index = actions().findIndex((a) => a.id === id);
    expect(index, `"${id}" is not on the action row: ${actions().map((a) => a.id).join(", ")}`)
      .toBeGreaterThanOrEqual(0);
    expect(index, `"${id}" is past the positional row, so no key reaches it`)
      .toBeLessThan(POSITIONAL_KEYS.length);
    press(POSITIONAL_KEYS[index]!);
  };

  const until = (what: string, ok: () => boolean, limit = 500): void => {
    for (let i = 0; i < limit && !ok(); i++) step();
    expect(ok(), `${what} — not within ${limit} ticks`).toBe(true);
  };

  const selection = (): readonly string[] => game.bridge.state.selection;
  const mine = <T extends { owner: string }>(all: Iterable<T>): T[] =>
    [...all].filter((x) => x.owner === "player");
  const units = (): string[] => mine(game.bridge.state.units.values()).map((u) => u.type);
  const buildings = (): string[] => mine(game.bridge.state.buildings.values()).map((b) => b.type);
  const myBuilding = (type: string) =>
    mine(game.bridge.state.buildings.values()).find((b) => b.type === type);

  /** What the current selection IS, as engine types — the only honest way to name it. */
  const selectedTypes = (): string[] => {
    const state = game.bridge.state;
    return selection().map((id) => state.units.get(id)?.type ?? state.buildings.get(id)?.type ?? "?");
  };

  /** Press Q until the selection is of `type`, or fail saying what it walked past. */
  const cycleTo = (type: string): void => {
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      if (selectedTypes().length > 0 && selectedTypes().every((t) => t === type)) return;
      press("q");
      step();
      seen.push(selectedTypes().join("+"));
    }
    expect.fail(`Q never reached a ${type}; it visited ${seen.join(" → ")}`);
  };

  /** Deploy the base with the keyboard, so a test can start from a world with something in it. */
  const foundBase = (): void => {
    frame();
    press("q");
    step();
    fire("deploy");
    until("the Command Center was founded", () => buildings().includes("command"));
  };

  const ghost = (): { x: number; y: number } | null =>
    (game as unknown as { ghost: { x: number; y: number } | null }).ghost;
  const mode = (): string => (game as unknown as { mode: { kind: string } }).mode.kind;

  /* --- P7-T03's two subjects, as the shell holds them ------------------------------------------ */

  /** Which screen is up, and — on the approach screen — the picker itself. */
  const screen = (): { kind: string; destId?: string; view?: ApproachView } =>
    (game as unknown as { screen: { kind: string; destId?: string; view?: ApproachView } }).screen;

  /** The approach view, or a failure that says which screen is up instead. */
  const approach = (): ApproachView => {
    const s = screen();
    expect(s.view, `the approach screen is not open — the shell is showing "${s.kind}"`).toBeDefined();
    return s.view!;
  };

  /** The starmap's own rig. Separate from the battlefield's, and priced at one distance. */
  const plate = (): CameraRig => (game as unknown as { starmapCamera: CameraRig }).starmapCamera;

  /** The command behind an action id, so an intent can be read without pressing anything. */
  const commandFor = (id: string): HudCommand => {
    const action = actions().find((a) => a.id === id);
    expect(action, `"${id}" is not on the row: ${actions().map((a) => a.id).join(", ")}`).toBeDefined();
    return action!.command;
  };

  const enabled = (id: string): boolean => {
    const action = actions().find((a) => a.id === id);
    expect(action, `"${id}" is not on the row: ${actions().map((a) => a.id).join(", ")}`).toBeDefined();
    return action!.enabled;
  };

  /**
   * Fly the approach screen's rig with the arrow keys, and nothing else.
   *
   * `panTo` above walks the BATTLEFIELD's rig; this walks the picker's, which until P7-T03 no key
   * touched at all. Deliberately a separate helper rather than a parameter on `panTo`: the two are
   * different rigs on different screens, and a helper that silently drove whichever one happened to
   * be up is how a test comes to prove nothing.
   */
  const flyApproach = (dx: number, dy: number): void => {
    const rig = approach().rig;
    const to = { x: rig.targetX + dx, y: rig.targetY + dy };
    for (let i = 0; i < 500 && Math.abs(rig.targetX - to.x) > 6; i++) {
      holdFrame(rig.targetX < to.x ? "ArrowRight" : "ArrowLeft");
    }
    for (let i = 0; i < 500 && Math.abs(rig.targetY - to.y) > 6; i++) {
      holdFrame(rig.targetY < to.y ? "ArrowDown" : "ArrowUp");
    }
    expect(Math.hypot(rig.targetX - to.x, rig.targetY - to.y),
      "the arrow keys could not fly the approach screen's own camera").toBeLessThan(10);
  };

  return {
    frame, step, press, holdFrame, panTo, actions, fire, until,
    selection, selectedTypes, units, buildings, myBuilding, cycleTo, foundBase, ghost, mode,
    screen, approach, plate, commandFor, enabled, flyApproach,
  };
}

/**
 * A finished Spaceport on the seat, and the credits to leave through it.
 *
 * `jumpCapital` refuses outright with no pad and no foothold, and `jumpManifestAll` stages every
 * player unit within `JUMP_LOAD_RADIUS` of one — so this is both what makes a destination reachable
 * and what puts a RIDER on the ship, which is the only way the engine records where a jump came
 * down. Placed beside the base, where the opening colony ship already is.
 */
function padAndFuel(game: Game): void {
  const state = game.bridge.state;
  const base = state.map.bases.player;
  const pad = makeBuilding("spaceport", "player", base.x + 70, base.y + 70);
  pad.constructing = false;
  pad.buildProgress = 1;
  state.buildings.set(pad.id, pad);
  game.bridge.galaxy.credits = 20_000;
}

describe("a player can play from a cold start with no mouse at all (P6-T11)", () => {
  let restore: () => void;
  let game: Game;
  let els: ReturnType<typeof elements>;
  let mouse: string[];
  let d: ReturnType<typeof driver>;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    els = elements();
    game = new Game(els, new RecordingRenderer(), "T0",
      { tierOverride: null, edgeScroll: false, newGame: null, motion: "auto" },
      { seed: SEED, worldId: "helix" });
    d = driver(game);

    mouse = [];
    for (const [name, el] of Object.entries(els)) {
      for (const type of MOUSE_EVENTS) {
        el.addEventListener(type, (e) => { mouse.push(`${name}:${e.type}`); }, true);
      }
    }
  });

  afterEach(() => {
    // The claim this whole file rests on, checked rather than promised.
    expect(mouse, `a mouse event reached the interface: ${mouse.join(", ")}`).toEqual([]);
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  /* --- the row's premise, measured ------------------------------------------------------------ */

  it("starts with nothing selected, which is why the keyboard had no way in at all", () => {
    d.frame();
    // Not "the colony ship starts selected and hides the problem" — the opening is worse than the
    // row assumed. Nothing is selected, so `hudModel` offers no Deploy, and the only control on
    // screen belongs to the onboarding card.
    expect(d.selection(), "the opening selects something after all — re-read this row's premise")
      .toEqual([]);
    expect(d.actions().map((a) => a.id), "the opening action row is not what this row measured")
      .toEqual(["dismissOnboarding"]);
    // …and the interface says so itself: the only instruction it can give a new player is a click.
    expect(els.hudRoot.textContent, "the HUD no longer tells the player to click")
      .toMatch(/Click your colony ship/);
  });

  /* --- the whole opening, keyboard only -------------------------------------------------------- */

  it("founds a base, trains a worker, puts a Barracks up and orders a unit — all from keys", () => {
    d.frame();

    // 1. SELECT. The one thing the keyboard could not do: Q takes the next type the player owns,
    //    which at t=0 is the lone colony ship.
    d.press("q");
    expect(d.selection(), "a cycle wrote sim state directly instead of queueing an intent").toEqual([]);
    d.step();
    expect(d.selectedTypes(), "Q did not select the colony ship").toEqual(["colonyship"]);

    // 2. DEPLOY. Z fires the first button on the row, which is Deploy now that something is
    //    selected — the binding that has always been advertised and could not be reached cold.
    expect(d.actions()[0]?.id, "Deploy is not the first control on the row").toBe("deploy");
    d.fire("deploy");
    d.until("the Command Center was founded", () => d.buildings().includes("command"));
    expect(d.selection(), "the colony ship survived its own deployment").toEqual([]);

    // 3. TRAIN. The selection is empty again — the ship became the base — so the keyboard has to
    //    find the base. `train:worker` is the Command Center's own first button.
    d.cycleTo("command");
    const before = d.units().filter((t) => t === "worker").length;
    d.fire("train:worker");
    d.until("a worker came out of the Command Center",
      () => d.units().filter((t) => t === "worker").length > before);

    // 4. BUILD. Q reaches the workers, the positional row offers what they can put up, and the
    //    crosshair — the camera centre — is where it goes.
    d.cycleTo("worker");
    d.fire("build:barracks");
    expect(d.mode(), "the build mode did not arm").toBe("build");
    d.frame();
    d.panTo(game.camera.targetX, game.camera.targetY - 80);
    d.press("k");
    d.until("the Barracks was founded", () => d.buildings().includes("barracks"));

    const barracks = d.myBuilding("barracks")!;
    expect(Math.hypot(barracks.x - game.camera.targetX, barracks.y - game.camera.targetY),
      "the Barracks went somewhere other than the crosshair").toBeLessThan(12);
    expect(d.mode(), "the build mode stayed armed after it was spent").toBe("none");

    // 5. ORDER. One worker, so the destination is the crosshair itself rather than a formation slot
    //    around it, and the engine's own `order` is the witness.
    d.cycleTo("worker");
    d.press("q", { shiftKey: true });
    d.step();
    expect(d.selection().length, "Shift+Q did not narrow to a single unit").toBe(1);
    const mover = game.bridge.state.units.get(d.selection()[0]!)!;
    d.panTo(game.camera.targetX + 140, game.camera.targetY);
    d.press("k");
    d.step();

    const order = mover.order as { type: string; x: number; y: number } | null;
    expect(order?.type, "K with nothing armed did not issue the context order").toBe("move");
    expect(Math.hypot(order!.x - game.camera.targetX, order!.y - game.camera.targetY),
      "the move went somewhere other than the crosshair").toBeLessThan(2);

    // …and the simulation moved, which is the only thing that settles it.
    const was = Math.hypot(mover.x - game.camera.targetX, mover.y - game.camera.targetY);
    for (let i = 0; i < 25; i++) d.step();
    const now = Math.hypot(mover.x - game.camera.targetX, mover.y - game.camera.targetY);
    expect(now, `the worker did not move toward the crosshair (${Math.round(was)} → ${Math.round(now)})`)
      .toBeLessThan(was - 20);
  });

  /* --- Q, in detail ---------------------------------------------------------------------------- */

  it("takes the camera with it, which is the minimap's missing keyboard half", () => {
    // Click-to-jump on the minimap had no keyboard equivalent beyond Home and Space, and a player
    // who cannot travel to a unit cannot watch what they just ordered. The cycle is that equivalent:
    // it lands the camera on the thing it selected, so Q both picks and travels.
    d.foundBase();
    d.cycleTo("worker");
    const worker = game.bridge.state.units.get(d.selection()[0]!)!;
    d.panTo(worker.x + 300, worker.y + 200);
    expect(Math.hypot(game.camera.targetX - worker.x, game.camera.targetY - worker.y),
      "the camera never left, so this proves nothing").toBeGreaterThan(100);

    d.press("q");
    d.step();
    d.press("q");                                  // …and round the lap, back to the workers
    d.step();
    expect(d.selectedTypes().every((t) => t === "worker"), "the lap did not come back round").toBe(true);
    const head = game.bridge.state.units.get(d.selection()[0]!)!;
    expect(game.camera.targetX, "the cycle selected without travelling").toBeCloseTo(head.x, 1);
    expect(game.camera.targetY).toBeCloseTo(head.y, 1);
  });

  it("narrows to one with Shift, and steps through them one at a time", () => {
    d.foundBase();
    d.cycleTo("worker");
    const group = [...d.selection()];
    expect(group.length, "there is only one worker, so stepping proves nothing").toBeGreaterThan(1);

    d.press("q", { shiftKey: true });
    d.step();
    expect(d.selection(), "Shift+Q from a whole group did not narrow to its first member")
      .toEqual([group[0]]);

    const walked = [d.selection()[0]!];
    for (let i = 1; i < group.length; i++) {
      d.press("q", { shiftKey: true });
      d.step();
      expect(d.selection().length, "Shift+Q widened the selection").toBe(1);
      walked.push(d.selection()[0]!);
    }
    expect(walked, "Shift+Q did not walk every member of the type exactly once").toEqual(group);

    d.press("q", { shiftKey: true });
    d.step();
    expect(d.selection(), "the member cycle did not wrap").toEqual([group[0]]);
  });

  it("advances twice on two presses inside one tick, which is what key repeat does", () => {
    // A `select` is an intent and lands on the next tick, so both presses read the same
    // `state.selection`. Without the shell's own cursor the second press repeats the first — and a
    // held key would sit on one type forever.
    //
    // The world at this point owns two types, so ONE press from the Command Center is the workers
    // and TWO is all the way round the lap and back. That is the assertion: not "it moved", but
    // "it moved exactly twice", which a cursor-less shell cannot produce.
    d.foundBase();
    d.cycleTo("command");
    d.press("q");
    d.step();
    expect(d.selectedTypes().every((t) => t === "worker"), "one press is not one step").toBe(true);

    d.cycleTo("command");
    d.press("q");
    d.press("q");                                  // no tick in between, deliberately
    d.step();
    expect(d.selectedTypes().every((t) => t === "command"),
      `two presses in one tick took ${d.selectedTypes().join("+")}, which is one step, not two`)
      .toBe(true);
  });

  it("never cycles onto the enemy, however close they are standing", () => {
    // `idsInBox`'s rule, and `applyGroup`'s: a selection control reaches the player's own things.
    // The enemy has to be inside the player's vision for this to be asked at all — the snapshot is
    // fog-filtered, so an AI unit across the map is not in the table the cycle walks and dropping
    // the owner check would look harmless.
    d.foundBase();
    const base = game.bridge.state.map.bases.player;
    const enemy = makeUnit("skiff", "ai", base.x + 40, base.y + 40);
    game.bridge.state.units.set(enemy.id, enemy);
    d.step();
    const e = game.bridge.snapshot.entities;
    const visible = [...e.ids.slice(0, e.count)];
    expect(visible.length, "the enemy is not in the snapshot, so the owner check is not being asked")
      .toBeGreaterThan([...e.owner.slice(0, e.count)].filter((o) => o === 0).length);

    // Two full laps of both cycles, so a roster that included the enemy could not hide behind one.
    for (let i = 0; i < 8; i++) {
      d.press("q");
      d.step();
      expect(d.selection(), `Q selected the enemy on press ${i + 1}`).not.toContain(enemy.id);
      d.press("q", { shiftKey: true });
      d.step();
      expect(d.selection(), `Shift+Q selected the enemy on press ${i + 1}`).not.toContain(enemy.id);
    }
  });

  it("forgets where it was standing when the seat moves to another world", () => {
    // `adoptSeat` clears the cursor beside `alerts.clear()` and for the same reason: both hold
    // engine ids from the world just left, and the tick stamp belongs to that world's own counter.
    //
    // Called directly rather than by jumping, deliberately: a jump needs a Spaceport, the credits
    // and a destination (`phase4-input.test.ts`'s subject), and what is pinned here is the one line
    // in `adoptSeat`. The press before it and the press after are a real player's, and they sit
    // inside ONE tick — which is exactly when the cursor is the thing being read.
    d.foundBase();
    d.cycleTo("command");
    d.press("q");                                  // asks for the workers; not applied yet
    (game as unknown as { adoptSeat(): void }).adoptSeat();
    d.press("q");                                  // same tick: the cursor would say "next again"
    d.step();
    expect(d.selectedTypes().every((t) => t === "worker"),
      "the cycle carried a cursor across a change of world").toBe(true);
  });

  it("says nothing when there is nothing left to cycle", () => {
    // A player whose last unit has just died still has a keyboard. The roster is empty, there is no
    // type to step to and no position to fly the camera to — so the press is a no-op rather than an
    // exception in the shell's key handler, which would take the whole loop's `keydown` with it.
    d.foundBase();
    d.cycleTo("worker");
    const camera = { x: game.camera.targetX, y: game.camera.targetY };
    for (const u of [...game.bridge.state.units.values()]) {
      if (u.owner === "player") game.bridge.state.units.delete(u.id);
    }
    for (const b of [...game.bridge.state.buildings.values()]) {
      if (b.owner === "player") game.bridge.state.buildings.delete(b.id);
    }
    d.step();
    expect(d.units().length + d.buildings().length, "the world was not actually emptied").toBe(0);
    // What the selection still HOLDS is the engine's business — nothing told it those units died,
    // because they were deleted rather than killed. What matters is that the press changes nothing.
    const held = [...d.selection()];

    expect(() => { d.press("q"); d.press("q", { shiftKey: true }); }, "a cycle with nothing to cycle threw")
      .not.toThrow();
    d.step();
    expect(d.selection(), "an empty roster still produced a selection").toEqual(held);
    expect(game.camera.targetX, "the camera flew to a unit that does not exist").toBe(camera.x);
    expect(game.camera.targetY).toBe(camera.y);
  });

  it("carries on from a selection something else made, not from its own memory", () => {
    // The other half of the cursor, and the bug that made the stamp a TICK rather than the selection
    // it started from: a control-group recall can put the selection back exactly where the cycle had
    // just left it, and a cursor that compared ids would then trust its own stale position.
    //
    // It is also the row's other named gap — control-group *assign* needed a selection a mouse had
    // made, so the digit row was unreachable from a cold start along with everything else.
    d.foundBase();
    d.cycleTo("worker");
    const workers = [...d.selection()];
    d.press("1", { ctrlKey: true });               // assign, from a selection no mouse made
    d.step();

    d.cycleTo("command");
    d.press("1");                                  // recall: back to the workers
    d.step();
    expect(d.selection(), "the control group did not come back").toEqual(workers);

    d.press("q");
    d.step();
    expect(d.selectedTypes().every((t) => t === "command"),
      "the cycle stepped from where it remembered rather than from what the player has").toBe(true);
  });

  /* --- K, in detail ---------------------------------------------------------------------------- */

  it("gathers the deposit under the crosshair, and attacks the enemy under it", () => {
    // The context order's three-way branch, which is what makes one key enough: the same press is a
    // move, a gather or an attack depending on what the camera is centred on — decided by
    // `translatePointer`, exactly as it is for a right click.
    d.foundBase();
    d.cycleTo("worker");
    d.press("q", { shiftKey: true });
    d.step();
    const worker = game.bridge.state.units.get(d.selection()[0]!)!;

    const node = game.bridge.state.map.nodes[0]!;
    d.panTo(node.x, node.y);
    d.press("k");
    d.step();
    const gather = worker.order as { type: string; nodeId?: string } | null;
    expect(gather?.type, "K over a deposit did not order a gather").toBe("gather");
    expect(gather!.nodeId, "the gather named a different deposit").toBe(node.id);

    // The enemy is put where the camera is already pointing, so the claim under test is the
    // targeting and not the panning — which the move order above has already settled.
    d.panTo(worker.x + 120, worker.y + 60);
    const enemy = makeUnit("skiff", "ai", game.camera.targetX, game.camera.targetY);
    game.bridge.state.units.set(enemy.id, enemy);
    d.step();
    expect(Math.hypot(enemy.x - worker.x, enemy.y - worker.y),
      "the enemy is on top of the worker, so 'what is under the crosshair' is not being asked")
      .toBeGreaterThan(50);

    d.press("k");
    d.step();
    const attack = worker.order as { type: string; targetId?: string } | null;
    expect(attack?.type, "K over an enemy did not order an attack").toBe("attack");
    expect(attack!.targetId, "the attack named something else").toBe(enemy.id);
  });

  it("queues the next order behind the last with Shift, as a shift-right-click does", () => {
    d.foundBase();
    d.cycleTo("worker");
    d.press("q", { shiftKey: true });
    d.step();
    const worker = game.bridge.state.units.get(d.selection()[0]!)!;

    d.panTo(worker.x + 150, worker.y);
    d.press("k");
    d.step();
    const first = { ...(worker.order as { type: string; x: number; y: number }) };
    expect(worker.orderQueue ?? [], "the first order was queued rather than taken").toEqual([]);

    d.panTo(game.camera.targetX, game.camera.targetY + 120);
    d.press("k", { shiftKey: true });
    d.step();
    expect((worker.order as { x: number }).x, "the queued order replaced the running one")
      .toBeCloseTo(first.x, 3);
    expect((worker.orderQueue ?? []).length, "Shift+K did not queue behind the running order").toBe(1);
  });

  it("shows the placement ghost at the crosshair when there is no pointer to follow", () => {
    // The preview is P1-T18's whole feature and it followed `pointerX/pointerY`, which are 0,0 until
    // a `pointermove` — so a keyboard player armed a build and was shown the validity, the reach and
    // the Plasma Rig survey of the top-left corner of the viewport. It has to follow the crosshair,
    // because the crosshair is where K will put the building.
    d.foundBase();
    d.cycleTo("worker");
    d.fire("build:barracks");
    d.frame();
    expect(d.ghost(), "no ghost at all with a build armed").not.toBeNull();
    expect(d.ghost()!.x, "the ghost is not at the crosshair").toBeCloseTo(game.camera.targetX, 1);
    expect(d.ghost()!.y).toBeCloseTo(game.camera.targetY, 1);

    // …and it travels with the camera, because that is the only cursor this player has.
    d.panTo(game.camera.targetX + 60, game.camera.targetY - 40);
    expect(d.ghost()!.x, "the ghost did not follow the crosshair").toBeCloseTo(game.camera.targetX, 1);
    expect(d.ghost()!.y).toBeCloseTo(game.camera.targetY, 1);
  });

  it("does not drop the focus ring when the selection rebuilds the row under it", () => {
    // P6-T03's ring walks `Game.actions`, and this row added a key that CHANGES that row: a new
    // selection replaces every button on it. That is precisely the rebuild `HudFocus.sync` exists
    // for, and the two rows have to be checked against each other rather than separately — a
    // keyboard player who pressed Q and was silently returned to the body would have to Tab back
    // through the whole drawer to get anywhere.
    d.foundBase();
    d.cycleTo("command");
    d.press("Tab");
    d.press("Tab");
    const stood = document.activeElement;
    expect(els.hudRoot.contains(stood), "the ring is not holding anything, so this proves nothing")
      .toBe(true);

    d.press("q");                                  // the row is about to be replaced entirely
    d.step();
    expect(els.hudRoot.textContent, "the row did not actually change, so nothing was rebuilt")
      .not.toBe("");
    expect(document.activeElement, "the rebuilt row left the player on a destroyed node")
      .not.toBe(stood);
    expect(els.hudRoot.contains(document.activeElement),
      "changing the selection dropped the keyboard out of the interface").toBe(true);
    expect(els.hudRoot.querySelectorAll(`.${FOCUS_CLASS}`).length,
      "two controls are showing focus at once after the rebuild").toBe(1);
  });

  it("does nothing on a galaxy screen, where there is no crosshair and nothing to travel to", () => {
    // The rule the camera commands already follow: the cycle MOVES the battlefield camera and the
    // crosshair IS it, and neither means anything on a screen that camera is not drawn through.
    d.foundBase();
    d.cycleTo("worker");
    const held = [...d.selection()];
    d.press("y");                                  // the starmap
    d.frame();
    const camera = { x: game.camera.targetX, y: game.camera.targetY };

    d.press("q");
    d.press("k");
    d.step();
    expect(d.selection(), "the cycle ran on the starmap").toEqual(held);
    expect(game.camera.targetX, "the starmap moved the battlefield camera").toBe(camera.x);
    expect(game.camera.targetY).toBe(camera.y);
  });
});

/* =================================================================================================
   THE POINTER IS STILL THE CURSOR WHEN THERE IS ONE

   The one claim this file cannot make with the guard up, and it needs a mouse to make: a player who
   HAS moved the pointer into the window sees the ghost under it, and `K` must then place the
   building THERE rather than at the camera centre. The rule is one sentence — a key acts where the
   interface says it will — and it is what stops the preview and the press ever disagreeing.
   ================================================================================================= */

describe("the crosshair never contradicts the picture (P6-T11)", () => {
  let restore: () => void;
  let game: Game;
  let els: ReturnType<typeof elements>;
  let d: ReturnType<typeof driver>;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    els = elements();
    game = new Game(els, new RecordingRenderer(), "T0",
      { tierOverride: null, edgeScroll: false, newGame: null, motion: "auto" },
      { seed: SEED, worldId: "helix" });
    d = driver(game);
  });

  afterEach(() => {
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  it("places where the ghost is drawn, not where the camera happens to point", () => {
    d.foundBase();
    d.cycleTo("worker");
    d.fire("build:barracks");
    d.frame();
    const atCrosshair = { ...d.ghost()! };
    expect(atCrosshair.x, "the ghost did not start at the crosshair").toBeCloseTo(game.camera.targetX, 1);

    // A pointer arrives, away from the centre of the viewport. jsdom has no `PointerEvent`, and the
    // shell reads only `clientX/clientY/buttons`, which `MouseEvent` carries.
    els.viewport.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, clientX: VIEW_W * 0.42, clientY: VIEW_H * 0.62, buttons: 0,
    }));
    d.frame();
    const atPointer = { ...d.ghost()! };
    expect(Math.hypot(atPointer.x - atCrosshair.x, atPointer.y - atCrosshair.y),
      "the pointer did not move the ghost, so there are not two cases here to tell apart")
      .toBeGreaterThan(20);

    d.press("k");
    d.until("the Barracks was founded", () => d.buildings().includes("barracks"));
    const barracks = d.myBuilding("barracks")!;
    expect(Math.hypot(barracks.x - atPointer.x, barracks.y - atPointer.y),
      "K placed the building somewhere other than the ghost the player was looking at")
      .toBeLessThan(2);
    expect(Math.hypot(barracks.x - game.camera.targetX, barracks.y - game.camera.targetY),
      "the two cases are indistinguishable here, so this test proves nothing").toBeGreaterThan(20);
  });
});

/* =================================================================================================
   THE TWO CONTROLS P6-T11 LEFT WITH A POINTER AND NOTHING ELSE (P7-T03)

   Same guard, same standard. A key that "produced an event" proves nothing here either: zoom is a
   distance that moved and the landing mark is a colony ship standing somewhere it would not
   otherwise be standing.
   ================================================================================================= */

describe("zoom and the landing mark, from the keyboard alone (P7-T03)", () => {
  let restore: () => void;
  let game: Game;
  let els: ReturnType<typeof elements>;
  let mouse: string[];
  let d: ReturnType<typeof driver>;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    els = elements();
    game = new Game(els, new RecordingRenderer(), "T0",
      { tierOverride: null, edgeScroll: false, newGame: null, motion: "auto" },
      { seed: SEED, worldId: "helix" });
    d = driver(game);

    mouse = [];
    for (const [name, el] of Object.entries(els)) {
      for (const type of MOUSE_EVENTS) {
        el.addEventListener(type, (e) => { mouse.push(`${name}:${e.type}`); }, true);
      }
    }
  });

  afterEach(() => {
    expect(mouse, `a mouse event reached the interface: ${mouse.join(", ")}`).toEqual([]);
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  /* --- ZOOM: the wheel was the only one in the app --------------------------------------------- */

  it("moves the camera by exactly the notch the wheel moves", () => {
    // **The notch is measured from `CameraRig` rather than written down here.** The wheel passes
    // `Math.sign(e.deltaY)` and a key press passes ±1 — literally the same argument through the
    // same `zoomBy` — so this ratio is what would change if the keyboard ever grew a feel of its
    // own, and the assertion needs no copy of 1.15 to notice.
    const probe = new CameraRig({ mapWidth: 1000, mapHeight: 1000 });
    const before = probe.distance;
    probe.zoom(1);
    const notch = probe.distance / before;
    expect(notch, "the rig's own zoom moves nothing, so this measures nothing").not.toBe(1);

    d.frame();
    const start = game.camera.distance;
    expect(start, "the camera opens at a stop, so a press could not be seen moving it")
      .toBeGreaterThan(MIN_DISTANCE);

    d.press("-");
    expect(game.camera.distance / start, "one press out is not one wheel notch")
      .toBeCloseTo(notch, 6);
    d.press("+", { shiftKey: true });               // the Shift a player holds to reach the + cap
    expect(game.camera.distance, "in and out do not undo each other").toBeCloseTo(start, 6);

    // …and the same two physical keys, pressed the other way round. `=` is `+` without Shift and
    // `_` is `-` with it; a build that bound only half of each would work for half its players.
    d.press("=");
    expect(game.camera.distance / start, "= is not the unshifted +").toBeCloseTo(1 / notch, 6);
    d.press("_", { shiftKey: true });
    expect(game.camera.distance, "_ is not the shifted -").toBeCloseTo(start, 6);
  });

  it("travels the whole range, which is the view a wheel-less player could not have", () => {
    // Not "it moved" — **it moved everywhere**. A player without a wheel was locked at whatever
    // distance the camera happened to be, and on this rig that is not only a framing: `pitch` is a
    // pure function of `distance` (`input/camera.ts`), so the same control decides the ANGLE the
    // world is read at. Both ends are asserted in pitch as well as in distance, because the pitch
    // ramp is the half of the loss that a distance figure hides.
    d.frame();
    for (let i = 0; i < 40; i++) d.press("-");
    expect(game.camera.distance, "the keys cannot reach the far stop").toBe(MAX_DISTANCE);
    expect(game.camera.pitch, "the overhead angle a battlefield is read from is unreachable")
      .toBeCloseTo(PITCH_FAR, 6);

    for (let i = 0; i < 60; i++) d.press("+", { shiftKey: true });
    expect(game.camera.distance, "the keys cannot reach the near stop").toBe(MIN_DISTANCE);
    expect(game.camera.pitch, "the low angle that shows a mesh is unreachable")
      .toBeCloseTo(PITCH_NEAR, 6);
  });

  it("leaves the plate alone, because a diagram is priced at one distance", () => {
    // ADR-0019 §3's constraint, and the wheel's own rule (`attachListeners` never zoomed the
    // starmap either). The battlefield rig must not move either — a zoom that fell through to the
    // screen behind would be the camera commands' oldest bug in a new place.
    d.frame();
    const battlefield = game.camera.distance;
    d.press("y");
    d.frame();
    expect(d.screen().kind, "the starmap did not open").toBe("starmap");

    for (const k of ["-", "=", "-", "_"]) d.press(k);
    expect(d.plate().distance, "the starmap zoomed").toBe(AUTHORED_VIEW.distance);
    expect(game.camera.distance, "a zoom on the starmap reached the battlefield behind it")
      .toBe(battlefield);
  });

  /* --- THE LANDING MARK: a jump that lands where the player chose ------------------------------ */

  it("marks the landing with the keys, and the colony ship comes down on the mark", () => {
    padAndFuel(game);
    d.step();

    // 1. OPEN THE PICKER. `Y` is the starmap and the destination list is the first thing on its
    //    row, so the positional keys reach it without a pointer anywhere.
    d.press("y");
    d.frame();
    const destAction = d.actions().find((a) => a.id.startsWith("approach:"))!;
    expect(destAction, "the starmap offered no destination at all").toBeDefined();
    d.fire(destAction.id);
    d.frame();
    const destId = destAction.id.slice("approach:".length);
    expect(d.screen().kind, "the positional key did not open the approach view").toBe("approach");

    // 2. THE PREMISE, MEASURED — this is what a keyboard player met before this row. The picker is
    //    open, it is showing the engine's own default, and the confirm is refused because nothing
    //    has been chosen. `pointAt` took screen pixels and there was no key that produced any.
    const view = d.approach();
    expect(view.pick, "something had already marked the landing").toBeNull();
    expect(view.site.source, "the picker did not open on the world's own answer").toBe("anchor");
    expect(d.enabled(`jump:${destId}`), "an unmarked approach offered a jump to confirm").toBe(false);
    expect(els.hudRoot.textContent, "the panel no longer says the landing is unchosen")
      .toMatch(/No landing site chosen/);
    const fallback = { x: view.site.x, y: view.site.y };

    // 3. FLY. The arrow keys drove nothing on this screen at all until P7-T03 — `applyContinuousPan`
    //    ran on the battlefield alone — so this is the binding under test as much as `K` is.
    const opened = { x: view.rig.targetX, y: view.rig.targetY };
    d.flyApproach(170, -20);
    expect(Math.hypot(view.rig.targetX - opened.x, view.rig.targetY - opened.y),
      "the arrow keys did not move the approach screen's camera").toBeGreaterThan(100);

    // 4. MARK. `K` is P6-T11's "here", and here is the middle of this screen.
    d.press("k");
    const pick = view.pick;
    expect(pick, "K marked nothing on the approach screen").not.toBeNull();
    expect(Math.hypot(pick!.x - view.rig.targetX, pick!.y - view.rig.targetY),
      "the mark landed somewhere other than the middle of the screen").toBeLessThan(2);
    const site = view.site;
    expect(site.source, "the engine did not take the mark").toBe("picked");
    expect(site.honoured, "the mark was placed and then overruled").toBe(true);
    expect(Math.hypot(site.x - fallback.x, site.y - fallback.y),
      "the mark is where the jump would have landed anyway, so this proves nothing")
      .toBeGreaterThan(100);

    // 5. THE INTENT CARRIES IT. The RAW point, not the snapped one — `ui/landing-panel.ts`'s rule,
    //    because `snapLandingPoint` is not idempotent at the map edge.
    d.frame();
    const command = d.commandFor(`jump:${destId}`);
    expect(command.kind).toBe("intent");
    const jump = (command as Extract<HudCommand, { kind: "intent" }>).intent as
      { kind: string; destId: string; landingX?: number; landingY?: number };
    expect(jump.kind).toBe("jump");
    expect(jump.landingX, "the jump carried no landing point").toBeCloseTo(pick!.x, 6);
    expect(jump.landingY).toBeCloseTo(pick!.y, 6);
    expect(d.enabled(`jump:${destId}`), "a marked approach still refused to confirm").toBe(true);

    // 6. AND THE GAME AGREES. Not "an intent was produced": the seat moves, and the colony ship
    //    that rode the jump is standing on the mark — inside `jumpCapital`'s own landing ring, and
    //    a long way from the world's anchor, which is where every keyboard jump landed before this.
    d.fire(`jump:${destId}`);
    d.step();
    expect(game.bridge.worldId, "the jump the keyboard confirmed was refused").toBe(destId);
    const rider = [...game.bridge.state.units.values()].find((u) => u.owner === "player");
    expect(rider, "nothing rode the jump, so where it landed cannot be asked").toBeDefined();
    expect(Math.hypot(rider!.x - site.x, rider!.y - site.y),
      "the rider did not come down on the marked site").toBeLessThan(90);
    const anchor = game.bridge.state.map.bases.player;
    expect(Math.hypot(rider!.x - anchor.x, rider!.y - anchor.y),
      "the rider came down on the world's default anchor after all").toBeGreaterThan(150);
  });

  it("never destroys the mark it has, wherever on the world the crosshair is", () => {
    // **A press must never leave the player with no mark at all.** `pointAt` REFUSES a ray that has
    // left the map rather than clamping it, and the crosshair can reach that: at the northern and
    // southern edges the centre ray is the rig's own look-at line, and at yaw 0 it approaches the
    // target from the south — so at the boundary it can cross out of the world before it meets the
    // ground. Refusing is right (clamping would be a second opinion about where the edge is, and
    // `snapLandingPoint` already owns that), and refusing must KEEP what the player chose.
    //
    // Asserted as a property over the whole boundary rather than as a coordinate at one edge,
    // deliberately: whether a given edge refuses or accepts comes down to the sign of a
    // sub-thousandth float against that world's own terrain, and a test that pinned one would be
    // pinning a coin flip. What is worth holding is the invariant — a chosen mark survives every
    // press, everywhere — and it is the same invariant a player would phrase as "pressing K at the
    // top of the map lost my landing site".
    padAndFuel(game);
    d.step();
    d.press("y");
    d.frame();
    d.fire(d.actions().find((a) => a.id.startsWith("approach:"))!.id);
    d.frame();

    const view = d.approach();
    d.flyApproach(170, 0);
    d.press("k");
    expect(view.pick, "nothing was marked, so there is no mark to keep").not.toBeNull();
    expect(view.site.source, "the mark was not taken in the first place").toBe("picked");

    const corners: readonly [string, string][] = [
      ["north", "ArrowUp"], ["west", "ArrowLeft"], ["south", "ArrowDown"], ["east", "ArrowRight"],
    ];
    for (const [edge, key] of corners) {
      for (let i = 0; i < 320; i++) d.holdFrame(key);
      expect(() => d.press("k"), `a crosshair press at the ${edge} edge threw`).not.toThrow();
      expect(view.pick, `a crosshair press at the ${edge} edge threw the mark away`).not.toBeNull();
      expect(view.site.source, `the ${edge} edge left the jump with no chosen site`).toBe("picked");
      d.frame();
      expect(d.enabled(`jump:${d.screen().destId}`),
        `the jump stopped being committable after a press at the ${edge} edge`).toBe(true);
    }
  });

  it("zooms the picker's own rig too, because it is a rig and not a pose", () => {
    // P4-T05 made the approach view a full `CameraRig` precisely so that looking into a valley
    // before committing is the same two controls it is on the battlefield. The wheel already turned
    // it; a keyboard that stopped at the world screen would be the smaller half of one control.
    padAndFuel(game);
    d.step();
    d.press("y");
    d.frame();
    d.fire(d.actions().find((a) => a.id.startsWith("approach:"))!.id);
    d.frame();

    const rig = d.approach().rig;
    expect(rig.distance, "the picker did not open at its far stop").toBe(MAX_DISTANCE);
    d.press("+", { shiftKey: true });
    expect(rig.distance, "the approach screen's camera does not zoom from the keyboard")
      .toBeLessThan(MAX_DISTANCE);
    for (let i = 0; i < 40; i++) d.press("+");
    expect(rig.distance, "the picker cannot be flown in far enough to read a valley")
      .toBe(MIN_DISTANCE);
    d.press("-");
    expect(rig.distance, "the picker zooms one way only").toBeGreaterThan(MIN_DISTANCE);
  });

  it("gives Q nothing to do on a picker, and leaves the battlefield where it was", () => {
    // The rule P6-T11 set and this row narrowed rather than broke: the CYCLE moves the battlefield
    // camera and reads a roster, and a picker has neither. Only the crosshair gained a second
    // meaning, because only the crosshair has one to gain.
    padAndFuel(game);
    d.foundBase();
    d.cycleTo("worker");
    const held = [...d.selection()];
    d.press("y");
    d.frame();
    d.fire(d.actions().find((a) => a.id.startsWith("approach:"))!.id);
    d.frame();
    const battlefield = { x: game.camera.targetX, y: game.camera.targetY };

    d.press("q");
    d.press("q", { shiftKey: true });
    d.step();
    expect(d.selection(), "the cycle ran on the approach screen").toEqual(held);
    expect(game.camera.targetX, "the picker moved the battlefield camera").toBe(battlefield.x);
    expect(game.camera.targetY).toBe(battlefield.y);
    // …and the arrow keys reached the picker rather than the battlefield behind it, which is the
    // other half of the same rule: one screen, one rig.
    d.flyApproach(120, 0);
    expect(game.camera.targetX, "flying the picker panned the battlefield too").toBe(battlefield.x);
    expect(game.camera.targetY).toBe(battlefield.y);
  });
});

/* =================================================================================================
   THE PANEL DECIDES AND THE CONTROL OBEYS (P7-T03)

   `landingZone` ignores `opts.landingPoint` outright whenever a player Spaceport already stands on
   the destination — the jump homes in on the pad. So a keyboard control that shipped a point there
   would be exactly the class of lie P4-T05 built this screen to prevent: an intent carrying a number
   the engine throws away, which a recorded stream replays and a game does not honour.

   `ui/landing-panel.ts` already returns `landingX`/`landingY` as null in that case and `hud.ts`'s
   `approachSection` omits the fields when it does. The claim here is that the keyboard changed
   nothing about who decides — it places a mark, exactly as the pointer does, and the panel keeps the
   last word over both.
   ================================================================================================= */

describe("a keyboard mark on a padded world promises nothing (P7-T03)", () => {
  let restore: () => void;
  let game: Game;
  let els: ReturnType<typeof elements>;
  let mouse: string[];
  let d: ReturnType<typeof driver>;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    els = elements();
    game = new Game(els, new RecordingRenderer(), "T0",
      { tierOverride: null, edgeScroll: false, newGame: null, motion: "auto" },
      { seed: SEED, worldId: "helix" });
    d = driver(game);
    mouse = [];
    for (const [name, el] of Object.entries(els)) {
      for (const type of MOUSE_EVENTS) {
        el.addEventListener(type, (e) => { mouse.push(`${name}:${e.type}`); }, true);
      }
    }
  });

  afterEach(() => {
    expect(mouse, `a mouse event reached the interface: ${mouse.join(", ")}`).toEqual([]);
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  it("marks, is overruled by the pad, and sends a jump with no landing point at all", () => {
    padAndFuel(game);
    d.step();
    d.press("y");
    d.frame();

    // A Spaceport of the player's own, already standing on the destination — the case the engine
    // refuses to honour a pick in. Built on a LIVE background world, so `previewPlanet` returns it
    // as it stands rather than generating a throwaway copy without the pad in it.
    const destAction = d.actions()
      .find((a) => a.id.startsWith("approach:") && game.bridge.galaxy.planets.has(a.id.slice(9)))!;
    expect(destAction, "no destination in this galaxy is live enough to stand a pad on")
      .toBeDefined();
    const destId = destAction.id.slice("approach:".length);
    const dest = game.bridge.galaxy.planets.get(destId)!;
    const theirs = dest.map.bases.player;
    const pad = makeBuilding("spaceport", "player", theirs.x + 200, theirs.y + 120);
    pad.constructing = false;
    pad.buildProgress = 1;
    dest.buildings.set(pad.id, pad);

    d.fire(destAction.id);
    d.frame();
    const view = d.approach();
    expect(view.site.source, "the pad on the destination did not win the landing").toBe("pad");

    // The mark is still PLACED — the control does its job and the screen shows the disagreement —
    // and then the panel overrules it in the player's own words, before the button is pressed.
    d.flyApproach(180, 100);
    d.press("k");
    d.frame();
    expect(view.pick, "the keyboard refused to mark at all, which is not the rule").not.toBeNull();
    expect(view.site.source, "a keyboard mark overrode the pad the engine prefers").toBe("pad");
    expect(view.site.honoured, "the picker claimed a mark that the engine discards").toBe(false);
    expect(els.hudRoot.textContent, "the player is not told their mark will be ignored")
      .toMatch(/Your mark is ignored/);

    // …and the intent carries no landing fields. Not zero, not the pad's coordinates — ABSENT, so
    // the recorded stream says exactly what the engine will do with it.
    const command = d.commandFor(`jump:${destId}`);
    const jump = (command as Extract<HudCommand, { kind: "intent" }>).intent as
      Record<string, unknown>;
    expect(jump.kind).toBe("jump");
    expect("landingX" in jump, "the jump shipped a landing point the engine will throw away")
      .toBe(false);
    expect("landingY" in jump).toBe(false);

    // And the game does what the panel said: the rider comes down at the pad, not at the mark.
    d.fire(`jump:${destId}`);
    d.step();
    expect(game.bridge.worldId, "the jump was refused").toBe(destId);
    const rider = [...game.bridge.state.units.values()].find((u) => u.owner === "player" && u.type === "colonyship");
    expect(rider, "nothing rode the jump").toBeDefined();
    expect(Math.hypot(rider!.x - pad.x, rider!.y - pad.y),
      "the rider did not come down at the Spaceport the panel promised").toBeLessThan(90);
    expect(Math.hypot(rider!.x - view.pick!.x, rider!.y - view.pick!.y),
      "the rider came down on the mark, so the pad case is not being exercised").toBeGreaterThan(100);
  });
});

/* =================================================================================================
   THE POINTER'S HALF OF THE SAME TWO CONTROLS (P7-T03)

   Two claims that need a mouse, so they sit outside the guard.

   **The wheel.** P7-T03 made the keys and the wheel one call (`Game.zoomBy`) rather than two
   matched implementations, which is what lets `keyboard-play`'s "one press is one wheel notch"
   above be a fact about the code. That refactor deserves the check the wheel never had: nothing in
   this repository dispatched a `wheel` event before this row, so the only zoom control the app
   shipped with was also the only one nothing tested.

   **Edge scrolling.** `applyContinuousPan` now takes the rig it flies, and the approach screen asks
   for it with edge scrolling OFF. That is a decision rather than an omission — the picker's pointer
   already marks the landing at every pixel of the window, so an edge that also panned would move
   the mark and the ground under it in one gesture — and a decision nothing holds is a comment.
   ================================================================================================= */

describe("the wheel and the window edge, which are the pointer's half (P7-T03)", () => {
  let restore: () => void;
  let game: Game;
  let els: ReturnType<typeof elements>;
  let d: ReturnType<typeof driver>;

  beforeEach(() => {
    restore = stubCanvas();
    localStorage.clear();
    els = elements();
    game = new Game(els, new RecordingRenderer(), "T0",
      // Edge scrolling ON, which no other test in this file has: it is half of what is under test.
      { tierOverride: null, edgeScroll: true, newGame: null, motion: "auto" },
      { seed: SEED, worldId: "helix" });
    d = driver(game);
  });

  afterEach(() => {
    game.stop();
    document.body.replaceChildren();
    localStorage.clear();
    restore();
  });

  /** One wheel notch, where a browser delivers it. */
  const wheel = (deltaY: number): void => {
    els.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
  };

  /** Open the picker with keys, so the screen under test is reached the way a player reaches it. */
  const openApproach = (): void => {
    padAndFuel(game);
    d.step();
    d.press("y");
    d.frame();
    d.fire(d.actions().find((a) => a.id.startsWith("approach:"))!.id);
    d.frame();
  };

  it("still zooms on the wheel, and by the same notch the key moves", () => {
    d.frame();
    const start = game.camera.distance;
    wheel(120);
    const afterWheel = game.camera.distance;
    expect(afterWheel, "the wheel no longer zooms at all").toBeGreaterThan(start);

    // The two controls are one call now, so this is the assertion that says so: a wheel notch out
    // and a key press out land on the same distance from the same start.
    game.camera.distance = start;
    d.press("-");
    expect(game.camera.distance, "the wheel and the key have drifted into two different steps")
      .toBeCloseTo(afterWheel, 6);

    // …and in, which is the direction a sign error would flip while leaving the step alone.
    game.camera.distance = start;
    wheel(-120);
    const inByWheel = game.camera.distance;
    expect(inByWheel, "the wheel zooms out in both directions").toBeLessThan(start);
    game.camera.distance = start;
    d.press("+", { shiftKey: true });
    expect(game.camera.distance, "the key and the wheel disagree about which way is closer")
      .toBeCloseTo(inByWheel, 6);
  });

  it("sends the wheel to whichever rig is on screen, and never to the plate", () => {
    d.frame();
    const battlefield = game.camera.distance;
    d.press("y");
    d.frame();
    wheel(120);
    wheel(-120);
    expect(d.plate().distance, "the wheel zoomed the starmap").toBe(AUTHORED_VIEW.distance);
    expect(game.camera.distance, "the wheel reached the battlefield behind the starmap")
      .toBe(battlefield);

    d.press("y");                                  // back to the world, then into the picker
    d.frame();
    openApproach();
    const rig = d.approach().rig;
    wheel(-120);
    expect(rig.distance, "the wheel no longer zooms the approach screen").toBeLessThan(MAX_DISTANCE);
    expect(game.camera.distance, "a wheel on the picker reached the battlefield's own rig")
      .toBe(battlefield);
  });

  it("edge-scrolls the battlefield and deliberately not the picker", () => {
    // The battlefield first, so the probe is known to work before it is used to prove an absence.
    d.frame();
    const before = { x: game.camera.targetX, y: game.camera.targetY };
    els.viewport.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, clientX: 4, clientY: VIEW_H / 2, buttons: 0,
    }));
    d.frame();
    expect(game.camera.targetX, "the pointer at the edge did not scroll the battlefield")
      .toBeLessThan(before.x);

    // The same pointer, on the picker. It marks the landing — that is what a pointer does on this
    // screen, at every pixel — and it must not also fly the camera out from under the mark.
    openApproach();
    const rig = d.approach().rig;
    const opened = { x: rig.targetX, y: rig.targetY };
    for (let i = 0; i < 5; i++) {
      els.viewport.dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true, clientX: 4, clientY: VIEW_H / 2, buttons: 0,
      }));
      d.frame();
    }
    expect(d.approach().pick, "the pointer did not mark, so it is not really on this screen")
      .not.toBeNull();
    expect(rig.targetX, "the window edge flew the approach screen's camera").toBe(opened.x);
    expect(rig.targetY).toBe(opened.y);
  });
});
