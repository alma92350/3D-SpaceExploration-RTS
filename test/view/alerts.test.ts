// P3-T14 — the alert system: one alert per thing that happened, where it happened, gone when the
// player says so, and silent about anything they have not earned the right to know.
//
// Three of the row's four clauses are cheap. **"Exactly one alert" is the one with teeth**, because
// the engine does not emit one event per thing that happened — it emits one per casualty.
// `detonateBomb` pushes an `entityKilled` for every entity it caught, so the single blast in the
// first test below produces ELEVEN of them on one tick, at eleven distinct positions spread ~140
// world units across. An implementation with no coalescing rule passes every other test in this
// file and turns that into eleven identical rows in the HUD, which is how the *next* attack gets
// buried. That test is the file's reason for existing.
//
// **The fog half is the one that can pass while proving nothing, and here it very nearly did.** An
// alert built on `snap.deaths` inherits the bridge's explored-ground gate for free. So the obvious
// fog test — kill an AI unit in the dark, assert silence — passes just as happily with the gate
// deleted, because this layer's own owner filter had already dropped that death for a completely
// different reason. The test below therefore kills the PLAYER's own units in never-explored ground
// and extracts the identical tick twice, differing by one byte of fog. Deleting the `exploredAt`
// guard in `extractDeaths` turns it red; that was run, not assumed.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { SNAP_AI, SNAP_PLAYER, SnapshotExtractor, type Snapshot } from "../../src/bridge/snapshot.js";
import {
  ALERT_ATTACK, ALERT_BOMB, ALERT_MERGE_RADIUS, ALERT_WINDOW_SECONDS, AlertFeed,
} from "../../src/view/alerts.js";
import {
  BOMB_BLAST_RADIUS, BOMB_FUSE_DELAY, isExploredAt, isVisibleAt, makeBuilding, makeUnit, tick,
} from "../../src/engine/index.js";

const SEED = 20260814;

/** What the bridge passes; none of it is anything alerts read, but `extract` requires it. */
const EXTRACT = { viewer: "player" as const, credits: 0, supplyUsed: 0, supplyCap: 0 };

/** A world with the player's Command Center standing, one tick in. Same opening as bomb.test.ts. */
function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

/**
 * A player Helium Bomb with ten of the player's own Skiffs in a ring around it, 300 units from the
 * base and armed to go off on the next step.
 *
 * The ring is radius 70 for a measured reason: the falloff is `3000 × (15/d)²`, a Skiff has 72 hp,
 * so the lethal radius is ~97 — at 70 every one of them dies, and the eleven corpses are spread
 * 140 units apart, which is a real spatial spread rather than eleven rows at one point. Set 200
 * units out and half of them survive and the scenario silently stops being a massacre.
 *
 * `fuseUntil` is set by hand rather than through the `detonate` intent so the blast lands on a
 * known step — bomb.test.ts writes the same field the same way.
 */
function blastAmongOwnUnits() {
  const { bridge, base } = world();
  const at = { x: base.x + 300, y: base.y };
  const bomb = makeUnit("heliumbomb", "player", at.x, at.y);
  bridge.state.units.set(bomb.id, bomb);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const skiff = makeUnit("skiff", "player", at.x + Math.cos(a) * 70, at.y + Math.sin(a) * 70);
    bridge.state.units.set(skiff.id, skiff);
  }
  bridge.step(STEP_SECONDS);

  bomb.armed = true;
  bomb.fuseUntil = bridge.state.time;
  bridge.step(STEP_SECONDS);
  return { bridge, base, at };
}

/**
 * A snapshot-shaped stub carrying only the two tables and the clock the feed reads.
 *
 * The same trick `combat-feedback.test.ts` uses on the effect pool, and for the same reason: the
 * coalescing rule is arithmetic over positions and times, and driving it from a real match would
 * mean waiting for the engine to happen to kill something 400 units from something else.
 */
function feedTick(
  feed: AlertFeed,
  time: number,
  deaths: Array<{ x: number; y: number; owner?: number }> = [],
  bombs: Array<{ x: number; y: number; owner?: number; fuse?: number }> = [],
): void {
  const d = {
    count: deaths.length,
    x: Float32Array.from(deaths.map((e) => e.x)),
    y: Float32Array.from(deaths.map((e) => e.y)),
    owner: Uint8Array.from(deaths.map((e) => e.owner ?? SNAP_PLAYER)),
    isBuilding: new Uint8Array(deaths.length),
  };
  const b = {
    count: bombs.length,
    x: Float32Array.from(bombs.map((e) => e.x)),
    y: Float32Array.from(bombs.map((e) => e.y)),
    owner: Uint8Array.from(bombs.map((e) => e.owner ?? SNAP_AI)),
    fuse: Float32Array.from(bombs.map((e) => e.fuse ?? 2)),
  };
  feed.ingestTick({ time, deaths: d, bombs: b } as unknown as Snapshot);
}

describe("exactly one alert (P3-T14)", () => {
  it("turns one blast's eleven kills into a single alert, standing where the blast was", () => {
    // THE test. Eleven `entityKilled` events, one tick, eleven positions — the engine's own
    // behaviour, not a contrivance — and one thing that happened.
    const { bridge, at } = blastAmongOwnUnits();
    const deaths = bridge.snapshot.deaths;

    let mine = 0;
    const seen = new Set<string>();
    let spread = 0;
    for (let i = 0; i < deaths.count; i++) {
      if (deaths.owner[i] !== SNAP_PLAYER) continue;
      mine++;
      seen.add(`${deaths.x[i]!.toFixed(3)},${deaths.y[i]!.toFixed(3)}`);
      spread = Math.max(spread, Math.hypot(deaths.x[i]! - at.x, deaths.y[i]! - at.y));
    }
    expect(mine, "the blast killed nothing of the player's — there is no scenario here").toBe(11);
    expect(seen.size, "every corpse landed on the same point, so coalescing is untested").toBe(mine);
    expect(spread, "the casualties are stacked, not spread — the radius rule never fired")
      .toBeGreaterThan(60);

    const feed = new AlertFeed();
    feed.ingestTick(bridge.snapshot);

    expect(feed.count, `${mine} kills in one blast produced ${feed.count} alerts`).toBe(1);
    expect(feed.liveCount()).toBe(1);
    expect(feed.kind[0]).toBe(ALERT_ATTACK);
    expect(feed.events[0], "the alert dropped casualties instead of folding them").toBe(mine);
  });

  it("keeps the merge radius at least as wide as the engine's own blast", () => {
    // `ALERT_MERGE_RADIUS` is 190 because `BOMB_BLAST_RADIUS` is — the widest circle in which the
    // engine can kill an arbitrary number of things in a single tick. `view/` may not import the
    // engine, so the constant is duplicated there; this is the only place that can notice if
    // upstream widens the blast and the alert rule stops covering it.
    expect(
      ALERT_MERGE_RADIUS,
      "a blast can now kill wider than one alert coalesces — the rim of a detonation will split off",
    ).toBeGreaterThanOrEqual(BOMB_BLAST_RADIUS);
  });

  it("still tells the player about an attack somewhere else", () => {
    // The mutation-proof half of the pair. "Merge everything" passes the blast test perfectly.
    const feed = new AlertFeed();
    feedTick(feed, 0, [
      { x: 1000, y: 1000 },
      { x: 1000 + ALERT_MERGE_RADIUS * 0.9, y: 1000 },              // same fight
      { x: 1000 + ALERT_MERGE_RADIUS * 2.5, y: 1000 },              // a different one
    ]);
    expect(feed.count, "two attacks 475 units apart were reported as one").toBe(2);
    expect(feed.events[0], "the near pair did not merge — the radius is too small").toBe(2);
    expect(feed.events[1]).toBe(1);
  });

  it("measures the merge from the anchor, not from wherever the last casualty fell", () => {
    // A rule that re-anchored on each fold would walk an alert across the map one merge radius at
    // a time, and the camera would end up somewhere the fight never was.
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 0, y: 0 }]);
    feedTick(feed, 0.05, [{ x: ALERT_MERGE_RADIUS * 0.9, y: 0 }]);
    feedTick(feed, 0.1, [{ x: ALERT_MERGE_RADIUS * 1.8, y: 0 }]);
    expect(feed.count, "the alert crept along with the casualties").toBe(2);
    expect(feed.x[0], "the anchor moved").toBe(0);
  });

  it("stops absorbing when the window closes, so a base attacked again is told again", () => {
    // Measured from the FIRST event, deliberately. A window that slid forward on every casualty
    // would give a twenty-minute siege exactly one alert, raised once at the start.
    const feed = new AlertFeed();
    feedTick(feed, 100, [{ x: 500, y: 500 }]);
    feedTick(feed, 100 + ALERT_WINDOW_SECONDS - 0.05, [{ x: 500, y: 500 }]);
    expect(feed.count, "a second casualty inside the window opened its own alert").toBe(1);
    expect(feed.events[0]).toBe(2);

    feedTick(feed, 100 + ALERT_WINDOW_SECONDS + 0.05, [{ x: 500, y: 500 }]);
    expect(feed.count, "the same ground attacked after the window said nothing").toBe(1);
    expect(feed.events[0], "the new alert inherited the old one's tally").toBe(1);
    expect(feed.firstAt[0]).toBeCloseTo(100 + ALERT_WINDOW_SECONDS + 0.05, 5);
  });

  it("never folds a bomb warning into an attack standing on the same ground", () => {
    // The two call for opposite actions — "your units are dying here" versus "everything here dies
    // in four seconds" — and one merged row would recommend neither.
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 700, y: 700 }], [{ x: 700, y: 700 }]);
    expect(feed.count, "a countdown and a body count were reported as one event").toBe(2);
    expect([feed.kind[0], feed.kind[1]].sort()).toEqual([ALERT_ATTACK, ALERT_BOMB]);
  });

  it("raises one alert for a burning fuse, not one per tick, and does not tally the ticks", () => {
    // `snap.bombs` is state, not an event stream: P3-T10 chose `fuseUntil` over the `bombFused`
    // event precisely so the warning would outlive the single tick the event fires on. That makes
    // the same device present on all eighty ticks of its fuse. Without coalescing this is eighty
    // alerts; with coalescing but no `tally` rule it is one alert badged "×79", which reads as a
    // swarm and is really a stopwatch.
    const { bridge, base } = world();
    // 180 units out: a Command Center sees 220 and `BOMB_DETECT_RANGE` is 15, so this is the band
    // where the player can see the device and the engine will not light its fuse on its own.
    const bomb = makeUnit("heliumbomb", "ai", base.x + 180, base.y);
    bridge.state.units.set(bomb.id, bomb);
    bomb.armed = true;
    bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.bombs.count, "an armed enemy bomb leaked before its fuse was lit").toBe(0);

    bomb.fuseUntil = bridge.state.time + BOMB_FUSE_DELAY;
    const feed = new AlertFeed();
    let ticksWarned = 0;
    for (let t = 0; t < Math.floor(BOMB_FUSE_DELAY / STEP_SECONDS) - 1; t++) {
      bridge.step(STEP_SECONDS);
      if (bridge.snapshot.bombs.count > 0) ticksWarned++;
      feed.ingestTick(bridge.snapshot);
    }

    expect(ticksWarned, "the fuse was never actually in the table — nothing was coalesced")
      .toBeGreaterThan(60);
    expect(feed.count, `${ticksWarned} ticks of one fuse produced ${feed.count} alerts`).toBe(1);
    expect(feed.kind[0]).toBe(ALERT_BOMB);
    expect(feed.events[0], "the fuse's dwell time was counted as that many separate threats").toBe(1);
    expect(feed.lastAt[0], "the alert never noticed the fuse was still burning")
      .toBeGreaterThan(feed.firstAt[0]!);
  });
});

describe("positioned (P3-T14)", () => {
  it("carries the event's own position, not the player's base", () => {
    // An alert is a camera jump. Anchoring it on the base — the one position every alert
    // implementation has lying around — would send the player home while their outpost burns.
    const { bridge, at } = blastAmongOwnUnits();
    const feed = new AlertFeed();
    feed.ingestTick(bridge.snapshot);

    const i = feed.latest();
    expect(i, "no alert to position").toBeGreaterThanOrEqual(0);
    const fromBlast = Math.hypot(feed.x[i]! - at.x, feed.y[i]! - at.y);
    const fromBase = Math.hypot(
      feed.x[i]! - bridge.snapshot.map.baseX,
      feed.y[i]! - bridge.snapshot.map.baseY,
    );
    expect(fromBlast, "the alert is not at the blast").toBeLessThanOrEqual(ALERT_MERGE_RADIUS);
    expect(fromBase, "the alert was pinned to the base, not to the fight").toBeGreaterThan(200);
  });

  it("hands 'focus last alert' the newest one still asking for attention", () => {
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 0, y: 0 }]);
    feedTick(feed, 1, [{ x: 5000, y: 0 }]);
    const newest = feed.latest();
    expect(feed.x[newest]).toBe(5000);

    feed.dismiss(feed.id[newest]!);
    const next = feed.latest();
    expect(next, "dismissing the newest left the camera key pointing at nothing").toBeGreaterThanOrEqual(0);
    expect(feed.x[next], "a dismissed alert is still what the camera jumps to").toBe(0);

    feed.dismissAll();
    expect(feed.latest(), "an empty board still offered somewhere to jump to").toBe(-1);
    expect(feed.liveCount()).toBe(0);
    expect(feed.count, "dismissing freed the slots — see the resurrection test").toBe(2);
  });

  it("breaks a same-tick tie by which alert was raised last, not by the clock", () => {
    // Two attacks on one tick share `firstAt` to the last bit, so a timestamp comparison has no
    // answer and falls back to whatever order the pool happens to be in — which swap-remove
    // reorders. Ids are minted in order and are the only thing here that says "later".
    const feed = new AlertFeed();
    feedTick(feed, 4, [{ x: 0, y: 0 }, { x: 5000, y: 0 }]);
    expect(feed.firstAt[0], "the two alerts did not land on the same tick").toBe(feed.firstAt[1]);
    expect(feed.x[feed.latest()], "'last alert' picked the earlier of two simultaneous ones").toBe(5000);
  });
});

describe("dismissible (P3-T14)", () => {
  it("is idempotent, and knows an id it has never seen", () => {
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 100, y: 100 }]);
    const id = feed.id[0]!;

    expect(feed.dismiss(id)).toBe(true);
    expect(feed.dismiss(id), "dismissing twice was not the same as dismissing once").toBe(true);
    expect(feed.liveCount()).toBe(0);
    expect(feed.dismiss(id + 9999), "a stranger's id was accepted").toBe(false);
    expect(feed.dismiss(0)).toBe(false);
  });

  it("does not come back on the next tick from the same fight", () => {
    // The trap the row names. A pool that FREES a dismissed slot passes every other test here: the
    // next casualty of the same battle, fifty milliseconds later at the same spot, finds nothing to
    // fold into and opens a fresh alert. A dismissal that lasts one tick is worse than none, since
    // the player learns the button does not work.
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 800, y: 800 }]);
    feed.dismiss(feed.id[0]!);

    for (let t = 1; t < 40; t++) feedTick(feed, t * 0.05, [{ x: 800 + t, y: 800 }]);

    expect(feed.count, "the dismissed alert was resurrected by the fight that raised it").toBe(1);
    expect(feed.liveCount(), "a dismissed alert came back to life").toBe(0);
    expect(feed.dismissed[0]).toBe(1);
    expect(feed.events[0], "the tombstone stopped absorbing, which is how it would have split")
      .toBe(40);
  });

  it("raises a fresh alert once the window has closed, dismissal or not", () => {
    // The other half: a tombstone must not silence that ground forever. Being attacked again a
    // minute later is news, and the player dismissed the first attack, not the place.
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 800, y: 800 }]);
    feed.dismiss(feed.id[0]!);
    feedTick(feed, ALERT_WINDOW_SECONDS + 0.05, [{ x: 800, y: 800 }]);

    expect(feed.count, "the tombstone outlived its window").toBe(1);
    expect(feed.liveCount(), "the second attack was swallowed by the first one's dismissal").toBe(1);
    expect(feed.dismissed[0]).toBe(0);
  });
});

describe("fog: nothing the player has not earned (P3-T14)", () => {
  it("says nothing about the player's OWN losses in ground that was never explored", () => {
    // The identical tick, extracted twice, differing in one byte of fog.
    //
    // The player's own casualties, not the AI's, and that is the whole design of this test. An AI
    // death is dropped by this layer's owner filter before fog is ever consulted, so a fog test
    // built on one passes whether the bridge gates or not — which is exactly the shape of test this
    // repo has caught proving nothing before. A player unit is the case where the fog gate is the
    // ONLY thing standing between the event and an alert.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const state = bridge.state;
    const base = state.map.bases.player;
    const cc = makeBuilding("command", "player", base.x, base.y);
    state.buildings.set(cc.id, cc);

    // The far corner, where the base's vision does not reach.
    const far = { x: state.map.width - 130, y: state.map.height - 130 };
    const bomb = makeUnit("heliumbomb", "player", far.x, far.y);
    state.units.set(bomb.id, bomb);
    const skiff = makeUnit("skiff", "player", far.x + 30, far.y);
    state.units.set(skiff.id, skiff);

    // The engine's own tick rather than `bridge.step`, for one reason: `step` drains `state.events`
    // when it is done, and this test needs to extract the SAME tick's events a second time.
    state.events.length = 0;
    tick(state, STEP_SECONDS);
    bomb.armed = true;
    bomb.fuseUntil = state.time;
    state.events.length = 0;
    tick(state, STEP_SECONDS);

    const killed = state.events.filter((e) => e.type === "entityKilled");
    expect(killed.length, "nothing died — the scenario did not happen").toBe(2);
    expect(killed.every((e) => e.owner === "player"), "these are not the player's losses").toBe(true);

    const extractor = new SnapshotExtractor(state.map);
    expect(isExploredAt(state.fog, far.x, far.y), "the corner was dark all along").toBe(true);

    // Control: the player's own units lit that corner, so the deaths are theirs to hear about.
    const lit = new AlertFeed();
    lit.ingestTick(extractor.extract(state, EXTRACT));
    expect(lit.count, "a loss in ground the player was standing in raised no alert").toBe(1);
    expect(lit.events[0]).toBe(2);

    // The same events, the same tick, in ground the player has never set foot in.
    state.fog.explored.fill(0);
    state.fog.visible.fill(0);
    expect(isExploredAt(state.fog, far.x, far.y)).toBe(false);
    expect(isVisibleAt(state.fog, far.x, far.y)).toBe(false);

    const dark = new AlertFeed();
    dark.ingestTick(extractor.extract(state, EXTRACT));
    expect(dark.count, "a kill in unexplored ground announced itself to the player").toBe(0);
  });

  it("says nothing about the AI's losses in ground the player merely remembers", () => {
    // The gate this layer adds on top of the bridge's, and the reason the owner filter is not just
    // tidiness. `extractDeaths` gates on EXPLORED, not visible — deliberately, so a death flash
    // still plays on ground the player scouted once (P3-T07). A flash is decoration. A HUD row
    // reading "fighting here" is a live report from territory the player cannot currently see, and
    // it would tell them the AI is losing units to something, somewhere they have no eyes.
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const state = bridge.state;
    const base = state.map.bases.player;
    const cc = makeBuilding("command", "player", base.x, base.y);
    state.buildings.set(cc.id, cc);

    // Scout a patch, then lose the scout: explored stays, visible does not.
    const spot = { x: base.x + 420, y: base.y };
    const scout = makeUnit("skiff", "player", spot.x, spot.y);
    state.units.set(scout.id, scout);
    state.events.length = 0;
    tick(state, STEP_SECONDS);
    state.units.delete(scout.id);
    state.events.length = 0;
    tick(state, STEP_SECONDS);
    expect(isExploredAt(state.fog, spot.x, spot.y), "the patch was never scouted").toBe(true);
    expect(isVisibleAt(state.fog, spot.x, spot.y), "the player can still see it — no memory involved")
      .toBe(false);

    const bomb = makeUnit("heliumbomb", "ai", spot.x, spot.y);
    state.units.set(bomb.id, bomb);
    const victim = makeUnit("skiff", "ai", spot.x + 25, spot.y);
    state.units.set(victim.id, victim);
    bomb.armed = true;
    bomb.fuseUntil = state.time;
    state.events.length = 0;
    tick(state, STEP_SECONDS);

    const snap = new SnapshotExtractor(state.map).extract(state, EXTRACT);
    expect(snap.deaths.count, "the AI's deaths never crossed the bridge, so nothing is being filtered")
      .toBe(2);
    for (let i = 0; i < snap.deaths.count; i++) expect(snap.deaths.owner[i]).toBe(SNAP_AI);

    const feed = new AlertFeed();
    feed.ingestTick(snap);
    expect(feed.count, "the player was told about a fight in ground they cannot see").toBe(0);
  });

  it("says nothing about the player's own bomb, armed or lit", () => {
    // The player's own armed device shows its rings unconditionally (P3-T10) — it is a planning
    // tool, and mostly a picture of their own units standing in it. An alert for it would fire on
    // the player's own deliberate act, every tick, for as long as they left it armed.
    const { bridge, base } = world();
    const bomb = makeUnit("heliumbomb", "player", base.x + 260, base.y);
    bridge.state.units.set(bomb.id, bomb);
    bomb.armed = true;
    bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.bombs.count, "the player's own armed bomb is not even in the table").toBe(1);

    const feed = new AlertFeed();
    feed.ingestTick(bridge.snapshot);
    expect(feed.count, "the player was warned about their own bomb").toBe(0);

    bomb.fuseUntil = bridge.state.time + BOMB_FUSE_DELAY;
    bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.bombs.fuse[0], "the fuse never lit").toBeGreaterThan(0);
    feed.ingestTick(bridge.snapshot);
    expect(feed.count, "the player was warned about a fuse they lit themselves").toBe(0);
  });

  it("refuses an unlit enemy device even if one ever reaches the table", () => {
    // The bridge does not hand over an unlit enemy bomb today, so this rule cannot be reached
    // through a real match — which is exactly why it is asserted against a hand-built table. The
    // alert means "this is counting down". An armed-but-untripped enemy device is a ring, not a
    // countdown, and the two must not collapse into one row if the bridge's rule ever widens.
    const feed = new AlertFeed();
    feedTick(feed, 0, [], [{ x: 400, y: 400, owner: SNAP_AI, fuse: -1 }]);
    expect(feed.count, "an enemy bomb that is not counting down raised a countdown").toBe(0);

    feedTick(feed, 0.05, [], [{ x: 400, y: 400, owner: SNAP_AI, fuse: 3.5 }]);
    expect(feed.count, "a lit enemy fuse raised nothing — the rule rejects everything").toBe(1);
  });
});

describe("the pool (ADR-0006)", () => {
  it("allocates nothing once it has grown, across a long running fight", () => {
    // The alert feed is not on the per-frame path — it ingests on a tick — but its `retire` loop is
    // the same swap-remove `effects.ts` needed, and the naive version of that loop is a `filter`.
    // A quiet run would prove nothing here, so the fight below keeps four fronts alight for 600
    // ticks with alerts continually expiring and re-opening underneath.
    const feed = new AlertFeed(4);

    // Warm up past the ONE legitimate growth: forty attacks in forty separate places, which is
    // more distinct fronts than a real match has and is here only to force the ensure.
    const scatter = Array.from({ length: 40 }, (_, i) => ({ x: (i % 8) * 400, y: Math.floor(i / 8) * 400 }));
    feedTick(feed, 0, scatter);
    expect(feed.count, "the warm-up did not actually grow the pool").toBe(40);

    const before = {
      id: feed.id, kind: feed.kind, x: feed.x, y: feed.y,
      firstAt: feed.firstAt, lastAt: feed.lastAt, events: feed.events, dismissed: feed.dismissed,
    };

    let peak = 0;
    let retired = false;
    for (let t = 1; t <= 600; t++) {
      const now = t * STEP_SECONDS;
      feedTick(feed, now, [
        { x: 100, y: 100 }, { x: 900, y: 100 }, { x: 100, y: 900 }, { x: 900, y: 900 },
      ]);
      peak = Math.max(peak, feed.count);
      if (feed.count < 40) retired = true;
      if (t % 97 === 0) feed.dismiss(feed.id[feed.latest()]!);
    }

    expect(peak, "no alert was ever live — 600 quiet ticks prove nothing").toBeGreaterThan(0);
    expect(retired, "nothing ever expired, so the compaction loop never ran").toBe(true);
    for (const [name, buffer] of Object.entries(before)) {
      expect(
        (feed as unknown as Record<string, unknown>)[name],
        `the alert pool reallocated \`${name}\` after warm-up — growth must be the ensure path only`,
      ).toBe(buffer);
    }
  });

  it("keeps live alerts and their tombstones when it does have to grow", () => {
    // Growth preserves contents here, unlike the snapshot's tables which are refilled from scratch.
    // Dropping on resize would take the tombstones with it, and a busy enough fight would re-raise
    // everything the player had just dismissed.
    const feed = new AlertFeed(2);
    feedTick(feed, 0, [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }]);
    expect(feed.count).toBe(3);
    const dismissedId = feed.id[1]!;
    feed.dismiss(dismissedId);

    feedTick(feed, 0.05, [{ x: 3000, y: 0 }, { x: 4000, y: 0 }, { x: 5000, y: 0 }]);
    expect(feed.count, "growth lost alerts that were still live").toBe(6);
    expect(feed.liveCount(), "growth resurrected a dismissed alert").toBe(5);
    const kept = feed.indexOf(dismissedId);
    expect(kept, "the tombstone was dropped by the resize").toBeGreaterThanOrEqual(0);
    expect(feed.dismissed[kept]).toBe(1);
  });

  it("compacts without keeping the dead or losing the survivor", () => {
    // Swap-remove has one classic bug and it is invisible from the outside: advancing past the slot
    // you just swapped a survivor INTO, so the entry copied down is never examined. It only shows
    // when two expired alerts are adjacent — the second gets a free tick of life, and with
    // `raise`'s window test living in `retire` alone, a casualty that tick would fold into an alert
    // whose window had already closed and silently extend it.
    //
    // This is the same hole `combat-feedback.test.ts` opened for the effect pool, and it survived a
    // first pass of thirteen mutations here before this test existed: every other assertion in the
    // file is green with the off-by-one in place, which is precisely the kind of test-shaped gap
    // that gets found the expensive way.
    const feed = new AlertFeed();
    feedTick(feed, 0, [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 4000, y: 0 }]);
    feedTick(feed, 5, [{ x: 6000, y: 0 }]);
    const survivor = feed.id[feed.indexOf(feed.id[3]!)]!;
    expect(feed.count).toBe(4);

    feedTick(feed, ALERT_WINDOW_SECONDS + 0.05, []);
    expect(feed.count, "an expired alert outlived its window because compaction skipped it").toBe(1);
    expect(feed.id[0], "compaction retired the survivor and kept a corpse").toBe(survivor);
    expect(feed.x[0]).toBe(6000);
  });

  it("does nothing at all on a quiet tick", () => {
    const feed = new AlertFeed();
    feedTick(feed, 0);
    expect(feed.count).toBe(0);
    expect(feed.latest()).toBe(-1);
    feed.clear();
    expect(feed.count).toBe(0);
  });
});
