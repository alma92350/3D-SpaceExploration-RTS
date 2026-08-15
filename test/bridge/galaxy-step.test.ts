// What `WorldBridge.step` owes the galaxy (P4-T13).
//
// Two engine-side gaps belonged to the reachability row rather than to a screen, and both are here
// because both are about the STEP rather than about a panel:
//
//   • **`sweepColonies` was called by nothing.** `stepGalaxy` runs the worlds, the lanes and the
//     ~1 Hz galaxy scans and does not bank colony income — `test/ui/colony-panel.test.ts` opens by
//     asserting exactly that, and then says the sweep "is the app's to drive, and today nobody
//     drives it". So `COLONY_INCOME_PER_BUILDING` was a rate nobody banked and P4-T06's panel was
//     correctly reporting money that never arrived. The first two tests here are the other half of
//     that file's premise: the app drives it now, and the treasury moves.
//   • **`WorldBridge` had no `get galaxy()`.** Every Phase 4 screen is about the galaxy rather than
//     the seat, and the only way in was a guarded cast at the private field.
//
// The third test is the argument that let the sweep land without re-recording the determinism
// fixture, checked instead of asserted in a commit message: the sweep moves `galaxy.credits` and
// `galaxy.colonyNotes`, and `hashGalaxy` hashes neither.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { colonyIncomeModel } from "../../src/ui/colony-panel.js";
import { hashGalaxy } from "../determinism/replay.js";
import { createGalaxy, makeBuilding, stepGalaxy } from "../../src/engine/index.js";

const SEED = 20260814;
const SEAT = "helix";
const OPTIONS = { seed: SEED, startId: SEAT, difficulty: "medium", playerFaction: "frontier" };

/** A bridge whose first background colony carries `n` finished player buildings. */
function withColony(n = 3): { bridge: WorldBridge; colonyId: string } {
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  const colonyId = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
  place(bridge, colonyId, n);
  return { bridge, colonyId };
}

function place(bridge: WorldBridge, planetId: string, n: number): Building[] {
  const state = bridge.galaxy.planets.get(planetId)!;
  const base = state.map.bases.player;
  const out: Building[] = [];
  for (let i = 0; i < n; i++) {
    const b = makeBuilding("habitat", "player", base.x + 60 + i * 40, base.y + 60);
    b.constructing = false;
    b.buildProgress = 1;
    state.buildings.set(b.id, b);
    out.push(b);
  }
  return out;
}

describe("the colony sweep runs on the bridge's own step (P4-T13)", () => {
  it("banks a colony's income at the rate the panel reports", () => {
    const { bridge } = withColony();
    // The panel's own figure, read BEFORE the run: it is the number a player is shown, and the
    // point of this test is that the treasury and the panel are now the same claim.
    const rate = colonyIncomeModel(bridge.galaxy).perSecond;
    expect(rate, "the colony pays nothing, so this test would pass against a bridge that banked nothing")
      .toBeGreaterThan(0);

    const before = bridge.galaxyCredits;
    for (let i = 0; i < 20; i++) bridge.step(STEP_SECONDS);   // one sim second
    expect(bridge.galaxyCredits - before, "a sim second of colony income never reached the treasury")
      .toBeCloseTo(rate, 6);
  });

  it("pays nothing for a galaxy whose only world is the one you are standing on", () => {
    // The guard on the test above: `sweepColonies` skips every world that is not `background`, so a
    // bridge that paid for the seat as well would show up here rather than as a slightly-too-large
    // number in an assertion that uses the panel's own total on both sides.
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    for (const [id, state] of bridge.galaxy.planets) {
      if (id === SEAT) continue;
      for (const [bid, b] of [...state.buildings]) if (b.owner === "player") state.buildings.delete(bid);
    }
    place(bridge, SEAT, 6);                                  // six on the SEAT: past the cap, and unpaid
    const before = bridge.galaxyCredits;
    for (let i = 0; i < 20; i++) bridge.step(STEP_SECONDS);
    expect(bridge.galaxyCredits, "the world under your feet was paid colony income").toBe(before);
  });

  it("hands over a colony's news once, and drains it", () => {
    const { bridge, colonyId } = withColony();
    bridge.step(STEP_SECONDS);                               // the sweep records `hadColony`
    bridge.takeColonyNotes();

    const colony = bridge.galaxy.planets.get(colonyId)!;
    for (const [id, b] of [...colony.buildings]) if (b.owner === "player") colony.buildings.delete(id);
    bridge.step(STEP_SECONDS);

    const notes = bridge.takeColonyNotes();
    expect(notes.map((n) => n.type), `the colony's loss was never reported (${JSON.stringify(notes)})`)
      .toContain("lost");
    expect(notes.every((n) => n.planetId === colonyId)).toBe(true);
    // Drained, not latched: a notice shown once is a notice, and one that re-arrived every frame
    // would sit on the HUD forever.
    expect(bridge.takeColonyNotes(), "the same news arrived twice").toEqual([]);
  });
});

describe("the galaxy, and what the sweep is allowed to touch", () => {
  it("hands out the galaxy the seat belongs to", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    expect(bridge.galaxy.planets.get(bridge.worldId), "`galaxy` is not the galaxy `state` came from")
      .toBe(bridge.state);
    expect(bridge.galaxy.credits).toBe(bridge.galaxyCredits);
  });

  it("applies an intent queued behind a jump to the world the jump arrived on", () => {
    // `drain` used to read the seat ONCE and apply every queued intent to it. A jump is the one
    // intent that changes which world the next one belongs to, and it became reachable in this row —
    // so an order issued in the same frame as a jump (a click that lands while the confirm is being
    // pressed, or two intents from one recorded tick) would have been applied to the world the
    // player just left.
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    const dest = [...bridge.galaxy.planets.keys()].find((id) => id !== SEAT)!;
    for (let i = 0; i < 20; i++) bridge.step(STEP_SECONDS);   // let the neighbour put something down
    // A BUILDING on the destination, because a jump re-mints every rider's id and the AI's opening
    // units are spent within a tick or two — an id that has to survive the jump has to be a
    // structure's. Selecting an enemy entity is allowed (it is how a player inspects one); it is the
    // command path that filters to your own.
    const arrivals = bridge.galaxy.planets.get(dest)!;
    const local = [...arrivals.buildings.values()][0];
    expect(local, "the destination has nothing to select, so this test could not fail").toBeDefined();
    bridge.galaxy.credits = 20_000;
    // `canJumpTo` is not "do I have a Spaceport" — but with no pad and no foothold on the far side
    // it is false, and a refused jump would make the assertion below vacuous.
    const pad = makeBuilding("spaceport", "player", bridge.state.map.bases.player.x + 70, 500);
    pad.constructing = false;
    pad.buildProgress = 1;
    bridge.state.buildings.set(pad.id, pad);

    bridge.enqueue({ kind: "jump", destId: dest });
    bridge.enqueue({ kind: "select", ids: [local!.id], additive: false });
    bridge.step(STEP_SECONDS);

    expect(bridge.worldId, "the jump was refused, so the claim below is vacuous").toBe(dest);
    expect(bridge.state.selection, "the order behind the jump was applied to the world it left")
      .toEqual([local!.id]);
  });

  it("banks credits without moving anything the determinism digest hashes", () => {
    // **Why the fixture did not have to be re-recorded.** The sweep writes `galaxy.credits` and
    // `galaxy.colonyNotes` and drains each background world's `state.events`; `hashGalaxy` hashes
    // the seat id and every world's `hashState`, and credits were left out of it deliberately (see
    // `test/determinism/replay.ts`). So a galaxy stepped through the bridge must digest identically
    // to one stepped by `stepGalaxy` alone.
    //
    // Run in sequence rather than interleaved: the engine mints entity ids from a module-global
    // counter that `createGalaxy` re-seeds, which is the same reason `replay.test.ts` can replay one
    // fixture twice in one process and compare hashes.
    const swept = new WorldBridge({ seed: SEED, worldId: SEAT });
    place(swept, [...swept.galaxy.planets.keys()].find((id) => id !== SEAT)!, 3);
    for (let i = 0; i < 40; i++) swept.step(STEP_SECONDS);
    const sweptDigest = hashGalaxy(swept.galaxy);
    const sweptCredits = swept.galaxyCredits;

    const plain = createGalaxy(OPTIONS);
    const colonyId = [...plain.planets.keys()].find((id) => id !== SEAT)!;
    const colony = plain.planets.get(colonyId)!;
    const base = colony.map.bases.player;
    for (let i = 0; i < 3; i++) {
      const b = makeBuilding("habitat", "player", base.x + 60 + i * 40, base.y + 60);
      b.constructing = false;
      b.buildProgress = 1;
      colony.buildings.set(b.id, b);
    }
    for (let i = 0; i < 40; i++) stepGalaxy(plain, STEP_SECONDS);

    expect(sweptDigest, "the colony sweep moved something the determinism fixture hashes")
      .toBe(hashGalaxy(plain));
    // …and the sweep did something, or the line above would be a comparison of two runs that both
    // did nothing — the exact shape of green test this project keeps finding.
    expect(sweptCredits, "the sweep banked nothing, so the digest claim above is vacuous")
      .toBeGreaterThan(plain.credits);
  });
});
