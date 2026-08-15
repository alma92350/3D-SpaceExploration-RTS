// P5-T09 — the save/load panel, over P4-T09's round trip.
//
// **The round trip is not re-proved here.** `test/bridge/galaxy-save.test.ts` already hashes a
// deliberately-diverged galaxy field by field, per world, and steps a restored one for 400 further
// ticks. Repeating any of that would be a second, weaker copy of a proof that already exists. What
// this file proves is the four things the UI adds, each of which can be wrong while the round trip
// is perfect:
//
//   1. NOT A SECOND    the panel never serialises or deserialises — the save it lists is the one
//      IMPLEMENTATION  `bridge.save()` produced and the one `bridge.load()` takes back.
//   2. LISTING IS FREE describing a save must not LOAD it. `deserializeGalaxy` rewinds the engine's
//                      module-global entity-id counter, so the obvious implementation of "what is
//                      in this file?" would corrupt the session doing the asking. The hazard is
//                      demonstrated here rather than asserted, then shown absent from the panel.
//   3. UNTRUSTED       the list reads storage BEFORE `sanitizeSave` ever sees it (N-08). Nothing
//                      in the panel may throw on a hand-edited slot, and nothing may vanish from
//                      the list either — a row that is not shown is storage nobody can reclaim.
//   4. LEGIBLE         a slot id identifies nothing. Every number in a row is asserted against the
//                      live galaxy the save was taken from, so a renamed payload field is a red
//                      test naming the field rather than a list of zeroes.
//
// The mutation log is at the bottom.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { WorldBridge } from "../../src/bridge/world.js";
import {
  GALAXY_SAVE_VERSION, PLANETS, deployColonyShip, deserializeGalaxy, makeBuilding, makeUnit,
} from "../../src/engine/index.js";
import {
  type SaveStorage, SAVE_PREFIX, deleteSave, describeSave, formatAge, formatDuration, liveSummary,
  newSaveId, readCatalog, savePanelModel, writeSave,
} from "../../src/ui/save-panel.js";

const SEED = 20260814;
const SEAT = "helix";
const NOW = 1_760_000_000_000;

/* =================================================================================================
   A GALAXY WORTH SAVING, and a storage to keep it in
   ================================================================================================= */

/**
 * A bridge whose galaxy has actually been played: a base founded through the engine's own
 * `deployColonyShip`, a second world held, a treasury that is not the opening 500.
 *
 * The divergence matters for the same reason P4-T09's does, one layer up: a fresh galaxy's
 * description is all defaults, so a describer that read nothing at all would produce a row that
 * looks right.
 */
function played(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  const state = bridge.state;

  const ship = [...state.units.values()].find((u) => u.owner === "player" && u.type === "colonyship");
  expect(ship, "the opening world has no colony ship — the Odyssey opening has changed").toBeDefined();
  expect(deployColonyShip(state, ship!.id), "the opening colony ship would not deploy").toBeTruthy();

  // A second world held. Placed rather than settled through a jump: this file is about what the
  // panel SAYS about a save, and `test/bridge/galaxy-save.test.ts` already owns the question of
  // whether a jumped-to world survives one.
  const other = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
  const colony = bridge.galaxy.planets.get(other)!;
  const cc = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  cc.constructing = false;
  cc.buildProgress = 1;
  colony.buildings.set(cc.id, cc);

  bridge.galaxy.credits = 1340;
  for (let i = 0; i < 40; i++) bridge.step(STEP_SECONDS);
  return bridge;
}

/** A `Storage` that lives in a Map. jsdom is not needed for any claim in this file. */
class FakeStorage implements SaveStorage {
  readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }

  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }

  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }

  removeItem(k: string): void {
    this.data.delete(k);
  }
}

/** The browser persona `app/settings.ts` guards for: site data blocked, every access throws. */
const blockedStorage = (): SaveStorage => new Proxy({} as SaveStorage, {
  get() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
});

/** Safari's private mode: reads fine, refuses to write. The failure a save must never swallow. */
function fullStorage(quota: boolean): SaveStorage {
  const store = new FakeStorage();
  store.setItem = () => {
    throw quota
      ? new DOMException("exceeded the quota", "QuotaExceededError")
      : new DOMException("refused", "SecurityError");
  };
  return store;
}

const model = (bridge: WorldBridge, storage: SaveStorage, now = NOW) =>
  savePanelModel({ catalog: readCatalog(storage), galaxy: bridge.galaxy, now });

/** Save the live galaxy into `storage`, the way the shell would. */
function saveInto(bridge: WorldBridge, storage: SaveStorage, name: string, now = NOW): string {
  const id = newSaveId(now, readCatalog(storage));
  const result = writeSave({ id, name, payload: bridge.save(), now, storage });
  expect(result.ok, `the save was not stored: ${result.problem}`).toBe(true);
  return id;
}

const numericId = (id: string): number => Number.parseInt(id.slice(1), 10);

/* =================================================================================================
   1. THE ROUND TRIP IS P4-T09's
   ================================================================================================= */

describe("the panel is a drawer over the engine's save, not a second one (P5-T09)", () => {
  it("does not serialise or deserialise anything itself", () => {
    // Structural, because it is the row's actual rule and no behavioural test can see it: a panel
    // that rebuilt a galaxy from the payload would pass every other claim in this file.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "..", "src", "ui", "save-panel.ts"), "utf8")
      // Comments come out first: the header explains at length WHY it calls neither function, and a
      // scan that reads its own documentation as a violation is one people delete.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["serializeGalaxy", "deserializeGalaxy", "createGalaxy", "rehydrate"]) {
      expect(source.includes(banned), `save-panel.ts calls ${banned} — the round trip is P4-T09's`)
        .toBe(false);
    }
  });

  it("stores what the bridge saved and hands it back for the bridge to load", () => {
    const bridge = played();
    const storage = new FakeStorage();
    const before = { seat: bridge.worldId, credits: bridge.galaxyCredits, tick: bridge.galaxy.tick };
    saveInto(bridge, storage, "before the raid");

    // The session moves on, exactly as it would while a player thinks about it.
    bridge.galaxy.credits = 99;
    for (let i = 0; i < 60; i++) bridge.step(STEP_SECONDS);
    expect(bridge.galaxy.tick, "the galaxy did not advance, so a load could not be seen")
      .toBeGreaterThan(before.tick);

    const row = model(bridge, storage).rows[0]!;
    expect(row.canLoad, `the panel would not offer its own save: ${row.detail}`).toBe(true);
    const stored = readCatalog(storage).saves[0]!;
    expect(bridge.load(stored.payload), "the bridge refused the payload the panel listed").toBe(true);

    expect(bridge.worldId, "the seat did not come back").toBe(before.seat);
    expect(bridge.galaxyCredits, "credits did not come back").toBeCloseTo(before.credits, 6);
    expect(bridge.galaxy.tick, "the galaxy clock did not come back").toBe(before.tick);
  });

  it("keeps the payload byte-identical through storage", () => {
    // The panel wraps a save in an envelope for its name and timestamp. If the wrapping touched the
    // payload — a stray `JSON.parse` reviver, a merged default — the round trip would be ours and
    // no longer P4-T09's.
    const bridge = played();
    const storage = new FakeStorage();
    const payload = bridge.save();
    saveInto(bridge, storage, "identical");
    expect(readCatalog(storage).saves[0]!.payload).toEqual(payload);
  });
});

/* =================================================================================================
   2. LISTING A SAVE MUST NOT LOAD IT

   The hazard is real and module-global, so it is demonstrated first and then shown absent.
   ================================================================================================= */

describe("describing a save costs the running game nothing (P5-T09)", () => {
  it("does NOT rewind the entity-id counter, which loading one does", () => {
    const bridge = played();
    const storage = new FakeStorage();
    saveInto(bridge, storage, "counter");
    const payload = readCatalog(storage).saves[0]!.payload;

    // A unit minted now. Its id comes from the ONE module-global counter in `engine/state.js`.
    const before = makeUnit("skiff", "player", 100, 100);
    bridge.state.units.set(before.id, before);

    // Describing, repeatedly, through the whole public surface a panel would use.
    for (let i = 0; i < 3; i++) {
      const m = model(bridge, storage);
      expect(m.rows[0]!.canLoad, "the row stopped being loadable while being described").toBe(true);
      describeSave(payload);
    }

    const after = makeUnit("skiff", "player", 120, 100);
    expect(numericId(after.id), "the id counter moved backwards while the panel merely LISTED a save")
      .toBeGreaterThan(numericId(before.id));
    expect(bridge.state.units.has(after.id), "the new unit's id collides with one already standing")
      .toBe(false);

    // The anti-vacuity half: prove the hazard is not imaginary. `deserializeGalaxy` — the obvious
    // way to answer "what is in this save?" — rewinds the counter under the live session, and the
    // very next unit is minted on top of one already on the map.
    deserializeGalaxy(payload);
    const collided = makeUnit("skiff", "player", 140, 100);
    expect(
      numericId(collided.id),
      "deserializing no longer rewinds the id counter — the reason the panel avoids it has gone, " +
      "and the describe path could be simplified",
    ).toBeLessThan(numericId(after.id));
  });

  it("does not disturb the galaxy it is describing", () => {
    const bridge = played();
    const storage = new FakeStorage();
    saveInto(bridge, storage, "untouched");
    const snapshot = { tick: bridge.galaxy.tick, credits: bridge.galaxyCredits, seat: bridge.worldId };

    model(bridge, storage);
    model(bridge, storage);

    expect(bridge.galaxy.tick, "building the panel model stepped the galaxy").toBe(snapshot.tick);
    expect(bridge.galaxyCredits, "building the panel model moved the treasury").toBe(snapshot.credits);
    expect(bridge.worldId, "building the panel model moved the seat").toBe(snapshot.seat);
  });

  it("is a pure function of what it is given", () => {
    const bridge = played();
    const storage = new FakeStorage();
    saveInto(bridge, storage, "pure");
    expect(model(bridge, storage)).toEqual(model(bridge, storage));
  });
});

/* =================================================================================================
   3. A SAVE IS UNTRUSTED INPUT, AND THE LIST SEES IT FIRST
   ================================================================================================= */

/** Payloads the panel can see are hopeless: not an object, no version, no worlds to load. */
const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a number", 42],
  ["a string", "not a save"],
  ["an array", [1, 2, 3]],
  ["an empty object", {}],
  ["a version-shaped string", { v: "1", planets: [] }],
  ["the right version and nothing else", { v: GALAXY_SAVE_VERSION }],
  ["planets that are not a list", { v: GALAXY_SAVE_VERSION, planets: "nope" }],
  ["no planets at all", { v: GALAXY_SAVE_VERSION, planets: [] }],
];

/** Payloads that look like saves from the outside. The LOADER is what refuses these — see below. */
const OFFERED_BUT_DOOMED: ReadonlyArray<readonly [string, unknown]> = [
  ["planets full of rubbish", { v: GALAXY_SAVE_VERSION, planets: [null, 3, { buildings: "no" }] }],
  ["NaN everywhere", { v: GALAXY_SAVE_VERSION, planets: [{}], credits: NaN, galaxyTime: "soon" }],
  ["a world that does not exist", { v: GALAXY_SAVE_VERSION, worlds: ["atlantis"], planets: [{ planetId: "atlantis" }] }],
];

describe("the list survives whatever is in storage (N-08)", () => {
  it("describes junk without throwing, whatever shape it is", () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 500; i++) node = (node.next = {}) as Record<string, unknown>;

    for (const [what, payload] of [...REFUSED, ...OFFERED_BUT_DOOMED, ["500 levels deep", deep] as const]) {
      const description = (() => {
        try {
          return describeSave(payload);
        } catch (err) {
          throw new Error(`describeSave threw on ${what}: ${String(err)}`);
        }
      })();
      expect(Number.isFinite(description.credits), `${what} produced a non-numeric credit balance`)
        .toBe(true);
      expect(Number.isFinite(description.simSeconds), `${what} produced a non-numeric clock`).toBe(true);
      expect(typeof description.summary, `${what} produced no summary line`).toBe("string");
      expect(description.summary.length, `${what} produced an empty row`).toBeGreaterThan(0);
    }
  });

  it("refuses what it can see is not loadable, and says why in a sentence", () => {
    for (const [what, payload] of REFUSED) {
      const description = describeSave(payload);
      expect(description.loadable, `${what} was offered as loadable`).toBe(false);
      expect(description.problem, `${what} was refused with no reason a player could read`)
        .toBeTruthy();
    }
  });

  it("leaves the deeper judgement to the loader, which really does refuse", () => {
    // **The division of labour, made explicit.** The panel reads three things off a payload — the
    // version, that it is an object, that it carries worlds — because a ROW needs them anyway. It
    // does not walk the entity graph looking for trouble: that is `deserializeGalaxy`'s job, it is
    // the job P5-T09 forbids re-implementing, and a second opinion here would be a second thing to
    // keep in step with upstream. So these payloads ARE offered, and the cost of pressing Load on
    // one is nothing at all.
    const bridge = played();
    const before = bridge.galaxy.tick;
    for (const [what, payload] of OFFERED_BUT_DOOMED) {
      expect(describeSave(payload).loadable, `${what} — the panel is doing the loader's job`).toBe(true);
      expect(bridge.load(payload), `${what} was accepted by the loader`).toBe(false);
    }
    expect(bridge.galaxy.tick, "a refused load damaged the running galaxy").toBe(before);
    bridge.step(STEP_SECONDS);
    expect(bridge.galaxy.tick, "the session stopped stepping").toBeGreaterThan(before);
  });

  it("lists a slot it cannot read rather than hiding it", () => {
    // A row that vanishes is storage the player can neither see nor reclaim — and the panel is the
    // only place in this build that can delete one.
    const storage = new FakeStorage();
    storage.setItem(`${SAVE_PREFIX}broken`, "{ this is not json");
    storage.setItem(`${SAVE_PREFIX}half`, JSON.stringify({ name: "half", savedAt: NOW }));

    const bridge = played();
    const m = model(bridge, storage);
    expect(m.rows.map((r) => r.id).sort(), "an unreadable slot was dropped from the list")
      .toEqual(["broken", "half"]);
    for (const row of m.rows) {
      expect(row.canLoad, `${row.id} was offered despite being unreadable`).toBe(false);
      expect(row.detail.length, `${row.id} gave the player nothing to read`).toBeGreaterThan(0);
    }
    expect(deleteSave("broken", storage).ok, "an unreadable slot could not be deleted").toBe(true);
    expect(readCatalog(storage).saves.map((s) => s.id), "the delete did not remove the slot")
      .toEqual(["half"]);
  });

  it("does not let a save reach Object.prototype", () => {
    // `JSON.parse` puts `__proto__` on the object as an own property rather than following it, and
    // nothing in the describe path merges — but this is the assertion that keeps it that way, and
    // `sanitizeSave` (which rejects the key outright) does not run until the LOAD.
    const storage = new FakeStorage();
    storage.setItem(`${SAVE_PREFIX}nasty`, '{"save":{"__proto__":{"pwned":true},"v":1,"planets":[]}}');
    const bridge = played();

    model(bridge, storage);
    expect(({} as Record<string, unknown>).pwned, "describing a save polluted Object.prototype")
      .toBeUndefined();
  });

  it("ignores keys that are not saves", () => {
    const storage = new FakeStorage();
    // The settings store shares the origin and the naming convention, and is emphatically not a save.
    storage.setItem("odyssey3d.settings.v1", JSON.stringify({ tierOverride: "T1", edgeScroll: true }));
    storage.setItem("odyssey3d.onboarding.v1", "seen");
    storage.setItem("some-other-app", "{}");
    expect(readCatalog(storage).saves, "the panel claimed another key as a save").toEqual([]);
  });
});

/* =================================================================================================
   THE VERSION GATE — visible BEFORE the click
   ================================================================================================= */

describe("a save from another version fails visibly (P5-T09)", () => {
  it("lists it, refuses it, and names both versions", () => {
    const bridge = played();
    const storage = new FakeStorage();
    const payload = bridge.save() as Record<string, unknown>;

    storage.setItem(`${SAVE_PREFIX}future`, JSON.stringify({
      name: "from a later build", savedAt: NOW, save: { ...payload, v: GALAXY_SAVE_VERSION + 1 },
    }));
    storage.setItem(`${SAVE_PREFIX}versionless`, JSON.stringify(({ save: stripped(payload) })));

    const rows = model(bridge, storage).rows;
    expect(rows.length, "a save with the wrong version was hidden instead of refused").toBe(2);
    for (const row of rows) {
      expect(row.canLoad, `${row.id} was offered for loading`).toBe(false);
      expect(row.description.readable, `${row.id} was reported as unreadable rather than as old`)
        .toBe(true);
    }
    const future = rows.find((r) => r.id === "future")!;
    expect(future.detail, "the refusal does not name the save's own version")
      .toContain(`v${GALAXY_SAVE_VERSION + 1}`);
    expect(future.detail, "the refusal does not name the version this build reads")
      .toContain(`v${GALAXY_SAVE_VERSION}`);
  });

  it("is refusing what the loader would refuse, and the running game survives the attempt", () => {
    // The panel's `canLoad` is only worth anything if it agrees with the engine. This is the pair:
    // the loader really does reject it, and rejecting it really is free — which is WHY the panel
    // refusing up front is a legibility fix rather than a safety one.
    const bridge = played();
    const payload = bridge.save() as Record<string, unknown>;
    const before = { seat: bridge.worldId, tick: bridge.galaxy.tick, credits: bridge.galaxyCredits };

    for (const bad of [{ ...payload, v: GALAXY_SAVE_VERSION + 1 }, stripped(payload), { ...payload, planets: [] }]) {
      expect(describeSave(bad).loadable, "the panel offered a save the loader will not take").toBe(false);
      expect(bridge.load(bad), "the loader accepted a save the panel had refused").toBe(false);
    }

    expect(bridge.worldId, "a rejected load moved the seat").toBe(before.seat);
    expect(bridge.galaxy.tick, "a rejected load disturbed the galaxy clock").toBe(before.tick);
    expect(bridge.galaxyCredits, "a rejected load disturbed the treasury").toBe(before.credits);
    bridge.step(STEP_SECONDS);
    expect(bridge.galaxy.tick, "the session stopped stepping after a rejected load")
      .toBeGreaterThan(before.tick);
  });
});

/** A payload with no version stamp at all — a hand-written file, or something that is not a save. */
function stripped(payload: Record<string, unknown>): Record<string, unknown> {
  const { v: _dropped, ...rest } = payload;
  return rest;
}

/* =================================================================================================
   4. A ROW A HUMAN CAN TELL APART
   ================================================================================================= */

describe("a save row says which galaxy it is (P5-T09)", () => {
  it("reads every number off the save, and they are the galaxy's own", () => {
    // The anti-drift claim. Each of these is a field name in upstream's `galaxyPayload`; if one is
    // renamed, this fails naming the number rather than showing a row of zeroes.
    const bridge = played();
    const description = describeSave(bridge.save());

    expect(description.loadable, "a save this build just wrote was not loadable").toBe(true);
    expect(description.version, "the row does not carry the save's version").toBe(GALAXY_SAVE_VERSION);
    expect(description.seatId, "the seat was lost between the save and the row").toBe(bridge.worldId);
    expect(description.seatName, "the row shows a raw world id instead of the engine's own name")
      .toBe(PLANETS.find((p) => p.id === SEAT)!.name);
    expect(description.credits, "the credit balance is not the galaxy's").toBe(bridge.galaxyCredits);
    expect(description.simSeconds, "the sim clock is not the galaxy's").toBeCloseTo(bridge.galaxy.time, 6);
    expect(description.settledWorlds, "the settled-world count is not what the galaxy holds").toBe(2);
    expect(description.reachedWorlds, "the reached-world count was lost")
      .toBe(bridge.galaxy.discovered.size);
    expect(description.lanes, "the lane count was lost").toBe(bridge.galaxy.lanes.length);

    // …and the live-galaxy path agrees with the saved-payload path, which is what makes it safe for
    // the Save button to describe the galaxy without serialising it first.
    expect(liveSummary(bridge.galaxy), "the button and the row describe the same galaxy differently")
      .toBe(description.summary);
  });

  it("separates two saves of the same campaign", () => {
    // The whole point of the row. A bare id would be identical between these two, and a player
    // choosing which to load would be guessing.
    const bridge = played();
    const early = describeSave(bridge.save());

    bridge.galaxy.credits += 5_000;
    for (let i = 0; i < 400; i++) bridge.step(STEP_SECONDS);
    const late = describeSave(bridge.save());

    expect(late.summary, "two saves an interesting distance apart read identically")
      .not.toBe(early.summary);
    expect(late.simSeconds, "the later save does not read as later").toBeGreaterThan(early.simSeconds);
    expect(late.credits, "the treasury did not move between the two saves")
      .toBeGreaterThan(early.credits);
    expect(early.summary, "the summary does not name the world the player is standing on")
      .toContain(PLANETS.find((p) => p.id === SEAT)!.name);
  });

  it("does not describe an unplayed galaxy the way it describes a played one", () => {
    // The anti-vacuity check P4-T09's premise makes at length: a describer that read nothing would
    // produce the same row for both of these.
    const fresh = new WorldBridge({ seed: SEED, worldId: SEAT });
    const bridge = played();
    expect(describeSave(fresh.save()).summary, "a fresh galaxy reads the same as a played one")
      .not.toBe(describeSave(bridge.save()).summary);
    expect(describeSave(fresh.save()).settledWorlds, "a galaxy with no base reads as settled").toBe(0);
  });

  it("says how much play a load would throw away, and only when there is some", () => {
    const bridge = played();
    const storage = new FakeStorage();
    // Kept for the last claim in this test: a payload from EARLIER than the galaxy's clock, which
    // is the only kind that can produce a warning at all.
    const early = bridge.save() as Record<string, unknown>;
    saveInto(bridge, storage, "checkpoint");

    const justSaved = model(bridge, storage);
    expect(justSaved.unsavedSeconds, "a galaxy saved a moment ago reads as having unsaved play")
      .toBeCloseTo(0, 6);
    expect(justSaved.warning, "a warning was shown with nothing at stake").toBeNull();

    for (let i = 0; i < 600; i++) bridge.step(STEP_SECONDS);
    const later = model(bridge, storage);
    expect(later.unsavedSeconds, "the play since the last save was not measured").toBeGreaterThan(25);
    expect(later.warning, "the one thing that cannot be undone was not said before it happens")
      .toContain(formatDuration(later.unsavedSeconds));

    // …and a save this build cannot open is not a fallback. The payload is a genuinely OLD one —
    // ten minutes of play behind the live galaxy — so a model that counted unloadable saves would
    // measure the same gap the loadable one just produced and warn about a load nobody can perform.
    const stale = new FakeStorage();
    stale.setItem(`${SAVE_PREFIX}old`, JSON.stringify({
      name: "old", savedAt: NOW, save: { ...early, v: GALAXY_SAVE_VERSION + 1 },
    }));
    const staleModel = model(bridge, stale);
    expect(staleModel.rows[0]!.canLoad, "the stale save was offered, so this proves nothing").toBe(false);
    expect(staleModel.unsavedSeconds, "the unloadable save was treated as a checkpoint")
      .toBeCloseTo(bridge.galaxy.time, 6);
    expect(staleModel.warning, "a warning was shown for a save that cannot be loaded").toBeNull();
  });

  it("dates a row against the clock it is given, not the wall", () => {
    const bridge = played();
    const storage = new FakeStorage();
    saveInto(bridge, storage, "aged", NOW);
    expect(model(bridge, storage, NOW).rows[0]!.ageText).toBe("just now");
    expect(model(bridge, storage, NOW + 8 * 60_000).rows[0]!.ageText).toBe("8 minutes ago");
    expect(model(bridge, storage, NOW + 3 * 3_600_000).rows[0]!.ageText).toBe("3 hours ago");
    expect(formatAge(null, NOW), "a slot with no timestamp claimed one").toBe("unknown");
  });

  it("counts sim time the way a campaign is counted", () => {
    // Not `hud.ts`'s `formatClock`: an Odyssey runs for hours and "184:07" is not a duration.
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3600 + 4 * 60)).toBe("1h 04m");
    expect(formatDuration(Number.NaN), "a broken clock printed NaN into the list").toBe("0s");
  });
});

/* =================================================================================================
   THE STORE
   ================================================================================================= */

describe("the save store (P5-T09)", () => {
  it("lists newest first, whatever order storage enumerates in", () => {
    const bridge = played();
    const storage = new FakeStorage();
    const oldest = saveInto(bridge, storage, "oldest", NOW - 90_000);
    const newest = saveInto(bridge, storage, "newest", NOW);
    const middle = saveInto(bridge, storage, "middle", NOW - 45_000);

    expect(readCatalog(storage).saves.map((s) => s.id), "the list is not newest-first")
      .toEqual([newest, middle, oldest]);
    expect(model(bridge, storage).rows.map((r) => r.name)).toEqual(["newest", "middle", "oldest"]);
  });

  it("keeps two saves of the same moment apart", () => {
    const bridge = played();
    const storage = new FakeStorage();
    const first = saveInto(bridge, storage, "before the raid", NOW);
    const second = saveInto(bridge, storage, "before the raid, again", NOW);
    expect(second, "a second save in the same millisecond overwrote the first").not.toBe(first);
    expect(readCatalog(storage).saves.length).toBe(2);
  });

  it("refuses an id that would reach outside its own keys", () => {
    const storage = new FakeStorage();
    const evil = writeSave({ id: "../settings.v1", name: "x", payload: {}, now: NOW, storage });
    expect(evil.ok, "a slot id escaped the save prefix").toBe(false);
    expect(storage.data.size, "the refused write touched storage anyway").toBe(0);
  });

  it("truncates a name rather than letting it break the list", () => {
    const bridge = played();
    const storage = new FakeStorage();
    saveInto(bridge, storage, "x".repeat(500));
    expect(readCatalog(storage).saves[0]!.name.length).toBe(80);
  });

  it("reads a bare payload that arrived without our envelope", () => {
    // The shape a save imported from elsewhere has. It gets a row, named by its slot, rather than
    // being discarded for not being ours.
    const bridge = played();
    const storage = new FakeStorage();
    storage.setItem(`${SAVE_PREFIX}imported`, JSON.stringify(bridge.save()));

    const row = model(bridge, storage).rows[0]!;
    expect(row.canLoad, "a bare payload was not offered").toBe(true);
    expect(row.name, "a bare payload was not named at all").toBe("imported");
    expect(row.description.settledWorlds, "a bare payload was not described").toBe(2);
    expect(row.ageText, "a payload with no envelope claimed a save time").toBe("unknown");
  });

  it("says so when the browser is not storing anything", () => {
    // Persona P2's locked-down browser, where `localStorage` throws on ACCESS. `saveSettings` may
    // swallow that; a save may not — a Save button that quietly does nothing is the worst outcome
    // this panel could produce.
    const bridge = played();
    const storage = blockedStorage();
    const catalog = readCatalog(storage);
    expect(catalog.available, "blocked storage was reported as working").toBe(false);

    const m = savePanelModel({ catalog, galaxy: bridge.galaxy, now: NOW });
    expect(m.canSave, "the panel offered to save into storage it cannot reach").toBe(false);
    expect(m.storageProblem, "the player was told nothing about why saving is unavailable").toBeTruthy();
    expect(m.rows, "blocked storage produced phantom rows").toEqual([]);

    const write = writeSave({ id: "s1", name: "x", payload: bridge.save(), now: NOW, storage });
    expect(write.ok, "a write into blocked storage reported success").toBe(false);
    expect(write.problem, "a failed write gave no reason").toBeTruthy();
    expect(deleteSave("s1", storage).ok, "a delete from blocked storage reported success").toBe(false);
  });

  it("reports a full quota as something the player can act on", () => {
    // The distinction that matters: a quota failure is fixable in this very panel by deleting a
    // save, and a message that did not say so would send the player to look for a bug.
    const bridge = played();
    const full = writeSave({ id: "s1", name: "x", payload: bridge.save(), now: NOW, storage: fullStorage(true) });
    expect(full.ok).toBe(false);
    expect(full.problem, "a full store did not tell the player what to do").toMatch(/room|delete/i);

    const refused = writeSave({ id: "s1", name: "x", payload: bridge.save(), now: NOW, storage: fullStorage(false) });
    expect(refused.ok).toBe(false);
    expect(refused.problem, "a refused write was reported as a quota problem").not.toMatch(/room left/i);

    // A store that READS fine and refuses to write is still a readable list — the catalog must not
    // report itself unavailable just because the last write failed.
    expect(readCatalog(fullStorage(true)).available, "a readable store was reported unavailable")
      .toBe(true);
  });

  it("has no index to go stale", () => {
    // The list IS storage's keys. Remove the key behind the panel's back — devtools, another tab,
    // a browser clearing site data — and the row goes with it rather than dangling.
    const bridge = played();
    const storage = new FakeStorage();
    const id = saveInto(bridge, storage, "doomed");
    expect(model(bridge, storage).rows.length).toBe(1);

    storage.data.delete(SAVE_PREFIX + id);
    expect(model(bridge, storage).rows, "a deleted slot survived in an index").toEqual([]);
    expect(model(bridge, storage).canSave, "losing a slot made the panel think storage was gone")
      .toBe(true);
  });
});

/* =================================================================================================
   MUTATION LOG — every claim above was made to fail before it was kept.

   Seventeen mutations, each applied to `src/ui/save-panel.ts`, run against this file, and reverted
   (the source is byte-compared against a backup after every run). One SURVIVED and is written up
   below, because a surviving mutation means the test was wrong, not that the code was fine.

     • `loadable: problem === null` -> `loadable: true`          -> 4 red, incl. "a save with the
                                                                    wrong version was hidden instead
                                                                    of refused"
     • drop the version comparison from `problem`                -> 2 red, both version-gate claims
     • `settledWorlds` counts planets instead of Command Centers -> 3 red: "the settled-world count
                                                                    is not what the galaxy holds",
                                                                    plus the fresh-vs-played row
     • read `p.time` instead of `p.galaxyTime`                   -> 3 red — the drift a renamed
                                                                    payload field would cause, and
                                                                    the reason those numbers are
                                                                    asserted against a live galaxy
     • `describeSave` trusts a missing `v` as current            -> 2 red: the versionless payload
     • `readSlot` drops an unparsable slot instead of listing it -> 1 red: it vanishes from the list
     • `writeSave` swallows the storage failure (returns ok)     -> 2 red: blocked and full storage
     • `readCatalog` drops the prefix test                       -> 1 red: the settings key listed
                                                                    as a save
     • `newSaveId` returns the base id unconditionally           -> 1 red: two saves in the same
                                                                    millisecond, one slot
     • `SAFE_ID` accepts anything                                -> 1 red: `../settings.v1`
     • sort by `id` instead of `savedAt`                         -> 1 red: newest-first
     • drop the 80-character name clamp                          -> 1 red
     • `formatAge` uses `Date.now()` instead of the given `now`  -> 1 red: "8 minutes ago"
     • `liveSummary` counts every world as settled               -> 1 red: the live/saved agreement,
                                                                    which is what makes it safe for
                                                                    the Save button not to serialise
     • `warning` fires on unsaved play alone                     -> 1 red: the stale-save case
     • call `deserializeGalaxy` inside `describeSave` (the
       implementation this file exists to rule out)              -> 2 red: the id counter walks
                                                                    backwards while merely LISTING,
                                                                    and the structural scan names it

     • SURVIVED: `unsavedSeconds` counting unloadable saves as fallbacks. The stale-save case was
       built from a payload taken AFTER the run of steps, so its clock already matched the live
       galaxy's and the mutation had nothing to measure — the assertion was true for the wrong
       reason. Fixed by keeping a genuinely older payload (`early`) and asserting `unsavedSeconds`
       explicitly as well as the warning; the mutation then fails.
   ================================================================================================= */
