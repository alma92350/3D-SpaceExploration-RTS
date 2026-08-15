// P4-T04 — the `jump` and `upgradeSpaceport` intents, each refused exactly when the engine refuses
// it, and each refusal naming the reason the engine actually had.
//
// The bridge's own header says why that second half matters here more than anywhere else in the
// module: `jumpCapital` returns null for every reason it can refuse — no pad and nowhere to fall
// back, not enough credits, same world — so the phrasing has to ask `canJumpTo` and `jumpCost`
// which one it was. "A message naming the wrong reason is worse than none," and a jump is the most
// expensive button in the game to press twice.
//
// Written against `applyIntent` directly rather than through `WorldBridge.apply`, and that is a
// deliberate exception to the pattern the other bridge tests use. A jump changes WHICH WORLD the
// next intent applies to, so these tests have to hold both worlds and the treasury at once — and
// `WorldBridge` keeps its galaxy private (rightly: nothing above the bridge may hold one). `apply`
// is a one-line delegation to `applyIntent`, and the last test in the file runs a jump through it
// so that the delegation itself is covered rather than assumed.

import { describe, expect, it } from "vitest";
import {
  JUMP_COST, JUMP_LOAD_RADIUS, SPACEPORT_CAPACITY, SPACEPORT_MAX_TIER, SPACEPORT_UPGRADE_COST,
  activeState, canJumpTo, createGalaxy, deployColonyShip, jumpCapacity, jumpCost, makeBuilding,
  makeUnit, playerSpaceports, snapLandingPoint, spaceportTier,
} from "../../src/engine/index.js";
import { applyIntent } from "../../src/bridge/commands.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260814;
const HOME = "helix";
/** A world in the live set that the player has never been to — a jump there costs real fuel. */
const FRONTIER = "ferros";

function settled(): { galaxy: Galaxy; home: State } {
  const galaxy = createGalaxy({ seed: SEED, startId: HOME });
  const home = galaxy.planets.get(HOME)!;
  const ship = [...home.units.values()].find((u) => u.owner === "player" && u.type === "colonyship")!;
  expect(deployColonyShip(home, ship.id), "the opening colony ship would not deploy").toBeTruthy();
  return { galaxy, home };
}

/** A completed pad, away from the base so a test's staging ring holds only what it parks. */
function pad(state: State, x = 700, y = 500, tier = 1): Building {
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

const players = (state: State): Unit[] => [...state.units.values()].filter((u) => u.owner === "player");

/* =================================================================================================
   THE JUMP
   ================================================================================================= */

describe("the jump intent (P4-T04)", () => {
  it("does nothing, and says nothing, when the destination is the world you are on", () => {
    // Not a refusal: clicking the world you are standing on is not an error, and a message would
    // be noise. The engine's own first line agrees (`destId === galaxy.activeId` returns null).
    const { galaxy, home } = settled();
    pad(home);
    const credits = galaxy.credits;

    expect(applyIntent(home, { kind: "jump", destId: HOME }, galaxy)).toBeNull();
    expect(galaxy.activeId).toBe(HOME);
    expect(galaxy.credits, "a no-op jump spent fuel").toBe(credits);
  });

  it("refuses a world it cannot reach, and names the rule that closed it", () => {
    // No pad here, and no foothold there. This is the one refusal that is about REACHABILITY rather
    // than money, and `canJumpTo` is what separates them — a bridge that checked `canJump` alone
    // would refuse the fall-back below with the same words.
    const { galaxy, home } = settled();
    const credits = galaxy.credits;
    expect(playerSpaceports(home).length, "this case needs a world with no launch pad").toBe(0);
    expect(canJumpTo(galaxy, FRONTIER), "the engine thinks this is reachable, so the bridge should too")
      .toBe(false);

    expect(applyIntent(home, { kind: "jump", destId: FRONTIER }, galaxy))
      .toMatch(/No Spaceport here, and no base to fall back to/i);
    expect(galaxy.activeId, "a refused jump moved the seat").toBe(HOME);
    expect(galaxy.credits, "a refused jump spent fuel").toBe(credits);
  });

  it("quotes `jumpCost` when the treasury is short — not `JUMP_COST`", () => {
    // The trap the row names, at the point a player actually reads a number. A bridge that put the
    // constant in this message would tell a Tier-3 port owner they need 400 credits for a jump the
    // engine will sell them for 271 — and they would go and sell ore they did not need to sell.
    const { galaxy, home } = settled();
    const port = pad(home, 700, 500, SPACEPORT_MAX_TIER);
    const cost = jumpCost(galaxy, FRONTIER);
    expect(cost, "the discounted price is the same as the constant, so this test cannot tell them "
      + "apart — pick a destination whose distance moves the bill").not.toBe(JUMP_COST);
    expect(spaceportTier(port)).toBe(SPACEPORT_MAX_TIER);

    galaxy.credits = cost - 1;
    const refusal = applyIntent(home, { kind: "jump", destId: FRONTIER }, galaxy);
    expect(refusal, "the refusal does not quote the engine's own price")
      .toBe(`A jump there costs ${Math.ceil(cost)} credits`);
    expect(refusal, "the refusal quotes the constant instead of the tier-discounted price")
      .not.toContain(String(JUMP_COST));
    expect(galaxy.activeId).toBe(HOME);
    expect(galaxy.credits, "a jump the treasury could not cover was charged anyway").toBe(cost - 1);

    // One credit more and the same order goes through, which is what makes the refusal a boundary
    // rather than a mood.
    galaxy.credits = cost;
    expect(applyIntent(home, { kind: "jump", destId: FRONTIER }, galaxy)).toBeNull();
    expect(galaxy.activeId).toBe(FRONTIER);
    expect(galaxy.credits, "the jump did not cost exactly what it quoted").toBe(0);
  });

  it("carries the staged expedition, leaves the base standing, and moves the seat", () => {
    const { galaxy, home } = settled();
    pad(home);
    const rider = park(home, "colonyship", 700, 520);
    const homebody = park(home, "skiff", 200, 500);          // far from the pad — not staged
    const cost = jumpCost(galaxy, FRONTIER);
    galaxy.credits = cost + 10;
    const buildings = [...home.buildings.values()].filter((b) => b.owner === "player").length;

    expect(applyIntent(home, { kind: "jump", destId: FRONTIER }, galaxy)).toBeNull();

    const dest = galaxy.planets.get(FRONTIER)!;
    expect(galaxy.activeId, "the seat did not move").toBe(FRONTIER);
    expect(activeState(galaxy), "activeState still answers with the old world").toBe(dest);
    expect(galaxy.credits, "the fuel charged is not `jumpCost`'s price").toBe(10);

    // The rider MOVED — it is not on both worlds, and it is not a copy. Its id is reminted on
    // arrival (the galaxy's own `g` scheme), so it is found by type rather than by id.
    expect(home.units.get(rider.id), "the rider is still standing on the world it left").toBeUndefined();
    expect(players(dest).map((u) => u.type), "the expedition did not arrive").toContain("colonyship");
    expect(players(dest).length, "more arrived than was staged").toBe(1);

    // …and nothing else went with it. A unit outside the ring stays, and NO building ever travels.
    expect(home.units.get(homebody.id), "a unit outside the staging ring was swept up").toBeDefined();
    expect([...home.buildings.values()].filter((b) => b.owner === "player").length,
      "a building travelled — `jumpCapital` relocates units and never a base").toBe(buildings);
    expect(galaxy.discovered.has(FRONTIER), "the destination was not marked reached, so the return "
      + "trip would be charged as a new world").toBe(true);
  });

  it("falls back to a world you still hold, and moves nobody doing it", () => {
    // The catch-22 escape: an army on a portless world can always get the seat back to a base it
    // holds. It is a CONTROL SWITCH — with no pad there is nothing to load a fleet from, so the
    // garrison stays. Both halves are asserted, because a fall-back that quietly ferried units
    // would be a much better deal than the engine intends.
    const { galaxy, home } = settled();
    pad(home);
    park(home, "skiff", 700, 520);
    galaxy.credits = 5_000;
    expect(applyIntent(home, { kind: "jump", destId: FRONTIER }, galaxy)).toBeNull();

    const stranded = galaxy.planets.get(FRONTIER)!;
    expect(playerSpaceports(stranded).length, "the expedition has a pad, so it is not stranded").toBe(0);
    const garrison = players(stranded).length;
    expect(garrison, "nothing crossed, so there is nothing stranded").toBeGreaterThan(0);

    const credits = galaxy.credits;
    expect(canJumpTo(galaxy, HOME), "the way home is closed — the fall-back clause is gone").toBe(true);
    expect(applyIntent(stranded, { kind: "jump", destId: HOME }, galaxy)).toBeNull();

    expect(galaxy.activeId, "the fall-back did not move the seat").toBe(HOME);
    expect(galaxy.credits, "a return to a world already reached was charged fuel").toBe(credits);
    expect(players(stranded).length, "the fall-back ferried the garrison home — it must not, "
      + "because there is no pad to load it from").toBe(garrison);
  });

  it("lands on the picker's snapped point, not on the raw click", () => {
    // `landingPoint` is consulted only when the destination has no pad of yours, and the engine
    // rounds it onto `LANDING_PICK_GRID` before using it — a blind landing is deliberately coarse.
    // A client that drew the raw click would be pointing at ground the colony does not land on.
    const { galaxy, home } = settled();
    pad(home);
    park(home, "worker", 700, 510);
    galaxy.credits = 5_000;

    const click = { x: 879, y: 559 };
    const dest = galaxy.planets.get(FRONTIER)!;
    const snapped = snapLandingPoint(dest.map, click.x, click.y);
    expect(snapped, "the picker's grid no longer moves this click, so the test cannot tell the two "
      + "points apart").not.toEqual(click);

    expect(applyIntent(home, { kind: "jump", destId: FRONTIER, landingX: click.x, landingY: click.y }, galaxy))
      .toBeNull();

    const arrived = players(dest);
    expect(arrived.length, "the landing-point case needs exactly one rider for a fixed ring slot").toBe(1);
    const toSnapped = Math.hypot(arrived[0]!.x - snapped.x, arrived[0]!.y - snapped.y);
    const toClick = Math.hypot(arrived[0]!.x - click.x, arrived[0]!.y - click.y);
    const toAnchor = Math.hypot(arrived[0]!.x - dest.map.bases.player.x, arrived[0]!.y - dest.map.bases.player.y);

    // Landed at the PICKED point at all — the assertion the weaker version of this test was
    // missing. Dropping `landingPoint` on the way through the bridge makes `landingZone` fall back
    // to the world's generation-time anchor, which is 640 units away and still, trivially, "closer
    // to the snap than to the click". Found by mutation.
    expect(toSnapped, "the colonist did not land anywhere near the point the player picked — the "
      + "landing point is not reaching `jumpCapital`").toBeLessThan(JUMP_LOAD_RADIUS);
    expect(toAnchor, "the colonist landed on the world's default anchor, so this test cannot tell "
      + "a used landing point from an ignored one").toBeGreaterThan(JUMP_LOAD_RADIUS);
    // …and at the SNAPPED point rather than the raw click, which is the engine's own coarsening.
    expect(toSnapped, "the colonist landed on the raw click — a client drawing that point would be "
      + "showing ground the colony does not touch down on").toBeLessThan(toClick);
  });

  it("goes through WorldBridge's own queue, on the same path the app uses", () => {
    // The other tests call `applyIntent` directly; this one proves the delegation is real, that an
    // enqueued jump lands at a tick boundary like every other order, and that `bridge.state`
    // follows the seat afterwards — which is what makes a recorded stream replayable across a jump
    // (P4-T11).
    const bridge = new WorldBridge({ seed: SEED, worldId: MVP_WORLD });
    bridge.step(STEP_SECONDS);
    pad(bridge.state);
    park(bridge.state, "worker", 700, 510);

    bridge.enqueue({ kind: "jump", destId: FRONTIER });
    bridge.step(STEP_SECONDS);

    expect(bridge.takeCommandError(), "the enqueued jump was refused").toBeNull();
    expect(bridge.worldId, "the bridge is still reporting the old world").toBe(FRONTIER);
    expect(players(bridge.state).map((u) => u.type), "`bridge.state` did not follow the seat")
      .toContain("worker");
  });
});

/* =================================================================================================
   THE SPACEPORT UPGRADE
   ================================================================================================= */

describe("the upgradeSpaceport intent (P4-T04)", () => {
  it("ignores a building that is not your own finished pad", () => {
    const { galaxy, home } = settled();
    const barracks = makeBuilding("barracks", "player", 400, 400);
    home.buildings.set(barracks.id, barracks);
    const theirs = makeBuilding("spaceport", "ai", 900, 500);
    theirs.constructing = false;
    home.buildings.set(theirs.id, theirs);

    // Silence rather than a message: these are not player mistakes, they are a stale click on a
    // building that died or was never yours — the same treatment every other intent gives them.
    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: barracks.id }, galaxy)).toBeNull();
    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: theirs.id }, galaxy)).toBeNull();
    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: "b-gone" }, galaxy)).toBeNull();
    expect(theirs.tier ?? 1, "the enemy's pad was upgraded").toBe(1);
  });

  it("refuses at the ceiling, and says which ceiling", () => {
    const { galaxy, home } = settled();
    const port = pad(home, 700, 500, SPACEPORT_MAX_TIER);
    home.players.player.resources.ore = 10_000;
    const ore = home.players.player.resources.ore;

    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: port.id }, galaxy))
      .toMatch(/already at its highest tier/i);
    expect(spaceportTier(port)).toBe(SPACEPORT_MAX_TIER);
    expect(home.players.player.resources.ore, "a refused upgrade charged ore").toBe(ore);
  });

  it("refuses an unaffordable upgrade without spending anything", () => {
    const { galaxy, home } = settled();
    const port = pad(home);
    const price = SPACEPORT_UPGRADE_COST[2]!.ore!;
    home.players.player.resources.ore = price - 1;

    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: port.id }, galaxy))
      .toMatch(/Not enough ore/i);
    expect(spaceportTier(port), "a refused upgrade moved the tier").toBe(1);
    expect(home.players.player.resources.ore, "a refused upgrade still took the ore").toBe(price - 1);
  });

  it("spends the engine's own price, and the pad lifts more afterwards", () => {
    const { galaxy, home } = settled();
    const port = pad(home);
    const price = SPACEPORT_UPGRADE_COST[2]!.ore!;
    home.players.player.resources.ore = price;

    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: port.id }, galaxy)).toBeNull();
    expect(spaceportTier(port)).toBe(2);
    expect(home.players.player.resources.ore, "the upgrade did not cost exactly SPACEPORT_UPGRADE_COST")
      .toBe(0);
    expect(jumpCapacity(port), "the tier moved but the capacity did not").toBe(SPACEPORT_CAPACITY[2]);
  });

  it("makes the next jump cheaper, which is the other half of what a tier buys", () => {
    // `FUEL_DISCOUNT_BY_TIER` is why `jumpCost` has to be asked rather than shown as a constant, and
    // this is the intent that changes it. Asserted through the bridge's own refusal message, so the
    // number a player is quoted is the one under test.
    const { galaxy, home } = settled();
    const port = pad(home);
    const before = jumpCost(galaxy, FRONTIER);
    home.players.player.resources.ore = SPACEPORT_UPGRADE_COST[2]!.ore!;

    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: port.id }, galaxy)).toBeNull();
    const after = jumpCost(galaxy, FRONTIER);
    expect(after, "upgrading the pad did not cut the fuel bill").toBeLessThan(before);

    galaxy.credits = 0;
    expect(applyIntent(home, { kind: "jump", destId: FRONTIER }, galaxy))
      .toBe(`A jump there costs ${Math.ceil(after)} credits`);
  });

  it("refuses a pad that is still going up (and the message is the one rough edge here)", () => {
    // `upgradeSpaceport` refuses a `constructing` pad, and the bridge reports its `false` as "Not
    // enough ore to extend the pad" — the only case in this intent where the message can name the
    // wrong reason. Asserted as a REFUSAL rather than as an exact string, so a bridge that grows a
    // `constructing` branch improves the wording without going red. Recorded here because the
    // module's own header sets the standard it is missing: a message naming the wrong reason is
    // worse than none.
    const { galaxy, home } = settled();
    const port = makeBuilding("spaceport", "player", 700, 500);
    port.constructing = true;
    home.buildings.set(port.id, port);
    home.players.player.resources.ore = 10_000;

    expect(applyIntent(home, { kind: "upgradeSpaceport", buildingId: port.id }, galaxy)).toBeTruthy();
    expect(spaceportTier(port), "a pad still under construction was upgraded").toBe(1);
    expect(home.players.player.resources.ore, "an unfinished pad was charged for an upgrade").toBe(10_000);
  });
});
