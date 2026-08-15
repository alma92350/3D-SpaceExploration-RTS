// P4-T07 and P4-T08 at the bridge: the five galaxy intents, each refused exactly when the engine
// refuses it (ADR-0008 §3, ADR-0012 §5).
//
// These intents are the first in the union that act on the GALAXY rather than on the seat, and they
// are wiring in the strictest sense — `createLane`, `deleteLane`, `assignShipToLane`,
// `unassignShipFromLane` and `setColonyPolicy` are all upstream's, and `applyIntent` calls them and
// reports what they said. So the question this file asks is not "does the rule work" (the engine's
// own suite answers that) but **"is the bridge honest about it"**: does a refusal arrive as a
// refusal, does a clamp arrive as the engine's number rather than the player's, and does anything
// change when the engine says no.
//
// Two claims are worth stating in advance because they are the ones a reviewer would otherwise have
// to take on trust:
//
//   • **The bridge does not clamp.** `MAX_WORKER_TARGET` is applied by `sanitizePolicy` inside
//     `setColonyPolicy`, and `applyIntent` deliberately does not pre-check it. A request of 99 must
//     therefore come back as 20 *from the engine* — and the UI's job is to have SHOWN that first
//     (`policyPreview`, tested in `test/ui/colony-panel.test.ts`), not to have applied it.
//   • **A refused intent changes nothing.** Every refusal below asserts the galaxy afterwards, not
//     just the message. A refusal that half-happened is worse than one that did not happen at all.
//
// The last section drives the same intents through `WorldBridge`'s real queue rather than through
// `applyIntent` directly, because that is the path the game uses: enqueue, step, and the change has
// to be in the galaxy the bridge owns — observed through its own save, which is the only window it
// offers onto anything above the seat.

import { describe, expect, it } from "vitest";
import { applyIntent } from "../../src/bridge/commands.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import {
  MAX_WORKER_TARGET, UNITS,
  activeState, createGalaxy, getColonyPolicy, makeBuilding, makeUnit, playerSpaceports,
  sanitizePolicy, stagedRiders,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;
const SEAT = "helix";
/** Worlds this seed brings up in the background — a lane needs BOTH ends instantiated. */
const NEAR = "ferros";
const FAR = "nimbus";
/** In the roster, never instantiated. A lane cannot reach a world you have never been to. */
const DORMANT = "korrath";

interface Scene {
  galaxy: Galaxy;
  seat: State;
  pad: Building;
  hauler: Unit;
  /** A player unit at the pad that is not a freighter. Nothing may crew it onto a lane. */
  worker: Unit;
}

/**
 * The seat with a finished launch pad, a freighter standing on it, and a worker beside it.
 *
 * This is the shape the game actually produces a lane from: you build the pad and the freighter on
 * the world you are on, open the route, crew it, and *then* jump away — which is exactly the order
 * `test/bridge/galaxy-save.test.ts` builds its scenario in, and for the same reason (`stagedRiders`
 * skips a lane-booked ship, so crewing before the jump is what keeps the ship home).
 */
function scene(): Scene {
  const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
  const seat = activeState(galaxy);
  const base = seat.map.bases.player;

  const pad = makeBuilding("spaceport", "player", base.x, base.y);
  pad.constructing = false;
  pad.buildProgress = 1;
  seat.buildings.set(pad.id, pad);

  const hauler = makeUnit("hauler", "player", base.x + 30, base.y + 20);
  seat.units.set(hauler.id, hauler);
  const worker = makeUnit("worker", "player", base.x - 30, base.y + 20);
  seat.units.set(worker.id, worker);

  return { galaxy, seat, pad, hauler, worker };
}

/** Apply one intent through the bridge's own function and return the refusal, if any. */
const send = (s: Scene, intent: Parameters<typeof applyIntent>[1]): string | null =>
  applyIntent(s.seat, intent, s.galaxy);

const laneIds = (s: Scene) => s.galaxy.lanes.map((l) => l.id);
const laneOf = (u: Unit): string | undefined => (u as unknown as { laneId?: string }).laneId;

/* =================================================================================================
   LANES: OPENING AND CLOSING ONE
   ================================================================================================= */

describe("createLane / deleteLane through the bridge (P4-T07)", () => {
  it("opens a lane between two instantiated worlds, with the filter it was given", () => {
    const s = scene();
    expect(send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: ["ore", "crystals"] }))
      .toBeNull();

    expect(s.galaxy.lanes.length, "no lane was created").toBe(1);
    const lane = s.galaxy.lanes[0]!;
    expect(lane.from).toBe(SEAT);
    expect(lane.to).toBe(NEAR);
    expect(lane.commodities, "the commodity filter did not survive the intent").toEqual(["ore", "crystals"]);
    expect(lane.shipIds, "a new lane came with a crew").toEqual([]);
  });

  it("refuses a lane to nowhere, and creates nothing while doing it", () => {
    const s = scene();
    for (const [what, to] of [["a same-world lane", SEAT], ["a world never visited", DORMANT]] as const) {
      const err = send(s, { kind: "createLane", from: SEAT, to, commodities: [] });
      expect(err, `${what} was accepted`).not.toBeNull();
      expect(err, `the refusal for ${what} does not say a lane could not be opened`)
        .toMatch(/lane cannot be opened/i);
    }
    expect(s.galaxy.lanes, "a refused lane was created anyway").toEqual([]);

    // The dormant case is a real rule rather than a missing world: `korrath` is in the roster and
    // reachable by jump, it simply has no state yet — and a lane needs a stockpile at both ends.
    expect(s.galaxy.worlds, "the dormant world is not in the roster, so this tested nothing")
      .toContain(DORMANT);
    expect(s.galaxy.planets.has(DORMANT), "the dormant world is already instantiated").toBe(false);
  });

  it("closes a lane and hands its ships back to the jump", () => {
    // `deleteLane` clears `u.laneId` on every ship it held. That flag is what `stagedRiders` skips,
    // so a lane that was deleted without clearing it would leave a freighter permanently unable to
    // board a jump, with nothing on screen to explain why.
    const s = scene();
    send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: [] });
    const laneId = laneIds(s)[0]!;
    expect(send(s, { kind: "assignLane", laneId, unitId: s.hauler.id })).toBeNull();
    expect(ring(s), "the booked ship is still in the staging ring").not.toContain(s.hauler.id);

    expect(send(s, { kind: "deleteLane", laneId })).toBeNull();
    expect(s.galaxy.lanes, "the lane survived its own deletion").toEqual([]);
    expect(laneOf(s.hauler), "the freed ship still thinks it is on a lane").toBeUndefined();
    expect(ring(s), "the freed ship did not come back to the staging ring").toContain(s.hauler.id);
  });

  it("says nothing about deleting a lane that is already gone", () => {
    // Deliberate: `applyIntent` ignores `deleteLane`'s boolean. Closing a route twice — a double
    // click, or a click on a stale panel — is not an error the player needs read out to them.
    const s = scene();
    send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: [] });
    const laneId = laneIds(s)[0]!;
    expect(send(s, { kind: "deleteLane", laneId })).toBeNull();
    expect(send(s, { kind: "deleteLane", laneId }), "a second delete was reported as a failure").toBeNull();
    expect(send(s, { kind: "deleteLane", laneId: "lane999" }), "an unknown lane id was reported as a failure")
      .toBeNull();
  });
});

/* =================================================================================================
   LANES: CREWING ONE
   ================================================================================================= */

describe("assignLane / unassignLane through the bridge (P4-T07)", () => {
  it("crews a freighter standing at the pad, and takes it out of the jump", () => {
    const s = scene();
    // The premise every claim in this section rests on: a Hauler is a real cargo ship, which is the
    // only reason a lane will take one.
    expect(UNITS.hauler?.cargoHold, "the Hauler is no longer a cargo ship").toBeGreaterThan(0);
    send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: [] });
    const laneId = laneIds(s)[0]!;

    expect(ring(s), "the freighter is not staged at the pad, so this proves nothing").toContain(s.hauler.id);
    expect(send(s, { kind: "assignLane", laneId, unitId: s.hauler.id })).toBeNull();

    expect(s.galaxy.lanes[0]!.shipIds, "the lane did not record its crew").toEqual([s.hauler.id]);
    expect(laneOf(s.hauler), "the ship does not carry its own booking").toBe(laneId);
    // The consequence, through the engine's own function rather than through the panel: this ship
    // will not ride the next jump.
    expect(ring(s), "a lane-booked ship is still staged for the jump").not.toContain(s.hauler.id);
  });

  it("refuses every ship the engine refuses, and changes nothing when it does", () => {
    const s = scene();
    send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: [] });
    const laneId = laneIds(s)[0]!;

    // A ship parked out of the pad's catchment. Its distance is the only thing wrong with it.
    const adrift = makeUnit("hauler", "player", s.pad.x + 4000, s.pad.y + 4000);
    s.seat.units.set(adrift.id, adrift);
    // A freighter on the DESTINATION world. `assignShipToLane` looks it up on the SOURCE only.
    const abroad = makeUnit("hauler", "player", 100, 100);
    s.galaxy.planets.get(NEAR)!.units.set(abroad.id, abroad);
    // The neighbour's own freighter, standing on our pad.
    const enemy = makeUnit("hauler", "ai", s.pad.x + 10, s.pad.y + 10);
    s.seat.units.set(enemy.id, enemy);

    const refusals: Array<[string, string]> = [
      ["a worker", s.worker.id],
      ["a freighter 4000 units from the pad", adrift.id],
      ["a freighter on the destination world", abroad.id],
      ["the neighbour's freighter", enemy.id],
      ["a unit that does not exist", "u-nobody"],
    ];
    for (const [what, unitId] of refusals) {
      const err = send(s, { kind: "assignLane", laneId, unitId });
      expect(err, `${what} was crewed onto the lane`).not.toBeNull();
      expect(err, `the refusal for ${what} does not say the ship cannot be crewed`)
        .toMatch(/cannot be crewed/i);
    }
    expect(send(s, { kind: "assignLane", laneId: "lane999", unitId: s.hauler.id }), "an unknown lane accepted a ship")
      .not.toBeNull();

    expect(s.galaxy.lanes[0]!.shipIds, "a refused assignment crewed something anyway").toEqual([]);
    expect(laneOf(s.worker), "a refused assignment booked the worker").toBeUndefined();

    // Anti-vacuity: the one ship that SHOULD be accepted still is, so the five refusals above are
    // the engine's rules and not a lane that refuses everything.
    expect(send(s, { kind: "assignLane", laneId, unitId: s.hauler.id }),
      "the lane refused the one ship that meets every condition").toBeNull();
  });

  it("moves a ship between lanes rather than double-booking it", () => {
    // Upstream's documented behaviour, surfaced through the bridge: a ship crewed onto a second lane
    // leaves the first. A double-booked freighter would have its hold counted twice.
    const s = scene();
    send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: [] });
    send(s, { kind: "createLane", from: SEAT, to: FAR, commodities: [] });
    const [first, second] = laneIds(s) as [string, string];

    expect(send(s, { kind: "assignLane", laneId: first, unitId: s.hauler.id })).toBeNull();
    expect(send(s, { kind: "assignLane", laneId: second, unitId: s.hauler.id })).toBeNull();

    expect(s.galaxy.lanes[0]!.shipIds, "the first lane kept a ship that moved to the second").toEqual([]);
    expect(s.galaxy.lanes[1]!.shipIds).toEqual([s.hauler.id]);
    expect(laneOf(s.hauler)).toBe(second);
  });

  it("returns a ship to the jump when it is pulled off, and shrugs at one that was never on", () => {
    const s = scene();
    send(s, { kind: "createLane", from: SEAT, to: NEAR, commodities: [] });
    const laneId = laneIds(s)[0]!;
    send(s, { kind: "assignLane", laneId, unitId: s.hauler.id });

    expect(send(s, { kind: "unassignLane", laneId, unitId: s.hauler.id })).toBeNull();
    expect(s.galaxy.lanes[0]!.shipIds, "the ship is still crewed").toEqual([]);
    expect(laneOf(s.hauler), "the ship still carries a booking").toBeUndefined();
    expect(ring(s), "the freed ship did not return to the staging ring").toContain(s.hauler.id);

    // Unassigning something that was never assigned is not an error — the same reasoning as a
    // second delete.
    expect(send(s, { kind: "unassignLane", laneId, unitId: s.worker.id })).toBeNull();
    expect(send(s, { kind: "unassignLane", laneId: "lane999", unitId: s.hauler.id })).toBeNull();
  });
});

/* =================================================================================================
   COLONY STANDING ORDERS
   ================================================================================================= */

describe("colonyPolicy through the bridge (P4-T08)", () => {
  it("round-trips a policy that has been moved off every default", () => {
    const s = scene();
    expect(send(s, {
      kind: "colonyPolicy", planetId: NEAR,
      patch: { autoSell: { enabled: true, floors: { ore: 200, crystals: 50 } }, workerTarget: 4 },
    })).toBeNull();

    expect(getColonyPolicy(s.galaxy, NEAR), "the policy did not arrive as it was sent").toEqual({
      autoSell: { enabled: true, floors: { ore: 200, crystals: 50 } },
      workerTarget: 4,
    });
    // The anti-vacuity half: this is not what an unset world reads back as.
    expect(getColonyPolicy(s.galaxy, NEAR), "the policy round-tripped into the OFF default")
      .not.toEqual(sanitizePolicy(null));
    expect(getColonyPolicy(s.galaxy, FAR), "an untouched world picked up the policy")
      .toEqual(sanitizePolicy(null));
  });

  it("stores the ENGINE's clamped number for a request above MAX_WORKER_TARGET", () => {
    // The row's own requirement, from the bridge's side: the intent is accepted (no refusal), and
    // what lands is `sanitizePolicy`'s number, not the player's. The bridge does not pre-clamp —
    // showing the clamp is the panel's job, and a second clamp here would be a second opinion that
    // could drift from the engine's.
    const s = scene();
    expect(send(s, { kind: "colonyPolicy", planetId: NEAR, patch: { workerTarget: 99 } }),
      "an over-ceiling target was refused rather than clamped").toBeNull();
    expect(getColonyPolicy(s.galaxy, NEAR).workerTarget, "the request was stored unclamped")
      .toBe(MAX_WORKER_TARGET);

    // …and a target under the ceiling is stored as asked, so the clamp above is the ceiling rather
    // than a setter that always writes 20.
    send(s, { kind: "colonyPolicy", planetId: NEAR, patch: { workerTarget: 3 } });
    expect(getColonyPolicy(s.galaxy, NEAR).workerTarget).toBe(3);
  });

  it("merges a floor edit instead of replacing the floor set", () => {
    // `setColonyPolicy`'s documented merge, which is what lets a UI edit one commodity's floor
    // without carrying every other floor along in the patch.
    const s = scene();
    send(s, { kind: "colonyPolicy", planetId: NEAR, patch: { autoSell: { enabled: true, floors: { ore: 200 } } } });
    send(s, { kind: "colonyPolicy", planetId: NEAR, patch: { autoSell: { floors: { crystals: 50 } } } });

    const policy = getColonyPolicy(s.galaxy, NEAR);
    expect(policy.autoSell.floors, "editing one floor blew away the other").toEqual({ ore: 200, crystals: 50 });
    expect(policy.autoSell.enabled, "a floor edit switched auto-sell back off").toBe(true);
  });

  it("passes junk to the engine's validator rather than trusting or rejecting it", () => {
    // `sanitizePolicy` is the validator and it is the SAME one the load path runs. The bridge's job
    // is to let it do that — an unknown commodity is dropped, a negative floor is dropped, and a
    // target that is not a number reads as none.
    const s = scene();
    expect(send(s, {
      kind: "colonyPolicy", planetId: NEAR,
      patch: { autoSell: { enabled: 1, floors: { ore: 100, unobtanium: 5, crystals: -1 } }, workerTarget: "many" },
    })).toBeNull();

    expect(getColonyPolicy(s.galaxy, NEAR)).toEqual({
      autoSell: { enabled: true, floors: { ore: 100 } },
      workerTarget: 0,
    });
  });
});

/* =================================================================================================
   THROUGH THE BRIDGE'S OWN QUEUE

   `applyIntent` above is the same function `WorldBridge.drain` calls, but the game never calls it
   directly — it enqueues, and the intent lands on a tick boundary so a recorded stream replays. The
   two tests here drive that path end to end, and read the result out of the bridge's own save,
   which is the only window it offers onto anything above the seat.
   ================================================================================================= */

describe("the galaxy intents reach the galaxy the bridge owns (P4-T07, P4-T08)", () => {
  it("carries a queued lane and a queued policy into the bridge's own galaxy", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    bridge.enqueue({ kind: "createLane", from: MVP_WORLD, to: NEAR, commodities: ["ore"] });
    bridge.enqueue({ kind: "colonyPolicy", planetId: NEAR, patch: { workerTarget: 99 } });
    bridge.step(STEP_SECONDS);

    const save = bridge.save() as unknown as {
      lanes: Array<{ from: string; to: string; commodities: string[] }>;
      colonyPolicies: Array<[string, ColonyPolicy]>;
    };
    expect(save.lanes, "the queued lane never reached the bridge's galaxy")
      .toEqual([expect.objectContaining({ from: MVP_WORLD, to: NEAR, commodities: ["ore"] })]);
    expect(save.colonyPolicies, "the queued policy never reached the bridge's galaxy")
      .toEqual([[NEAR, { autoSell: { enabled: false, floors: {} }, workerTarget: MAX_WORKER_TARGET }]]);
    expect(bridge.takeCommandError(), "an accepted pair of intents reported an error").toBeNull();
  });

  it("surfaces a refusal through the same channel every other command uses", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    bridge.enqueue({ kind: "createLane", from: MVP_WORLD, to: MVP_WORLD, commodities: [] });
    bridge.step(STEP_SECONDS);

    expect(bridge.takeCommandError(), "a refused lane was swallowed instead of reported")
      .toMatch(/lane cannot be opened/i);
    expect((bridge.save() as unknown as { lanes: unknown[] }).lanes, "the refused lane was created anyway")
      .toEqual([]);
  });
});

/** The staging ring on the seat — `stagedRiders`, which skips every lane-booked ship. */
function ring(s: Scene): string[] {
  const pads = playerSpaceports(s.seat);
  expect(pads.length, "the seat has no completed Spaceport, so there is no staging ring").toBeGreaterThan(0);
  return pads.flatMap((pad) => stagedRiders(s.seat, pad).map((u) => u.id));
}
