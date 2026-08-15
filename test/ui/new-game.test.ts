// PARITY row 104 — new-game setup: faction and difficulty.
//
// `WorldOptions` has accepted both since Phase 1 and `main.ts` passes neither, so every session this
// client has ever run has been Medium / Frontier. The row is a screen; this is the model under it,
// and the file is built around the three ways a setup screen lies about a tuning table:
//
//   • **It re-derives what a difficulty means.** Every row here is `DIFFICULTY_OPTIONS` mapped, and
//     the test that says so appends a field to the engine's own entry and watches a row appear —
//     the same round trip `milestones-panel.test.ts` makes against `MILESTONE_IDS`.
//   • **It fills in Medium's empty column.** Medium carries none of the tuning fields, and the
//     obvious repair is to default an absent one to 1. `counterEvery` is where that is wrong by
//     three units: Easy sets it to **0**, Medium leaves it absent, and its use site reads
//     `?? COUNTER_EVERY` (3). Present-with-0 and absent are asserted as different things.
//   • **It trusts the engine to refuse a bad pick.** It does not, twice over, in two different
//     ways — and both are proved by BUILDING the galaxy and looking at what the AI got, not by
//     reading the fallback in `difficultyFor`.
//
// The vacuity traps specific to this subject:
//
//   • **A trait table that agrees with itself.** The multipliers are asserted against
//     `factionTrait` called on a REAL galaxy's state, built with that faction — so the one-field
//     stub this model asks with is held against the thing it is standing in for.
//   • **A difficulty pick that changes nothing.** Every "the pick reached the engine" assertion is
//     paired with a galaxy built at a different difficulty answering differently.
//   • **A default nobody checked.** `ENGINE_DEFAULT_*` are `createGalaxy`'s own parameter defaults,
//     which cannot be imported — so they are pinned against a galaxy built with neither field set.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIFFICULTY_OPTIONS, FACTIONS, PLAYABLE_FACTIONS, activeState, createGalaxy, factionTrait,
} from "../../src/engine/index.js";
import { MVP_WORLD, WorldBridge } from "../../src/bridge/world.js";
import {
  ENGINE_DEFAULT_DIFFICULTY, ENGINE_DEFAULT_FACTION, dialLabel, newGameModel, traitLabel,
  worldOptionsFor,
} from "../../src/ui/new-game.js";

const SEED = 20260815;
const SEAT = "helix";

const model = (requested: unknown = null) => newGameModel({ requested });
const factionOf = (id: string, requested: unknown = null) => model(requested).factions.find((f) => f.id === id)!;
const diffOf = (key: string, requested: unknown = null) => model(requested).difficulties.find((d) => d.key === key)!;

/** A galaxy built the way this model says to build one. */
function build(requested: unknown): Galaxy {
  const m = model(requested);
  const opts = worldOptionsFor(m.choice, { seed: SEED, worldId: SEAT });
  return new WorldBridge(opts).galaxy;
}

/* =================================================================================================
   THE DEFAULT NOBODY EVER CHOSE
   ================================================================================================= */

describe("what every session of this client has silently been", () => {
  it("names the engine's own defaults, pinned against a galaxy built with neither field set", () => {
    // `createGalaxy`'s parameter defaults are not exported and cannot be imported, so they are asked
    // for instead: build one with nothing and read what it wrote down.
    const bare = createGalaxy({ seed: SEED, startId: SEAT });
    expect(bare.settings.difficulty, "the engine's default difficulty moved").toBe(ENGINE_DEFAULT_DIFFICULTY);
    expect(bare.settings.playerFaction, "the engine's default faction moved").toBe(ENGINE_DEFAULT_FACTION);
  });

  it("marks the status quo as preselected without making it the only thing selectable", () => {
    const m = model();
    expect(m.choice).toEqual({ difficulty: ENGINE_DEFAULT_DIFFICULTY, playerFaction: ENGINE_DEFAULT_FACTION });
    expect(m.isDefault).toBe(true);
    expect(m.difficulties.filter((d) => d.preselected).map((d) => d.key)).toEqual([ENGINE_DEFAULT_DIFFICULTY]);
    expect(m.factions.filter((f) => f.preselected).map((f) => f.id)).toEqual([ENGINE_DEFAULT_FACTION]);

    const picked = model({ difficulty: "hard", playerFaction: "syndicate" });
    expect(picked.isDefault).toBe(false);
    expect(picked.difficulties.find((d) => d.selected)!.key).toBe("hard");
    expect(picked.factions.find((f) => f.selected)!.id).toBe("syndicate");
    // Preselected is about the engine, selected is about the player: the two must not be the same
    // bit, on either list. A screen that marked the pick as "the default" would be telling the
    // player they had changed nothing.
    expect(picked.difficulties.find((d) => d.preselected)!.key).toBe(ENGINE_DEFAULT_DIFFICULTY);
    expect(picked.factions.find((f) => f.preselected)!.id).toBe(ENGINE_DEFAULT_FACTION);
    expect(picked.factions.filter((f) => f.preselected)).toHaveLength(1);
    expect(picked.factions.filter((f) => f.selected)).toHaveLength(1);
  });
});

/* =================================================================================================
   THE FACTIONS
   ================================================================================================= */

describe("the faction roster is `PLAYABLE_FACTIONS`, not a copy of it", () => {
  it("offers the engine's list, in the engine's order, and not `neutral`", () => {
    const m = model();
    expect(m.factions.map((f) => f.id)).toEqual([...PLAYABLE_FACTIONS]);
    // `neutral` IS a faction — `createGameState` defaults to it and `FACTIONS` carries it — and
    // upstream's own comment says it is internal only. Offering it would be offering "no bonuses"
    // as a fourth pick the setup screen was never meant to have.
    expect(Object.keys(FACTIONS), "the roster no longer contains `neutral`").toContain("neutral");
    expect(m.factions.map((f) => f.id)).not.toContain("neutral");
  });

  it("carries the engine's own name and blurb for each", () => {
    for (const f of model().factions) {
      expect(f.name).toBe(FACTIONS[f.id]!.name);
      expect(f.blurb.length, `${f.id} has no blurb, and the blurb is where the polarity lives`)
        .toBeGreaterThan(0);
      expect(f.short.length).toBeGreaterThan(0);
    }
    expect(factionOf("miners").blurb).toContain("richer hauls");
  });

  it("resolves every trait through `factionTrait`, and agrees with a real galaxy's state", () => {
    // The stub this model asks with is a one-field state. Here it is held against the thing it
    // stands in for: a galaxy actually built with that faction, whose `players.player.faction` is
    // what the engine reads through `sideMod` on every gather, move and shot.
    for (const id of PLAYABLE_FACTIONS) {
      const seat = activeState(createGalaxy({ seed: SEED, startId: SEAT, playerFaction: id }));
      for (const line of factionOf(id).traits) {
        expect(line.multiplier, `${id}.${line.key} disagrees with the running engine`)
          .toBe(factionTrait(seat, "player", line.key));
      }
    }
  });

  it("gives three factions three comparable columns, marking the dials each leaves alone", () => {
    const m = model();
    const keys = m.factions.map((f) => f.traits.map((t) => t.key));
    expect(keys[0], "the columns do not line up, so the picker cannot compare them").toEqual(keys[1]);
    expect(keys[1]).toEqual(keys[2]);
    // Every key any faction touches is a row for all of them — read out of the engine's own bags.
    const engineKeys = new Set(PLAYABLE_FACTIONS.flatMap((id) => Object.keys(FACTIONS[id]!.traits as object)));
    expect(new Set(keys[0])).toEqual(engineKeys);

    const frontier = factionOf("frontier");
    // Frontier touches speed and sight and nothing else. `stock` is the difference between "this
    // faction gives no bonus here" and "this dial does not exist", which a blank cell cannot say.
    expect(frontier.traits.find((t) => t.key === "speedMult")!.stock).toBe(false);
    expect(frontier.traits.find((t) => t.key === "gatherMult")!.stock).toBe(true);
    expect(frontier.traits.find((t) => t.key === "gatherMult")!.multiplier).toBe(1);
  });

  it("states the multiplier as a percentage without a verdict on it", () => {
    const miners = factionOf("miners");
    const gather = miners.traits.find((t) => t.key === "gatherMult")!;
    const build = miners.traits.find((t) => t.key === "buildTimeMult")!;

    expect(gather.multiplier).toBe(1.15);
    // Rounded: `(1.15 - 1) * 100` is not 15 in binary floating point, and a picker that printed the
    // IEEE representation would be reporting the arithmetic rather than the trait.
    expect(gather.percent).toBe("+15%");
    expect(build.multiplier).toBe(0.9);
    expect(build.percent).toBe("-10%");
    expect(factionOf("frontier").traits.find((t) => t.key === "gatherMult")!.percent).toBe("±0%");

    // **And there is deliberately no verdict.** `buildTimeMult: 0.90` is an improvement and
    // `gatherMult: 0.92` is a penalty, and which way a dial cuts is a fact about `sideMod`'s use
    // sites rather than about the faction. A polarity table here would be a second opinion nothing
    // keeps in sync — so the model carries the number, and the engine's blurb carries the meaning.
    const syndicate = factionOf("syndicate");
    expect(syndicate.traits.find((t) => t.key === "gatherMult")!.percent).toBe("-8%");
    expect(Object.keys(build)).not.toContain("better");
    expect(Object.keys(build)).not.toContain("direction");
  });

  it("names a trait key it has never heard of rather than dropping it", () => {
    expect(traitLabel("speedMult")).toBe("Movement speed");
    expect(traitLabel("warpFieldMult")).toBe("warpFieldMult");

    const traits = FACTIONS.frontier!.traits as Record<string, number>;
    traits.warpFieldMult = 1.5;
    try {
      const line = factionOf("frontier").traits.find((t) => t.key === "warpFieldMult");
      expect(line, "a trait added upstream never became a row").toBeDefined();
      expect(line!.multiplier, "the new trait's value was not asked of the engine").toBe(1.5);
      expect(line!.label).toBe("warpFieldMult");
      // …and it becomes a row for every faction, so the columns stay comparable.
      expect(factionOf("miners").traits.some((t) => t.key === "warpFieldMult")).toBe(true);
      expect(factionOf("miners").traits.find((t) => t.key === "warpFieldMult")!.stock).toBe(true);
    } finally {
      delete traits.warpFieldMult;
    }
    expect(factionOf("frontier").traits.some((t) => t.key === "warpFieldMult")).toBe(false);
  });
});

/* =================================================================================================
   THE DIFFICULTIES
   ================================================================================================= */

describe("a difficulty is a name for a tuning table the engine owns", () => {
  it("offers `DIFFICULTY_OPTIONS`, keyed on `mult` and labelled with `label`", () => {
    const m = model();
    // `mult` is the key `WorldOptions.difficulty` takes and `label` is the button text. A model that
    // confused the two would produce a picker whose every choice was silently downgraded to Medium.
    expect(m.difficulties.map((d) => d.key)).toEqual(DIFFICULTY_OPTIONS.map((o) => o.mult));
    expect(m.difficulties.map((d) => d.label)).toEqual(DIFFICULTY_OPTIONS.map((o) => o.label));
    expect(m.difficulties.map((d) => d.note)).toEqual(DIFFICULTY_OPTIONS.map((o) => o.note));
    expect(diffOf("medium").note).toBe("a fair fight");
  });

  it("shows every dial any difficulty carries, so three columns compare", () => {
    const m = model();
    const keys = m.difficulties.map((d) => d.dials.map((x) => x.key));
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[1]).toEqual(keys[2]);

    const engineKeys = new Set(DIFFICULTY_OPTIONS.flatMap((o) => Object.keys(o))
      .filter((k) => k !== "label" && k !== "mult" && k !== "note"));
    expect(new Set(keys[0]), "the dial list is not the engine's").toEqual(engineKeys);
    expect(engineKeys.size, "the engine's tuning table shrank to nothing").toBeGreaterThan(10);
  });

  it("reports Medium's empty table as empty, and never as ones", () => {
    // Upstream: "Medium carries none of them at all (byte-identical to unset) ... the baseline every
    // dial is relative to." A picker that printed a value here would be inventing the baseline.
    const medium = diffOf("medium");
    const tuning = medium.dials.filter((d) => d.key !== "aiApm" && d.key !== "aiMicro" && d.key !== "marketAccess");
    expect(tuning.every((d) => !d.present && d.value === null),
      `Medium reported a value it does not carry: ${JSON.stringify(tuning.filter((d) => d.present))}`).toBe(true);
    expect(medium.dialsSet, "Medium's own three fields went missing").toBe(3);
    expect(diffOf("hard").dialsSet).toBeGreaterThan(medium.dialsSet);
  });

  it("keeps `counterEvery: 0` and an absent `counterEvery` apart", () => {
    // **The whole reason `present` exists.** Easy sets 0 — it never counter-picks. Medium leaves it
    // absent, and `aiMilitary.js` reads `?? COUNTER_EVERY`, which is 3. A model that defaulted an
    // absent numeric dial to 1 would have said they were the same, and would have been wrong about
    // both of them.
    const easy = diffOf("easy").dials.find((d) => d.key === "counterEvery")!;
    const medium = diffOf("medium").dials.find((d) => d.key === "counterEvery")!;
    expect(easy.present).toBe(true);
    expect(easy.value).toBe(0);
    expect(medium.present).toBe(false);
    expect(medium.value).toBeNull();
    // …and the same for a flag, where `false` and absent are equally different.
    expect(diffOf("easy").dials.find((d) => d.key === "aiMicro")!.value).toBe(false);
    expect(diffOf("easy").dials.find((d) => d.key === "aiMicro")!.present).toBe(true);
  });

  it("carries every value verbatim, whatever type it is", () => {
    const hard = diffOf("hard");
    const value = (k: string) => hard.dials.find((d) => d.key === k)!.value;
    expect(value("aiApm")).toBe(140);
    expect(value("aiMicro")).toBe(true);
    expect(value("workerTargetMult")).toBe(1.25);
    expect(value("strategicCeiling"), "Hard was given Easy's ceiling").toBeNull();
    expect(diffOf("easy").dials.find((d) => d.key === "strategicCeiling")!.value).toBe(true);
  });

  it("grows a row when the engine's own table does", () => {
    // The round trip `milestones-panel.test.ts` makes against `MILESTONE_IDS`: the list is the
    // engine's, so a dial added upstream reaches the picker with no edit here.
    const hard = DIFFICULTY_OPTIONS[2] as unknown as Record<string, unknown>;
    hard.rushWindow = 42;
    try {
      const line = diffOf("hard").dials.find((d) => d.key === "rushWindow");
      expect(line, "a dial added upstream never became a row").toBeDefined();
      expect(line!.value).toBe(42);
      expect(line!.label).toBe("rushWindow");
      expect(diffOf("medium").dials.find((d) => d.key === "rushWindow")!.present,
        "the new dial was reported as set on a difficulty that does not carry it").toBe(false);
    } finally {
      delete hard.rushWindow;
    }
    expect(diffOf("hard").dials.some((d) => d.key === "rushWindow")).toBe(false);
  });

  it("names a dial it has never heard of rather than leaving the row blank", () => {
    expect(dialLabel("aiApm")).toBe("Opponent actions per minute");
    expect(dialLabel("rushWindow")).toBe("rushWindow");
    for (const d of model().difficulties) {
      for (const line of d.dials) expect(line.label.length, `${line.key} has no name`).toBeGreaterThan(0);
    }
  });

  it("says what the pick actually reaches", () => {
    // `buildPlanetState` gives `galaxy.settings`' difficulty to the world whose id is
    // `galaxy.activeId` and resolves every other world through `neighbourAiProfile`. Two galaxies
    // from one seed at two difficulties: the seat differs, every other world is identical. Picking
    // Hard is not "the galaxy is hard".
    const easy = build({ difficulty: "easy" });
    const hard = build({ difficulty: "hard" });
    const dialsOf = (g: Galaxy, id: string) => (g.planets.get(id) as unknown as { ai: { difficulty: string } }).ai.difficulty;

    expect(dialsOf(easy, easy.activeId)).toBe("easy");
    expect(dialsOf(hard, hard.activeId)).toBe("hard");
    const others = [...easy.planets.keys()].filter((id) => id !== easy.activeId);
    expect(others.length, "this seed brought up no other world, so the claim is untested")
      .toBeGreaterThan(0);
    for (const id of others) {
      expect(dialsOf(hard, id), `${id} followed the player's pick`).toBe(dialsOf(easy, id));
    }
    expect(model().difficultyScope).toContain("starting world");
  });
});

/* =================================================================================================
   THE TWO SILENT FAILURES
   ================================================================================================= */

describe("the engine accepts both fields without validating either", () => {
  it("refuses a difficulty the engine would have played as Medium without saying so", () => {
    // The behavioural half first: a galaxy built at a junk difficulty is a Medium galaxy. Hard seeds
    // the synthetic `hardEdge` upgrade onto the AI at creation, so it is the observable that
    // separates the three.
    const edge = (difficulty: string): boolean => {
      const seat = activeState(createGalaxy({ seed: SEED, startId: SEAT, difficulty }));
      return (seat as unknown as { players: Record<string, { upgrades: Record<string, unknown> }> })
        .players.ai!.upgrades.hardEdge === true;
    };
    expect(edge("hard"), "Hard's economic edge is not observable, so nothing below is proved").toBe(true);
    expect(edge("medium")).toBe(false);
    expect(edge("bogus"), "the engine refused an unknown difficulty").toBe(false);

    const m = model({ difficulty: "bogus" });
    expect(m.choice.difficulty).toBe(ENGINE_DEFAULT_DIFFICULTY);
    expect(m.problems).toHaveLength(1);
    expect(m.problems[0]).toContain("bogus");
    expect(m.problems[0], "the message does not say what the engine would have done").toContain("Medium");
  });

  it("refuses a faction the engine would have accepted and given nothing", () => {
    // The second silent failure, and it is a different one: the id is STORED, so the save says
    // "bogus" while every multiplier is 1. The player is Unaligned and nothing anywhere says so.
    const seat = activeState(createGalaxy({ seed: SEED, startId: SEAT, playerFaction: "bogus" }));
    expect((seat as unknown as { players: Record<string, { faction: string }> }).players.player!.faction)
      .toBe("bogus");
    for (const key of ["speedMult", "sightMult", "gatherMult", "buildTimeMult", "damageDealtMult"]) {
      expect(factionTrait(seat, "player", key), `${key} was not silently 1`).toBe(1);
    }
    const real = activeState(createGalaxy({ seed: SEED, startId: SEAT, playerFaction: "frontier" }));
    expect(factionTrait(real, "player", "speedMult"), "a real faction gives nothing either")
      .not.toBe(1);

    const m = model({ playerFaction: "bogus" });
    expect(m.choice.playerFaction).toBe(ENGINE_DEFAULT_FACTION);
    expect(m.problems).toHaveLength(1);
    expect(m.problems[0]).toContain("no bonuses");
  });

  it("refuses `neutral`, which the engine would have honoured", () => {
    // Not junk — a real entry with an empty trait bag. Rejecting it is a decision, so it is tested
    // as one rather than falling out of the same branch as a typo.
    expect(FACTIONS.neutral, "the engine no longer has a neutral faction").toBeDefined();
    const m = model({ playerFaction: "neutral" });
    expect(m.choice.playerFaction).toBe(ENGINE_DEFAULT_FACTION);
    expect(m.problems).toHaveLength(1);
  });

  it("says nothing about an absent request, and everything about a malformed one", () => {
    for (const nothing of [null, undefined, {}, { difficulty: undefined }]) {
      const m = model(nothing);
      expect(m.problems, `${JSON.stringify(nothing)} was treated as a bad pick`).toEqual([]);
      expect(m.isDefault).toBe(true);
    }
    // Untrusted input in `loadSettings`' sense: this can arrive from storage, a query string or a
    // hand-edited file, and none of it is a string.
    for (const junk of ["a string", 42, ["easy"], true]) {
      expect(model(junk).problems, `${JSON.stringify(junk)} produced a complaint about nothing`).toEqual([]);
      expect(model(junk).choice.difficulty).toBe(ENGINE_DEFAULT_DIFFICULTY);
    }
    const both = model({ difficulty: 7, playerFaction: ["miners"] });
    expect(both.problems).toHaveLength(2);
    expect(both.problems[0]).toContain("number");
    expect(both.choice).toEqual({ difficulty: ENGINE_DEFAULT_DIFFICULTY, playerFaction: ENGINE_DEFAULT_FACTION });
  });
});

/* =================================================================================================
   AND THE OTHER END: THE OPTIONS A BRIDGE IS ACTUALLY BUILT WITH
   ================================================================================================= */

describe("`worldOptionsFor` is the two fields `main.ts` has never passed", () => {
  it("sets both without touching what the shell had already decided", () => {
    const base = { seed: SEED, worldId: MVP_WORLD };
    const opts = worldOptionsFor({ difficulty: "hard", playerFaction: "syndicate" }, base);
    expect(opts).toEqual({ seed: SEED, worldId: MVP_WORLD, difficulty: "hard", playerFaction: "syndicate" });
    // ADR-0010 §2 fixed the seed and the world so playtest reports compare. This row does not
    // overturn that, and a model that dropped either would.
    expect(opts.seed).toBe(base.seed);
    expect(opts.worldId).toBe(base.worldId);
    expect(worldOptionsFor({ difficulty: "easy", playerFaction: "miners" }))
      .toEqual({ difficulty: "easy", playerFaction: "miners" });

    // And the choice wins over anything the base already carried. `WorldOptions` has had both fields
    // since Phase 1, so a base built from a stored default is exactly the shape that would arrive
    // here — and a spread in the wrong order would silently ignore the player's pick.
    const stale = { seed: SEED, difficulty: "easy", playerFaction: "miners" };
    expect(worldOptionsFor({ difficulty: "hard", playerFaction: "syndicate" }, stale))
      .toEqual({ seed: SEED, difficulty: "hard", playerFaction: "syndicate" });
  });

  it("reaches the running simulation, not just `galaxy.settings`", () => {
    const galaxy = build({ difficulty: "hard", playerFaction: "syndicate" });
    expect(galaxy.settings.difficulty).toBe("hard");
    expect(galaxy.settings.playerFaction).toBe("syndicate");

    const seat = activeState(galaxy);
    // The two observables the pick actually moves: the AI's Hard-only economic edge, and the
    // player's own trait multipliers as `sideMod` will read them on every gather and every shot.
    expect((seat as unknown as { players: Record<string, { upgrades: Record<string, unknown> }> })
      .players.ai!.upgrades.hardEdge).toBe(true);
    expect(factionTrait(seat, "player", "damageDealtMult")).toBe(1.1);
    expect(factionTrait(seat, "player", "gatherMult")).toBe(0.92);

    // The pairing: today's silent default answers differently on both counts.
    const today = new WorldBridge({ seed: SEED, worldId: SEAT }).galaxy;
    expect((activeState(today) as unknown as { players: Record<string, { upgrades: Record<string, unknown> }> })
      .players.ai!.upgrades.hardEdge).not.toBe(true);
    expect(factionTrait(activeState(today), "player", "damageDealtMult")).toBe(1);
  });

  it("carries a rejected pick through as the engine default rather than as junk", () => {
    const galaxy = build({ difficulty: "HARD", playerFaction: "Syndicate" });
    // Case matters — these are engine keys, not labels — and the point of sanitising before
    // `createGalaxy` is that the string the galaxy records is one `difficultyFor` can resolve.
    expect(galaxy.settings.difficulty).toBe(ENGINE_DEFAULT_DIFFICULTY);
    expect(galaxy.settings.playerFaction).toBe(ENGINE_DEFAULT_FACTION);
    expect(model({ difficulty: "HARD", playerFaction: "Syndicate" }).problems).toHaveLength(2);
  });

  it("is pure: two calls agree and neither touches the engine's tables", () => {
    const before = JSON.stringify({ d: DIFFICULTY_OPTIONS, f: FACTIONS });
    expect(model({ difficulty: "easy" })).toEqual(model({ difficulty: "easy" }));
    expect(JSON.stringify({ d: DIFFICULTY_OPTIONS, f: FACTIONS }), "the model edited the engine's own tables")
      .toBe(before);
  });
});

/* =================================================================================================
   THE ONE CLAIM NO BEHAVIOURAL TEST CAN MAKE

   `factionTrait(state, owner, key)` and `FACTIONS[id].traits[key]` answer identically today — that
   is the whole reason the second is tempting — so no assertion above can tell which one this model
   asks. `save-panel.test.ts` had the same problem with "the panel does not deserialize" and answered
   it the same way: read the source.
   ================================================================================================= */

describe("the resolution goes through the engine's own function", () => {
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "ui", "new-game.ts"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("calls `factionTrait` and never reads a trait's value out of the table", () => {
    expect(SOURCE, "the model stopped asking `factionTrait` for a multiplier")
      .toMatch(/factionTrait\s*\(/);
    // `traits` may be ENUMERATED — `factionTrait` answers for a key and cannot list them — but a
    // value read straight out of the bag is a second opinion about a resolution the engine owns
    // (ADR-0012 §5), and it would be right until the day the resolution grows a rule.
    expect([...SOURCE.matchAll(/\.traits\s*\[/g)].map((m) => m[0]),
      "a trait's value was read out of `FACTIONS` rather than asked of `factionTrait`").toEqual([]);
    expect(SOURCE, "the trait keys are no longer enumerated from the engine's own bags")
      .toMatch(/Object\.keys\(traits\)/);
  });

  it("reads the dial tables off `DIFFICULTY_OPTIONS` rather than naming a difficulty", () => {
    expect(SOURCE).toMatch(/DIFFICULTY_OPTIONS/);
    // The three engine keys must not appear as string literals in the resolution: a difficulty
    // hard-coded here is a difficulty that stops existing when upstream renames it.
    const literals = [...SOURCE.matchAll(/"(easy|hard)"/g)].map((m) => m[0]);
    expect(literals, `a difficulty key is written into the model: ${literals.join(", ")}`).toEqual([]);
  });
});
