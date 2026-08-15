// P4-T04 — the jump panel's model.
//
// The row's whole demand is that `canJump`/`canJumpTo`/`jumpCost` DECIDE and the panel only reports
// — so most of this file is written as an identity against the engine's own answer rather than
// against a number typed here. A test that asserted `cost === 342` would pass just as happily
// against a panel that had hard-coded 342, which is the failure mode the row names.
//
// Four traps, one section each, and each section is arranged around the case where the obvious
// re-derivation is wrong rather than the case where it happens to agree:
//
//   1. `jumpCost` vs `JUMP_COST` — asserted with two pads of different tiers, because the constant
//      and the function agree often enough that a single-tier test proves nothing.
//   2. `canJumpTo` vs "do I have a Spaceport" — asserted on BOTH branches, including the stranded
//      force whose only way home is the fall-back clause.
//   3. `jumpManifest` vs a head-count — asserted on a ring the pad cannot lift whole, with a heavy
//      ship left behind while a lighter one standing further away rides.
//   4. `SPACEPORT_CAPACITY[tier]` vs a constant, and the upgrade's affordability asserted against
//      `upgradeSpaceport`'s own answer rather than against a second cost check.

import { describe, expect, it } from "vitest";
import {
  JUMP_COST, JUMP_LOAD_RADIUS, SPACEPORT_CAPACITY, SPACEPORT_MAX_TIER, SPACEPORT_UPGRADE_COST,
  UNITS, assignShipToLane, canJumpTo, createGalaxy, createLane, deployColonyShip, jumpCapital,
  jumpCost, jumpManifest, makeBuilding, makeUnit, playerSpaceports, spaceportTier, stagedRiders,
  upgradeSpaceport,
} from "../../src/engine/index.js";
import { jumpPanelModel } from "../../src/ui/jump-panel.js";

const SEED = 20260814;
const HOME = "helix";
/** A world in the galaxy's live set that the player has never been to. */
const UNVISITED = "ferros";

/** A galaxy with a real base on the opening world — a Command Center, so a fall-back has somewhere to go. */
function settled(): { galaxy: Galaxy; home: State } {
  const galaxy = createGalaxy({ seed: SEED, startId: HOME });
  const home = galaxy.planets.get(HOME)!;
  const ship = [...home.units.values()].find((u) => u.owner === "player" && u.type === "colonyship")!;
  expect(deployColonyShip(home, ship.id), "the opening colony ship would not deploy").toBeTruthy();
  return { galaxy, home };
}

/**
 * A finished pad, placed well away from the base on purpose.
 *
 * The opening colonists stand on the Command Center, and a pad next to them would sweep them into
 * every manifest below — so the staging ring in these tests holds exactly what each test parks in
 * it, and `stagedRiders` is asked to confirm that rather than assumed.
 */
function pad(state: State, x: number, y: number, tier = 1): Building {
  const b = makeBuilding("spaceport", "player", x, y);
  b.constructing = false;
  b.buildProgress = 1;
  b.tier = tier;
  state.buildings.set(b.id, b);
  return b;
}

function park(state: State, type: string, x: number, y: number): Unit {
  const u = makeUnit(type, "player", x, y);
  state.units.set(u.id, u);
  return u;
}

/**
 * The stranded case, built the way a player reaches it: hop an army to a new world and forget the
 * colony ship, so there is no Spaceport under your feet and the only way on is the fall-back.
 */
function stranded(): { galaxy: Galaxy; world: State } {
  const { galaxy, home } = settled();
  pad(home, 700, 500);
  park(home, "skiff", 700, 520);
  park(home, "skiff", 710, 530);
  expect(jumpCapital(galaxy, UNVISITED), "the army never crossed").not.toBeNull();
  const world = galaxy.planets.get(UNVISITED)!;
  expect(playerSpaceports(world).length, "the expedition built a pad on arrival — this is no "
    + "longer the stranded case").toBe(0);
  expect([...world.units.values()].filter((u) => u.owner === "player").length,
    "the army did not arrive, so nothing is stranded").toBeGreaterThan(0);
  return { galaxy, world };
}

/* =================================================================================================
   1. THE PRICE — `jumpCost`, never `JUMP_COST`
   ================================================================================================= */

describe("what a jump costs (P4-T04)", () => {
  it("quotes the engine's own price for every destination, not a constant", () => {
    const { galaxy, home } = settled();
    pad(home, 700, 500);
    const model = jumpPanelModel(galaxy);

    expect(model.destinations.length, "the panel lists no destinations at all").toBeGreaterThan(0);
    for (const d of model.destinations) {
      expect(d.cost, `${d.id}'s price is not jumpCost's`).toBe(jumpCost(galaxy, d.id));
    }
    // …and the world under your feet is not offered as somewhere to go.
    expect(model.destinations.map((d) => d.id)).not.toContain(galaxy.activeId);
    expect(model.originId).toBe(HOME);
  });

  it("charges a Tier-3 pad less than a Tier-1 pad for the same jump — the trap in the row", () => {
    // The reason a single-tier test is not enough: at Tier 1 the discount is 1.0, so `jumpCost` and
    // a hand-rolled distance formula agree, and a panel that had simply shown `JUMP_COST` is wrong
    // by only 13 credits on this hop. Upgrade the pad and the gap opens to 116 — a third of the
    // bill — because `FUEL_DISCOUNT_BY_TIER` is applied to the origin's BEST completed pad.
    const one = settled();
    pad(one.home, 700, 500, 1);
    const three = settled();
    pad(three.home, 700, 500, 3);

    const cheap = jumpPanelModel(three.galaxy).destinations.find((d) => d.id === UNVISITED)!;
    const dear = jumpPanelModel(one.galaxy).destinations.find((d) => d.id === UNVISITED)!;

    expect(dear.cost, "a Tier-1 jump to an unvisited world should cost real fuel").toBeGreaterThan(0);
    expect(cheap.cost, "the bigger pad did not make the jump cheaper — the panel is quoting a "
      + "number that does not depend on the tier").toBeLessThan(dear.cost);
    for (const [tier, quoted] of [[1, dear.cost], [3, cheap.cost]] as const) {
      expect(quoted, `a Tier-${tier} pad quoting exactly JUMP_COST means the constant is being `
        + "shown instead of the engine's price").not.toBe(JUMP_COST);
    }
    expect(cheap.cost).toBe(jumpCost(three.galaxy, UNVISITED));
    expect(dear.cost).toBe(jumpCost(one.galaxy, UNVISITED));
  });

  it("marks a world already reached as free, which is why the return trip is", () => {
    const { galaxy, home } = settled();
    pad(home, 700, 500);
    park(home, "colonyship", 700, 520);
    expect(jumpCapital(galaxy, UNVISITED), "the settling jump was refused").not.toBeNull();

    const back = jumpPanelModel(galaxy).destinations.find((d) => d.id === HOME)!;
    expect(back.reached, "the world we launched from is not marked reached").toBe(true);
    expect(back.cost, "a world already reached is a free return jump").toBe(0);
    expect(back.affordable, "a free jump is not affordable — the comparison is inverted").toBe(true);

    const onward = jumpPanelModel(galaxy).destinations.find((d) => d.id === "nimbus")!;
    expect(onward.reached, "a world nobody has been to is marked reached").toBe(false);
  });

  it("calls a jump affordable on the same comparison the bridge refuses on", () => {
    const { galaxy, home } = settled();
    pad(home, 700, 500);
    const target = jumpPanelModel(galaxy).destinations.find((d) => d.id === UNVISITED)!;

    galaxy.credits = target.cost;
    expect(jumpPanelModel(galaxy).destinations.find((d) => d.id === UNVISITED)!.affordable,
      "exactly enough credits reads as unaffordable — the engine refuses on `credits < cost`, so "
      + "the boundary belongs to the player").toBe(true);

    galaxy.credits = target.cost - 1;
    expect(jumpPanelModel(galaxy).destinations.find((d) => d.id === UNVISITED)!.affordable,
      "one credit short still reads as affordable").toBe(false);
    // And the engine agrees, which is the half that makes this more than a comparison with itself.
    expect(jumpCapital(galaxy, UNVISITED), "the engine took a jump the panel called unaffordable")
      .toBeNull();
  });
});

/* =================================================================================================
   2. WHO CAN BE REACHED — `canJumpTo`, and the clause that stops a portless world being a trap
   ================================================================================================= */

describe("where a jump can go (P4-T04)", () => {
  it("takes every destination's reachability from `canJumpTo`, with a pad and without one", () => {
    // BOTH galaxies, and that is the whole point of the second one: with a pad here, `canJumpTo` is
    // true everywhere, so an identity check on that galaxy alone is equally satisfied by a panel
    // that answers "do I have a Spaceport" and never looks at the destination at all. (Found by
    // mutation: `reachable = hasPad` passed this test until the portless galaxy was added.)
    const withPad = settled();
    pad(withPad.home, 700, 500);
    for (const d of jumpPanelModel(withPad.galaxy).destinations) {
      expect(d.reachable, `${d.id} disagrees with canJumpTo`).toBe(canJumpTo(withPad.galaxy, d.id));
    }

    const { galaxy } = stranded();
    const model = jumpPanelModel(galaxy);
    expect(model.canLaunch, "this galaxy was supposed to have no pad under the player's feet").toBe(false);
    // The discriminating shape: no pad here, and the destinations DISAGREE with each other — one is
    // reachable through the fall-back clause and the rest are not. A panel answering `hasPad` gets
    // every one of them wrong at once.
    const reachable = model.destinations.filter((d) => d.reachable).map((d) => d.id);
    expect(reachable, "the stranded galaxy no longer separates the two branches").toEqual([HOME]);
    for (const d of model.destinations) {
      expect(d.reachable, `${d.id} disagrees with canJumpTo on a world with no pad`)
        .toBe(canJumpTo(galaxy, d.id));
    }
  });

  it("with a pad here, opens a frontier world nobody has visited", () => {
    const { galaxy, home } = settled();
    pad(home, 700, 500);
    const model = jumpPanelModel(galaxy);

    expect(model.canLaunch, "a completed pad stands here and the panel says it cannot launch").toBe(true);
    const frontier = model.destinations.find((d) => d.id === UNVISITED)!;
    expect(frontier.reachable, "a Spaceport lets you open a NEW world — that is what it is for").toBe(true);
    expect(frontier.fallback, "a jump from a real pad is not a fall-back").toBe(false);
  });

  it("without a pad, offers only the world you still hold — and says it carries nobody", () => {
    // The stranded-force case, built the way a player reaches it: hop an army to a new world,
    // forget the colony ship, and there is now no Spaceport under your feet. `canJump` is false, so
    // a panel that gated on "do I have a Spaceport" would grey out every destination and the force
    // would be trapped. `canJumpTo` still says yes to the world where the Command Center stands.
    const { galaxy, world } = stranded();
    const model = jumpPanelModel(galaxy);
    expect(model.canLaunch, "there is no pad on this world").toBe(false);

    const home_ = model.destinations.find((d) => d.id === HOME)!;
    expect(home_.reachable, "the way home is closed — a portless world has become a trap, which is "
      + "exactly the rule `canJumpTo`'s fall-back clause exists to prevent").toBe(true);
    expect(home_.fallback, "the return is not flagged as the fall-back it is").toBe(true);

    // …and only that one. A world the player holds nothing on stays closed without a pad.
    const elsewhere = model.destinations.find((d) => d.id === "nimbus")!;
    expect(elsewhere.reachable, "a world with no foothold is reachable without a Spaceport — the "
      + "panel is answering 'is there anywhere to go' rather than asking about THIS destination")
      .toBe(false);

    // The half a player has to know BEFORE pressing it: a fall-back is a control switch. With no
    // pad there is nothing to load a fleet from, so the garrison stays exactly where it is.
    expect(model.launch.riders, "the fall-back is being presented as a ferry").toEqual([]);
    expect(model.launch.capacity, "a world with no pad has no jump capacity").toBe(0);
    const before = [...world.units.values()].filter((u) => u.owner === "player").length;
    expect(jumpCapital(galaxy, HOME), "the fall-back was refused").not.toBeNull();
    expect([...world.units.values()].filter((u) => u.owner === "player").length,
      "the fall-back moved units after all — then the panel's empty manifest was a lie").toBe(before);
  });
});

/* =================================================================================================
   3. THE MANIFEST — who rides, and who is standing on the pad afterwards
   ================================================================================================= */

describe("the jump manifest (P4-T04)", () => {
  it("names both halves, and the engine's own count agrees with the roster", () => {
    const { galaxy, home } = settled();
    const launch = pad(home, 700, 500, 1);
    const capacity = SPACEPORT_CAPACITY[1]!;
    // Fifteen colonists into a hold that takes twelve.
    const parked: Unit[] = [];
    for (let i = 0; i < 15; i++) parked.push(park(home, "worker", 700 + 4 * i, 510));
    expect(stagedRiders(home, launch).length, "the ring picked up something this test did not park")
      .toBe(parked.length);

    const model = jumpPanelModel(galaxy);
    const m = model.pads[0]!.manifest;

    expect(m.capacity, "the pad's capacity is not the tier's").toBe(capacity);
    expect(m.supply, "the hold is not filled to capacity by fifteen supply-1 colonists").toBe(capacity);
    expect(m.stagedSupply, "the ring's total supply is not what is standing in it").toBe(15);
    expect(m.riders.length).toBe(capacity);
    expect(m.overCapacity, "three colonists are being left and the panel calls it a clean launch").toBe(true);

    // The claim the row is about: the roster of what STAYS, cross-checked against the engine's own
    // count. `left` is a set difference of two engine answers, and this is what keeps it honest.
    expect(m.leftBehind, "the engine's own count of the overflow").toBe(15 - capacity);
    expect(m.left.length, "the panel's roster of what stays disagrees with `leftBehind` — one of "
      + "them is derived wrongly, and the engine's count is the one to believe").toBe(m.leftBehind);
    expect([...m.riders, ...m.left].map((u) => u.id).sort(),
      "rider + left is not the ring: somebody is on both lists, or on neither")
      .toEqual(parked.map((u) => u.id).sort());
  });

  it("leaves a heavy ship that a lighter one standing further away gets past", () => {
    // `jumpManifest` fills closest-first and SKIPS what does not fit rather than stopping there, so
    // "who was left" is not "the ones at the back" and cannot be worked out from a total. Here the
    // colony ship is nearer the pad than the last colonist to board — and it is the one that stays.
    // A player who saw only a rider list would find that out on the far side of the jump.
    const { galaxy, home } = settled();
    const launch = pad(home, 700, 500, 1);
    const capacity = SPACEPORT_CAPACITY[1]!;
    expect(UNITS.colonyship?.supplyCost, "a colony ship no longer weighs more than a colonist, so "
      + "this scenario cannot demonstrate the skip").toBeGreaterThan(1);

    for (let i = 0; i < capacity - 1; i++) park(home, "worker", 700 + i, 505);   // 11 supply, all close
    const bumped = park(home, "colonyship", 700, 560);                           // 3 supply — would be 14
    const boards = park(home, "worker", 700, 600);                               // 1 supply — fits exactly

    const m = jumpPanelModel(galaxy).pads[0]!.manifest;
    expect(m.supply, "the hold did not fill to the last point of capacity").toBe(capacity);
    expect(m.left.map((u) => u.id), "the colony ship was not the thing left behind").toEqual([bumped.id]);
    expect(m.riders.map((u) => u.id), "the colonist standing further out did not get past it")
      .toContain(boards.id);
    // Reported per unit so a panel can SAY why, rather than leaving "3 supply" to be inferred.
    expect(m.left[0]!.supply, "the overflow does not carry the supply cost that explains it")
      .toBe(UNITS.colonyship!.supplyCost);
    expect(stagedRiders(home, launch).length, "the ring is not what this test parked in it")
      .toBe(capacity + 1);
  });

  it("skips a lane-booked freighter entirely — it is not riding, and it is not overflow", () => {
    // `stagedRiders` excludes `u.laneId`: a ship crewed onto a Freight Lane is standing
    // infrastructure, and the exclusion is what stops the next jump sweeping it off-world from
    // under its own route. So it must not appear as a rider, and must not appear in the overflow
    // either — "left behind" means the pad could not take it, and this one was never going.
    const { galaxy, home } = settled();
    const launch = pad(home, 700, 500, 1);
    const hauler = park(home, "hauler", 700, 520);
    const colonist = park(home, "worker", 700, 515);

    const lane = createLane(galaxy, HOME, UNVISITED, ["ore"]);
    expect(lane, "the lane was refused, so nothing is booked and this test proves nothing").not.toBeNull();
    expect(assignShipToLane(galaxy, lane!.id, hauler.id), "the lane would not take the freighter")
      .toBe(true);

    const m = jumpPanelModel(galaxy).pads[0]!.manifest;
    expect(m.riders.map((u) => u.id), "the lane's freighter was swept onto the jump").not.toContain(hauler.id);
    expect(m.left.map((u) => u.id), "the lane's freighter is being shown as overflow — a player "
      + "would read that as 'it did not fit' and try to make room").not.toContain(hauler.id);
    expect(m.riders.map((u) => u.id), "the colonist beside it did not board").toContain(colonist.id);
    expect(m.stagedSupply, "the booked freighter is still being counted against the ring's supply")
      .toBe(UNITS.worker!.supplyCost);
    expect(stagedRiders(home, launch).map((u) => u.id), "the engine itself now stages lane ships — "
      + "this test is asserting a rule that has changed").toEqual([colonist.id]);
  });

  it("only stages what is inside the ring the panel reports", () => {
    const { galaxy, home } = settled();
    pad(home, 700, 500, 1);
    const inside = park(home, "worker", 700 + JUMP_LOAD_RADIUS - 10, 500);
    const outside = park(home, "worker", 700 + JUMP_LOAD_RADIUS + 10, 500);

    const model = jumpPanelModel(galaxy);
    expect(model.stagingRadius, "the panel's ring is not the engine's").toBe(JUMP_LOAD_RADIUS);
    expect(model.launch.riders.map((u) => u.id)).toContain(inside.id);
    expect([...model.launch.riders, ...model.launch.left].map((u) => u.id),
      "a unit outside the staging radius is on the manifest").not.toContain(outside.id);
  });
});

/* =================================================================================================
   4. TIER CAPACITY — visible before committing, and the upgrade asked of the engine
   ================================================================================================= */

describe("the pad's tier (P4-T04)", () => {
  it("shows this tier's capacity, the next tier's, and what it costs to get there", () => {
    const { galaxy, home } = settled();
    pad(home, 700, 500, 1);
    const row = jumpPanelModel(galaxy).pads[0]!;

    expect(row.tier).toBe(1);
    expect(row.capacity, "capacity is not SPACEPORT_CAPACITY indexed by tier").toBe(SPACEPORT_CAPACITY[1]);
    expect(row.nextTier).toBe(2);
    expect(row.nextCapacity, "the next tier's capacity is what makes an upgrade a decision rather "
      + "than a price").toBe(SPACEPORT_CAPACITY[2]);
    expect(row.upgradeCost, "the upgrade price is not the engine's").toEqual(SPACEPORT_UPGRADE_COST[2]);
    expect(row.atMaxTier).toBe(false);
    expect(row.fuelDiscount, "the tier's fuel multiplier is not reported, so a panel cannot say why "
      + "the price list moves after an upgrade").toBe(1);
  });

  it("stops offering an upgrade at the ceiling", () => {
    const { galaxy, home } = settled();
    const top = pad(home, 700, 500, SPACEPORT_MAX_TIER);
    home.players.player.resources.ore = 10_000;
    const row = jumpPanelModel(galaxy).pads[0]!;

    expect(row.atMaxTier).toBe(true);
    expect(row.capacity, "the top tier's capacity is not SPACEPORT_CAPACITY's")
      .toBe(SPACEPORT_CAPACITY[SPACEPORT_MAX_TIER]);
    expect(row.nextTier).toBeNull();
    expect(row.nextCapacity).toBeNull();
    expect(row.upgradeCost).toBeNull();
    expect(row.canUpgrade, "an upgrade is offered at the ceiling — and the engine would refuse it")
      .toBe(false);
    expect(upgradeSpaceport(home, top), "the engine took an upgrade past the ceiling").toBe(false);
  });

  it("predicts `upgradeSpaceport`'s answer instead of re-implementing its cost check", () => {
    // Both directions, and each ends by asking the engine — because a panel that agreed with itself
    // is the failure this row is written against.
    const poor = settled();
    const cheap = pad(poor.home, 700, 500, 1);
    poor.home.players.player.resources.ore = (SPACEPORT_UPGRADE_COST[2]!.ore ?? 0) - 1;
    expect(jumpPanelModel(poor.galaxy).pads[0]!.canUpgrade,
      "one ore short and the panel still offers the upgrade").toBe(false);
    expect(upgradeSpaceport(poor.home, cheap), "the engine took an upgrade the panel called unaffordable")
      .toBe(false);
    expect(spaceportTier(cheap), "a refused upgrade moved the tier anyway").toBe(1);

    const rich = settled();
    const pad2 = pad(rich.home, 700, 500, 1);
    rich.home.players.player.resources.ore = SPACEPORT_UPGRADE_COST[2]!.ore ?? 0;
    expect(jumpPanelModel(rich.galaxy).pads[0]!.canUpgrade,
      "exactly the price and the panel says no").toBe(true);
    expect(upgradeSpaceport(rich.home, pad2), "the engine refused an upgrade the panel offered").toBe(true);
    expect(spaceportTier(pad2)).toBe(2);
  });

  it("lifts more after the upgrade, because capacity is the tier's and nothing else", () => {
    const { galaxy, home } = settled();
    const launch = pad(home, 700, 500, 1);
    for (let i = 0; i < SPACEPORT_CAPACITY[2]!; i++) park(home, "worker", 700 + 4 * i, 510);

    const before = jumpPanelModel(galaxy).pads[0]!.manifest;
    expect(before.riders.length).toBe(SPACEPORT_CAPACITY[1]);
    expect(before.overCapacity, "a Tier-1 pad is taking a Tier-2 load").toBe(true);

    home.players.player.resources.ore = 10_000;
    expect(upgradeSpaceport(home, launch), "the upgrade was refused").toBe(true);

    const upgraded = jumpPanelModel(galaxy).pads[0]!;
    const after = upgraded.manifest;
    // The ROW's own capacity as well as the manifest's, and they come from different places: the
    // row's is `jumpCapacity(pad)` and the manifest's is the engine's. Found by mutation — pinning
    // the row's capacity to Tier 1 passed every other assertion in this file, because every one of
    // them happened to read the manifest's copy or a Tier-1 pad.
    expect(upgraded.tier, "the row is still reporting the old tier").toBe(2);
    expect(upgraded.capacity, "the row is still quoting the old tier's capacity")
      .toBe(SPACEPORT_CAPACITY[2]);
    expect(after.capacity, "the panel is still quoting the old tier's capacity").toBe(SPACEPORT_CAPACITY[2]);
    expect(after.riders.length, "the bigger pad did not lift more").toBe(SPACEPORT_CAPACITY[2]);
    expect(after.left, "there is still an overflow after the pad grew to fit the ring").toEqual([]);
    expect(after.overCapacity).toBe(false);
  });

  it("counts a ship once across two pads, and sums what the world can launch", () => {
    // `jumpManifestAll` is what `jumpCapital` actually calls, and it is not "the first pad found":
    // every unit boards through its NEAREST pad and each pad fills its own capacity. Two overlapping
    // rings must therefore not name the same colonist twice.
    const { galaxy, home } = settled();
    pad(home, 700, 500, 1);
    pad(home, 780, 500, 2);
    const shared = park(home, "worker", 740, 500);     // inside both rings
    const model = jumpPanelModel(galaxy);

    expect(model.pads.length).toBe(2);
    expect(model.launch.capacity, "the world's launch capacity is not both pads'")
      .toBe(SPACEPORT_CAPACITY[1]! + SPACEPORT_CAPACITY[2]!);
    expect(model.launch.riders.filter((u) => u.id === shared.id).length,
      "the colonist standing between two pads is on the manifest twice").toBe(1);
    expect(model.launch.riders.length + model.launch.leftBehind,
      "the combined manifest is not counting the ring once").toBe(1);
  });

  it("does not name an overflowing colonist twice when two rings overlap", () => {
    // The de-duplication above is invisible while everybody fits: the riders come from the engine,
    // which counts each unit once, so a panel that walked both rings and concatenated them would
    // look correct. It only shows in the OVERFLOW, which is derived — so this crowds both rings
    // past one pad's capacity and checks the roster against the engine's count.
    // (Found by mutation: concatenating `stagedRiders` across pads passed the test above.)
    const { galaxy, home } = settled();
    const near = pad(home, 700, 500, 1);
    const far = pad(home, 760, 500, 1);
    const crowd: Unit[] = [];
    for (let i = 0; i < 20; i++) crowd.push(park(home, "worker", 698 + (i % 5), 505 + i));
    for (const p of [near, far]) {
      expect(stagedRiders(home, p).length, "the crowd is not inside BOTH rings, so nothing can be "
        + "double-counted and this test proves nothing").toBe(crowd.length);
    }

    const m = jumpPanelModel(galaxy).launch;
    expect(m.riders.length, "the nearer pad did not fill to its own capacity").toBe(SPACEPORT_CAPACITY[1]);
    expect(m.leftBehind, "the engine's own overflow count").toBe(crowd.length - SPACEPORT_CAPACITY[1]!);
    expect(m.left.length, "the overflow roster disagrees with the engine's count — the two rings "
      + "are being walked twice").toBe(m.leftBehind);
    expect(new Set(m.left.map((u) => u.id)).size, "a colonist appears twice in the overflow")
      .toBe(m.left.length);
  });
});

/* =================================================================================================
   THE DECLARATION, CHECKED AGAINST THE ENGINE

   `src/engine/types/engine/galaxy.d.ts` is hand-written: it is an ASSERTION about what the vendored
   JavaScript returns, and nothing in the toolchain verifies it. The cost of getting it wrong is not
   a compile error — it is a panel that typechecks, runs, and shows `undefined`.

   That is not hypothetical here. The declaration for these two functions originally advertised
   `{ riders, supply, capacity, left }`; the engine returns `{ riders, capacity, used, stagedSupply,
   staged, leftBehind }`, with `staged` and `leftBehind` as COUNTS. It has since been corrected, and
   this is the test that would have caught it — the only place the .d.ts and `galaxy.js` are ever
   compared.
   ================================================================================================= */

describe("the engine's manifest shape, pinned (P4-T04)", () => {
  it("returns riders/capacity/used/stagedSupply/staged/leftBehind, and nothing else", () => {
    const { home } = settled();
    const launch = pad(home, 700, 500, 1);
    park(home, "worker", 700, 510);

    const raw = jumpManifest(home, launch) as unknown as Record<string, unknown>;
    expect(Object.keys(raw).sort(),
      "the engine's manifest shape has changed. Fix src/engine/types/engine/galaxy.d.ts to match "
      + "`galaxy.js` — a declaration that disagrees with the code it describes is worse than none, "
      + "because it typechecks.")
      .toEqual(["capacity", "leftBehind", "riders", "staged", "stagedSupply", "used"]);
    // The two that were invented, asserted absent by name: they are what a panel would read.
    expect(raw.left, "`left` is back — the roster in this panel is derived, and should not be")
      .toBeUndefined();
    expect(raw.supply, "`supply` is back — check which of it and `used` the panel should report")
      .toBeUndefined();
    // …and the two that are counts rather than rosters, which is the half that silently misreads.
    expect(typeof raw.staged, "`staged` is no longer a count").toBe("number");
    expect(typeof raw.leftBehind, "`leftBehind` is no longer a count").toBe("number");
  });
});
