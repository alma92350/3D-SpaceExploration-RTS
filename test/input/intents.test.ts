// P1-T11 — every MVP gesture produces exactly one intent with the right payload, and no intent
// writes sim state directly (ADR-0008 §3).

import { describe, expect, it } from "vitest";
import { type PendingMode, idsInBox, translateKey, translatePointer } from "../../src/input/intents.js";
import { SnapshotExtractor, numericId } from "../../src/bridge/snapshot.js";
import { activeState, createGalaxy, makeUnit } from "../../src/engine/index.js";
import { MVP_WORLD } from "../../src/bridge/world.js";

const SEED = 20260814;
const NONE: PendingMode = { kind: "none" };

function fixture() {
  const state = activeState(createGalaxy({ seed: SEED, startId: MVP_WORLD }));
  const base = state.map.bases.player;
  // Placed just off the base, close enough to sit inside the colony ship's own vision (the
  // snapshot is fog-filtered, so a unit out of sight is not in it at all) but far enough that a
  // box drawn around them does not also catch the ship. The Odyssey opening seeds a COLONY SHIP
  // at the base, not a worker — engine/state.js seedPlayer.
  const origin = { x: base.x + 60, y: base.y };
  const mine = makeUnit("skiff", "player", origin.x, origin.y);
  const mine2 = makeUnit("skiff", "player", origin.x + 10, origin.y);
  const other = makeUnit("lancer", "player", origin.x + 20, origin.y);
  const enemy = makeUnit("bastion", "ai", origin.x + 15, origin.y);   // inside the box AND the player's vision
  for (const u of [mine, mine2, other, enemy]) state.units.set(u.id, u);
  const snap = new SnapshotExtractor(state.map).extract(state, {
    viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0,
  });
  return { state, snap, base: origin, mine, mine2, other, enemy };
}

describe("pointer gestures", () => {
  it("left-click selects what is under the cursor", () => {
    const { snap, mine } = fixture();
    const { intent } = translatePointer({
      type: "click", button: "left", worldX: 0, worldY: 0, entityId: mine.id, shift: false, ctrl: false,
    }, NONE, snap);
    expect(intent).toEqual({ kind: "select", ids: [mine.id], additive: false });
  });

  it("left-click on empty ground clears the selection", () => {
    const { snap } = fixture();
    const { intent } = translatePointer({
      type: "click", button: "left", worldX: 10, worldY: 10, entityId: null, shift: false, ctrl: false,
    }, NONE, snap);
    expect(intent).toEqual({ kind: "select", ids: [], additive: false });
  });

  it("shift makes selection additive", () => {
    const { snap, mine } = fixture();
    const { intent } = translatePointer({
      type: "click", button: "left", worldX: 0, worldY: 0, entityId: mine.id, shift: true, ctrl: false,
    }, NONE, snap);
    expect(intent).toMatchObject({ additive: true });
  });

  it("double-click selects every visible unit of that type, and only the player's", () => {
    const { snap, mine, mine2, other } = fixture();
    const { intent } = translatePointer({
      type: "doubleClick", button: "left", worldX: 0, worldY: 0, entityId: mine.id, shift: false, ctrl: false,
    }, NONE, snap);
    expect(intent).toMatchObject({ kind: "select" });
    const ids = (intent as { ids: string[] }).ids;
    expect(new Set(ids)).toEqual(new Set([mine.id, mine2.id]));
    expect(ids).not.toContain(other.id);
  });

  it("right-click on empty ground is a move", () => {
    const { snap } = fixture();
    const { intent } = translatePointer({
      type: "contextClick", button: "right", worldX: 400, worldY: 250, entityId: null, nodeId: null, shift: false, ctrl: false,
    }, NONE, snap);
    expect(intent).toEqual({ kind: "move", x: 400, y: 250, queue: false });
  });

  it("right-click on an enemy is an attack, on a friendly is still a move", () => {
    const { snap, enemy, mine } = fixture();
    const attack = translatePointer({
      type: "contextClick", button: "right", worldX: 1, worldY: 1, entityId: enemy.id, nodeId: null, shift: false, ctrl: false,
    }, NONE, snap).intent;
    expect(attack).toEqual({ kind: "attack", targetId: enemy.id, queue: false });

    const move = translatePointer({
      type: "contextClick", button: "right", worldX: 1, worldY: 1, entityId: mine.id, nodeId: null, shift: false, ctrl: false,
    }, NONE, snap).intent;
    expect(move).toMatchObject({ kind: "move" });
  });

  it("right-click on a resource node is a gather order", () => {
    const { snap, state } = fixture();
    const node = state.map.nodes[0]!;
    const { intent } = translatePointer({
      type: "contextClick", button: "right", worldX: node.x, worldY: node.y, entityId: null, nodeId: node.id, shift: false, ctrl: false,
    }, NONE, snap);
    expect(intent).toEqual({ kind: "gather", nodeId: node.id, queue: false });
  });

  it("shift queues an order rather than replacing it", () => {
    const { snap } = fixture();
    const { intent } = translatePointer({
      type: "contextClick", button: "right", worldX: 5, worldY: 5, entityId: null, nodeId: null, shift: true, ctrl: false,
    }, NONE, snap);
    expect(intent).toMatchObject({ queue: true });
  });
});

describe("modal input", () => {
  it("attack-move mode turns the next left click into an attack-move, then clears", () => {
    const { snap } = fixture();
    const result = translatePointer({
      type: "click", button: "left", worldX: 700, worldY: 300, shift: false, ctrl: false,
    }, { kind: "attackMove" }, snap);
    expect(result.intent).toEqual({ kind: "attackMove", x: 700, y: 300, queue: false });
    expect(result.mode).toEqual(NONE);
  });

  it("build mode places a structure and clears — unless shift keeps it open", () => {
    const { snap } = fixture();
    const once = translatePointer({
      type: "click", button: "left", worldX: 100, worldY: 100, shift: false, ctrl: false,
    }, { kind: "build", buildingType: "turret" }, snap);
    expect(once.intent).toEqual({ kind: "build", buildingType: "turret", x: 100, y: 100 });
    expect(once.mode).toEqual(NONE);

    const sticky = translatePointer({
      type: "click", button: "left", worldX: 100, worldY: 100, shift: true, ctrl: false,
    }, { kind: "build", buildingType: "turret" }, snap);
    expect(sticky.mode, "shift should keep build mode open for a turret line")
      .toEqual({ kind: "build", buildingType: "turret" });
  });

  it("right-click cancels a pending mode instead of issuing an order", () => {
    const { snap } = fixture();
    const result = translatePointer({
      type: "contextClick", button: "right", worldX: 100, worldY: 100, shift: false, ctrl: false,
    }, { kind: "build", buildingType: "barracks" }, snap);
    expect(result.intent, "a right-click during build mode must not also move the army").toBeNull();
  });
});

describe("box select", () => {
  it("takes the player's units inside the rectangle and nothing else", () => {
    const { snap, base, mine, mine2, other, enemy } = fixture();
    const ids = idsInBox(snap, base.x - 5, base.y - 50, base.x + 25, base.y + 50);
    expect(new Set(ids)).toEqual(new Set([mine.id, mine2.id, other.id]));
    expect(ids, "a box select must never take the enemy's units").not.toContain(enemy.id);
  });

  it("never grabs buildings", () => {
    // Dragging a box across your own base and selecting the Command Center along with the army is
    // the most-complained-about selection bug in the genre. It is excluded on purpose.
    const { snap, state } = fixture();
    const ids = idsInBox(snap, 0, 0, state.map.width, state.map.height);
    const buildingIds = [...state.buildings.values()].map((b) => b.id);
    for (const id of buildingIds) expect(ids).not.toContain(id);
  });

  it("works with the corners dragged in any direction", () => {
    const { snap, base } = fixture();
    const forward = idsInBox(snap, base.x - 5, base.y - 50, base.x + 25, base.y + 50);
    const backward = idsInBox(snap, base.x + 25, base.y + 50, base.x - 5, base.y - 50);
    expect(new Set(backward)).toEqual(new Set(forward));
  });

  it("only reports entities that are in the snapshot, so fog cannot leak through it", () => {
    const { snap, state } = fixture();
    const ids = idsInBox(snap, 0, 0, state.map.width, state.map.height);
    const visible = new Set<number>();
    for (let i = 0; i < snap.entities.count; i++) visible.add(snap.entities.ids[i]!);
    for (const id of ids) expect(visible.has(numericId(id))).toBe(true);
  });
});

describe("hotkeys", () => {
  it("uses upstream's own letters, so a returning player's hands still work", () => {
    expect(translateKey({ key: "x", shift: false, ctrl: false }).intent).toEqual({ kind: "stop" });
    expect(translateKey({ key: "h", shift: false, ctrl: false }).intent).toEqual({ kind: "hold" });
    expect(translateKey({ key: "a", shift: false, ctrl: false }).mode).toEqual({ kind: "attackMove" });
    expect(translateKey({ key: "r", shift: false, ctrl: false }).mode).toEqual({ kind: "patrol" });
    expect(translateKey({ key: "z", shift: false, ctrl: false }).intent).toEqual({ kind: "deploy" });
  });

  it("leaves W/A/S/D free enough for the camera to keep panning (PRD §5)", () => {
    // S and D must NOT be orders: they pan. A double-books deliberately — see the module comment.
    expect(translateKey({ key: "s", shift: false, ctrl: false }).intent).toBeNull();
    expect(translateKey({ key: "d", shift: false, ctrl: false }).intent).toBeNull();
    expect(translateKey({ key: "w", shift: false, ctrl: false }).intent).toBeNull();
  });

  it("is case-insensitive, so caps lock does not disarm the army", () => {
    expect(translateKey({ key: "X", shift: true, ctrl: false }).intent).toEqual({ kind: "stop" });
  });

  it("escape cancels any pending mode", () => {
    const result = translateKey({ key: "Escape", shift: false, ctrl: false });
    expect(result.mode).toEqual(NONE);
    expect(result.cancel).toBe(true);
  });

  it("routes camera keys as camera actions, not as intents", () => {
    // The camera is not simulation state, so moving it must never enter the command stream — or a
    // determinism replay would depend on where someone was looking.
    for (const key of [",", ".", " ", "Home"]) {
      const result = translateKey({ key, shift: false, ctrl: false });
      expect(result.intent, `${key} produced a sim intent`).toBeNull();
      expect(result.camera).not.toBeNull();
    }
  });

  it("ignores keys it does not own", () => {
    const result = translateKey({ key: "j", shift: false, ctrl: false });
    expect(result).toEqual({ intent: null, mode: null, camera: null, cancel: false });
  });
});
