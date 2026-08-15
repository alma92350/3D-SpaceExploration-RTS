// P5-T15 — PARITY rows 66, 67 and 68: the three things the engine says about every landed hit.
//
// `combat.js` has pushed an `attackHit` event carrying `heavy`, `bonus` and `splashRadius` since
// the Phase 1 MVP — one commit, `4a5c169`, before Phase 3 was scoped — and nothing above the bridge
// has ever read it. ADR-0017 opens by saying no such event exists, PARITY §7.1 checked that against
// the source and it is false, and these three rows exist because of it.
//
// So the first describe below asserts the PREMISE against the vendored source, not against a
// comment. That is the same discipline `shots.test.ts` applies to the `attackTimer` invariant, and
// it is here for a sharper reason: a premise about this exact file, stated in an accepted ADR, was
// wrong for two phases and nothing caught it. A test that reads the source is what would have.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { SNAP_AI, SNAP_PLAYER, SnapshotExtractor } from "../../src/bridge/snapshot.js";
import {
  BUILDINGS, TERRAIN, UNITS, activeState, createGalaxy, isVisibleAt, issueAttack, makeBuilding,
  makeUnit, sampleTerrain,
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

/** Run until at least one impact crosses, and hand back everything that did. */
function collectImpacts(bridge: WorldBridge, ticks: number) {
  const rows: Array<{ x: number; y: number; owner: number; heavy: number; bonus: number; splash: number }> = [];
  for (let t = 0; t < ticks; t++) {
    bridge.step(STEP_SECONDS);
    const im = bridge.snapshot.impacts;
    for (let i = 0; i < im.count; i++) {
      rows.push({
        x: im.x[i]!, y: im.y[i]!, owner: im.owner[i]!,
        heavy: im.heavy[i]!, bonus: im.bonus[i]!, splash: im.splashRadius[i]!,
      });
    }
  }
  return rows;
}

describe("the premise ADR-0017 got wrong (PARITY §7.1)", () => {
  it("the engine really does push an attackHit, with all three payload fields", () => {
    // If this file stops emitting the event, or renames a field, three cues go silently blank and
    // every behavioural test below would simply observe zero impacts and could be read as "the
    // fight did not happen". This says which it was.
    expect(COMBAT_SRC, "combat.js no longer pushes an attackHit event at all").toMatch(/type:\s*"attackHit"/);
    for (const field of ["heavy", "bonus", "splashRadius", "fromX", "fromY", "owner"]) {
      expect(
        new RegExp(`\\b${field}\\s*:`).test(COMBAT_SRC),
        `attackHit no longer carries \`${field}\` — the cue built on it draws nothing and says nothing`,
      ).toBe(true);
    }
  });

  it("the three flags are still the engine's own questions, not ones this bridge could ask", () => {
    // The bridge copies them (ADR-0012 §5). This pins WHAT it is copying, so a future reader can
    // see that `heavy` is a fact about the ATTACKER's weapon — `def.bonusVsBuildings` — which the
    // snapshot has no access to and must never try to reconstruct from the target.
    expect(COMBAT_SRC).toMatch(/heavy:\s*!!\(def\.bonusVsBuildings\s*&&\s*target\.kind\s*===\s*"building"\)/);
    expect(COMBAT_SRC).toMatch(/bonus:\s*!!\(def\.bonusVs\s*&&\s*def\.bonusVs\[target\.type\]\)/);
    expect(COMBAT_SRC).toMatch(/splashRadius:\s*def\.splash\s*\?\s*def\.splash\.radius\s*:\s*undefined/);
  });
});

describe("row 66 — a siege hit reads heavier than a normal one", () => {
  it("marks a bonusVsBuildings weapon landing on a structure, and nothing else", () => {
    // The Breacher is the engine's own example: `bonusVsBuildings: 30`, and deliberately outside the
    // Skiff/Lancer/Bastion triangle so `bonus` cannot be what is being observed here.
    const breacher = UNITS.breacher as { bonusVsBuildings?: number; bonusVs?: Record<string, number> };
    expect(breacher.bonusVsBuildings, "the Breacher stopped being a siege unit").toBeGreaterThan(0);
    expect(breacher.bonusVs, "the Breacher gained a per-type counter, which muddies this test")
      .toBeUndefined();

    const { bridge, base } = world();
    const siege = makeUnit("breacher", "player", base.x + 30, base.y);
    const target = makeBuilding("habitat", "ai", base.x + 120, base.y);
    target.hp = 1e6;                       // survive long enough to be shelled repeatedly
    target.maxHp = 1e6;
    bridge.state.units.set(siege.id, siege);
    bridge.state.buildings.set(target.id, target);

    const rows = collectImpacts(bridge, 200).filter((r) => r.owner === SNAP_PLAYER);
    expect(rows.length, "the Breacher never landed a shell — the scenario did not happen")
      .toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.heavy, "a siege weapon hitting a building did not read as heavy").toBe(1);
      expect(r.bonus, "`bonus` is the per-type counter and the Breacher has none").toBe(0);
    }
  });

  it("does not mark the same weapon landing on a UNIT", () => {
    // `heavy` is `bonusVsBuildings && target.kind === "building"` — the second half is the whole
    // point, and a bridge that carried the weapon's flag rather than the event's would mark this.
    const { bridge, base } = world();
    const siege = makeUnit("breacher", "player", base.x + 30, base.y);
    const victim = makeUnit("worker", "ai", base.x + 120, base.y);
    victim.hp = 1e6;
    victim.maxHp = 1e6;
    bridge.state.units.set(siege.id, siege);
    bridge.state.units.set(victim.id, victim);

    const rows = collectImpacts(bridge, 200).filter((r) => r.owner === SNAP_PLAYER);
    expect(rows.length, "the Breacher never fired at the Worker").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.heavy, "a siege weapon reads as heavy against a unit, where it gets no bonus").toBe(0);
    }
  });
});

describe("row 67 — a counter-triangle hit telegraphs", () => {
  it("marks the matchup the engine's own bonusVs table names, from BOTH sides", () => {
    // The counter triangle is read out of the engine's table rather than typed in here: a Skiff
    // beats a Lancer beats a Bastion beats a Skiff, and if upstream re-points one of those this
    // test follows it instead of quietly asserting yesterday's balance.
    const counters = Object.entries(UNITS)
      .flatMap(([type, def]) => Object.keys((def as { bonusVs?: Record<string, number> }).bonusVs ?? {})
        .map((against) => [type, against] as const));
    expect(counters.length, "no unit in the roster has a bonusVs — there is no counter system to cue")
      .toBeGreaterThan(2);

    const [attackerType, victimType] = counters[0]!;
    const { bridge, base } = world();
    // Both sides armed and in range, so the *victim* shoots back with a weapon that has no bonus
    // against its attacker. One tick of one fight therefore produces marked and unmarked hits at
    // once, which is what makes the mark a contrast rather than a constant.
    const attacker = makeUnit(attackerType, "player", base.x + 30, base.y);
    const victim = makeUnit(victimType, "ai", base.x + 55, base.y);
    attacker.hp = 1e6; attacker.maxHp = 1e6;
    victim.hp = 1e6; victim.maxHp = 1e6;
    bridge.state.units.set(attacker.id, attacker);
    bridge.state.units.set(victim.id, victim);

    const rows = collectImpacts(bridge, 200);
    const bySide = { counter: rows.filter((r) => r.owner === SNAP_PLAYER), back: rows.filter((r) => r.owner === SNAP_AI) };
    expect(bySide.counter.length, `${attackerType} never hit ${victimType}`).toBeGreaterThan(0);
    expect(bySide.back.length, `${victimType} never hit back, so there is nothing to contrast with`)
      .toBeGreaterThan(0);

    for (const r of bySide.counter) {
      expect(r.bonus, `${attackerType} hitting ${victimType} is exactly the engine's bonusVs entry`).toBe(1);
    }
    const reciprocal = (UNITS[victimType] as { bonusVs?: Record<string, number> }).bonusVs?.[attackerType];
    expect(reciprocal, "the triangle became mutual, which would make the contrast below meaningless")
      .toBeUndefined();
    for (const r of bySide.back) {
      expect(r.bonus, `${victimType} shooting back has no bonus against ${attackerType} and must not cue one`)
        .toBe(0);
    }
  });
});

describe("row 68 — a splash impact ring at the weapon's own radius", () => {
  it("carries the attacker's def.splash.radius, unchanged", () => {
    // The Colossus is the first and only unit with splash. The number is asserted against the
    // engine's own def rather than against a literal, because the whole cue is "the ring is the
    // weapon's real reach" — a ring drawn at a number this side invented would be a picture of a
    // radius nothing takes damage inside.
    const splash = (UNITS.colossus as { splash?: { radius: number } }).splash;
    expect(splash?.radius, "the Colossus lost its splash — row 68 has no subject").toBeGreaterThan(0);

    const { bridge, base } = world();
    const gun = makeUnit("colossus", "player", base.x + 30, base.y);
    const victim = makeUnit("worker", "ai", base.x + 150, base.y);
    victim.hp = 1e6;
    victim.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.units.set(victim.id, victim);

    const rows = collectImpacts(bridge, 200).filter((r) => r.owner === SNAP_PLAYER);
    expect(rows.length, "the Colossus never fired").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.splash, "the impact ring is not the weapon's own radius").toBe(splash!.radius);
    }
  });

  it("reports 0 for a weapon with no splash, so a ring is never drawn where none exists", () => {
    const { bridge, base } = world();
    const gun = makeUnit("skiff", "player", base.x + 30, base.y);
    const victim = makeUnit("worker", "ai", base.x + 55, base.y);
    victim.hp = 1e6;
    victim.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.units.set(victim.id, victim);

    const rows = collectImpacts(bridge, 120).filter((r) => r.owner === SNAP_PLAYER);
    expect(rows.length, "the Skiff never fired").toBeGreaterThan(0);
    for (const r of rows) expect(r.splash, "a splashless weapon reported a radius").toBe(0);
  });

  it("puts a heavy siege shell and its splash on ONE row, because it is one hit", () => {
    // The Colossus is the case that decides the overlay's shape: `bonusVsBuildings: 25` AND
    // `splash`, so a shell on a building is heavy and splashing at once. Two rows for it would be
    // two positions and two clocks for one event.
    expect((UNITS.colossus as { bonusVsBuildings?: number }).bonusVsBuildings,
      "the Colossus stopped being a base-cracker").toBeGreaterThan(0);
    const { bridge, base } = world();
    const gun = makeUnit("colossus", "player", base.x + 30, base.y);
    const target = makeBuilding("habitat", "ai", base.x + 150, base.y);
    target.hp = 1e6;
    target.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.buildings.set(target.id, target);

    const rows = collectImpacts(bridge, 200).filter((r) => r.owner === SNAP_PLAYER);
    expect(rows.length, "the Colossus never shelled the Habitat").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.heavy, "the shell was not heavy").toBe(1);
      expect(r.splash, "the shell lost its splash on the way across").toBeGreaterThan(0);
    }
  });
});

describe("the fog rule, which is live vision at the impact point", () => {
  it("separates all three fog states on one and the same hit", () => {
    // The rule, isolated. One synthetic `attackHit` at three positions — visible, explored-but-not-
    // visible, and never seen — through the real extractor with the fog set by hand. Everything
    // else in this file drives the engine; this one exists because the middle state is what the
    // mutation to `extractDeaths`' rule would silently take, and reasoning about a fight is a poor
    // way to be sure which cell you are standing in.
    const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
    const extractor = new SnapshotExtractor(state.map);
    const fog = state.fogs.player;
    const at = (cx: number, cy: number) => ({ x: cx * 40 + 20, y: cy * 40 + 20, i: cy * fog.cols + cx });

    const seen = at(4, 4);
    const remembered = at(6, 4);
    const dark = at(8, 4);
    fog.visible.fill(0);
    fog.explored.fill(0);
    fog.visible[seen.i] = 1;
    fog.explored[seen.i] = 1;
    fog.explored[remembered.i] = 1;      // scouted an hour ago, nobody watching it now

    const hitAt = (p: { x: number; y: number }) => ({
      type: "attackHit", x: p.x, y: p.y, fromX: 0, fromY: 0,
      unitType: "colossus", owner: "player", heavy: false, bonus: true, splashRadius: 26,
    });
    state.events.length = 0;
    state.events.push(hitAt(seen), hitAt(remembered), hitAt(dark));

    const snap = extractor.extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
    expect(
      snap.impacts.count,
      "one of the three fog states let a hit through that should have been suppressed — visible " +
      "ground shows the hit, remembered ground must not (that is the DEATH rule), dark ground must not",
    ).toBe(1);
    expect(snap.impacts.x[0], "the wrong one of the three crossed").toBeCloseTo(seen.x, 3);
  });

  it("is reachable in a real game: a shell onto a mesa the player scouted and cannot see", () => {
    // Not a hypothetical. Every weapon in the roster out-sees its own range, so on flat ground a
    // hit always lands where the player can see — except under UPHILL CONCEALMENT, where a source
    // on low ground reveals a high-ground cell only to `UPHILL_FRAC` (0.55) of its sight. A
    // Colossus sees 210 and shoots 185, so between 116 and 185 it can shell a mesa it cannot see —
    // `combat.js` normally refuses to ACQUIRE such a target for exactly that reason, and an
    // explicitly ordered attack goes straight past that check, which is a player right-clicking a
    // building they scouted earlier.
    //
    // Run as an A/B on ONE fight: the same shells, the same positions, and the only thing that
    // changes is whether the player has eyes on the mesa. A one-sided version of this test would
    // pass just as well if the Colossus had never fired.
    const { bridge, base } = world();
    const terrain = bridge.state.map.terrain;
    const map = bridge.state.map;
    let mesa: { x: number; y: number } | null = null;
    let ledge: { x: number; y: number } | null = null;
    outer:
    for (let cy = 0; cy < Math.ceil(map.height / 40); cy++) {
      for (let cx = 0; cx < Math.ceil(map.width / 40); cx++) {
        const x = cx * 40 + 20;
        const y = cy * 40 + 20;
        if (sampleTerrain(terrain, x, y) !== TERRAIN[2]) continue;
        if (Math.hypot(x - base.x, y - base.y) < 500) continue;   // clear of the base's own sight
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const lx = x + Math.cos(ang) * 150;                     // 150: past 0.55x210, inside 185
          const ly = y + Math.sin(ang) * 150;
          if (lx < 60 || ly < 60 || lx > map.width - 60 || ly > map.height - 60) continue;
          if (sampleTerrain(terrain, lx, ly) === TERRAIN[2]) continue;
          mesa = { x, y };
          ledge = { x: lx, y: ly };
          break outer;
        }
      }
    }
    expect(
      mesa,
      "this world has no high ground far enough from the base to shell from low ground. The scenario " +
      "is a TERRAIN feature; if the generator changed, find another world rather than deleting this",
    ).not.toBeNull();

    // Scout the mesa, then leave. What is left is memory, which is what `extractDeaths` would honour.
    const scout = makeUnit("ranger", "player", mesa!.x, mesa!.y);
    bridge.state.units.set(scout.id, scout);
    bridge.step(STEP_SECONDS);
    bridge.state.units.delete(scout.id);
    bridge.step(STEP_SECONDS);
    const fog = bridge.state.fogs.player;
    const mesaCell = Math.floor(mesa!.y / 40) * fog.cols + Math.floor(mesa!.x / 40);
    expect(fog.explored[mesaCell], "the scout never explored the mesa").toBe(1);
    expect(isVisibleAt(fog, mesa!.x, mesa!.y), "the mesa is still under live vision").toBe(false);

    const target = makeBuilding("habitat", "ai", mesa!.x, mesa!.y);
    target.hp = 1e6;
    target.maxHp = 1e6;
    const gun = makeUnit("colossus", "player", ledge!.x, ledge!.y);
    bridge.state.buildings.set(target.id, target);
    bridge.state.units.set(gun.id, gun);

    /** Shell the mesa for `ticks`, re-issuing the order the engine clears, and count both sides. */
    const shell = (ticks: number) => {
      let fired = 0;
      let crossed = 0;
      let prev = bridge.state.units.get(gun.id)?.attackTimer ?? 0;
      for (let t = 0; t < ticks; t++) {
        const live = bridge.state.units.get(gun.id);
        if (live) issueAttack([live], target.id);
        bridge.step(STEP_SECONDS);
        const now = bridge.state.units.get(gun.id)?.attackTimer ?? 0;
        if (now > prev + 1e-9) fired++;                  // the engine's own "a shell went out"
        prev = now;
        const im = bridge.snapshot.impacts;
        for (let i = 0; i < im.count; i++) {
          if (Math.hypot(im.x[i]! - mesa!.x, im.y[i]! - mesa!.y) < 80) crossed++;
        }
      }
      return { fired, crossed };
    };

    const blind = shell(200);
    expect(blind.fired, "the Colossus never shelled the mesa — the scenario did not happen")
      .toBeGreaterThan(1);
    expect(
      blind.crossed,
      `${blind.crossed} of ${blind.fired} shells drew an impact on ground the player only REMEMBERS. ` +
      `That is the rule \`extractDeaths\` uses and it is wrong here: the mark names an enemy's ` +
      `position this instant, in fog nobody is watching`,
    ).toBe(0);

    // Now put eyes on it — a Habitat has sight and no weapon, so nothing about the fight changes
    // except what the player can see — and the identical shells must now all be drawn.
    const spotter = makeBuilding("habitat", "player", mesa!.x + 30, mesa!.y);
    bridge.state.buildings.set(spotter.id, spotter);
    bridge.step(STEP_SECONDS);
    expect(isVisibleAt(bridge.state.fogs.player, mesa!.x, mesa!.y), "the spotter did not reveal the mesa")
      .toBe(true);

    const watched = shell(200);
    expect(watched.fired, "the Colossus stopped firing once it had a spotter").toBeGreaterThan(1);
    expect(
      watched.crossed,
      "with the mesa in live vision the very same shells still drew nothing — the gate is not on " +
      "visibility at all, and the half above proves nothing",
    ).toBeGreaterThan(0);
  });

  it("shows a hit landing on the player's own unit even when the shooter is hidden", () => {
    // What this rule buys back, and it is worth naming: ADR-0017 filed "being shot from the dark
    // shows no cue" as a real cost of its own fog rule. The impact is gated on the target's ground,
    // and a player's own unit is always on ground they can see — so "something is hitting me and I
    // cannot see what" is now sayable, while the tracer that would point at the shooter is not.
    const { bridge } = world();
    const m = bridge.state.map;
    const py = m.height - 140;
    const px = 140;
    const victim = makeUnit("worker", "player", px, py);
    const gun = makeUnit("colossus", "ai", px + 180, py);   // sight 110 against a reach of 185
    victim.hp = 4000;
    victim.maxHp = 4000;
    bridge.state.units.set(victim.id, victim);
    bridge.state.units.set(gun.id, gun);
    bridge.step(STEP_SECONDS);

    let impacts = 0;
    let tracers = 0;
    let gunEverVisible = false;
    for (let t = 0; t < 150; t++) {
      bridge.step(STEP_SECONDS);
      const live = bridge.state.units.get(gun.id);
      if (live && isVisibleAt(bridge.state.fog, live.x, live.y)) gunEverVisible = true;
      const im = bridge.snapshot.impacts;
      for (let i = 0; i < im.count; i++) if (im.owner[i] === SNAP_AI) impacts++;
      const s = bridge.snapshot.shots;
      for (let i = 0; i < s.count; i++) if (s.owner[i] === SNAP_AI) tracers++;
    }
    expect(gunEverVisible, "the artillery was visible, so nothing is being suppressed").toBe(false);
    expect(impacts, "the player got no cue at all that something was hitting them").toBeGreaterThan(0);
    expect(tracers, "a tracer from the dark points straight at the artillery (ADR-0017 §4)").toBe(0);
  });
});

describe("the impact table keeps the snapshot's contracts", () => {
  it("is per-tick, never a running log", () => {
    const { bridge, base } = world();
    const a = makeUnit("skiff", "player", base.x + 30, base.y);
    const b = makeUnit("worker", "ai", base.x + 50, base.y);
    b.hp = 1e6;
    b.maxHp = 1e6;
    bridge.state.units.set(a.id, a);
    bridge.state.units.set(b.id, b);

    let sawSome = false;
    for (let t = 0; t < 120; t++) {
      bridge.step(STEP_SECONDS);
      if (bridge.snapshot.impacts.count > 0) sawSome = true;
      // A weapon cycles at least 17 ticks, so the table has to be empty far more often than not.
      expect(bridge.snapshot.impacts.count, "impacts accumulated across ticks").toBeLessThan(4);
    }
    expect(sawSome, "nobody hit anything in 120 ticks").toBe(true);
    bridge.state.units.delete(b.id);
    for (let t = 0; t < 5; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.impacts.count, "the table still holds hits after the fight ended").toBe(0);
  });

  it("allocates nothing across a long quiet stretch", () => {
    const { bridge } = world();
    const before = bridge.snapshot.impacts.x;
    for (let t = 0; t < 60; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.impacts.count).toBe(0);
    expect(bridge.snapshot.impacts.x, "the impact table reallocated on idle ticks").toBe(before);
  });

  it("carries the ATTACKER's owner, which is the shot's colour and not the target's", () => {
    const { bridge, base } = world();
    const gun = makeUnit("skiff", "ai", base.x + 40, base.y);
    const victim = makeUnit("worker", "player", base.x + 55, base.y);
    victim.hp = 1e6;
    victim.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.units.set(victim.id, victim);

    const rows = collectImpacts(bridge, 120);
    expect(rows.length, "the AI Skiff never hit the player's Worker").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.owner, "the hit was reported under the victim's colour").toBe(SNAP_AI);
    }
  });

  it("is the only combat feedback a manually ordered attack produces today", () => {
    // A finding, pinned on the half of it this row owns.
    //
    // `extractShots` resolves a tracer's endpoint from `unit.autoTarget`, and `combat.js` writes
    // that field ONLY in the auto-acquire branch — an explicit `order.type === "attack"` takes its
    // target straight off the order and never touches it. So a player right-clicking an enemy
    // (PARITY row 17, marked PRESENT) fires shells that draw no tracer at all and land on
    // `shots.dropped`, the counter ADR-0017 says must stay zero. Measured on this exact scenario:
    // **10 shots fired, 0 tracers, 10 dropped.**
    //
    // That belongs to row 63 and to ADR-0017, not here, so nothing below asserts the broken half —
    // pinning it would cement it. What is asserted is this row's own claim, which is what makes the
    // defect visible in the first place: the hit is reported, because it is READ off the engine's
    // event rather than derived, and the derivation is where the endpoint goes missing.
    const { bridge, base } = world();
    const gun = makeUnit("skiff", "player", base.x + 40, base.y);
    const victim = makeUnit("worker", "ai", base.x + 60, base.y);
    victim.hp = 1e6;
    victim.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.units.set(victim.id, victim);

    let impacts = 0;
    let fired = 0;
    let prev = 0;
    for (let t = 0; t < 200; t++) {
      const live = bridge.state.units.get(gun.id);
      if (live) issueAttack([live], victim.id);
      bridge.step(STEP_SECONDS);
      const now = bridge.state.units.get(gun.id)?.attackTimer ?? 0;
      if (now > prev + 1e-9) fired++;
      prev = now;
      impacts += bridge.snapshot.impacts.count;
      expect(bridge.state.units.get(gun.id)?.autoTarget ?? null,
        "an ordered attack now sets autoTarget — the tracer defect this test describes may be gone")
        .toBeNull();
    }
    expect(fired, "the ordered attack never fired").toBeGreaterThan(1);
    expect(
      impacts,
      "an explicitly ordered attack produced no impact either, which would leave the single most " +
      "common combat order in the game with no feedback of any kind",
    ).toBe(fired);
  });

  it("reports a turret's hits too — performAttack is shared", () => {
    // `combat.js` calls `performAttack` "Shared by mobile units and turrets", and a static defence
    // reads `attackTimer` on the same rule. A cue that only ever fired for units would leave a base
    // defending itself in total silence.
    expect((BUILDINGS.turret as { attack?: number }).attack, "the Sentinel Turret lost its weapon")
      .toBeGreaterThan(0);
    const { bridge, base } = world();
    const turret = makeBuilding("turret", "player", base.x + 20, base.y + 20);
    const raider = makeUnit("skiff", "ai", base.x + 60, base.y + 20);
    raider.hp = 1e6;
    raider.maxHp = 1e6;
    bridge.state.buildings.set(turret.id, turret);
    bridge.state.units.set(raider.id, raider);

    const rows = collectImpacts(bridge, 200).filter((r) => r.owner === SNAP_PLAYER);
    expect(rows.length, "the turret's own hits never reached the view").toBeGreaterThan(0);
  });
});
