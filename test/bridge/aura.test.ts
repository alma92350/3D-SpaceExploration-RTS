// P3-T04 — the Aegis Bastion's guard aura is visible, and so is the Aegis unit's.
//
// This is the one building in the game whose entire function is invisible. It has **no attack**:
// `BUILDINGS.aegisbastion` is a `guardAura` granting −20% damage taken within 130, and it currently
// shares the `fortress` mesh with the Bastille and the Torpedo Battery, both of which shoot. So a
// player looking at their own base cannot tell the thing that protects from the two things that
// kill, and cannot see the coverage they paid 250 ore and 180 crystals for.
//
// The engine already does the work: `collectAnvils` rebuilds `state.anvils` every tick from live
// positions — `{id, owner, x, y, range, mult}`, covering the Aegis UNIT and the Bastion with one
// shape. Nothing here re-derives a radius; the bridge carries the engine's own list.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { SNAP_AI, SNAP_PLAYER } from "../../src/bridge/snapshot.js";
import { BUILDINGS, UNITS, makeBuilding, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

function auraAt(bridge: WorldBridge, x: number, y: number) {
  const a = bridge.snapshot.auras;
  for (let i = 0; i < a.count; i++) {
    if (Math.abs(a.x[i]! - x) < 0.01 && Math.abs(a.y[i]! - y) < 0.01) {
      return { x: a.x[i]!, y: a.y[i]!, radius: a.radius[i]!, owner: a.owner[i]! };
    }
  }
  return null;
}

describe("the guard aura crosses the bridge", () => {
  it("carries the engine's own radius, never a re-derived one", () => {
    const { bridge, base } = world();
    const b = makeBuilding("aegisbastion", "player", base.x + 80, base.y);
    bridge.state.buildings.set(b.id, b);
    bridge.step(STEP_SECONDS);

    const aura = auraAt(bridge, b.x, b.y);
    expect(aura, "the Aegis Bastion projects no aura the view can see").not.toBeNull();
    expect(aura!.radius, "the radius must be the engine's `guardAura.range`")
      .toBe(BUILDINGS.aegisbastion!.guardAura!.range);
    expect(aura!.owner).toBe(SNAP_PLAYER);
  });

  it("covers the Aegis unit too, which has a smaller aura than the building", () => {
    // `collectAnvils` handles units and buildings with one shape, and the two ranges genuinely
    // differ — 96 against 130 — so a view that hardcoded either would be wrong about the other.
    const { bridge, base } = world();
    const u = makeUnit("aegis", "player", base.x + 40, base.y);
    bridge.state.units.set(u.id, u);
    bridge.step(STEP_SECONDS);

    const unitRange = UNITS.aegis!.guardAura!.range;
    const buildingRange = BUILDINGS.aegisbastion!.guardAura!.range;
    expect(unitRange, "the premise: the two ranges differ").not.toBe(buildingRange);

    const aura = auraAt(bridge, u.x, u.y);
    expect(aura, "the Aegis unit projects no aura the view can see").not.toBeNull();
    expect(aura!.radius).toBe(unitRange);
  });

  it("shows nothing for a bastion still under construction", () => {
    // `collectAnvils` skips one that has not finished standing, so the ring must not appear before
    // the protection does — a player who trusted it would walk an army into an unprotected spot.
    const { bridge, base } = world();
    const b = makeBuilding("aegisbastion", "player", base.x + 80, base.y, { constructing: true });
    bridge.state.buildings.set(b.id, b);
    bridge.step(STEP_SECONDS);
    expect(auraAt(bridge, b.x, b.y)).toBeNull();
  });

  it("shows an enemy aura only where the player can actually see it", () => {
    // Knowing the enemy has a damage-reduction bubble is exactly the tactical information a player
    // needs — and it has to be earned. An aura visible through fog is a map hack with a nice name.
    const { bridge, base } = world();
    const near = makeBuilding("aegisbastion", "ai", base.x + 40, base.y);
    const far = makeBuilding("aegisbastion", "ai", base.x + 1200, base.y + 700);
    bridge.state.buildings.set(near.id, near);
    bridge.state.buildings.set(far.id, far);
    bridge.step(STEP_SECONDS);

    const seen = auraAt(bridge, near.x, near.y);
    expect(seen, "an enemy bastion inside the player's vision should show its aura").not.toBeNull();
    expect(seen!.owner).toBe(SNAP_AI);
    expect(
      auraAt(bridge, far.x, far.y),
      "an aura appeared for a bastion the player has never seen",
    ).toBeNull();
  });

  it("does not leak the damage multiplier as a radius, or vice versa", () => {
    // Both are numbers on the same engine record and mixing them would draw a 0.8-unit ring.
    const { bridge, base } = world();
    const b = makeBuilding("aegisbastion", "player", base.x + 80, base.y);
    bridge.state.buildings.set(b.id, b);
    bridge.step(STEP_SECONDS);
    expect(auraAt(bridge, b.x, b.y)!.radius).toBeGreaterThan(1);
  });

  it("re-reads position every tick, because the Aegis unit moves", () => {
    const { bridge, base } = world();
    const u = makeUnit("aegis", "player", base.x + 40, base.y);
    bridge.state.units.set(u.id, u);
    bridge.step(STEP_SECONDS);
    expect(auraAt(bridge, u.x, u.y)).not.toBeNull();

    const live = bridge.state.units.get(u.id)!;
    live.x += 60;
    bridge.step(STEP_SECONDS);
    expect(auraAt(bridge, live.x, live.y), "the ring stayed where the Aegis used to be").not.toBeNull();
  });

  it("is empty when nothing projects one, and allocates nothing to say so", () => {
    const { bridge } = world();
    expect(bridge.snapshot.auras.count).toBe(0);
    const before = bridge.snapshot.auras.x;
    for (let i = 0; i < 30; i++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.auras.x, "the aura table reallocated on an idle frame").toBe(before);
  });
});
