// Gestures → intents (P1-T11). Pure translation: no DOM, no engine, no side effects.
//
// Every mouse gesture and hotkey in the MVP arrives here as a described event and leaves as at most
// one `Intent`. Keeping it pure is what makes the input layer testable at all — the alternative is
// a browser test per gesture — and it is what guarantees ADR-0008's rule that nothing above the
// bridge writes sim state: this module *cannot*, it has nothing to write to.
//
// The gesture vocabulary is upstream's, letter for letter, because a returning 2D player should not
// have to relearn their hands (persona P1). Left-click selects, left-drag box-selects, double-click
// selects the type on screen, right-click is the context order (move / attack / gather, decided by
// what is under the cursor).
//
// The keys are the ones that surprise people, and they are upstream's for a reason worth writing
// down: **stop is X, not S**, because W/A/S/D pan the camera (PRD §5) and upstream gave the pan
// keys priority. `A` genuinely does double duty there — it pans left AND arms attack-move — and
// that is upstream's own resolution, kept deliberately rather than "fixed" into a third dialect.
// Camera rotation gets `,` and `.` because upstream has already spent Q and E on select-army and
// scout; binding rotation to them now would collide the day Phase 3 adds those orders.

import { type Intent } from "../bridge/commands.js";
import { type Snapshot, FLAG_BUILDING_KIND } from "../bridge/snapshot.js";

export type MouseButton = "left" | "right" | "middle";

export interface PointerGesture {
  readonly type: "click" | "doubleClick" | "boxSelect" | "contextClick";
  readonly button: MouseButton;
  /** Simulation coordinate the gesture resolved to (from `pickGround`). */
  readonly worldX: number;
  readonly worldY: number;
  /** Second corner, for a box select. */
  readonly worldX2?: number;
  readonly worldY2?: number;
  /** Engine id under the cursor, if the entity picker found one. */
  readonly entityId?: string | null;
  /** Resource-node engine id under the cursor, if any. */
  readonly nodeId?: string | null;
  readonly shift: boolean;
  readonly ctrl: boolean;
}

/**
 * A pending mode the next click resolves: attack-move waiting for its target point, or a build
 * placement waiting for its spot. Modal input is how an RTS keeps its hotkey count human.
 */
export type PendingMode =
  | { kind: "none" }
  | { kind: "attackMove" }
  | { kind: "patrol" }
  | { kind: "build"; buildingType: string }
  // Phase 3. A formation move needs a destination and an escort needs a target, so both are modes
  // for the same reason attack-move is: the order is not complete until the next click.
  //
  // The formation's shape rides ON the mode rather than in the caller's state, which is what keeps
  // this module pure. Pressing the key again while the mode is up advances the shape, so cycling and
  // arming are the same gesture and the player sees what they are about to get before committing.
  | { kind: "formation"; shape: string; leaderPos: string }
  | { kind: "escort" };

export interface GestureResult {
  readonly intent: Intent | null;
  /** What the mode should become. The caller owns the mode; this only says what it becomes. */
  readonly mode: PendingMode;
}

const NO_INTENT: GestureResult = { intent: null, mode: { kind: "none" } };

/**
 * Translate one pointer gesture.
 *
 * @param snap  used only to decide *what* is under the cursor — never mutated, never stored.
 */
export function translatePointer(
  gesture: PointerGesture,
  mode: PendingMode,
  snap: Snapshot,
): GestureResult {
  if (gesture.button === "left") {
    // A pending mode consumes the next left click. Modal state is the one place an RTS is allowed
    // to surprise the player, so it always resolves on the very next click and never persists.
    switch (mode.kind) {
      case "attackMove":
        return { intent: { kind: "attackMove", x: gesture.worldX, y: gesture.worldY, queue: gesture.shift }, mode: { kind: "none" } };
      case "patrol":
        return { intent: { kind: "patrol", x: gesture.worldX, y: gesture.worldY }, mode: { kind: "none" } };
      case "build":
        return {
          intent: { kind: "build", buildingType: mode.buildingType, x: gesture.worldX, y: gesture.worldY },
          // Shift keeps the build mode alive so a player can lay a turret line without re-clicking
          // the button five times — the one place upstream's own UI is sticky, and it matters.
          mode: gesture.shift ? mode : { kind: "none" },
        };
      case "formation":
        return {
          intent: {
            kind: "moveInFormation", x: gesture.worldX, y: gesture.worldY,
            shape: mode.shape, leaderPos: mode.leaderPos, queue: gesture.shift,
          },
          mode: { kind: "none" },
        };
      case "escort":
        // An escort needs a SHIP, not a point. Clicking empty ground cancels rather than issuing
        // anything: the alternative is a silently swallowed click, and the player would try again.
        return gesture.entityId
          ? { intent: { kind: "escort", targetId: gesture.entityId, queue: gesture.shift }, mode: { kind: "none" } }
          : NO_INTENT;
      case "none":
        break;
    }

    switch (gesture.type) {
      case "click":
        return {
          intent: { kind: "select", ids: gesture.entityId ? [gesture.entityId] : [], additive: gesture.shift },
          mode: { kind: "none" },
        };
      case "doubleClick": {
        // Select every visible entity of the clicked type. "On screen" is the snapshot, which is
        // already fog-filtered, so this can never select something the player cannot see.
        if (!gesture.entityId) return NO_INTENT;
        const ids = sameTypeAs(snap, gesture.entityId);
        return { intent: { kind: "select", ids, additive: gesture.shift }, mode: { kind: "none" } };
      }
      case "boxSelect": {
        const ids = idsInBox(snap, gesture.worldX, gesture.worldY, gesture.worldX2 ?? gesture.worldX, gesture.worldY2 ?? gesture.worldY);
        return { intent: { kind: "select", ids, additive: gesture.shift }, mode: { kind: "none" } };
      }
      case "contextClick":
        break;
    }
    return NO_INTENT;
  }

  if (gesture.button === "right") {
    // Right-click cancels a pending mode rather than issuing an order — the universal "no, not
    // that" that stops a mis-clicked build mode becoming a mis-placed building.
    if (mode.kind !== "none") return NO_INTENT;
    if (gesture.entityId && isEnemy(snap, gesture.entityId)) {
      return { intent: { kind: "attack", targetId: gesture.entityId, queue: gesture.shift }, mode: { kind: "none" } };
    }
    if (gesture.nodeId) {
      return { intent: { kind: "gather", nodeId: gesture.nodeId, queue: gesture.shift }, mode: { kind: "none" } };
    }
    return { intent: { kind: "move", x: gesture.worldX, y: gesture.worldY, queue: gesture.shift }, mode: { kind: "none" } };
  }

  return NO_INTENT;
}

export interface KeyGesture {
  readonly key: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
}

export interface KeyResult {
  readonly intent: Intent | null;
  readonly mode: PendingMode | null;
  /** Camera actions the caller performs; the camera is not sim state, so it is not an intent. */
  readonly camera: "focusBase" | "rotateLeft" | "rotateRight" | null;
  readonly cancel: boolean;
  /** Flip the power-grid overlay. A view concern, so it is not an intent (nothing in the sim moves). */
  readonly togglePower?: boolean;
  /**
   * A control-group press (P3-T13), for the caller to resolve against its own `ControlGroups`.
   *
   * NOT an intent, and that is the whole point of the task: a control group is client state, and
   * `state.selection` is sim state that `hashState` hashes. A recall becomes an ordinary `select`
   * intent up in the caller, where the group and the snapshot both live. This module has neither
   * and must not grow either.
   */
  readonly group?: { readonly n: number; readonly op: "assign" | "append" | "recall" };
  /**
   * A Helium Bomb command (P3-T10) for the caller to aim at the selection.
   *
   * Same shape of problem as `group`: `armBomb`/`detonate` address ONE unit by id, deliberately —
   * "arm everything selected" is not a thing anyone should be able to do to a doomsday device by
   * accident — and this module cannot see the selection. So the caller resolves it.
   */
  readonly bomb?: "toggleArm" | "detonate";
}

const NO_KEY: KeyResult = { intent: null, mode: null, camera: null, cancel: false };

/**
 * Hotkeys. Upstream's letters, so muscle memory carries over (persona P1).
 *
 * `mode` is passed in because Phase 3's formation key CYCLES: pressing it again while the mode is up
 * advances the shape rather than re-arming the same one. The parameter is optional so every existing
 * call site keeps working, and the function stays pure — it reads the mode, it does not own it.
 *
 * **The free letters are scarcer than they look**, which is what decided these bindings. W/A/S/D pan
 * (PRD §5), upstream spends Q and E on select-army and scout, and Z/C/V/B/N are upstream's
 * POSITIONAL action keys — they fire the Nth button the HUD is showing, so binding a fixed order to
 * one would break that rule the moment the HUD has buttons. That leaves F, T and P, which is why a
 * doomsday device ended up on O rather than on B for "bomb".
 */
export function translateKey(gesture: KeyGesture, mode: PendingMode = { kind: "none" }): KeyResult {
  // Control groups: the digit row, as every RTS since the nineties. Ctrl assigns, Shift appends, a
  // bare press recalls. Checked before the letter switch because a digit is never a letter.
  const digit = /^[0-9]$/.test(gesture.key) ? Number(gesture.key) : -1;
  if (digit >= 0) {
    const op = gesture.ctrl ? "assign" : gesture.shift ? "append" : "recall";
    return { ...NO_KEY, group: { n: digit, op } };
  }

  switch (gesture.key.toLowerCase()) {
    case "a": return { intent: null, mode: { kind: "attackMove" }, camera: null, cancel: false };
    case "r": return { intent: null, mode: { kind: "patrol" }, camera: null, cancel: false };
    case "x": return { intent: { kind: "stop" }, mode: { kind: "none" }, camera: null, cancel: false };
    case "h": return { intent: { kind: "hold" }, mode: { kind: "none" }, camera: null, cancel: false };
    // Z is upstream's first POSITIONAL action key (Z/C/V/B/N fire the Nth button the HUD is
    // showing). Deploy is the only action button a selected colony ship has, so Z lands on it by
    // the same rule a returning player already has in their fingers.
    case "z": return { intent: { kind: "deploy" }, mode: { kind: "none" }, camera: null, cancel: false };
    // The power grid overlay. `G` for grid — upstream has not spent it, and the alternatives
    // (`P` for power) collide with nothing today but read as "pause" to anyone coming from another
    // RTS. It is a toggle rather than a mode because the grid answers "where can I build this
    // efficiently?", which a player asks while doing something else.
    case "g": return { ...NO_KEY, togglePower: true };
    // --- Phase 3 ------------------------------------------------------------------------------
    // F arms a formation move and cycles its shape on repeat. The shape lives in the mode, so the
    // player can see what they are arming before they commit the click (see `PendingMode`).
    case "f": return {
      intent: null,
      mode: { kind: "formation", shape: nextShape(mode), leaderPos: DEFAULT_LEADER_POS },
      camera: null, cancel: false,
    };
    // T holds the formation where the group already stands — no click, because there is no
    // destination. It reuses whatever shape F last armed, so the two keys are one control.
    case "t": return {
      intent: {
        kind: "holdFormation",
        shape: mode.kind === "formation" ? mode.shape : FORMATION_KEY_SHAPES[0]!,
        leaderPos: DEFAULT_LEADER_POS,
      },
      mode: { kind: "none" }, camera: null, cancel: false,
    };
    // P for protect. Not G (the power grid), not E (upstream's scout), not C or V (positional).
    case "p": return { intent: null, mode: { kind: "escort" }, camera: null, cancel: false };
    // The Helium Bomb. O rather than B because B is one of upstream's positional action keys.
    // Arming and detonating are separate presses on purpose — `applyIntent` refuses to detonate an
    // unarmed bomb, so those two presses ARE the confirmation dialog this build does not have.
    case "o": return { ...NO_KEY, bomb: gesture.shift ? "detonate" : "toggleArm" };
    case "escape": return { intent: null, mode: { kind: "none" }, camera: null, cancel: true };
    case " ": case "home": return { ...NO_KEY, camera: "focusBase" };
    case ",": return { ...NO_KEY, camera: "rotateLeft" };
    case ".": return { ...NO_KEY, camera: "rotateRight" };
    default: return NO_KEY;
  }
}

/**
 * The shapes F cycles through, and the leader position it uses.
 *
 * **A copy of the engine's `FORMATION_SHAPES`, and it must not drift** — `applyIntent` validates
 * against the engine's own list and returns "Unknown formation …" for anything else, so a shape
 * added here that the engine does not know is a key press that is silently refused. It is copied
 * rather than imported because `input/` may not import the engine (ADR-0008), and
 * `test/input/phase3-input.test.ts` asserts the two lists are equal so the copy cannot rot.
 */
export const FORMATION_KEY_SHAPES: readonly string[] = ["grid", "line", "wedge", "circle"];
/** `front` because a formation move is an advance; the leader arrives first, which is legible. */
export const DEFAULT_LEADER_POS = "front";

function nextShape(mode: PendingMode): string {
  if (mode.kind !== "formation") return FORMATION_KEY_SHAPES[0]!;
  const i = FORMATION_KEY_SHAPES.indexOf(mode.shape);
  return FORMATION_KEY_SHAPES[(i + 1) % FORMATION_KEY_SHAPES.length]!;
}

/** Entity ids inside a world-space rectangle, player-owned only — box-select never grabs the enemy. */
export function idsInBox(snap: Snapshot, x0: number, y0: number, x1: number, y1: number): string[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const out: string[] = [];
  const e = snap.entities;
  for (let i = 0; i < e.count; i++) {
    if (e.owner[i] !== 0) continue;
    // Buildings are excluded: dragging a box across your base to grab an army and getting the
    // Command Center too is the single most-complained-about selection bug in the genre.
    if ((e.flags[i]! & FLAG_BUILDING_KIND) !== 0) continue;
    const x = e.x[i]!;
    const y = e.y[i]!;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    out.push(engineId(e.ids[i]!));
  }
  return out;
}

function sameTypeAs(snap: Snapshot, entityId: string): string[] {
  const e = snap.entities;
  const numeric = toNumeric(entityId);
  let typeIndex = -1;
  for (let i = 0; i < e.count; i++) if (e.ids[i] === numeric) { typeIndex = e.typeIndex[i]!; break; }
  if (typeIndex < 0) return [entityId];
  const out: string[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.owner[i] !== 0 || e.typeIndex[i] !== typeIndex) continue;
    out.push(engineId(e.ids[i]!));
  }
  return out;
}

function isEnemy(snap: Snapshot, entityId: string): boolean {
  const numeric = toNumeric(entityId);
  const e = snap.entities;
  for (let i = 0; i < e.count; i++) if (e.ids[i] === numeric) return e.owner[i] === 1;
  return false;
}

function toNumeric(id: string): number {
  const n = Number.parseInt(id.slice(1), 10);
  return id.charCodeAt(0) === 98 ? -(n + 1) : n + 1;
}

function engineId(numeric: number): string {
  return numeric < 0 ? `b${-numeric - 1}` : `u${numeric - 1}`;
}
