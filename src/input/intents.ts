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
  | { kind: "build"; buildingType: string };

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
}

const NO_KEY: KeyResult = { intent: null, mode: null, camera: null, cancel: false };

/** Hotkeys. Upstream's letters, so muscle memory carries over (persona P1). */
export function translateKey(gesture: KeyGesture): KeyResult {
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
    case "escape": return { intent: null, mode: { kind: "none" }, camera: null, cancel: true };
    case " ": case "home": return { ...NO_KEY, camera: "focusBase" };
    case ",": return { ...NO_KEY, camera: "rotateLeft" };
    case ".": return { ...NO_KEY, camera: "rotateRight" };
    default: return NO_KEY;
  }
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
