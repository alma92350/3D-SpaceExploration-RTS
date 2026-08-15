// P6-T01 / Q-12 — a shot crosses the bridge as the engine's own `attackHit` event (ADR-0023).
//
// This file used to open by asserting the `attackTimer` invariant ADR-0017 derived a shot from.
// That derivation is gone. `combat.js:187` pushes an `attackHit` inside `performAttack` carrying
// `fromX`/`fromY` and `x`/`y` — **both endpoints, stamped before the corpse is removed** — and
// ADR-0023 reads it. So the sweeps below pin the new premise against the vendored source, on the
// same discipline and for a sharper reason than before: ADR-0017's premise about this exact file
// was checkably false for two phases and no test noticed, because no test read the file.
//
// The three measurements that decided the change, all on `helix`, seed 20260814:
//
//   • A Skiff right-clicked onto a Worker: **10 shots, 0 tracers, 10 `dropped`**. `extractShots`
//     resolved the endpoint from `unit.autoTarget` and `combat.js:46` takes an ordered attack's
//     target straight off `unit.order`, leaving `combat.js:65` — the only line in the engine that
//     writes `autoTarget` — unreachable.
//   • A 120-unit fight over 400 ticks: the engine pushed **622** `attackHit`s and the diff drew
//     **620**, with **1** on `dropped` and **1** silently lost. Same fight packed tighter: 585
//     against 578 drawn and 4 dropped.
//   • The one thing the event does NOT cover: a hit on an ARMED Helium Bomb detonates it through
//     `detonateIfAttacked` and returns before the push, so that shot fires and lands no hit. One per
//     bomb, and it is the reason `performAttack`'s early return is swept below rather than assumed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { SNAP_AI, SNAP_PLAYER, SnapshotExtractor } from "../../src/bridge/snapshot.js";
import {
  BUILDINGS, UNITS, activeState, createGalaxy, isVisibleAt, issueAttack, makeBuilding, makeUnit,
} from "../../src/engine/index.js";

const SEED = 20260814;

const COMBAT_SRC = readFileSync(new URL("../../src/engine/engine/combat.js", import.meta.url), "utf8");

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

/**
 * The scene ADR-0017's points 1–3 were measured on and ADR-0023 re-measured: 120 units, two blocks
 * in contact across the player's base, over 400 ticks. **ADR-0017's own recipe was never committed**
 * — this one is, so the next re-measurement is a re-run rather than a reconstruction.
 */
function packedFight(gap = 60) {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const st = bridge.state;
  const base = st.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  st.buildings.set(cc.id, cc);
  const mix = Object.keys(UNITS);
  for (let i = 0; i < 120; i++) {
    const owner = Math.floor(i / mix.length) % 2 === 0 ? "player" : "ai";
    const u = makeUnit(
      mix[i % mix.length]!, owner as "player" | "ai",
      base.x + (owner === "player" ? -gap : gap) + ((i * 13) % 60) - 30,
      base.y + ((i * 29) % 180) - 90,
    );
    st.units.set(u.id, u);
  }
  return bridge;
}

/** Every `attackHit` the engine pushes, whoever fired it and whether or not it survives fog. */
function hitLog(bridge: WorldBridge): ReadonlyArray<{ fromX: number; fromY: number; owner: string }> {
  const events = bridge.state.events as unknown as { push: (...a: unknown[]) => number };
  const orig = events.push;
  const log: Array<{ fromX: number; fromY: number; owner: string }> = [];
  events.push = function (...args: unknown[]) {
    for (const a of args) {
      const e = a as { type?: string; fromX?: number; fromY?: number; owner?: string };
      if (e.type === "attackHit") log.push({ fromX: e.fromX!, fromY: e.fromY!, owner: e.owner! });
    }
    return orig.apply(this, args as never[]);
  };
  return log;
}

describe("the premise ADR-0023 rests on, checked against the engine's source", () => {
  it("every landed hit is announced with BOTH endpoints", () => {
    // The whole design in one line of upstream. If the push loses `fromX`/`fromY`, a tracer has no
    // origin and every behavioural test below would simply observe fewer lines and read as "the
    // fight was quieter". This says which it was.
    const push = COMBAT_SRC.match(/state\.events\.push\(\{[^}]*type:\s*"attackHit"[^}]*\}\)/s);
    expect(push, "combat.js no longer pushes an attackHit event at all").not.toBeNull();
    for (const field of ["x", "y", "fromX", "fromY", "owner"]) {
      expect(
        new RegExp(`\\b${field}:`).test(push![0]),
        `attackHit no longer carries \`${field}\` — ADR-0023 reads a tracer's endpoints off it`,
      ).toBe(true);
    }
    expect(push![0], "the endpoints stopped being the target's and the attacker's positions")
      .toMatch(/x:\s*target\.x,\s*y:\s*target\.y/);
    expect(push![0]).toMatch(/fromX:\s*attacker\.x,\s*fromY:\s*attacker\.y/);
  });

  it("the hit is announced BEFORE the corpse is removed", () => {
    // ADR-0017's point 4 — 12.9% of shots have a target that no longer exists at extraction time —
    // is answered by this ordering and by nothing else. If upstream ever moves `removeEntity` above
    // the push, `ev.x`/`ev.y` would name a position the engine has already discarded.
    const body = COMBAT_SRC.slice(COMBAT_SRC.indexOf("function performAttack("));
    const push = body.indexOf('type: "attackHit"');
    const remove = body.indexOf("removeEntity(");
    expect(push, "performAttack no longer pushes attackHit").toBeGreaterThan(-1);
    expect(remove, "performAttack no longer removes the corpse").toBeGreaterThan(-1);
    expect(push, "the corpse is now removed before the hit is announced — the endpoint is stale")
      .toBeLessThan(remove);
  });

  it("exactly one shot can fire and land no hit, and it is the armed-bomb fuze", () => {
    // The set ADR-0023 draws is "shots that LANDED". This is the sweep that keeps that set honest:
    // `performAttack` has one early return before the push, and it is `detonateIfAttacked`. A miss
    // chance, an out-of-range abort or a dud round added upstream would each add a second return —
    // and would each silently widen the gap between what fires and what is drawn.
    const body = COMBAT_SRC.slice(COMBAT_SRC.indexOf("function performAttack("));
    const preamble = body.slice(0, body.indexOf('type: "attackHit"'));
    const returns = [...preamble.matchAll(/\breturn\b/g)];
    expect(
      returns.length,
      `performAttack now has ${returns.length} ways to leave before announcing the hit. ADR-0023 ` +
      `draws a tracer per landed hit, so every one of them is a shot that fires and draws nothing:\n` +
      preamble,
    ).toBe(1);
    expect(preamble, "the one early return stopped being the Helium Bomb's impact fuze")
      .toMatch(/if\s*\(detonateIfAttacked\(state,\s*target\)\)\s*return true;/);
  });

  it("cannot land a hit without spending a shot", () => {
    // The converse, and the reason a tracer per hit is not a tracer per arbitrary event: every
    // `performAttack` call site resets the shooter's cooldown immediately after, so a hit always
    // costs a weapon cycle. Three call sites — mobile units, workers, turrets.
    // Every mention of the name with a paren after it, less its own declaration. Written this way
    // rather than as a tighter pattern because the tighter pattern is what a new call site slips
    // through: an earlier draft required a space before the name and missed `return performAttack(`.
    const calls = [...COMBAT_SRC.matchAll(/(?<!function )performAttack\(/g)];
    expect(calls.length, "the number of places that fire changed — check each one resets a cooldown")
      .toBe(3);
    for (const call of calls) {
      const after = COMBAT_SRC.slice(call.index!, call.index! + 900);
      const reset = after.search(/\battackTimer\s*=\s*(?!Math\.max\(0,)/);
      expect(
        reset,
        `a performAttack call at index ${call.index} is not followed by a cooldown reset:\n${after.slice(0, 400)}`,
      ).toBeGreaterThan(-1);
    }
  });

  it("is shared by mobile units and turrets, so a base defending itself is not silent", () => {
    expect((BUILDINGS.turret as { attack?: number }).attack, "the Sentinel Turret lost its weapon")
      .toBeGreaterThan(0);
    expect(COMBAT_SRC, "updateBuildingCombat stopped going through the shared attack path")
      .toMatch(/export function updateBuildingCombat[\s\S]*performAttack\(state,\s*building/);
  });
});

describe("the defect P6-T01 was filed for", () => {
  it("draws a tracer for an explicitly ordered attack", () => {
    // **The row, measured: 10 shots, 0 tracers, 10 `dropped`.** Right-click-to-attack is the most
    // common combat order in an RTS and it produced no visual feedback from Phase 3 to Phase 6,
    // because the endpoint came from `autoTarget` and an ordered attack never writes it. Nothing
    // here reads `autoTarget`, so the whole class of order is covered by the same code path as any
    // other shot — which is the point of reading the engine rather than inferring it.
    const { bridge, base } = world();
    // Laid out DIAGONALLY, inside the Skiff's 40 reach. On a shared Y a tracer whose far end carried
    // the shooter's own Y would look perfect, and that mutation survived the first draft of this
    // test — the same failure `combat-feedback.test.ts` found on the rally line's elevation.
    const gun = makeUnit("skiff", "player", base.x + 40, base.y - 24);
    const victim = makeUnit("worker", "ai", base.x + 62, base.y);
    victim.hp = 1e6;
    victim.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.units.set(victim.id, victim);

    let fired = 0;
    let prev = 0;
    let tracers = 0;
    let dropped = 0;
    let missBy = -1;
    let rise = 0;
    for (let t = 0; t < 200; t++) {
      const live = bridge.state.units.get(gun.id);
      if (live) issueAttack([live], victim.id);
      bridge.step(STEP_SECONDS);
      const now = bridge.state.units.get(gun.id)?.attackTimer ?? 0;
      if (now > prev + 1e-9) fired++;
      prev = now;
      const s = bridge.snapshot.shots;
      tracers += s.count;
      dropped += s.dropped;
      // Measured against where the Worker is standing on THIS tick — it walks, so a position read
      // after the loop would be a different place entirely.
      if (s.count > 0 && missBy < 0) {
        missBy = Math.hypot(s.toX[0]! - victim.x, s.toY[0]! - victim.y);
        rise = Math.abs(s.toY[0]! - s.fromY[0]!);
      }
    }

    expect(fired, "the ordered attack never fired — the scenario did not happen").toBeGreaterThan(5);
    // The order really is the only thing pinning the target: if this ever starts writing
    // `autoTarget`, the scenario has stopped being the one the row is about and this test would go
    // green for the wrong reason.
    expect(
      bridge.state.units.get(gun.id)?.autoTarget ?? null,
      "an ordered attack now writes autoTarget, so this no longer exercises the defect",
    ).toBeNull();
    expect(
      tracers,
      `the engine fired ${fired} ordered shots and ${tracers} tracers reached the view`,
    ).toBe(fired);
    expect(dropped, "an ordered shot landed on the dropped counter").toBe(0);
    expect(missBy, "no tracer at all").toBeGreaterThanOrEqual(0);
    expect(missBy, "the tracer ended somewhere other than the target it was ordered onto")
      .toBeLessThan(3);
    expect(rise, "the two ends came out on the same Y, so a shared-Y bug could not be seen here")
      .toBeGreaterThan(10);
  });

  it("drops nothing across every tick of a 120-unit fight, not just the last one", () => {
    // Two failures in one line. `dropped` is reset per extraction, so the old version of this test —
    // which read the counter once, after the loop — could only ever see the final tick and reported
    // zero while the run had really discarded four shots. Summed, the diff implementation drops 4
    // here (a dead target that was never in the previous tick's VISIBLE entity table, so `prevPos`
    // had no position for it) and this reads 0.
    const bridge = packedFight(30);
    let tracers = 0;
    let dropped = 0;
    let busiest = 0;
    for (let t = 0; t < 400; t++) {
      bridge.step(STEP_SECONDS);
      const s = bridge.snapshot.shots;
      busiest = Math.max(busiest, s.count);
      // Every row is read, not just counted. A table that never grew would keep incrementing `count`
      // past its capacity — typed-array writes past the end are silently discarded — and hand the
      // view `undefined` for a coordinate while every total in this test still added up.
      for (let i = 0; i < s.count; i++) {
        expect(
          Number.isFinite(s.fromX[i]!) && Number.isFinite(s.fromY[i]!)
          && Number.isFinite(s.toX[i]!) && Number.isFinite(s.toY[i]!),
          `shot ${i} of ${s.count} on tick ${t} has no usable coordinates — the table did not grow`,
        ).toBe(true);
      }
      tracers += s.count;
      dropped += s.dropped;
    }
    expect(tracers, "400 ticks of a 120-unit brawl produced almost no tracers").toBeGreaterThan(300);
    expect(busiest, "no tick in this fight carried more than one shot").toBeGreaterThan(1);
    expect(
      dropped,
      `${dropped} shots could not be drawn across the run — ADR-0023 says this counter stays 0`,
    ).toBe(0);
  });

  it("draws every hit the engine announced, and exactly those", () => {
    // The whole claim, on the scene ADR-0017 measured: the tracer set IS the hit set, less whatever
    // fog suppresses. Measured at 622 hits over 400 ticks; the diff drew 620.
    const bridge = packedFight(60);
    const hits = hitLog(bridge);
    let tracers = 0;
    let suppressed = 0;
    for (let t = 0; t < 400; t++) {
      const before = hits.length;
      bridge.step(STEP_SECONDS);
      tracers += bridge.snapshot.shots.count;
      for (let i = before; i < hits.length; i++) {
        const h = hits[i]!;
        if (h.owner !== "player" && !isVisibleAt(bridge.state.fogs.player, h.fromX, h.fromY)) suppressed++;
      }
    }
    expect(hits.length, "the fight never happened").toBeGreaterThan(300);
    expect(
      tracers,
      `the engine announced ${hits.length} hits, ${suppressed} of them from ground the player cannot ` +
      `see, and ${tracers} tracers crossed`,
    ).toBe(hits.length - suppressed);
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
      "a shot was reported on the tick after firing — the table is latching rather than per-tick",
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
    // ADR-0017's point 4, and the measurement its whole design turned on: 12.9% of shots in a real
    // fight have a target that has already been removed by extraction time. It is answered here by
    // the event's own ordering — `attackHit` is pushed before `removeEntity` — rather than by a
    // `prevPos` fallback, so it needs no ordering rule inside the extractor and it is correct for a
    // target that was never visible on the previous tick, which the fallback was not.
    const { bridge, base } = world();
    const killer = makeUnit("lancer", "player", base.x + 40, base.y);
    const victim = makeUnit("worker", "ai", base.x + 60, base.y);
    bridge.state.units.set(killer.id, killer);
    bridge.state.units.set(victim.id, victim);
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
        expect(killingShot.toX, "the killing shot did not end where the target died").toBeCloseTo(vx, 0);
        expect(killingShot.toY).toBeCloseTo(vy!, 0);
      }
    }
    expect(killingShot, "the shot that killed the target never reached the view").not.toBeNull();
    expect(bridge.state.units.get(victim.id), "the victim should be dead by now").toBeUndefined();
  });

  it("still reports the shot whose SHOOTER dies on the same tick", () => {
    // The second loss ADR-0017 did not know it had, and the one it could not have counted: a shot
    // fired by an entity that is removed later in the same tick is invisible to any per-entity diff,
    // because there is no entity left to read a timer off. It never even reached `dropped`. Measured
    // at 1–3 shots per 600 in a packed fight; constructed deterministically here.
    const { bridge, base } = world();
    const doomed = makeUnit("skiff", "player", base.x + 30, base.y);
    const prey = makeUnit("worker", "ai", base.x + 55, base.y);
    prey.hp = 1e6;
    prey.maxHp = 1e6;
    const executioner = makeUnit("dreadnought", "ai", base.x + 20, base.y + 30);
    // Insertion order is update order, so the doomed shooter fires before its killer acts.
    bridge.state.units.set(doomed.id, doomed);
    bridge.state.units.set(prey.id, prey);
    bridge.state.units.set(executioner.id, executioner);

    for (let t = 0; t < 200; t++) {
      const d = bridge.state.units.get(doomed.id);
      const x = bridge.state.units.get(executioner.id);
      // Held on the edge of death with both weapons ready, so the tick the Dreadnought finally
      // closes to range is a tick on which the Skiff has certainly fired too.
      if (d && x) { d.hp = 1; d.attackTimer = 0; x.attackTimer = 0; }
      const wasAt = d ? { x: d.x, y: d.y } : null;
      bridge.step(STEP_SECONDS);
      if (bridge.state.units.get(doomed.id)) continue;

      const s = bridge.snapshot.shots;
      let mine = -1;
      for (let i = 0; i < s.count; i++) {
        if (s.owner[i] !== SNAP_PLAYER) continue;
        mine = Math.hypot(s.fromX[i]! - wasAt!.x, s.fromY[i]! - wasAt!.y);
      }
      expect(
        mine,
        "the shooter fired and was removed inside the same tick, and its shot vanished with it — " +
        "a per-entity diff cannot see this and does not count it as dropped either",
      ).toBeGreaterThanOrEqual(0);
      expect(mine, "a player tracer crossed, but not from where the dead Skiff was standing")
        .toBeLessThan(5);
      return;
    }
    throw new Error("the doomed shooter never died — the scenario did not happen");
  });

  it("draws one tracer for a splash weapon, however many it catches", () => {
    // `applySplash` runs right below the push and adds no second `attackHit` — it deals falloff
    // damage and pushes only `entityKilled` for whatever it finishes off. So one shot is one line
    // even when ten enemies take damage from it, which is what makes "a tracer per hit" a tracer
    // per shot. The impact RING is the cue that grows with the splash, and it is the same event's
    // `splashRadius` (P5-T15).
    const splash = (UNITS.colossus as { splash?: { radius: number } }).splash;
    expect(splash, "the Colossus stopped being the roster's splash weapon").toBeDefined();

    const { bridge, base } = world();
    const gun = makeUnit("colossus", "player", base.x + 30, base.y);
    bridge.state.units.set(gun.id, gun);
    for (let i = 0; i < 10; i++) {
      const v = makeUnit("worker", "ai", base.x + 120 + (i % 5) * 5, base.y + Math.floor(i / 5) * 5);
      v.hp = 1e6;
      v.maxHp = 1e6;
      bridge.state.units.set(v.id, v);
    }

    let sawAShot = false;
    let mostCaught = 0;
    for (let t = 0; t < 300; t++) {
      const hpBefore = new Map<string, number>();
      for (const u of bridge.state.units.values()) hpBefore.set(u.id, u.hp);
      bridge.step(STEP_SECONDS);
      const s = bridge.snapshot.shots;
      if (s.count === 0) continue;
      sawAShot = true;
      let caught = 0;
      for (const u of bridge.state.units.values()) {
        if (u.owner === "ai" && u.hp < (hpBefore.get(u.id) ?? 0) - 1e-9) caught++;
      }
      mostCaught = Math.max(mostCaught, caught);
      expect(s.count, "a splash shot drew more than one tracer — one shot, one line").toBe(1);
    }
    expect(sawAShot, "the Colossus never fired").toBe(true);
    expect(mostCaught, "the splash never caught more than the primary target, so this proves nothing")
      .toBeGreaterThan(1);
  });

  it("reports a turret's shots on the same path as a unit's", () => {
    // `performAttack` is "Shared by mobile units and turrets" and a static defence is not a unit, so
    // a tracer path that only ever walked `state.units` would leave a base defending itself silent.
    const { bridge, base } = world();
    const turret = makeBuilding("turret", "player", base.x + 200, base.y + 200);
    const raider = makeUnit("worker", "ai", base.x + 230, base.y + 200);
    raider.hp = 1e6;
    raider.maxHp = 1e6;
    bridge.state.buildings.set(turret.id, turret);
    bridge.state.units.set(raider.id, raider);

    let tracers = 0;
    for (let t = 0; t < 200; t++) {
      bridge.step(STEP_SECONDS);
      const s = bridge.snapshot.shots;
      for (let i = 0; i < s.count; i++) {
        expect(s.owner[i], "the turret's fire came out under the raider's colour").toBe(SNAP_PLAYER);
        expect(Math.hypot(s.fromX[i]! - turret.x, s.fromY[i]! - turret.y), "the line did not start at the turret")
          .toBeLessThan(2);
        tracers++;
      }
    }
    expect(tracers, "the turret's own shots never reached the view").toBeGreaterThan(2);
  });

  it("shows nothing fired where the player cannot see, and everything where they can", () => {
    // Written in two halves on purpose. The first draft asserted only that a VISIBLE enemy's fire
    // shows — which is true, and passes just as well with the fog gate deleted. Removing the gate
    // was mutation-tested and slipped straight through, so the half that actually pins the rule is
    // the one below it: a fight the player has never scouted must produce no tracers at all.
    const { bridge, base } = world();
    const m = bridge.state.map;

    const hx = m.width - 90;
    const hy = m.height - 90;
    const h1 = makeUnit("skiff", "ai", hx, hy);
    const h2 = makeUnit("skiff", "ai", hx + 14, hy);
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

    // Enough hit points to soak several shells: a Worker has 40 against the Colossus' 42, so at
    // stock HP the scenario is one tick long and proves nothing. Found by mutation-testing the gate
    // away and watching the test pass anyway.
    victim.maxHp = 4000;
    victim.hp = 4000;
    bridge.step(STEP_SECONDS);
    expect(bridge.state.units.get(victim.id), "the victim must survive to be shelled").toBeDefined();

    const hits = hitLog(bridge);
    let bridgeShots = 0;
    let sawHidden = false;
    for (let t = 0; t < 150; t++) {
      bridge.step(STEP_SECONDS);
      const live = bridge.state.units.get(gun.id);
      if (!live) break;
      if (!isVisibleAt(bridge.state.fog, live.x, live.y)) sawHidden = true;
      const s = bridge.snapshot.shots;
      for (let i = 0; i < s.count; i++) if (s.owner[i] === SNAP_AI) bridgeShots++;
    }

    expect(hits.length, "the Colossus never fired — the scenario did not happen").toBeGreaterThan(1);
    expect(sawHidden, "the Colossus was visible the whole time — nothing was being suppressed").toBe(true);
    expect(
      bridgeShots,
      `the engine landed ${hits.length} shells from outside the player's vision and ${bridgeShots} ` +
      `reached the view — each one a line pointing straight at the artillery`,
    ).toBe(0);
    // The gate must be the reason nothing was drawn. If these shots were instead being lost to a
    // malformed payload the count would also be zero, and the test would pass while proving nothing.
    expect(
      bridge.snapshot.shots.dropped,
      "the shells were discarded for want of an endpoint, not suppressed by fog",
    ).toBe(0);
  });

  it("counts a hit it cannot draw rather than swallowing it", () => {
    // ADR-0023 keeps ADR-0017's obligation and narrows it: the endpoints now arrive with the shot,
    // so the only way to lose one is a payload that does not carry them. A counter that stays 0 is
    // worth nothing unless it can move, so this moves it — an `attackHit` shaped the way a future
    // upstream attack path might push one, with the hit but not the shooter. Driven through the
    // real extractor with hand-written events, because the engine cannot be made to emit one.
    const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
    const extractor = new SnapshotExtractor(state.map);
    const base = state.map.bases.player;
    const fog = state.fogs.player;
    fog.visible.fill(0);                    // nothing in live vision, so the fog gate is armed
    const dark = { x: base.x + 400, y: base.y + 400 };
    const opts = { viewer: "player" as const, credits: 0, supplyUsed: 0, supplyCap: 0 };

    state.events.length = 0;
    state.events.push(
      { type: "attackHit", x: base.x + 10, y: base.y, owner: "player" },        // no origin
      { type: "attackHit", fromX: base.x, fromY: base.y, owner: "player" },     // no impact point
      // **The malformed one the fog would otherwise swallow.** The counter has to be reached before
      // the gate, or a payload defect on unseen ground reads as a suppressed shot and nobody hears
      // about it. Ordering the two the other way round survived the first draft of this test.
      { type: "attackHit", x: dark.x, y: dark.y, owner: "ai" },
      { type: "attackHit", x: base.x + 10, y: base.y, fromX: base.x, fromY: base.y, owner: "player" },
      // Well-formed, from ground the player cannot see: suppressed, and NOT counted as dropped.
      { type: "attackHit", x: dark.x, y: dark.y, fromX: dark.x + 5, fromY: dark.y, owner: "ai" },
    );

    const snap = extractor.extract(state, opts);
    expect(
      snap.shots.dropped,
      "an attackHit with half a line in it was skipped in silence — the tracer set can shrink unnoticed",
    ).toBe(3);
    expect(snap.shots.count, "the well-formed hit was not drawn, or a line was drawn from nowhere").toBe(1);

    // And the counter is per-tick, like every other field of this table. One that accumulated would
    // report a payload defect for the rest of the match after a single malformed event.
    state.events.length = 0;
    extractor.extract(state, opts);
    expect(snap.shots.dropped, "the dropped counter carried over into a clean tick").toBe(0);
  });

  it("allocates nothing across a long quiet stretch", () => {
    const { bridge } = world();
    const before = bridge.snapshot.shots.fromX;
    for (let t = 0; t < 60; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.shots.count).toBe(0);
    expect(bridge.snapshot.shots.fromX, "the shot table reallocated on idle ticks").toBe(before);
  });

  it("grows past its starting capacity rather than writing off the end of the buffer", () => {
    // ADR-0006's growth path, and the one failure mode a count-only test cannot see: a write past a
    // typed array's end is silently discarded, so a table that never grew would keep incrementing
    // `count` and hand the view `undefined` for every coordinate past index 63 while every total
    // still added up. The starting capacity is 64 and the busiest tick measured in a 120-unit fight
    // is 46, so this is driven through the extractor rather than through a fight.
    const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
    const extractor = new SnapshotExtractor(state.map);
    const base = state.map.bases.player;
    const N = 200;
    state.events.length = 0;
    for (let i = 0; i < N; i++) {
      state.events.push({
        type: "attackHit", x: base.x + i, y: base.y + 1, fromX: base.x, fromY: base.y, owner: "player",
      });
    }

    const snap = extractor.extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
    expect(snap.shots.count, "not every hit crossed").toBe(N);
    expect(snap.shots.capacity, "the table did not grow to hold them").toBeGreaterThanOrEqual(N);
    for (let i = 0; i < N; i++) {
      expect(snap.shots.toX[i], `shot ${i} came back with no endpoint — it was written off the end`)
        .toBeCloseTo(base.x + i, 3);
    }
  });
});

describe("the one shot ADR-0023 knowingly gives up", () => {
  it("draws nothing for the shell that sets off an armed Helium Bomb", () => {
    // Pinned rather than hidden, because it is a real regression against the diff and the diff drew
    // this one (measured: 1 tracer before, 0 after). `detonateIfAttacked` runs first in
    // `performAttack` and returns, so the shot resets a cooldown and announces no hit — there is
    // nothing to read. What the player still gets is every `entityKilled` the blast produces, across
    // a 190-unit radius, which is a far louder cue than a 150 ms line.
    //
    // The trade is argued in ADR-0023 §4. This test's job is to make the day it stops being one
    // shot a red build: the source sweep above catches a new early return, and this catches the
    // behaviour changing under it.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const st = bridge.state;
    const base = st.map.bases.player;
    const cc = makeBuilding("command", "player", base.x, base.y);
    cc.hp = 1e9;
    cc.maxHp = 1e9;
    st.buildings.set(cc.id, cc);
    bridge.step(STEP_SECONDS);

    const hits = hitLog(bridge);
    const gun = makeUnit("lancer", "player", base.x + 50, base.y);
    gun.hp = 1e9;                          // survive its own handiwork
    gun.maxHp = 1e9;
    gun.attackTimer = 3;                   // hold fire long enough for the bomb to be extracted once
    const bomb = makeUnit("heliumbomb", "ai", base.x + 90, base.y);
    (bomb as { armed?: boolean }).armed = true;
    st.units.set(gun.id, gun);
    st.units.set(bomb.id, bomb);
    bridge.step(STEP_SECONDS);

    // It has to be on screen the tick before, or "no tracer" would only mean "never seen".
    let onScreen = false;
    const e = bridge.snapshot.entities;
    for (let i = 0; i < e.count; i++) if (e.x[i] === bomb.x && e.y[i] === bomb.y) onScreen = true;
    expect(onScreen, "the bomb was never visible, so nothing is being given up here").toBe(true);

    let fired = 0;
    let prev = gun.attackTimer;
    let tracers = 0;
    let deaths = 0;
    for (let t = 0; t < 90; t++) {
      bridge.step(STEP_SECONDS);
      const now = st.units.get(gun.id)?.attackTimer ?? 0;
      if (now > prev + 1e-9) fired++;
      prev = now;
      tracers += bridge.snapshot.shots.count;
      deaths += bridge.snapshot.deaths.count;
    }

    expect(fired, "the Lancer never fired at the bomb").toBe(1);
    expect(st.units.get(bomb.id), "the bomb did not go off, so the fuze path was not taken").toBeUndefined();
    expect(hits.length, "the engine announced a hit after all — the early return has moved").toBe(0);
    expect(tracers, "a tracer was drawn for a shot the engine never announced").toBe(0);
    expect(deaths, "the blast produced no death cue either, which would make this shot truly silent")
      .toBeGreaterThan(0);
    expect(bridge.snapshot.shots.dropped, "an unannounced shot must not land on the payload counter")
      .toBe(0);
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
    // must not mean keeping them twice, or a long match accumulates every death it ever saw. Since
    // ADR-0023 the drain is load-bearing for tracers too: `extractShots` reads the same list.
    const { bridge, base } = world();
    const a = makeUnit("lancer", "player", base.x + 40, base.y);
    const b = makeUnit("worker", "ai", base.x + 60, base.y);
    b.hp = 1;
    bridge.state.units.set(a.id, a);
    bridge.state.units.set(b.id, b);
    for (let t = 0; t < 80; t++) bridge.step(STEP_SECONDS);

    expect(bridge.state.events.length, "the engine's own event list is growing unbounded").toBe(0);
    // And the snapshot reports only THIS tick's deaths and shots, not a running log.
    for (let t = 0; t < 5; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.deaths.count, "deaths accumulated across ticks instead of being per-tick").toBe(0);
    expect(bridge.snapshot.shots.count, "shots accumulated across ticks instead of being per-tick").toBe(0);
  });
});
