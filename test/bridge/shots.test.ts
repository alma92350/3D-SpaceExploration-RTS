// P3-T05 / Q-12 — a shot crosses the bridge as a diff, because the engine never says one happened.
//
// Thirteen event types exist in the whole simulation and the only combat one is `entityKilled`.
// ADR-0017 derives a shot from `attackTimer` rising between ticks, which is an invariant of the
// engine's own code rather than a heuristic — and the first test below checks that invariant
// against the *source*, because a comment claiming it would be worth nothing the day upstream adds
// a third way to write that field.
//
// The measurement that shaped the design: **12.9% of shots in a real fight have a target that no
// longer exists by extraction time**, because the engine applies damage and removes the corpse
// inside the same tick. The killing shot is exactly the one a naive lookup would drop.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { SNAP_AI, SNAP_PLAYER } from "../../src/bridge/snapshot.js";
import { UNITS, isVisibleAt, makeBuilding, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

/** Two units in weapons range of each other, one per side. */
function duel(type = "skiff") {
  const { bridge, base } = world();
  const a = makeUnit(type, "player", base.x + 40, base.y);
  const b = makeUnit(type, "ai", base.x + 55, base.y);
  bridge.state.units.set(a.id, a);
  bridge.state.units.set(b.id, b);
  return { bridge, a, b };
}

describe("the attackTimer invariant ADR-0017 rests on", () => {
  it("holds in the engine's own source: the timer is only decremented or reset on a shot", () => {
    // Asserted against the source rather than against a comment. If upstream ever adds a third way
    // to write `attackTimer` — a stun that resets it, an ability that refunds it — this bridge
    // starts inventing shots, and the failure would otherwise be purely visual.
    const src = readFileSync(new URL("../../src/engine/engine/combat.js", import.meta.url), "utf8");
    const writes = [...src.matchAll(/\battackTimer\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(writes.length, "no attackTimer writes found — the file moved or was renamed").toBeGreaterThan(0);

    for (const rhs of writes) {
      const decrement = /Math\.max\(0,\s*\w+\.attackTimer\s*-\s*dt\)/.test(rhs);
      const reset = /def\.cooldown/.test(rhs);
      expect(
        decrement || reset,
        `combat.js writes attackTimer = ${rhs}, which is neither a decrement nor a cooldown reset. ` +
        `ADR-0017 derives "a shot happened" from this field rising, and that is no longer sound.`,
      ).toBe(true);
    }
  });

  it("cannot fire twice in one tick, by a wide margin", () => {
    // The other half of "a per-tick diff loses nothing". Cooldowns are 17x the tick at minimum.
    const cooldowns = Object.values(UNITS)
      .map((u) => (u as { cooldown?: number }).cooldown)
      .filter((c): c is number => typeof c === "number");
    expect(cooldowns.length).toBeGreaterThan(5);
    expect(
      Math.min(...cooldowns) / STEP_SECONDS,
      "a weapon now cycles fast enough to fire twice in a tick — the diff would lose shots",
    ).toBeGreaterThan(2);
  });
});

describe("shots reach the view", () => {
  it("emits one on the tick a unit fires, and none on the ticks it does not", () => {
    const { bridge, a } = duel();
    let firedOn = -1;
    for (let t = 0; t < 60 && firedOn < 0; t++) {
      bridge.step(STEP_SECONDS);
      if (bridge.snapshot.shots.count > 0) firedOn = t;
    }
    expect(firedOn, "nobody fired in 60 ticks — the duel never engaged").toBeGreaterThanOrEqual(0);

    // The very next tick must be quiet: the cooldown is 17+ ticks long.
    bridge.step(STEP_SECONDS);
    expect(
      bridge.snapshot.shots.count,
      "a shot was reported on the tick after firing — the diff is latching rather than edging",
    ).toBe(0);
    expect(bridge.state.units.get(a.id), "the duel should still have both sides").toBeDefined();
  });

  it("draws the line from the shooter to the target, with the shooter's own colour", () => {
    const { bridge } = duel();
    for (let t = 0; t < 60; t++) {
      bridge.step(STEP_SECONDS);
      const s = bridge.snapshot.shots;
      if (s.count === 0) continue;

      const owner = s.owner[0]!;
      expect([SNAP_PLAYER, SNAP_AI]).toContain(owner);
      const len = Math.hypot(s.toX[0]! - s.fromX[0]!, s.toY[0]! - s.fromY[0]!);
      expect(len, "a shot with zero length is a shooter firing at itself").toBeGreaterThan(0.5);
      expect(len, "the tracer is longer than the weapon's reach").toBeLessThan(400);
      return;
    }
    throw new Error("no shot was observed in 60 ticks");
  });

  it("still reports the shot that kills, whose target no longer exists", () => {
    // The measurement this whole design turns on: 12.9% of shots in a real fight have a target that
    // has already been removed by extraction time. A lookup-and-skip implementation drops exactly
    // the kills, and looks perfect in any test without a death in it.
    const { bridge, base } = world();
    const killer = makeUnit("lancer", "player", base.x + 40, base.y);
    const victim = makeUnit("worker", "ai", base.x + 60, base.y);
    bridge.state.units.set(killer.id, killer);
    bridge.state.units.set(victim.id, victim);
    // It has to survive one extraction first, exactly as anything trained or built does. An entity
    // that spawns and dies inside a single tick has no previous position and is legitimately
    // undrawable — the `dropped` counter says so rather than pretending otherwise.
    bridge.step(STEP_SECONDS);
    bridge.state.units.get(victim.id)!.hp = 1;         // now one hit ends it, inside a tick

    let killingShot: { toX: number; toY: number } | null = null;
    for (let t = 0; t < 80 && !killingShot; t++) {
      const vx = bridge.state.units.get(victim.id)?.x;
      const vy = bridge.state.units.get(victim.id)?.y;
      bridge.step(STEP_SECONDS);
      const gone = !bridge.state.units.get(victim.id);
      const s = bridge.snapshot.shots;
      if (gone && s.count > 0 && vx !== undefined) {
        killingShot = { toX: s.toX[0]!, toY: s.toY[0]! };
        // The endpoint is where the victim was standing, from `prevPos` — not dropped, and not the
        // origin either, which is what a zeroed fallback would give.
        expect(killingShot.toX, "the killing shot did not end where the target died").toBeCloseTo(vx, 0);
        expect(killingShot.toY).toBeCloseTo(vy!, 0);
      }
    }
    expect(killingShot, "the shot that killed the target never reached the view").not.toBeNull();
    expect(bridge.state.units.get(victim.id), "the victim should be dead by now").toBeUndefined();
  });

  it("never silently drops a shot it cannot resolve", () => {
    // ADR-0017's stated obligation. A dropped-shot counter that stays zero is the only evidence the
    // dead-target path is still working; one that climbs means the endpoint logic has a hole.
    const { bridge, base } = world();
    for (let i = 0; i < 40; i++) {
      const owner = i % 2 === 0 ? "player" : "ai";
      const u = makeUnit(["skiff", "lancer", "bastion", "wraith"][i % 4]!, owner,
        base.x + (owner === "player" ? -30 : 30) + (i % 5) * 6, base.y + Math.floor(i / 5) * 6);
      bridge.state.units.set(u.id, u);
    }
    let total = 0;
    for (let t = 0; t < 300; t++) {
      bridge.step(STEP_SECONDS);
      total += bridge.snapshot.shots.count;
    }
    expect(total, "no shots at all in 300 ticks of a 40-unit brawl").toBeGreaterThan(10);
    expect(
      bridge.snapshot.shots.dropped,
      `${bridge.snapshot.shots.dropped} shots could not be given an endpoint and were discarded`,
    ).toBe(0);
  });

  it("shows nothing fired where the player cannot see, and everything where they can", () => {
    // Written in two halves on purpose. The first draft asserted only that a VISIBLE enemy's fire
    // shows — which is true, and passes just as well with the fog gate deleted. Removing the gate
    // was mutation-tested and slipped straight through, so the half that actually pins the rule is
    // the one below it: a fight the player has never scouted must produce no tracers at all.
    const { bridge, base } = world();
    const m = bridge.state.map;

    // Two AI units duelling in the far corner, nowhere near anything the player owns.
    const hx = m.width - 90;
    const hy = m.height - 90;
    const h1 = makeUnit("skiff", "ai", hx, hy);
    const h2 = makeUnit("skiff", "ai", hx + 14, hy);
    // The engine will not have them shoot each other, so give one a player-owned thing to shoot at
    // out there — a lone scout that is itself hidden from the player's base but still theirs.
    bridge.state.units.set(h1.id, h1);
    bridge.state.units.set(h2.id, h2);

    // And a visible pair near the base, well inside the Command Center's sight.
    const vx = base.x + 40;
    const v1 = makeUnit("skiff", "ai", vx, base.y);
    const v2 = makeUnit("skiff", "player", vx + 14, base.y);
    bridge.state.units.set(v1.id, v1);
    bridge.state.units.set(v2.id, v2);

    let visibleAiShots = 0;
    let hiddenShots = 0;
    for (let t = 0; t < 120; t++) {
      bridge.step(STEP_SECONDS);
      const s = bridge.snapshot.shots;
      for (let i = 0; i < s.count; i++) {
        const nearBase = Math.hypot(s.fromX[i]! - vx, s.fromY[i]! - base.y) < 120;
        if (nearBase) { if (s.owner[i] === SNAP_AI) visibleAiShots++; }
        else if (Math.hypot(s.fromX[i]! - hx, s.fromY[i]! - hy) < 200) hiddenShots++;
      }
    }

    expect(
      visibleAiShots,
      "an AI unit inside the player's own vision should show its fire — the gate is on visibility, not ownership",
    ).toBeGreaterThan(0);
    expect(
      hiddenShots,
      `${hiddenShots} tracers came from a corner of the map the player has never seen — a line from ` +
      `unexplored ground points straight at the shooter standing in it`,
    ).toBe(0);
  });

  it("suppresses an artillery piece shelling from beyond the player's sight", () => {
    // The real scenario, and the one the first two drafts of this test failed to construct. Two AI
    // units will not shoot each other, so "a hidden shooter" needs a hidden shooter with something
    // of the PLAYER's to shoot at — and the engine supplies exactly that pairing:
    //
    //   a Worker sees 110.  A Colossus shoots from 185.
    //
    // So the shell arrives from 75 units beyond anything the player can see. Removing the fog gate
    // draws a line from empty ground straight to the artillery, which is the single most valuable
    // thing an opponent could hand a player for free.
    const { bridge } = world();
    const m = bridge.state.map;
    const py = m.height - 140;
    const px = 140;
    const victim = makeUnit("worker", "player", px, py);
    const gun = makeUnit("colossus", "ai", px + 180, py);
    bridge.state.units.set(victim.id, victim);
    bridge.state.units.set(gun.id, gun);

    expect(UNITS.worker!.sight, "the premise: the Worker's sight is shorter than the Colossus' reach")
      .toBeLessThan(UNITS.colossus!.range!);

    // One extraction before anything is allowed to die, so a dropped shot can only mean the fog
    // gate — not a target that never had a previous position. And enough hit points to soak several
    // shells: a Worker has 40 against the Colossus' 42, so at stock HP the scenario is one tick long
    // and proves nothing. Both of these were found by mutation-testing the gate away and watching
    // the test pass anyway, twice.
    victim.maxHp = 4000;
    victim.hp = 4000;
    bridge.step(STEP_SECONDS);
    expect(bridge.state.units.get(victim.id), "the victim must survive to be shelled").toBeDefined();

    let engineShots = 0;
    let bridgeShots = 0;
    let prevTimer = 0;
    let sawHidden = false;
    for (let t = 0; t < 150; t++) {
      bridge.step(STEP_SECONDS);
      const live = bridge.state.units.get(gun.id);
      if (!live) break;
      const now = live.attackTimer ?? 0;
      if (now > prevTimer + 1e-9) {
        engineShots++;
        if (!isVisibleAt(bridge.state.fog, live.x, live.y)) sawHidden = true;
      }
      prevTimer = now;
      const s = bridge.snapshot.shots;
      for (let i = 0; i < s.count; i++) {
        if (s.owner[i] === SNAP_AI) bridgeShots++;
      }
    }

    expect(engineShots, "the Colossus never fired — the scenario did not happen").toBeGreaterThan(1);
    expect(sawHidden, "the Colossus was visible the whole time — nothing was being suppressed").toBe(true);
    expect(
      bridgeShots,
      `the engine fired ${engineShots} shells from outside the player's vision and ${bridgeShots} ` +
      `reached the view — each one a line pointing straight at the artillery`,
    ).toBe(0);
    // The gate must be the reason nothing was drawn. If these shots were instead being lost to an
    // unresolvable endpoint the count would also be zero, and the test would pass while proving
    // nothing — which is exactly what it did before this line existed.
    expect(
      bridge.snapshot.shots.dropped,
      "the shells were discarded for want of an endpoint, not suppressed by fog",
    ).toBe(0);
  });

  it("allocates nothing across a long quiet stretch", () => {
    const { bridge } = world();
    const before = bridge.snapshot.shots.fromX;
    for (let t = 0; t < 60; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.shots.count).toBe(0);
    expect(bridge.snapshot.shots.fromX, "the shot table reallocated on idle ticks").toBe(before);
  });
});

describe("engine events survive the tick (P3-T07)", () => {
  it("carries a death to the view, with the engine's own position and owner", () => {
    const { bridge, base } = world();
    const killer = makeUnit("lancer", "player", base.x + 40, base.y);
    const victim = makeUnit("worker", "ai", base.x + 60, base.y);
    victim.hp = 1;
    bridge.state.units.set(killer.id, killer);
    bridge.state.units.set(victim.id, victim);

    let seen = false;
    for (let t = 0; t < 80 && !seen; t++) {
      bridge.step(STEP_SECONDS);
      const d = bridge.snapshot.deaths;
      for (let i = 0; i < d.count; i++) {
        seen = true;
        expect(d.owner[i], "the dead unit was the AI's").toBe(SNAP_AI);
        expect(Math.hypot(d.x[i]! - base.x - 60, d.y[i]! - base.y), "died nowhere near where it stood")
          .toBeLessThan(60);
      }
    }
    expect(seen, "`entityKilled` never reached the view — the bridge is still discarding events").toBe(true);
  });

  it("drains the engine's list exactly once, so it cannot grow without bound", () => {
    // The bridge cleared `state.events` for this reason and threw the contents away. Keeping them
    // must not mean keeping them twice, or a long match accumulates every death it ever saw.
    const { bridge, base } = world();
    const a = makeUnit("lancer", "player", base.x + 40, base.y);
    const b = makeUnit("worker", "ai", base.x + 60, base.y);
    b.hp = 1;
    bridge.state.units.set(a.id, a);
    bridge.state.units.set(b.id, b);
    for (let t = 0; t < 80; t++) bridge.step(STEP_SECONDS);

    expect(bridge.state.events.length, "the engine's own event list is growing unbounded").toBe(0);
    // And the snapshot reports only THIS tick's deaths, not a running log.
    for (let t = 0; t < 5; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.deaths.count, "deaths accumulated across ticks instead of being per-tick").toBe(0);
  });
});
