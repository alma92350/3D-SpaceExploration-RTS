// The id codec: every namespace the engine mints, packed and unpacked (P5-T07).
//
// `numericId`/`engineId` are the whole reason the hot tables can be `Int32Array`s, and for five
// phases they were three lines that assumed every engine id was `<letter><digits>` and that only
// two letters existed. Neither assumption was true, and both failures were a dead click on the
// exact object the game had just told the player to click:
//
//   • `n7`, `u7` and `g7` all packed to 8, so the relief ship `checkGalaxyRescue` sends a
//     wiped-out player decoded as a unit that either did not exist or was somebody else. Covered
//     end to end, through a real wipeout and a real box-select, in `relief.test.ts`.
//   • Salvage and crater deposits are named off the entity that died there — `wreck-u12-ore`,
//     `crater-bomb3-ore` — so there was no number to parse, `parseInt` answered NaN, and an
//     `Int32Array` stores NaN as 0. Every wreck and every crater in the game shared the id 0 and
//     decoded to `n-1`. That is ADR-0018's whole feature, shipped in Phase 3, un-right-clickable.
//
// So this file tests the codec directly, and the property it must have is not "these examples work"
// but **injectivity**: no two ids the engine can mint may share an integer. The examples below are
// the shapes; the sweep is the claim.
//
// The engine's own comments are the reason to trust the namespaces rather than a scan of them —
// `engine/bomb.js` on `crater-${bomb.id}`: "so it can never collide with a map-generated node's
// n<N> id scheme — the two id spaces are namespaced apart by construction". The engine kept them
// apart; this client collapsed them; this file is what stops that happening a third time.

import { describe, expect, it } from "vitest";
import { engineId, isBuildingId, numericId } from "../../src/bridge/snapshot.js";

/** Every namespace the simulation mints, with a real example of each. */
const NAMESPACES = [
  { what: "unit", id: "u12", minter: "engine/state.js makeUnit → newId('u')" },
  { what: "building", id: "b7", minter: "engine/state.js makeBuilding → newId('b')" },
  { what: "map deposit", id: "n3", minter: "engine/map.js generateMap → `n${nid++}`" },
  { what: "galaxy entity", id: "g4", minter: "engine/galaxy.js checkGalaxyRescue / jumpCapital" },
  { what: "salvage deposit", id: "wreck-u12-ore", minter: "engine/wreckage.js `${site.id}-${com}`" },
  { what: "crater deposit", id: "crater-bomb3-ore", minter: "engine/bomb.js spawnCraterNode" },
];

describe("the id codec round-trips every namespace the engine mints", () => {
  for (const { what, id, minter } of NAMESPACES) {
    it(`round-trips a ${what} (${minter})`, () => {
      expect(engineId(numericId(id)), `${id} does not survive the round trip`).toBe(id);
    });
  }

  it("packs into an Int32Array without losing anything", () => {
    // The failure that hid for five phases was not in the arithmetic — it was in the STORE. NaN
    // reaching an Int32Array is silently 0, which is why this goes through the real container
    // rather than comparing numbers.
    const packed = new Int32Array(NAMESPACES.length);
    NAMESPACES.forEach(({ id }, i) => { packed[i] = numericId(id); });
    expect([...packed].map((n) => engineId(n))).toEqual(NAMESPACES.map((n) => n.id));
    expect([...packed].filter((n) => n === 0), "an id packed to 0 — the NaN store is back")
      .toEqual([]);
  });

  it("gives no two ids the same integer, across every namespace and 4000 counter values", () => {
    // The property, not the examples. A counter runs to 1000 in each numbered namespace and the two
    // opaque families get 1000 entries apiece, all in one set: a collision anywhere is a dead click
    // somewhere. 1000 is past anything a match reaches, and past `world:10` — the ordering bug
    // P5-T06 found is the same class of "two digits is a different case from one".
    const seen = new Map<number, string>();
    const add = (id: string): void => {
      const n = numericId(id);
      const clash = seen.get(n);
      expect(clash, `${id} and ${clash} both pack to ${n}`).toBeUndefined();
      seen.set(n, id);
      expect(engineId(n), `${id} packs to ${n} but unpacks to something else`).toBe(id);
    };
    for (let i = 0; i < 1000; i++) {
      add(`u${i}`);
      add(`b${i}`);
      add(`n${i}`);
      add(`g${i}`);
      add(`wreck-u${i}-ore`);
      add(`crater-bomb${i}-metals`);
    }
    expect(seen.size).toBe(6000);
  });

  it("packs a counter namespace's counter, rather than interning it", () => {
    // Found by mutation: deleting the `g` case makes every galaxy entity fall through to the intern
    // table, and every test above still passes — the round trip works, the sweep stays injective.
    // It is still wrong. Interning costs a `Map` entry per entity and a `Map` lookup per call, and
    // `numericId` runs for every entity and every node, every tick (ADR-0006). The intern table is
    // the fallback for ids with no counter to read, not a general answer.
    //
    // The observable difference is that interning is FIRST-SEEN order, so consecutive lookups come
    // out consecutive whatever the numbers say. Asserting the gap catches that without pinning the
    // band constants — which would be the ADR-0019 line-number guard all over again.
    for (const prefix of ["u", "b", "n", "g"]) {
      const gap = Math.abs(numericId(`${prefix}999`) - numericId(`${prefix}4`));
      expect(gap, `${prefix} ids are not packing their counter — interned?`).toBe(995);
    }
  });

  it("keeps buildings, and only buildings, on the negative side", () => {
    // `isBuildingId` is what lets one number carry both identity and kind — the snapshot has no
    // other channel for it. `jumpCapital` re-ids RIDERS only (`from.units.delete`/`dest.units.set`),
    // so no building ever carries a `g`; if that ever changes upstream, this is the test that says
    // the sign convention has to go.
    expect(isBuildingId(numericId("b0"))).toBe(true);
    expect(isBuildingId(numericId("b999"))).toBe(true);
    for (const id of ["u0", "u999", "n0", "g0", "g999", "wreck-u1-ore", "crater-bomb1-ore"]) {
      expect(isBuildingId(numericId(id)), `${id} reads as a building`).toBe(false);
    }
  });

  it("interns an unfamiliar namespace rather than answering NaN", () => {
    // What made the wreck bug expensive was that it failed SILENTLY: parseInt returned NaN, the
    // store turned it into 0, and every caller carried on. A namespace this client has not met
    // must round-trip too, or the next `${site.id}-${com}` scheme upstream invents lands the same
    // way — and this is not hypothetical, since `wreckage.js` builds node ids by concatenation.
    for (const id of ["x1", "swarm-7-alpha", "z", "n12x", "u"]) {
      expect(engineId(numericId(id)), `${id} did not survive`).toBe(id);
      expect(numericId(id), `${id} packed to the NaN store`).not.toBe(0);
    }
    expect(numericId("swarm-7-alpha"), "interning is not stable within a session")
      .toBe(numericId("swarm-7-alpha"));
  });

  it("survives a counter far past any band, rather than decoding as the wrong kind", () => {
    // The other mutation worth recording. A counter big enough to reach the next band's floor would
    // encode into it and come back as a different KIND — `g<band-1>` decoding as a node — and the
    // boundary test for that would have to hardcode the band constant, which is the ADR-0019
    // line-number guard again. So `numericId` interns anything that large instead, and the property
    // to assert is the general one: every counter round-trips, however absurd.
    //
    // With that guard the band edges are unreachable by construction, which makes `>` vs `>=` in
    // `engineId` genuinely equivalent. Recorded rather than papered over with a test that would
    // have to construct an id no engine can mint.
    for (const id of ["u16777215", "u16777216", "g16777215", "n16777216", "b16777216"]) {
      expect(engineId(numericId(id)), `${id} decoded as another kind`).toBe(id);
    }
    expect(numericId("u16777216"), "the overflow guard collides with a real unit")
      .not.toBe(numericId("g0"));
    // And the guard must not swallow a building: buildings are the one kind whose identity is
    // carried by the SIGN, so an interned one would come back positive and read as a unit.
    expect(isBuildingId(numericId("b16777216")), "a large building lost its kind to the guard")
      .toBe(true);
  });

  it("does not answer a confident `u-1` for the zero that used to mean NaN", () => {
    // Nothing encodes to 0 any more, so 0 can only arrive from an uninitialised slot. The old
    // decoder answered `u-1` for it, which reads exactly like a real id and is not one.
    expect(engineId(0)).toBe("");
  });
});
