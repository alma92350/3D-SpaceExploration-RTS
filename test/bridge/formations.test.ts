// P3-T11, P3-T12, P3-T13 — formations, escorts and control groups.
//
// The first two are WIRING, not invention: `issueEscort` and `issueHoldFormation` have existed
// upstream since before this project started, `issueMove` has taken a formation argument the whole
// time, and the bridge simply never passed one. So the tests here are about the bridge asking the
// engine rather than deciding anything — the slots asserted are `formationSlots`' own.
//
// Control groups are the opposite: they exist nowhere, and the whole task is a constraint.
// `state.selection` IS simulation state — it lives on `State` and `applyIntent` reads it to decide
// who every order applies to — so a control group stored there would be a local, per-player
// convenience deciding what the simulation does. The last describe is that rule, asserted.
//
// **Correction (P3-T17): `hashState` does NOT hash the selection**, and an earlier version of this
// comment said it did. So the determinism fixture would not catch a control group written into
// `state.selection` — the rule stands on its own and never rested on the hash.

import { describe, expect, it } from "vitest";
import { ControlGroups, GROUP_COUNT } from "../../src/input/control-groups.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  FORMATION_SHAPES, LEADER_POSITIONS, formationSlots, makeBuilding, makeUnit,
} from "../../src/engine/index.js";

const SEED = 20260814;

function squad(n = 6) {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  const units = [];
  for (let i = 0; i < n; i++) {
    const u = makeUnit("skiff", "player", base.x + 40 + (i % 3) * 10, base.y + Math.floor(i / 3) * 10);
    bridge.state.units.set(u.id, u);
    units.push(u);
  }
  bridge.step(STEP_SECONDS);
  bridge.enqueue({ kind: "select", ids: units.map((u) => u.id), additive: false });
  bridge.step(STEP_SECONDS);
  return { bridge, base, units };
}

describe("formations (P3-T11)", () => {
  it("offers exactly the shapes and leader positions the engine defines", () => {
    // Not a copy: a UI listing a shape the engine does not know would offer a button that is
    // silently refused, and one missing a shape hides a feature that is already built.
    expect(FORMATION_SHAPES.length).toBeGreaterThan(1);
    expect([...FORMATION_SHAPES]).toEqual(["grid", "line", "wedge", "circle"]);
    expect([...LEADER_POSITIONS]).toEqual(["front", "back", "center"]);
  });

  it("refuses a shape the engine has never heard of, instead of silently ignoring it", () => {
    const { bridge } = squad();
    const err = bridge.apply({ kind: "moveInFormation", x: 100, y: 100, shape: "phalanx", leaderPos: "front", queue: false });
    expect(err).toMatch(/Unknown formation/);
    const err2 = bridge.apply({ kind: "holdFormation", shape: "grid", leaderPos: "sideways" });
    expect(err2).toMatch(/Unknown leader position/);
  });

  it("moves the leader and has everyone else keep station on it", () => {
    // The first draft of this test asserted that every unit got a `move` order to its own slot, and
    // that is NOT what the engine does for a player selection. `dispatchFormation` gives the leader
    // one move order and every follower a `follow-leader` order carrying an offset relative to the
    // leader's slot — a squad that keeps its shape against the leader's LIVE position, rather than
    // six independent moves that would drift apart the moment anything blocked one of them.
    //
    // (The AI and owner-less units take the other branch and do get one order each. That path is
    // deliberate too, and it is why the leader/follower mechanic is described upstream as a
    // selection-UX feature.)
    const { bridge, base } = squad();
    const dest = { x: base.x + 300, y: base.y + 120 };
    bridge.apply({ kind: "moveInFormation", x: dest.x, y: dest.y, shape: "wedge", leaderPos: "front", queue: false });

    const skiffs = [...bridge.state.units.values()].filter((u) => u.type === "skiff");
    const leaders = skiffs.filter((u) => u.order?.type === "move");
    const followers = skiffs.filter((u) => u.order?.type === "follow-leader");

    expect(leaders.length, "a formation should have exactly one leader under way").toBe(1);
    expect(followers.length, "the rest of the squad should be keeping station").toBe(skiffs.length - 1);

    // The offsets are what make it a formation rather than a blob: distinct, and non-zero.
    const offsets = followers.map((u) => {
      const o = u.order as { offsetX?: number; offsetY?: number };
      return `${Math.round(o.offsetX ?? 0)},${Math.round(o.offsetY ?? 0)}`;
    });
    expect(new Set(offsets).size, "two followers were given the same station").toBe(offsets.length);
    expect(offsets.some((o) => o !== "0,0"), "every offset was zero — the squad would stack up").toBe(true);
  });

  it("puts the leader on a slot rather than exactly on the click", () => {
    // A formation move aims the SHAPE at the destination; the leader lands on the shape's leader
    // slot, which for anything but a single unit is not the click point itself. If the bridge
    // dropped the formation argument the leader would go exactly where the mouse was — which is
    // what the MVP did, and would look almost right.
    const { bridge, base } = squad();
    const dest = { x: base.x + 300, y: base.y + 120 };
    bridge.apply({ kind: "moveInFormation", x: dest.x, y: dest.y, shape: "line", leaderPos: "back", queue: false });
    const leader = [...bridge.state.units.values()].find((u) => u.order?.type === "move")!;
    const off = Math.hypot((leader.order!.x ?? 0) - dest.x, (leader.order!.y ?? 0) - dest.y);
    expect(off, "the leader was sent to the raw click point — no formation was applied")
      .toBeGreaterThan(0.5);
  });

  it("gives a different arrangement for a different shape", () => {
    // Guards against the shape being accepted, validated and then dropped on the floor.
    const { bridge, base } = squad();
    const units = [...bridge.state.units.values()].filter((u) => u.type === "skiff");
    const line = formationSlots(units, base.x + 300, base.y, { shape: "line", leaderPos: "front" });
    const circle = formationSlots(units, base.x + 300, base.y, { shape: "circle", leaderPos: "front" });
    const same = line.every((p, i) => Math.abs(p.x - circle[i]!.x) < 1e-6 && Math.abs(p.y - circle[i]!.y) < 1e-6);
    expect(same, "line and circle produced identical slots").toBe(false);
  });

  it("holds a formation where the group already stands", () => {
    const { bridge } = squad();
    const err = bridge.apply({ kind: "holdFormation", shape: "grid", leaderPos: "center" });
    expect(err).toBeNull();
    const units = [...bridge.state.units.values()].filter((u) => u.type === "skiff");
    const orders = units.map((u) => u.order?.type);
    expect(orders.some((o) => o === "hold-formation"), "no unit took the leader's anchor").toBe(true);
    expect(orders.every((o) => o === "hold-formation" || o === "follow-leader"),
      `formation orders were ${[...new Set(orders)].join(", ")}`).toBe(true);
  });
});

describe("escorts (P3-T12)", () => {
  it("puts every escort on a ring slot around the target, and never the target itself", () => {
    const { bridge } = squad();
    const guarded = [...bridge.state.units.values()].find((u) => u.type === "skiff")!;
    const err = bridge.apply({ kind: "escort", targetId: guarded.id, queue: false });
    expect(err).toBeNull();

    const escorts = [...bridge.state.units.values()].filter((u) => u.order?.type === "escort");
    expect(escorts.length, "nobody took an escort order").toBeGreaterThan(0);
    expect(
      escorts.some((u) => u.id === guarded.id),
      "the guarded ship was ordered to escort itself — the engine says the caller must filter it",
    ).toBe(false);

    // Slots are fixed at issue time so the ring is deterministic; two units must not share one.
    const slots = escorts.map((u) => (u.order as { slot?: number }).slot);
    expect(new Set(slots).size, "two escorts were given the same ring slot").toBe(slots.length);
    for (const u of escorts) {
      expect((u.order as { targetId?: string }).targetId).toBe(guarded.id);
    }
  });

  it("does nothing when the target died between the click and the tick", () => {
    const { bridge } = squad();
    expect(bridge.apply({ kind: "escort", targetId: "u9999", queue: false })).toBeNull();
    const escorts = [...bridge.state.units.values()].filter((u) => u.order?.type === "escort");
    expect(escorts.length).toBe(0);
  });

  it("keeps the escort order after the target stops moving", () => {
    // The property that makes an escort look like a stuck move order: it is a persistent follow,
    // never cleared on arrival. Worth pinning, because "the order is still there" is what a player
    // is relying on when they walk away from the screen.
    const { bridge } = squad();
    const guarded = [...bridge.state.units.values()].find((u) => u.type === "skiff")!;
    bridge.apply({ kind: "escort", targetId: guarded.id, queue: false });
    for (let t = 0; t < 40; t++) bridge.step(STEP_SECONDS);
    const stillEscorting = [...bridge.state.units.values()].filter((u) => u.order?.type === "escort");
    expect(stillEscorting.length, "the escort order cleared once the units arrived").toBeGreaterThan(0);
  });
});

describe("control groups (P3-T13)", () => {
  it("assigns, recalls and appends", () => {
    const g = new ControlGroups();
    g.assign(1, ["u1", "u2", "u3"]);
    expect(g.recall(1, () => true)).toEqual(["u1", "u2", "u3"]);
    g.append(1, ["u3", "u4"]);
    expect(g.recall(1, () => true), "append should not duplicate").toEqual(["u1", "u2", "u3", "u4"]);
    g.assign(1, ["u9"]);
    expect(g.recall(1, () => true), "assign should replace, not merge").toEqual(["u9"]);
  });

  it("survives a unit dying, and prunes it permanently", () => {
    // Nothing tells this class an entity died — it has no access to the simulation and should not
    // have — so pruning happens on read. Without the write-back a group would re-filter forever and
    // its badge would keep counting ghosts.
    const g = new ControlGroups();
    g.assign(2, ["u1", "u2", "u3"]);
    expect(g.recall(2, (id) => id !== "u2")).toEqual(["u1", "u3"]);
    expect(g.size(2), "the dead unit is still counted in the group's size").toBe(2);
    expect(g.recall(2, () => true), "the pruned id came back").toEqual(["u1", "u3"]);
  });

  it("ignores a group number that does not exist", () => {
    const g = new ControlGroups();
    g.assign(-1, ["u1"]);
    g.assign(GROUP_COUNT, ["u1"]);
    expect(g.recall(-1, () => true)).toEqual([]);
    expect(g.recall(GROUP_COUNT, () => true)).toEqual([]);
    expect(g.size(99)).toBe(0);
  });

  it("NEVER touches simulation state — the constraint is the whole task", () => {
    // `state.selection` is sim state: it lives on `State` and `applyIntent` reads it to decide who
    // every order applies to. A control group stored there is a local convenience deciding what the
    // simulation does. It reaches the sim only through the ordinary `select` intent, which is the
    // same path a mouse drag takes.
    //
    // Note this is asserted HERE and not inferred from a determinism hash — `hashState` does not
    // include the selection (see the file header), so nothing else in the repo would catch it.
    const { bridge } = squad();
    const before = [...bridge.state.selection];
    const g = new ControlGroups();

    g.assign(3, [...bridge.state.units.keys()]);
    g.append(3, ["u1"]);
    g.recall(3, () => true);
    g.size(3);
    g.clear(3);

    expect(bridge.state.selection, "a control group wrote to `state.selection`").toEqual(before);
  });

  it("reaches the simulation only by replaying a select intent", () => {
    const { bridge, units } = squad();
    const g = new ControlGroups();
    g.assign(4, units.slice(0, 2).map((u) => u.id));

    bridge.enqueue({ kind: "select", ids: [], additive: false });
    bridge.step(STEP_SECONDS);
    expect(bridge.state.selection).toEqual([]);

    const recalled = g.recall(4, (id) => bridge.state.units.has(id));
    bridge.enqueue({ kind: "select", ids: recalled, additive: false });
    bridge.step(STEP_SECONDS);
    expect(bridge.state.selection.length, "the recall did not reach the simulation").toBe(2);
    expect([...bridge.state.selection].sort()).toEqual([...recalled].sort());
  });
});
