// P4-T06 (colonies, passive income, credits) and P4-T08 (colony standing orders).
//
// Both rows are wiring, so the risk in this file is not that a model is wrong — it is that a model
// is UNFALSIFIABLE. Two shapes of vacuity are specifically hunted here, because both would leave a
// green run proving nothing:
//
//   • **A colony with no buildings.** Every income assertion below would pass against a model that
//     always returned zero, so each one asserts a non-zero rate first and then asserts it against a
//     number the engine itself produced.
//   • **A policy that was already at its default.** `sanitizePolicy(null)` is `{autoSell:{enabled:
//     false,floors:{}},workerTarget:0}`, and a round-trip of *that* would survive a `setColonyPolicy`
//     that dropped its argument on the floor. So every policy claim moves a field off its default
//     and then reads it back.
//
// The strongest assertions here are the ones that compare the model to the MOVER rather than to
// arithmetic: `sweepColonies(galaxy, 1)`'s own credit delta for the income model, and a real
// `runColonyPolicies` scan for the standing orders. `incomeBuildingCount` is module-private in
// `engine/galaxy.js` — the turret exclusion and the cap are the one rule the panel has to repeat —
// so those two assertions are what stop the panel and the treasury drifting apart in silence.
//
// One thing this file establishes early and deliberately: **`stepGalaxy` does not bank colony
// income**, and neither does anything else in this client. `sweepColonies` is the app's to drive,
// and today nobody drives it (see the P4-T06 notes). The first test states that as a fact rather
// than leaving the reader to wonder why every income assertion calls the sweep by hand.

import { describe, expect, it } from "vitest";
import {
  COLONY_INCOME_CAP, COLONY_INCOME_PER_BUILDING, MAX_WORKER_TARGET, PACIFIED_INCOME,
  addPlanet, createGalaxy, getColonyPolicy, makeBuilding, quoteSell, runColonyPolicies,
  sanitizePolicy, setColonyPolicy, stepGalaxy, sweepColonies,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { colonyIncomeModel, colonyPolicyModel, policyPreview } from "../../src/ui/colony-panel.js";

const SEED = 20260814;
/** The seat. Never a colony while the player is standing on it. */
const SEAT = "helix";
/** Two of the three worlds this seed brings up in the background (`backgroundWorldIds`). */
const COLONY = "ferros";
const OTHER = "nimbus";

const galaxy = (): Galaxy => createGalaxy({ seed: SEED, startId: SEAT });
const world = (g: Galaxy, id: string): State => g.planets.get(id)!;

/**
 * Put `n` finished player buildings on a world.
 *
 * Placed rather than built: a Habitat takes an economy and a worker to raise, and none of the
 * claims below turn on how a building got there — only on `sweepColonies` finding it. `makeBuilding`
 * is the engine's own constructor, the same one `test/bridge/galaxy-save.test.ts` places with.
 */
function place(state: State, type: string, n: number): Building[] {
  const base = state.map.bases.player;
  const out: Building[] = [];
  for (let i = 0; i < n; i++) {
    const b = makeBuilding(type, "player", base.x + 60 + i * 40, base.y + 60 + (i % 3) * 40);
    b.constructing = false;
    b.buildProgress = 1;
    state.buildings.set(b.id, b);
    out.push(b);
  }
  return out;
}

/** Credits banked by one second of the colony sweep — the engine's own number, not a prediction. */
function bankOneSecond(g: Galaxy): number {
  const before = g.credits;
  sweepColonies(g, 1);
  return g.credits - before;
}

/**
 * What the sweep pays for ONE world, measured rather than divided out of the total.
 *
 * A probe galaxy holding a single planet, sharing everything the sweep reads (`pacified`) and
 * carrying its own credits and notification bookkeeping so measuring cannot disturb the galaxy being
 * measured. Without this, a model that piled every world's income onto one row would still match the
 * total — which is exactly the bug a sum hides.
 */
function bankFor(g: Galaxy, id: string): number {
  const probe = { ...g, credits: 0, planets: new Map([[id, world(g, id)]]), colonyNotes: new Map() } as Galaxy;
  sweepColonies(probe, 1);
  return probe.credits;
}

/** The most a colony can pay from buildings alone. */
const colonyCeiling = COLONY_INCOME_CAP * COLONY_INCOME_PER_BUILDING;

const row = (g: Galaxy, id: string) => colonyIncomeModel(g).rows.find((r) => r.id === id)!;

/* =================================================================================================
   P4-T06 — THE INCOME, AND WHO MOVES IT
   ================================================================================================= */

describe("colony income: sweepColonies is the mover (P4-T06)", () => {
  it("is not banked by stepping the galaxy — the sweep is a separate call the app owes", () => {
    // Stated first because everything below depends on it. `stepGalaxy` runs the worlds, the lanes
    // and the throttled galaxy scans; it does NOT run `sweepColonies`, so a client that only steps
    // has colonies that produce nothing. Nothing in this repo calls it yet.
    const g = galaxy();
    place(world(g, COLONY), "habitat", 3);

    const before = g.credits;
    for (let i = 0; i < 20; i++) stepGalaxy(g, STEP_SECONDS);   // a full sim-second of everything else
    expect(g.credits, "stepping the galaxy banked colony income on its own — this file's premise is wrong")
      .toBe(before);

    const banked = bankOneSecond(g);
    expect(banked, "the sweep banked nothing for a three-building colony").toBeGreaterThan(0);
  });

  it("reports the rate the sweep actually banks, colony by colony and in total", () => {
    // THE anti-drift assertion. The panel counts buildings itself (`incomeBuildingCount` is
    // module-private), so the only thing that keeps that count honest is comparing its result to the
    // credits the engine really moves.
    const g = galaxy();
    place(world(g, COLONY), "habitat", 4);
    place(world(g, COLONY), "turret", 2);          // excluded — a turret wall is not an economy
    place(world(g, OTHER), "reactor", 9);          // three past the cap

    const model = colonyIncomeModel(g);
    expect(model.perSecond, "the model says these colonies earn nothing").toBeGreaterThan(0);
    expect(bankOneSecond(g), "the panel's total and the treasury disagree")
      .toBeCloseTo(model.perSecond, 9);

    // Per world as well as in aggregate.
    for (const r of model.rows) {
      expect(r.perSecond, `${r.id}'s row disagrees with what the sweep pays for ${r.id}`)
        .toBeCloseTo(bankFor(g, r.id), 9);
    }
    expect(model.rows.filter((r) => r.perSecond > 0).length, "only one world is earning, so the per-row check is weak")
      .toBeGreaterThan(1);
    expect(model.perMinute, "per-minute is not per-second's own minute").toBeCloseTo(model.perSecond * 60, 9);
  });

  it("counts a building the moment it is placed, unfinished included — upstream's rule, mirrored", () => {
    // Worth pinning rather than assuming: `incomeBuildingCount` does not look at `constructing`, so
    // a half-raised Habitat pays like a finished one. A panel that "corrected" that would understate
    // every colony the player is actively developing.
    const g = galaxy();
    const colony = world(g, COLONY);
    const [b] = place(colony, "habitat", 1);
    b!.constructing = true;
    b!.buildProgress = 0.2;

    expect(row(g, COLONY).counted, "an unfinished building was not counted").toBe(1);
    expect(bankOneSecond(g)).toBeCloseTo(COLONY_INCOME_PER_BUILDING, 9);
  });
});

describe("colony income: the cap, made visible before it bites (P4-T06)", () => {
  it("pays for each building up to the cap and nothing for the one after it", () => {
    // The row's own claim, driven one building at a time. This is the number a player cannot see
    // any other way: the treasury keeps rising while they expand, and simply stops rising — with no
    // event, no message and no visible reason — at the seventh income building.
    const g = galaxy();
    const colony = world(g, COLONY);
    const paid: number[] = [];
    for (let n = 1; n <= COLONY_INCOME_CAP + 2; n++) {
      place(colony, "habitat", 1);
      paid.push(bankOneSecond(g));
    }

    for (let n = 1; n <= COLONY_INCOME_CAP; n++) {
      expect(paid[n - 1], `the ${n}th building did not add the per-building rate`)
        .toBeCloseTo(n * COLONY_INCOME_PER_BUILDING, 9);
    }
    const capped = COLONY_INCOME_CAP * COLONY_INCOME_PER_BUILDING;
    expect(paid[COLONY_INCOME_CAP], "the building past the cap earned something").toBeCloseTo(capped, 9);
    expect(paid[COLONY_INCOME_CAP + 1], "the second building past the cap earned something")
      .toBeCloseTo(capped, 9);
  });

  it("says where a colony stands against the cap, and what the next building is worth", () => {
    const g = galaxy();
    const colony = world(g, COLONY);

    place(colony, "habitat", COLONY_INCOME_CAP - 1);
    let r = row(g, COLONY);
    expect(r.atCap, "one short of the cap and the panel already says it is capped").toBe(false);
    expect(r.beyondCap, "nothing is past the cap yet").toBe(0);
    expect(r.marginalPerSecond, "the next building below the cap is worth the full rate")
      .toBeCloseTo(COLONY_INCOME_PER_BUILDING, 9);

    place(colony, "habitat", 3);                    // two past the cap
    r = row(g, COLONY);
    expect(r.incomeBuildings, "the panel stopped counting standing buildings at the cap")
      .toBe(COLONY_INCOME_CAP + 2);
    expect(r.counted, "the panel counted past the cap").toBe(COLONY_INCOME_CAP);
    expect(r.beyondCap, "the buildings earning nothing are not named").toBe(2);
    expect(r.atCap).toBe(true);
    // The number the expansion decision turns on: at the cap another building is worth exactly zero,
    // and the panel says so BEFORE the ore is spent rather than after the counter fails to move.
    expect(r.marginalPerSecond, "the panel still advertises income for a building that earns none").toBe(0);
    expect(r.perSecond, "a capped colony pays more than the ceiling").toBeCloseTo(colonyCeiling, 9);
  });

  it("states the ceiling as a number the engine confirms, not as a constant quoted back", () => {
    const g = galaxy();
    place(world(g, COLONY), "habitat", COLONY_INCOME_CAP + 4);
    const model = colonyIncomeModel(g);
    expect(bankOneSecond(g), "the advertised per-colony ceiling is not what a maxed colony pays")
      .toBeCloseTo(model.colonyCeiling, 9);
    expect(model.perBuilding * model.cap, "the ceiling is not the rate times the cap")
      .toBeCloseTo(model.colonyCeiling, 9);
  });
});

describe("colony income: what does NOT pay (P4-T06)", () => {
  it("pays nothing for turrets, which is why a turret wall is not an income strategy", () => {
    const g = galaxy();
    const colony = world(g, COLONY);
    place(colony, "turret", 5);

    let r = row(g, COLONY);
    expect(r.buildings, "the turrets are not even counted as standing buildings").toBe(5);
    expect(r.incomeBuildings, "a turret was counted as income").toBe(0);
    expect(bankOneSecond(g), "five turrets earned credits").toBe(0);

    // Anti-vacuity: the same world, one Habitat later, does pay — so the zero above is the turret
    // rule and not an inert world.
    place(colony, "habitat", 1);
    r = row(g, COLONY);
    expect(r.incomeBuildings).toBe(1);
    expect(bankOneSecond(g)).toBeCloseTo(COLONY_INCOME_PER_BUILDING, 9);
  });

  it("pays nothing for the seat, however much is standing on it", () => {
    // The trap a panel falls into by iterating every world it can see. The seat is where the player
    // has built the most, so a panel that counted it would advertise the largest income in the
    // galaxy from the one world that pays nothing at all.
    const g = galaxy();
    place(world(g, SEAT), "habitat", COLONY_INCOME_CAP);

    const seat = row(g, SEAT);
    expect(seat.buildings, "the seat's buildings are not reported").toBe(COLONY_INCOME_CAP);
    expect(seat.earning, "the seat is marked as earning").toBe(false);
    expect(seat.perSecond, "the seat is credited with income").toBe(0);
    expect(colonyIncomeModel(g).perSecond, "the galaxy total counted the seat").toBe(0);
    expect(bankOneSecond(g), "the engine paid for the seat, which would make this test wrong").toBe(0);
  });

  it("keys on the engine's own `background` flag, not on 'any world that is not the seat'", () => {
    // These two predicates agree in every situation the game produces, which is exactly why the
    // wrong one is easy to write and impossible to notice. `addPlanet` without `unsettled` builds a
    // world that is neither the seat nor a background colony — `sweepColonies` skips it, and a panel
    // keyed on `id !== activeId` would report income for it that never arrives.
    const g = galaxy();
    const extra = addPlanet(g, "vesper");
    place(extra, "habitat", 3);

    const r = row(g, "vesper");
    expect(r.id, "the world was not added to the galaxy at all").toBe("vesper");
    expect(r.buildings, "the placed buildings are missing").toBe(3);
    expect(r.earning, "a world the sweep skips is marked as earning").toBe(false);
    expect(bankOneSecond(g), "the engine paid a world that is not a background colony").toBe(0);

    // …and the same three buildings on a real colony do pay, so the zero above is the flag and not
    // the buildings.
    place(world(g, COLONY), "habitat", 3);
    expect(bankOneSecond(g)).toBeCloseTo(3 * COLONY_INCOME_PER_BUILDING, 9);
  });
});

describe("colony income: the occupation dividend (P4-T06)", () => {
  it("adds PACIFIED_INCOME to a conquered world, buildings or none", () => {
    // Pacified through the engine's own rule rather than by writing the set: `checkDomination` calls
    // a world pacified once the neighbour has no standing Command Center AND no colony ship to
    // re-found from. Razing both is what a player does; adding the id to a Set is what a test does,
    // and the two can drift.
    const g = galaxy();
    const colony = world(g, COLONY);
    for (const [id, u] of [...colony.units]) if (u.owner === "ai") colony.units.delete(id);
    for (const [id, b] of [...colony.buildings]) if (b.owner === "ai") colony.buildings.delete(id);

    stepGalaxy(g, STEP_SECONDS);                    // tick 1 runs the conquest scan
    expect(g.pacified.has(COLONY), "the world was not pacified, so there is no dividend to test").toBe(true);

    const bare = row(g, COLONY);
    expect(bare.pacified).toBe(true);
    expect(bare.counted, "this world is supposed to have no player buildings").toBe(0);
    expect(bare.perSecond, "a pacified world with no colony earns nothing")
      .toBeCloseTo(PACIFIED_INCOME, 9);
    expect(bankOneSecond(g), "the dividend the panel shows is not what the engine pays")
      .toBeCloseTo(PACIFIED_INCOME, 9);

    // Additive with the per-building income rather than instead of it — and additive OVER the cap,
    // which is the one way a colony pays more than `colonyCeiling`.
    place(colony, "habitat", COLONY_INCOME_CAP + 2);
    const model = colonyIncomeModel(g);
    const r = model.rows.find((x) => x.id === COLONY)!;
    expect(r.perSecond).toBeCloseTo(model.colonyCeiling + PACIFIED_INCOME, 9);
    expect(bankOneSecond(g)).toBeCloseTo(model.colonyCeiling + PACIFIED_INCOME, 9);
  });
});

describe("colony income: the model itself (P4-T06)", () => {
  it("reports credits and every world, including the ones paying nothing", () => {
    const g = galaxy();
    const model = colonyIncomeModel(g);
    expect(model.credits, "the treasury is not reported").toBe(g.credits);
    expect(model.rows.map((r) => r.id), "the panel drops worlds that are not earning")
      .toEqual([...g.planets.keys()]);
  });

  it("is a pure function of the galaxy it is given", () => {
    const g = galaxy();
    place(world(g, COLONY), "habitat", 2);
    expect(colonyIncomeModel(g)).toEqual(colonyIncomeModel(g));
  });
});

/* =================================================================================================
   P4-T08 — THE STANDING ORDERS
   ================================================================================================= */

describe("colony standing orders: the policy round-trips (P4-T08)", () => {
  it("reads back a world that has never been set as sanitizePolicy(null), not as undefined", () => {
    // The default has to be a real, fully-off policy: `runColonyPolicies` reads `policy.autoSell
    // .enabled` and `policy.workerTarget` unconditionally, and a colony that predates the feature
    // must be inert rather than crash the scan.
    const g = galaxy();
    const model = colonyPolicyModel(g, COLONY);
    expect(model.policy, "an unset world does not read back as the off default")
      .toEqual(sanitizePolicy(null));
    expect(model.policy).toEqual({ autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
    expect(model.autoSellEnabled).toBe(false);
    expect(model.workerTarget).toBe(0);
    expect(model.floors, "an unset world reported floors").toEqual([]);
    expect(model.inertReason, "a fully-off policy does not say that it is off").toMatch(/Nothing is set/);
  });

  it("reads back a policy that has been moved off every default", () => {
    const g = galaxy();
    world(g, COLONY).players.player.resources.ore = 900;
    setColonyPolicy(g, COLONY, { autoSell: { enabled: true, floors: { ore: 200 } }, workerTarget: 4 });

    const model = colonyPolicyModel(g, COLONY);
    expect(model.autoSellEnabled, "auto-sell came back off").toBe(true);
    expect(model.workerTarget, "the sustain target came back at its default").toBe(4);
    expect(model.policy, "the model's policy is not the engine's").toEqual(getColonyPolicy(g, COLONY));
    expect(model.inertReason, "a policy with both halves set was called inert").toBeNull();

    const ore = model.floors.find((f) => f.com === "ore")!;
    expect(ore.floor).toBe(200);
    expect(ore.held, "the colony's own stock is not reported").toBe(900);
    expect(ore.surplus, "the surplus is not held minus the floor").toBe(700);
  });

  it("hands out a copy — a panel that edits its own model cannot corrupt the store", () => {
    const g = galaxy();
    setColonyPolicy(g, COLONY, { workerTarget: 5 });
    const model = colonyPolicyModel(g, COLONY);
    model.policy.workerTarget = 19;
    model.policy.autoSell.floors.ore = 999;

    expect(getColonyPolicy(g, COLONY), "editing the model wrote through to the galaxy's store")
      .toEqual({ autoSell: { enabled: false, floors: {} }, workerTarget: 5 });
  });
});

describe("colony standing orders: the clamp is shown, not silently applied (P4-T08)", () => {
  it("names MAX_WORKER_TARGET when a request exceeds it, and stores exactly what it previewed", () => {
    // The row's own requirement. A UI that accepted 99, stored 20 and displayed 99 would be lying at
    // the keystroke and at every later read; one that stored 20 with no comment would leave the
    // player believing the ceiling is theirs to pick.
    const g = galaxy();
    const preview = policyPreview({ workerTarget: 99 });

    expect(preview.adjustments, "a request four times the ceiling was accepted in silence").not.toEqual([]);
    const clamp = preview.adjustments.find((a) => a.field === "workerTarget")!;
    expect(clamp.requested).toBe("99");
    expect(clamp.accepted, "the preview did not say what will actually be stored").toBe(MAX_WORKER_TARGET);
    expect(clamp.reason, "the reason does not name the ceiling").toContain(String(MAX_WORKER_TARGET));
    expect(preview.policy.workerTarget).toBe(MAX_WORKER_TARGET);

    // …and the preview is not a guess: the engine's own setter lands on the same number.
    setColonyPolicy(g, COLONY, { workerTarget: 99 });
    expect(getColonyPolicy(g, COLONY).workerTarget, "the preview and the engine disagree")
      .toBe(preview.policy.workerTarget);
    expect(colonyPolicyModel(g, COLONY).atMaxWorkerTarget, "the stored policy does not read as capped")
      .toBe(true);
  });

  it("says nothing about a request the validator takes as asked", () => {
    // The control. A preview that always reported an adjustment would be noise, and the test above
    // would pass against it.
    const preview = policyPreview({ workerTarget: MAX_WORKER_TARGET, autoSell: { enabled: true, floors: { ore: 50 } } });
    expect(preview.adjustments, "an entirely valid request was reported as adjusted").toEqual([]);
    expect(preview.policy).toEqual({ autoSell: { enabled: true, floors: { ore: 50 } }, workerTarget: MAX_WORKER_TARGET });
  });

  it("names every other way the validator rewrites a request", () => {
    const rounded = policyPreview({ workerTarget: 3.7 });
    expect(rounded.policy.workerTarget, "the validator no longer rounds").toBe(4);
    expect(rounded.adjustments[0]!.reason, "a rounded target was stored without comment").toMatch(/Rounded/);

    const negative = policyPreview({ workerTarget: -5 });
    expect(negative.policy.workerTarget).toBe(0);
    expect(negative.adjustments[0]!.reason).toMatch(/Below zero/);

    const text = policyPreview({ workerTarget: "many" });
    expect(text.policy.workerTarget).toBe(0);
    expect(text.adjustments[0]!.reason).toMatch(/Not a number/);
  });

  it("names a dropped floor, and says which kind of wrong it was", () => {
    const preview = policyPreview({
      autoSell: { enabled: true, floors: { ore: 100, unobtanium: 50, crystals: -1 } },
    });
    expect(preview.policy.autoSell.floors, "the validator kept a floor it should have dropped")
      .toEqual({ ore: 100 });

    const bogus = preview.adjustments.find((a) => a.field === "autoSell.floors.unobtanium")!;
    expect(bogus.accepted, "a dropped field was reported as stored").toBeNull();
    expect(bogus.reason, "an unknown commodity was dropped without saying so").toMatch(/not a commodity/);

    const negative = preview.adjustments.find((a) => a.field === "autoSell.floors.crystals")!;
    expect(negative.reason).toMatch(/negative/);
    expect(preview.adjustments.some((a) => a.field === "autoSell.floors.ore"), "a valid floor was reported as adjusted")
      .toBe(false);
  });
});

describe("colony standing orders: what the orders will actually do (P4-T08)", () => {
  it("quotes the surplus and the proceeds a scan will really bank", () => {
    // The end-to-end check, and the one that would catch a drift the arithmetic assertions above
    // could all miss together: preview it, run the engine's own scan, compare both sides.
    const g = galaxy();
    const colony = world(g, COLONY);
    colony.players.player.resources.ore = 900;
    setColonyPolicy(g, COLONY, { autoSell: { enabled: true, floors: { ore: 200 } } });

    const ore = colonyPolicyModel(g, COLONY).floors.find((f) => f.com === "ore")!;
    expect(ore.surplus, "there is nothing to sell, so this proves nothing").toBe(700);
    expect(ore.proceeds, "the panel quotes no proceeds for a 700-unit surplus").toBeGreaterThan(0);
    // Not `unitPrice x surplus`: the sale walks in lots and slips between them.
    expect(ore.proceeds, "the quote is a single price multiplied out, not the real lot walk")
      .toBe(quoteSell(colony.market, "ore", 700));

    const credits = g.credits;
    runColonyPolicies(g);
    expect(colony.players.player.resources.ore, "the scan did not sell down to the floor").toBe(200);
    expect(g.credits - credits, "the panel's quote is not what the sale paid").toBe(ore.proceeds);
  });

  it("is inert on the seat, and says so — the order is stored, and nothing runs", () => {
    // The trap a player hits first: set a standing order on the world under your feet and watch
    // nothing happen. `runColonyPolicies` acts on BACKGROUND worlds only; the seat takes real orders.
    const g = galaxy();
    const seat = world(g, SEAT);
    seat.players.player.resources.ore = 900;
    setColonyPolicy(g, SEAT, { autoSell: { enabled: true, floors: { ore: 200 } } });

    const model = colonyPolicyModel(g, SEAT);
    expect(model.policy.autoSell.enabled, "the order was not stored at all, which is a different bug")
      .toBe(true);
    expect(model.inertReason, "a seat policy that will never run reads as ready to run")
      .toMatch(/standing on/);

    const credits = g.credits;
    runColonyPolicies(g);
    expect(seat.players.player.resources.ore, "the seat's stock was sold by a colony standing order")
      .toBe(900);
    expect(g.credits, "the seat earned market credits from a colony standing order").toBe(credits);

    // Anti-vacuity: the identical order on a colony DOES sell, so the inertness above is the seat
    // rule rather than a policy that was never stored.
    const colony = world(g, COLONY);
    colony.players.player.resources.ore = 900;
    setColonyPolicy(g, COLONY, { autoSell: { enabled: true, floors: { ore: 200 } } });
    runColonyPolicies(g);
    expect(colony.players.player.resources.ore, "the colony's own order did not run either").toBe(200);
  });

  it("warns when auto-sell is on with no floor set, because it will sell nothing", () => {
    const g = galaxy();
    const colony = world(g, COLONY);
    colony.players.player.resources.ore = 900;
    setColonyPolicy(g, COLONY, { autoSell: { enabled: true } });

    const model = colonyPolicyModel(g, COLONY);
    expect(model.inertReason, "auto-sell is switched on, so the policy is not inert").toBeNull();
    expect(model.warnings.join(" "), "a switched-on auto-sell with nothing to sell went unremarked")
      .toMatch(/no commodity has a floor/);

    runColonyPolicies(g);
    expect(colony.players.player.resources.ore, "a floorless auto-sell sold something after all").toBe(900);

    // …and the warning clears once a floor exists, on the same colony.
    setColonyPolicy(g, COLONY, { autoSell: { floors: { ore: 200 } } });
    expect(colonyPolicyModel(g, COLONY).warnings, "the warning survived the floor that answers it")
      .toEqual([]);
  });

  it("warns when a worker target has no Command Center to queue from", () => {
    // A colony razed back to its outbuildings keeps its policy, and the sustain half of it silently
    // stops working: `runWorkerSustain` needs a finished Command Center to queue at. The idle-worker
    // half still runs, so the warning says exactly which half is dead.
    const g = galaxy();
    const colony = world(g, COLONY);
    colony.players.player.resources.ore = 2000;
    setColonyPolicy(g, COLONY, { workerTarget: 4 });

    let model = colonyPolicyModel(g, COLONY);
    expect(model.hasCommandCenter, "this colony was supposed to have no Command Center").toBe(false);
    expect(model.warnings.join(" "), "a target with nowhere to queue went unremarked")
      .toMatch(/no worker can be queued/);

    // Build one, and both the warning and the engine's behaviour change together.
    const [cc] = place(colony, "command", 1);
    model = colonyPolicyModel(g, COLONY);
    expect(model.hasCommandCenter).toBe(true);
    expect(model.warnings, "the warning outlived the Command Center that answers it").toEqual([]);
    expect(model.workers, "this colony was supposed to have no workers yet").toBe(0);

    runColonyPolicies(g);
    expect(cc!.queue.length, "the standing order queued nothing at the Command Center it now has")
      .toBeGreaterThan(0);
  });

  it("answers for a world the galaxy does not have, rather than throwing on a stale click", () => {
    const g = galaxy();
    const model = colonyPolicyModel(g, "korrath");   // in the roster, never instantiated
    expect(model.policy, "an absent world did not read back as the off default").toEqual(sanitizePolicy(null));
    expect(model.inertReason, "an absent world does not say it is absent").toMatch(/not a world in this galaxy/);
    expect(model.floors).toEqual([]);
  });
});
