// P5-T06 — milestones, domination, and the fireworks.
//
// The row asks that `checkGalaxyProgress` and `checkDomination` "drive what is shown" and that
// `MILESTONE_IDS` "round-trip", and the note under it says why: the engine raises these itself, so
// the job is to report them. The trap named in the brief is a milestone list re-derived from galaxy
// state — walk the worlds, find a Capital, decide the milestone is earned. That agrees today. This
// file is built to catch the day it stops.
//
// Three shapes carry that:
//
//   • **The engine's answer and the visible condition are separated, and then driven apart.** Four
//     worlds are marked pacified WITHOUT running `checkDomination`, so the count says the target is
//     met and the engine has raised nothing. A model that computed the milestone from the count
//     claims it; this one reports `milestoneReached: false` and `pendingScan: true`, and then agrees
//     the moment the scan runs. The same trick is played for the Capital and the Gate: the
//     condition is arranged and the scan withheld.
//   • **`MILESTONE_IDS` round-trips two ways.** Every id the engine can mint gets a row — asserted
//     as list equality against `MILESTONE_IDS` itself, so a sixth id upstream cannot fall off the
//     panel — and a galaxy with every milestone reached is saved, loaded, and shown identically.
//     That second half runs through the engine's own `isMilestoneId` filter on load, which is what
//     `MILESTONE_IDS` is exported FOR.
//   • **What the engine does not recognise is kept.** A junk id survives in the live galaxy long
//     enough to be shown, and it appears in `unknown` rather than as a milestone and rather than not
//     at all — `bridge/galaxy-snapshot.ts`'s `unknownStatuses` reasoning, applied here.
//
// The vacuity traps specific to this subject:
//
//   • **A milestone that was already reached before the test arranged anything.** Every "not reached
//     yet" assertion is paired with the same galaxy reaching it a few lines later, so nothing here
//     passes because the set was empty and stayed empty.
//   • **A domination test that cannot distinguish target from roster.** `DOMINATION_TARGET` is 4 and
//     the roster is 11, so the `domination` and `domination:all` cases are arranged separately and a
//     panel that confused them fails one of them.
//   • **A world-milestone count read off the worlds instead of off `reached`.** One test puts a lone
//     `world:5` in the set with no worlds settled at all, where a re-derivation answers zero.

import { describe, expect, it } from "vitest";
import {
  DOMINATION_TARGET, MILESTONE_IDS, activeState, addPlanet, checkDomination, checkGalaxyProgress,
  createGalaxy, deserializeGalaxy, isMilestoneId, makeBuilding, serializeGalaxy, upgradeToCapital,
} from "../../src/engine/index.js";
import { milestoneLabel, milestonesPanelModel } from "../../src/ui/milestones-panel.js";

const SEED = 20260815;
const HOME = "helix";

const model = (g: Galaxy) => milestonesPanelModel(g);
const named = (g: Galaxy, id: string) => model(g).named.find((r) => r.id === id)!;
const ids = (g: Galaxy) => model(g).named.map((r) => r.id);

/** Strip every AI foothold from a world — `rivalgate.test.js`'s own `razeAiCommand` idiom. */
function razeAiCommand(state: State): void {
  for (const [id, b] of [...state.buildings]) if (b.owner === "ai" && b.type === "command") state.buildings.delete(id);
  for (const [id, u] of [...state.units]) if (u.owner === "ai" && u.type === "colonyship") state.units.delete(id);
}

/** A player Command Center on `state`, which is what `checkGalaxyProgress` counts a settled world by. */
function settle(state: State): Building {
  const base = state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  state.buildings.set(cc.id, cc);
  return cc;
}

/* =================================================================================================
   THE VOCABULARY — `MILESTONE_IDS` round-trips
   ================================================================================================= */

describe("`MILESTONE_IDS` is the panel's list, not a copy of it (P5-T06)", () => {
  it("shows one row per engine id, in the engine's own order, each with a name", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const m = model(g);

    expect(m.named.map((r) => r.id), "the panel keeps its own list of milestones")
      .toEqual([...MILESTONE_IDS]);
    expect(m.namedTotal).toBe(MILESTONE_IDS.length);
    for (const row of m.named) {
      expect(row.label.length, `${row.id} has no name`).toBeGreaterThan(0);
      expect(isMilestoneId(row.id), `${row.id} is not an id the engine can mint`).toBe(true);
      expect(row.kind).toBe("named");
    }
    // Nothing has happened yet, so nothing is reached — and the next test proves that can change.
    expect(m.reachedCount).toBe(0);
  });

  it("grows a row when the ENGINE's vocabulary grows", () => {
    // The assertion above compares two lists that are identical today, so it cannot tell a panel
    // that READS `MILESTONE_IDS` from one that keeps a copy in the same order — found by mutation:
    // building the rows from this file's own label table survived it. This one cannot be survived.
    // The engine's array is appended to and restored, which is the only way to ask the question.
    const grown = MILESTONE_IDS as string[];
    const before = grown.length;
    grown.push("second-sun");
    try {
      const g = createGalaxy({ seed: SEED, startId: HOME });
      g.reached.add("second-sun");
      const row = model(g).named.find((r) => r.id === "second-sun");
      expect(row, "a milestone the engine can now mint has no row — the panel keeps its own list")
        .toBeDefined();
      expect(row!.reached).toBe(true);
      expect(row!.label, "a new milestone came through nameless").toBe("second-sun");
      expect(model(g).namedTotal).toBe(before + 1);
      expect(model(g).unknown, "an id the engine mints is not unknown").toEqual([]);
    } finally {
      grown.length = before;
    }
    expect(MILESTONE_IDS).toHaveLength(before);
  });

  it("names an id it has never heard of rather than dropping it", () => {
    // What protects the panel when `MILESTONE_IDS` grows: rows come from the engine's list, and the
    // label falls back rather than returning empty.
    expect(milestoneLabel("some-future-milestone")).toBe("some-future-milestone");
    expect(milestoneLabel("world:7"), "the world family lost its name").toBe("7 worlds settled");
    // The tuned target reaches the copy — a re-tuned DOMINATION_TARGET moves the label with it.
    expect(milestoneLabel("domination")).toContain(String(DOMINATION_TARGET));
  });

  it("survives a save and a load unchanged — the filter `MILESTONE_IDS` is exported for", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    for (const id of MILESTONE_IDS) g.reached.add(id);
    g.reached.add("world:1");
    g.reached.add("world:2");
    const before = model(g);
    expect(before.reachedCount, "the fixture did not reach everything").toBe(MILESTONE_IDS.length);

    const loaded = deserializeGalaxy(serializeGalaxy(g)) as Galaxy;
    const after = model(loaded);

    expect(after.named, "a milestone did not survive the round trip").toEqual(before.named);
    expect(after.worlds.map((r) => r.id)).toEqual(["world:1", "world:2"]);
    expect(after.reachedCount).toBe(MILESTONE_IDS.length);
    expect(after.unknown).toEqual([]);
  });

  it("keeps a junk id as evidence, and never as a milestone", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    g.reached.add("capital");
    g.reached.add("not-a-milestone");
    g.milestones.push("also-junk");

    const m = model(g);
    expect(m.unknown, "a junk id was silently swallowed").toEqual(["not-a-milestone", "also-junk"]);
    expect(m.named.map((r) => r.id), "junk was promoted to a milestone row").toEqual([...MILESTONE_IDS]);
    expect(m.worlds).toEqual([]);
    // The queue is reported whole. A firework the engine raised and the panel quietly dropped is
    // the same silence as one never raised.
    expect(m.fireworks.map((r) => r.id), "the firework queue was filtered").toEqual(["also-junk"]);
    expect(named(g, "capital").reached).toBe(true);

    // The engine's own load filter drops it, and then there is nothing to report.
    const loaded = deserializeGalaxy(serializeGalaxy(g)) as Galaxy;
    expect(model(loaded).unknown, "the engine's filter let junk through").toEqual([]);
    expect(model(loaded).named.find((r) => r.id === "capital")!.reached).toBe(true);
  });
});

/* =================================================================================================
   `checkGalaxyProgress` DRIVES WHAT IS SHOWN
   ================================================================================================= */

describe("`checkGalaxyProgress` decides, and the panel reports (P5-T06)", () => {
  it("a fortified Capital is a milestone only once the engine has said so", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const seat = activeState(g);
    const cc = settle(seat);
    Object.assign(seat.players.player.resources, { ore: 9999, metals: 9999, alloys: 9999, machinery: 9999 });

    expect(upgradeToCapital(seat, cc), "the fixture did not actually fortify anything").toBe(true);
    // The condition is now true on the board and the scan has not run.
    expect(named(g, "capital").reached, "the panel read the board instead of the engine").toBe(false);

    checkGalaxyProgress(g);
    expect(named(g, "capital").reached, "the engine raised it and the panel missed it").toBe(true);
    expect(model(g).reachedCount).toBe(1);
  });

  it("a Gate online is a milestone, and the panel waits for the engine to raise it", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const seat = activeState(g);
    settle(seat);
    const gate = makeBuilding("antimatter_gate", "player", 400, 500);
    (gate as unknown as { charge: number }).charge = 1;
    seat.buildings.set(gate.id, gate);

    expect(named(g, "gate").reached).toBe(false);
    checkGalaxyProgress(g);
    expect(named(g, "gate").reached, "a Gate at full charge did not reach the panel").toBe(true);
    // …and it is a firework, not a win.
    expect(seat.over, "the galaxy ended on a Gate — it is a milestone, never a win").toBe(false);
  });

  it("counts settled worlds from `reached`, never from the worlds the player holds", () => {
    // The re-derivation this row warns about, made to disagree: nothing is settled anywhere and the
    // engine's set says the fifth world was. A panel counting Command Centers answers zero.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    g.reached.add("world:5");

    const m = model(g);
    expect(m.worlds.map((r) => r.id), "the panel counted the board instead of reading the set")
      .toEqual(["world:5"]);
    expect(m.worlds[0]!.label).toBe("5 worlds settled");
    expect(m.worlds[0]!.kind).toBe("world");
    // …and it did not invent the four the engine never raised.
    expect(m.worlds).toHaveLength(1);
  });

  it("orders the world family by N whatever order the set is in", () => {
    // `checkGalaxyProgress` always fills `reached` ascending, and `deserializeGalaxy` rebuilds it in
    // that same order — so no engine-produced galaxy can tell an ordered list from an unordered one,
    // and dropping the sort survived every other test here (found by mutation). A set is not ordered
    // by contract, though, and the model promises N-order, so the promise is arranged directly —
    // the same way the junk-id test arranges an id the engine would not have written.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    for (const id of ["world:10", "world:2", "world:11", "world:1"]) g.reached.add(id);

    expect([...g.reached], "the fixture's insertion order is already sorted")
      .toEqual(["world:10", "world:2", "world:11", "world:1"]);
    expect(model(g).worlds.map((r) => r.id), "the world family was reported in set order")
      .toEqual(["world:1", "world:2", "world:10", "world:11"]);
  });

  it("lists the world family in order as the engine fills it in, past ten", () => {
    // Ten worlds, not two. `world:10` sorts before `world:2` as a STRING, and the roster is eleven
    // worlds long, so the engine really does mint two-digit ids — a sort that never sees one is a
    // sort that proves nothing (found by mutation: ordering by `localeCompare` survived the
    // two-world version of this test).
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const settled = g.worlds.slice(0, 10);
    for (const id of settled) {
      if (!g.planets.has(id)) addPlanet(g, id);
      settle(g.planets.get(id)!);
    }
    checkGalaxyProgress(g);

    const expected = settled.map((_, i) => `world:${i + 1}`);
    expect(expected, "the fixture never reached a two-digit milestone").toContain("world:10");
    expect(model(g).worlds.map((r) => r.id), "the world milestones came back out of order")
      .toEqual(expected);
  });
});

/* =================================================================================================
   DOMINATION — the count and the milestone are two different facts
   ================================================================================================= */

describe("`checkDomination` drives the conquest readout (P5-T06)", () => {
  it("reports the engine's target and its own pacified set", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const d = model(g).domination;

    expect(d.target, "the panel typed the target in instead of reading it").toBe(DOMINATION_TARGET);
    expect(d.target).toBe(4);
    expect(d.pacified).toBe(0);
    expect(d.remaining).toBe(DOMINATION_TARGET);
    expect(d.worlds).toEqual([]);
    expect(d.totalWorlds).toBe(g.worlds.length);
    expect(d.milestoneReached).toBe(false);
    expect(d.pendingScan).toBe(false);
  });

  it("counts up as worlds are pacified, in roster order", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    // The pair matters. `checkDomination` walks `galaxy.planets`, whose insertion order puts the
    // seat first — so pacifying `helix` and `ferros` fills the engine's Set as [helix, ferros] while
    // the roster says [ferros, helix]. Any other pair here and the two orders agree, and a panel
    // reporting the raw Set survives this test (found by mutation).
    razeAiCommand(g.planets.get("helix")!);
    razeAiCommand(g.planets.get("ferros")!);
    checkDomination(g);

    expect([...g.pacified], "the fixture's insertion order no longer differs from the roster")
      .toEqual(["helix", "ferros"]);
    const d = model(g).domination;
    expect(d.pacified).toBe(2);
    expect(d.worlds, "the pacified list came back in Map order").toEqual(["ferros", "helix"]);
    expect(d.remaining).toBe(DOMINATION_TARGET - 2);
    expect(d.milestoneReached, "two of four is not domination").toBe(false);
  });

  it("does NOT call the milestone from the count — the engine calls it", () => {
    // The trap, made concrete. The set says the target is met; `checkDomination` has not run, so the
    // engine has raised nothing. A model deriving `milestoneReached` from `pacified >= target` is
    // wrong here, and would go on being wrong the first time another condition joined the target.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    for (const id of g.worlds.slice(0, DOMINATION_TARGET)) g.pacified.add(id);

    const before = model(g).domination;
    expect(before.pacified).toBe(DOMINATION_TARGET);
    expect(before.milestoneReached, "the panel raised a milestone the engine had not").toBe(false);
    expect(before.pendingScan, "the gap between the count and the milestone went unreported").toBe(true);
    expect(named(g, "domination").reached).toBe(false);

    // …and it agrees the moment the engine's own scan runs.
    checkDomination(g);
    const after = model(g).domination;
    expect(after.milestoneReached, "the engine raised it and the panel did not follow").toBe(true);
    expect(after.pendingScan, "the gap was reported after it had closed").toBe(false);
    expect(named(g, "domination").reached).toBe(true);
  });

  it("separates the target from the whole roster", () => {
    // `domination` at 4 and `domination:all` at 11 are different milestones; a panel that folded
    // them together passes one of these and fails the other.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    for (const id of g.worlds) if (!g.planets.has(id)) addPlanet(g, id);
    for (const [, state] of g.planets) razeAiCommand(state);
    checkDomination(g);

    const d = model(g).domination;
    expect(d.pacified).toBe(g.worlds.length);
    expect(d.pacified).toBeGreaterThan(DOMINATION_TARGET);
    expect(d.remaining, "remaining went negative past the target").toBe(0);
    expect(d.milestoneReached).toBe(true);
    expect(d.allMilestoneReached, "pacifying every world did not reach the grander milestone").toBe(true);

    // The four-world case reaches one and not the other.
    const partial = createGalaxy({ seed: SEED, startId: HOME });
    for (const [, state] of partial.planets) razeAiCommand(state);
    checkDomination(partial);
    const p = model(partial).domination;
    expect(p.pacified).toBe(DOMINATION_TARGET);
    expect(p.milestoneReached).toBe(true);
    expect(p.allMilestoneReached, "four of eleven worlds was called the whole galaxy").toBe(false);
  });
});

/* =================================================================================================
   THE FIREWORKS
   ================================================================================================= */

describe("the firework queue is the engine's, in the engine's order (P5-T06)", () => {
  it("reports what `reachMilestone` queued, oldest first, labelled", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const seat = activeState(g);
    const cc = settle(seat);
    Object.assign(seat.players.player.resources, { ore: 9999, metals: 9999, alloys: 9999, machinery: 9999 });
    upgradeToCapital(seat, cc);
    checkGalaxyProgress(g);

    const m = model(g);
    expect(g.milestones, "the fixture queued nothing").toEqual(["world:1", "capital"]);
    expect(m.fireworks.map((r) => r.id), "the queue was reordered or filtered")
      .toEqual(["world:1", "capital"]);
    expect(m.fireworks.map((r) => r.label)).toEqual(["1 worlds settled", "Capital fortified"]);
    expect(m.fireworks.map((r) => r.kind)).toEqual(["world", "named"]);
    expect(m.fireworks.every((r) => r.reached)).toBe(true);
  });

  it("a milestone already reached is never queued twice", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    settle(activeState(g));
    checkGalaxyProgress(g);
    checkGalaxyProgress(g);
    checkGalaxyProgress(g);

    expect(model(g).fireworks.map((r) => r.id), "`reachMilestone`'s idempotence did not survive")
      .toEqual(["world:1"]);
  });

  it("the queue is transient and `reached` is not — a reload replays no fireworks", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    settle(activeState(g));
    checkGalaxyProgress(g);
    expect(model(g).fireworks).toHaveLength(1);

    const loaded = deserializeGalaxy(serializeGalaxy(g)) as Galaxy;
    const m = model(loaded);
    expect(m.fireworks, "a reload replayed a firework the player has already seen").toEqual([]);
    expect(m.worlds.map((r) => r.id), "the milestone itself did not survive").toEqual(["world:1"]);
  });
});

/* =================================================================================================
   PURITY
   ================================================================================================= */

describe("the panel reads and never scans (P5-T06)", () => {
  it("raises nothing, queues nothing and drains nothing by being opened", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const seat = activeState(g);
    const cc = settle(seat);
    Object.assign(seat.players.player.resources, { ore: 9999, metals: 9999, alloys: 9999, machinery: 9999 });
    upgradeToCapital(seat, cc);
    for (const [, state] of g.planets) razeAiCommand(state);

    // Every condition on the board is met and no scan has run.
    const first = model(g);
    expect(first.reachedCount, "the panel ran a scan and raised milestones").toBe(0);
    expect(first.domination.pacified, "the panel pacified worlds by being opened").toBe(0);
    expect([...g.reached]).toEqual([]);
    expect(g.milestones).toEqual([]);

    // Opening it again changes nothing about the galaxy or the answer.
    expect(model(g)).toEqual(first);
    expect([...g.reached]).toEqual([]);

    // …and the engine's own scans still do their job afterwards.
    checkGalaxyProgress(g);
    checkDomination(g);
    const after = model(g);
    expect(after.reachedCount).toBeGreaterThan(0);
    expect(after.domination.pacified).toBe(DOMINATION_TARGET);
    expect(ids(g)).toEqual([...MILESTONE_IDS]);
  });
});
