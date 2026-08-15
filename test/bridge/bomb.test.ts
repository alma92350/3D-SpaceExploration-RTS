// P3-T10 — the Helium Bomb: its fuse, its blast radius, and the warning.
//
// The board calls this "the one unit whose *radius* is the whole decision", and that is literal:
// the blast is **not owner-exempt**, so the ring a player sees around their own armed bomb is
// mostly a picture of which of their own units are standing in it. The first test below pins that,
// because every design choice here follows from it.
//
// The design question this task actually turned on was where the warning comes from. `bombFused` is
// an engine event and the obvious answer, and it is the wrong one — the exact inverse of ADR-0023's
// answer for shots, and the contrast is the point. A tracer is a MOMENT and `attackHit` is a moment,
// so a shot is read straight off the event. A warning is a STATE that lasts four seconds, and
// `bombFused` fires on exactly one tick in eighty; `fuseUntil` is the field that persists. The
// "survives the event" test is the one that separates the two implementations.
//
// (ADR-0017 drew this contrast the other way round — "a shot leaves no trace, so a diff is the only
// signal" — on a premise PARITY §7.1 disproved. It leaves `attackHit`.)

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { FUSE_UNLIT, SNAP_AI, SNAP_PLAYER } from "../../src/bridge/snapshot.js";
import {
  BOMB_BLAST_RADIUS, BOMB_CORE_RADIUS, BOMB_FUSE_DELAY, BOMB_MAX_DAMAGE, UNITS, bombDamageAt,
  isVisibleAt, makeBuilding, makeUnit,
} from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

/** One player Helium Bomb, parked well clear of anything that would trip it. */
function withBomb(owner: "player" | "ai" = "player", dx = 260, dy = 0) {
  const { bridge, base } = world();
  const bomb = makeUnit("heliumbomb", owner, base.x + dx, base.y + dy);
  bridge.state.units.set(bomb.id, bomb);
  bridge.step(STEP_SECONDS);
  return { bridge, base, bomb };
}

/**
 * An ARMED enemy bomb inside the player's vision and outside everything's detect range.
 *
 * A Command Center sees 220 and `BOMB_DETECT_RANGE` is 15, so 180 units out is the only band where
 * both halves hold — parked any closer and the engine lights the fuse itself on the first tick,
 * which is a different scenario entirely.
 */
function enemyBomb() {
  const { bridge, base } = world();
  const bomb = makeUnit("heliumbomb", "ai", base.x + 180, base.y);
  bridge.state.units.set(bomb.id, bomb);
  bomb.armed = true;
  bridge.step(STEP_SECONDS);
  return { bridge, base, bomb };
}

/** The row for `bomb`, or null when the bridge decided the player is not entitled to it. */
function rowFor(bridge: WorldBridge, id: string) {
  const live = bridge.state.units.get(id);
  const b = bridge.snapshot.bombs;
  for (let i = 0; i < b.count; i++) {
    // Positions are the only handle the table carries; ids deliberately do not cross, because
    // nothing in the view addresses a bomb — it draws a ring on the ground.
    if (live && Math.abs(b.x[i]! - live.x) < 1e-6 && Math.abs(b.y[i]! - live.y) < 1e-6) {
      return { core: b.core[i]!, blast: b.blast[i]!, fuse: b.fuse[i]!, owner: b.owner[i]! };
    }
  }
  return null;
}

describe("the premise: what the ring actually means", () => {
  it("catches the bomb's OWN side, which is why the radius is worth drawing at all", () => {
    // If the blast spared friendlies this whole task would be a threat indicator for the enemy and
    // nothing more. It does not, so the ring is a planning tool first: a player arming a bomb in
    // their own base is looking at a circle full of their own buildings.
    const { bridge, bomb } = withBomb();
    const friend = makeUnit("skiff", "player", bomb.x + 4, bomb.y);
    bridge.state.units.set(friend.id, friend);
    bomb.armed = true;
    bridge.apply({ kind: "detonate", unitId: bomb.id });
    for (let t = 0; t < Math.ceil(BOMB_FUSE_DELAY / STEP_SECONDS) + 4; t++) bridge.step(STEP_SECONDS);

    expect(bridge.state.units.get(bomb.id), "the bomb survived its own blast").toBeUndefined();
    expect(
      bridge.state.units.get(friend.id),
      "a friendly ship at ground zero survived — the ring would not be a planning tool",
    ).toBeUndefined();
  });

  it("has no attack of its own, so nothing else about it says 'dangerous'", () => {
    // The legibility argument ADR-0016 made for this unit: it is one of two units in the game with
    // no weapon, and the other one heals. Everything a player knows about the threat has to come
    // from the overlay.
    expect(UNITS.heliumbomb!.attack, "the Helium Bomb has grown a weapon — the premise moved")
      .toBeUndefined();
    expect(UNITS.heliumbomb!.role).toBe("bomb");
  });
});

describe("the two radii (P3-T10)", () => {
  it("crosses both of the engine's radii, and they are the two places the falloff changes", () => {
    // Not two numbers copied out of a header: `bombDamageAt` is asserted at both of them, so a ring
    // drawn at either is drawn where the damage curve actually does something. One circle could not
    // carry this — at `core` everything dies outright and at `blast` the damage is already zero.
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.step(STEP_SECONDS);

    const row = rowFor(bridge, bomb.id)!;
    expect(row, "an armed player bomb produced no row at all").not.toBeNull();
    expect(row.core).toBe(BOMB_CORE_RADIUS);
    expect(row.blast).toBe(BOMB_BLAST_RADIUS);
    expect(row.core, "the rings would be drawn on top of each other").toBeLessThan(row.blast);

    expect(bombDamageAt(row.core), "the inner ring is not where the peak hit ends")
      .toBeCloseTo(BOMB_MAX_DAMAGE, 6);
    expect(bombDamageAt(row.blast * 1.0001), "damage reaches past the outer ring").toBe(0);
    const mid = (row.core + row.blast) / 2;
    expect(bombDamageAt(mid), "the curve between the rings is flat — one ring would do")
      .toBeGreaterThan(0);
    expect(bombDamageAt(mid)).toBeLessThan(BOMB_MAX_DAMAGE);
  });

  it("shows nothing for an UNARMED bomb, because arming is the commitment", () => {
    // An unarmed bomb is inert in all three of its trigger paths. A ring around one would be a
    // warning about a unit that cannot go off, and — since a player drives an unarmed bomb across
    // the map — it would be on screen for most of the device's life.
    const { bridge, bomb } = withBomb();
    expect(bomb.armed).toBeFalsy();
    expect(rowFor(bridge, bomb.id), "an inert bomb was drawn as a threat").toBeNull();
  });
});

describe("the fuse is state, not an event (P3-T10)", () => {
  it("keeps warning long after the tick `bombFused` fired on", () => {
    // THE test. An implementation built on the `bombFused` event passes every other test in this
    // file and fails this one: the event fires once, four seconds before the blast, and a player
    // who was looking at another part of the map on that single tick would get no warning at all.
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.apply({ kind: "detonate", unitId: bomb.id });
    bridge.step(STEP_SECONDS);

    // The event is real, and it happened on a tick that is now over.
    const litRow = rowFor(bridge, bomb.id)!;
    expect(litRow.fuse, "the fuse was not lit — the scenario did not happen").toBeGreaterThan(0);

    let ticksWarnedWithoutTheEvent = 0;
    let last = litRow.fuse;
    const ticks = Math.floor(BOMB_FUSE_DELAY / STEP_SECONDS) - 2;
    expect(ticks, "the fuse is too short to tell the two implementations apart").toBeGreaterThan(10);

    for (let t = 0; t < ticks; t++) {
      bridge.step(STEP_SECONDS);
      const fused = (bridge.state.events ?? []).some((e) => e.type === "bombFused");
      const row = rowFor(bridge, bomb.id);
      expect(row, `the warning vanished ${t} ticks in, with the fuse still burning`).not.toBeNull();
      expect(row!.fuse, "the countdown went up").toBeLessThan(last);
      last = row!.fuse;
      if (!fused) ticksWarnedWithoutTheEvent++;
    }

    expect(
      ticksWarnedWithoutTheEvent,
      "every warned tick also carried the event — an event-driven implementation would have passed",
    ).toBe(ticks);
  });

  it("counts down from the engine's own delay and never goes negative", () => {
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.apply({ kind: "detonate", unitId: bomb.id });
    bridge.step(STEP_SECONDS);

    const first = rowFor(bridge, bomb.id)!.fuse;
    expect(first, "the countdown started above the engine's delay").toBeLessThanOrEqual(BOMB_FUSE_DELAY);
    expect(first, "the countdown started near zero — the window is the whole point")
      .toBeGreaterThan(BOMB_FUSE_DELAY - 0.5);

    for (let t = 0; t < Math.ceil(BOMB_FUSE_DELAY / STEP_SECONDS) + 2; t++) {
      bridge.step(STEP_SECONDS);
      const row = rowFor(bridge, bomb.id);
      if (!row) break;
      expect(row.fuse, "a negative countdown reached the view").toBeGreaterThanOrEqual(0);
    }
    expect(bridge.state.units.get(bomb.id), "the bomb never went off").toBeUndefined();
  });

  it("carries the engine's delay so the view never hardcodes four seconds", () => {
    // `view/` may not import the engine (ADR-0008), so without this the only way to draw a fuse as a
    // fraction is a literal that agrees with the engine right up until someone tunes the fuse.
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.bombs.fuseDelay).toBe(BOMB_FUSE_DELAY);
  });

  it("marks an armed but untripped bomb as unlit rather than as a zero countdown", () => {
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.step(STEP_SECONDS);
    expect(rowFor(bridge, bomb.id)!.fuse, "an armed bomb read as one tick from detonating")
      .toBe(FUSE_UNLIT);
  });
});

describe("disarming (P3-T10)", () => {
  it("cuts a lit fuse, and the bomb is still there when the blast was due", () => {
    // The engine emits nothing when a fuse is cut. So an event-driven warning would count down to a
    // blast that is never coming — and, worse, the player would have no way to tell that from a
    // real one. This is the second half of the argument for reading state.
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.apply({ kind: "detonate", unitId: bomb.id });
    bridge.step(STEP_SECONDS);
    expect(rowFor(bridge, bomb.id)!.fuse, "nothing was lit to cut").toBeGreaterThan(0);

    bridge.apply({ kind: "armBomb", unitId: bomb.id, armed: false });
    bridge.step(STEP_SECONDS);

    expect(bridge.state.units.get(bomb.id)!.fuseUntil, "the fuse was left burning").toBeFalsy();
    expect(rowFor(bridge, bomb.id), "a disarmed bomb kept its warning ring").toBeNull();

    for (let t = 0; t < Math.ceil(BOMB_FUSE_DELAY / STEP_SECONDS) + 6; t++) bridge.step(STEP_SECONDS);
    expect(bridge.state.units.get(bomb.id), "the disarmed bomb went off anyway").toBeDefined();
  });
});

describe("who is entitled to see it (P3-T10)", () => {
  it("hides an enemy's armed bomb, even standing in plain sight", () => {
    // An enemy bomb's ring before its fuse is lit is a number the player has not earned: they would
    // route an army around a device they were never told was armed. The gate is on the fuse, not on
    // vision, so this holds for a bomb the player is looking straight at.
    //
    // 180 units out, not 30: the first draft parked it beside the Command Center and the engine
    // lit its fuse on the first tick, because `checkBombProximity` measures to a building's RIM and
    // a CC's hull was inside BOMB_DETECT_RANGE. The test failed honestly and the scenario was the
    // thing that was wrong. A Command Center sees 220 and the detect range is 15, so this is the
    // band where "visible" and "untripped" are both true.
    const { bridge, bomb } = enemyBomb();
    expect(
      isVisibleAt(bridge.state.fog, bomb.x, bomb.y),
      "the bomb was not actually visible — the test would pass with no rule at all",
    ).toBe(true);
    expect(bomb.fuseUntil, "the bomb tripped its own fuse — this is the lit case, not the armed one")
      .toBeFalsy();
    expect(rowFor(bridge, bomb.id), "an enemy's armed bomb handed over its radius").toBeNull();
  });

  it("shows an enemy's LIT fuse in vision — that is what the warning is for", () => {
    // The mutation-proof half of the pair above: the same enemy bomb in the same place, differing in
    // one field. If the rule were "never show an enemy bomb" the previous test would still pass and
    // this one would not; if it were "always show one" the previous one would fail.
    const { bridge, bomb } = enemyBomb();
    bomb.fuseUntil = bridge.state.time + BOMB_FUSE_DELAY;
    bridge.step(STEP_SECONDS);

    const row = rowFor(bridge, bomb.id);
    expect(row, "a lit enemy fuse in plain sight produced no warning").not.toBeNull();
    expect(row!.fuse).toBeGreaterThan(0);
    expect(row!.owner, "the warning claimed the bomb was the player's own").toBe(SNAP_AI);
  });

  it("suppresses a lit enemy fuse the player cannot see", () => {
    // Fog on live vision, not memory — the guard aura's rule (P3-T04). A warning remembered where a
    // bomb used to be is a warning about ground that is now safe, and the bomb moves.
    const { bridge } = world();
    const m = bridge.state.map;
    const far = makeUnit("heliumbomb", "ai", m.width - 90, m.height - 90);
    bridge.state.units.set(far.id, far);
    far.armed = true;
    far.fuseUntil = bridge.state.time + BOMB_FUSE_DELAY;
    bridge.step(STEP_SECONDS);

    expect(
      isVisibleAt(bridge.state.fog, far.x, far.y),
      "the far corner was visible after all — nothing was being suppressed",
    ).toBe(false);
    expect(rowFor(bridge, far.id), "a bomb in unseen ground announced itself").toBeNull();
  });

  it("shows the player their own bomb with their own owner slot", () => {
    const { bridge, bomb } = withBomb();
    bomb.armed = true;
    bridge.step(STEP_SECONDS);
    expect(rowFor(bridge, bomb.id)!.owner).toBe(SNAP_PLAYER);
  });
});

describe("arming and triggering (P3-T10)", () => {
  it("refuses to detonate a bomb that was never armed", () => {
    const { bridge, bomb } = withBomb();
    expect(bridge.apply({ kind: "detonate", unitId: bomb.id })).toMatch(/not armed/);
    bridge.step(STEP_SECONDS);
    expect(bridge.state.units.get(bomb.id)!.fuseUntil, "an unarmed bomb lit a fuse").toBeFalsy();
  });

  it("lights a fuse rather than blowing up on the spot", () => {
    // The player's own trigger is a FUSE, like the proximity trigger. Detonating instantly here
    // would give the player's button a property the enemy's trigger does not have — and would take
    // the four seconds away from the player's own units standing in the ring.
    const { bridge, bomb } = withBomb();
    const friend = makeUnit("skiff", "player", bomb.x + 4, bomb.y);
    bridge.state.units.set(friend.id, friend);
    bridge.apply({ kind: "armBomb", unitId: bomb.id, armed: true });
    bridge.apply({ kind: "detonate", unitId: bomb.id });
    bridge.step(STEP_SECONDS);

    expect(bridge.state.units.get(bomb.id), "the bomb detonated on the click").toBeDefined();
    expect(bridge.state.units.get(friend.id), "a friendly ship had no window to move").toBeDefined();

    for (let t = 0; t < Math.ceil(BOMB_FUSE_DELAY / STEP_SECONDS) + 4; t++) bridge.step(STEP_SECONDS);
    expect(bridge.state.units.get(bomb.id), "the fuse never came due").toBeUndefined();
  });

  it("will not arm somebody else's bomb", () => {
    // These two intents are the only ones in the bridge that write a sim field directly, so the
    // owner check is the whole of their safety. Silent, not an error: it is the same shape as
    // clicking a unit that died between the click and the tick.
    const { bridge, base } = world();
    const theirs = makeUnit("heliumbomb", "ai", base.x + 300, base.y);
    bridge.state.units.set(theirs.id, theirs);
    expect(bridge.apply({ kind: "armBomb", unitId: theirs.id, armed: true })).toBeNull();
    expect(bridge.state.units.get(theirs.id)!.armed, "the player armed the AI's bomb").toBeFalsy();
    expect(bridge.apply({ kind: "detonate", unitId: theirs.id })).toBeNull();
    expect(bridge.state.units.get(theirs.id)!.fuseUntil, "the player set off the AI's bomb").toBeFalsy();
  });

  it("ignores the intents on a unit that is not a bomb", () => {
    const { bridge, base } = world();
    const skiff = makeUnit("skiff", "player", base.x + 40, base.y);
    bridge.state.units.set(skiff.id, skiff);
    expect(bridge.apply({ kind: "armBomb", unitId: skiff.id, armed: true })).toBeNull();
    expect((bridge.state.units.get(skiff.id) as { armed?: boolean }).armed,
      "an ordinary ship was armed as a doomsday device").toBeFalsy();
    expect(bridge.apply({ kind: "armBomb", unitId: "u9999", armed: true })).toBeNull();
  });

  it("goes through the intent queue, so a replay reproduces it", () => {
    // Both intents write a sim field, which is exactly the thing that desyncs a replay when it
    // happens anywhere but a tick boundary in recorded order. Queued rather than applied, and the
    // flip must not have happened before the step.
    const { bridge, bomb } = withBomb();
    bridge.enqueue({ kind: "armBomb", unitId: bomb.id, armed: true });
    expect(bridge.state.units.get(bomb.id)!.armed, "the flip happened outside the queue").toBeFalsy();
    bridge.step(STEP_SECONDS);
    expect(bridge.state.units.get(bomb.id)!.armed, "the queued intent never reached the sim").toBe(true);
  });
});
