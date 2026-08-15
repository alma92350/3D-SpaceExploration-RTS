// PARITY rows 93 and 94 — the news nobody hears.
//
// Row 93's colony notes are collected every tick by `WorldBridge.step` and, until now, spent on a
// single shared one-line notice that the next refused order overwrites. Row 94's four galaxy queues
// reach nothing at all. This file is built around the three ways a news board of this shape goes
// wrong, and every one of them is driven rather than described:
//
//   • **A model that drains is a model that cannot be called twice.** Every assertion about a queue
//     is paired with the queue still being there afterwards — and, for `galaxy.milestones`, with
//     `milestonesPanelModel`'s own `fireworks` list still reporting it, because that panel has
//     shipped (row 99) and a drainer here would silently empty it.
//   • **A cumulative queue replayed as news.** `milestones-panel.ts` says the queue is everything
//     since the galaxy was created or loaded. So a feed meeting a galaxy with a backlog must raise
//     NOTHING, and the test that says so is paired with the same feed raising the very next entry —
//     otherwise it passes against a feed that never raises anything at all.
//   • **A latch mistaken for an event.** `galaxy.reliefNote` is raised on every dispatch and lowered
//     by nothing in this client, so a toast on it lasts the rest of the run. The relief entry here
//     is driven off `lastReliefTime` CHANGING, and one test raises `reliefNote` on its own and
//     asserts silence.
//
// The vacuity traps specific to this subject:
//
//   • **A coalescing test on a source that cannot repeat.** Only `attacked` repeats; `lost`,
//     `hostile`, every milestone, every pacification and every claim latch upstream. So the merge is
//     asserted on `attacked` (and on `attacked` from the engine's own sweep), and it is asserted in
//     BOTH directions — one raid is one line, and a second raid past the window is a second line.
//   • **A cursor that agrees by starting empty.** Every cursor test raises a second event after the
//     first ingest, so a feed that read the whole queue every time would report the first entry
//     twice and fail.
//   • **A galaxy whose queues were filled by the test.** Three of the four are filled by calling the
//     engine's own scans — `checkGalaxyProgress`, `checkDomination`, `checkRivalGate` — so the
//     entries carry the engine's own words rather than words this file typed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeState, checkDomination, checkGalaxyProgress, checkRivalGate, createGalaxy,
  deserializeGalaxy, makeBuilding, serializeGalaxy,
} from "../../src/engine/index.js";
import { WorldBridge, type ColonyNote } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { milestonesPanelModel } from "../../src/ui/milestones-panel.js";
import {
  NEWS_LIMIT, NEWS_MERGE_SECONDS, NEWS_TOAST_SECONDS, NewsFeed, newsModel,
} from "../../src/ui/news.js";

const SEED = 20260815;
const SEAT = "helix";

const NO_NOTES: readonly ColonyNote[] = [];

/** One observation. `now` is the galaxy clock, which is what the shell passes. */
function ingest(feed: NewsFeed, galaxy: Galaxy, now: number, colonyNotes: readonly ColonyNote[] = NO_NOTES): void {
  feed.ingest({ galaxy, colonyNotes, now });
}

/** A feed already watching `galaxy`, with whatever backlog it had primed away. */
function watching(galaxy: Galaxy, now = 0): NewsFeed {
  const feed = new NewsFeed();
  ingest(feed, galaxy, now);
  return feed;
}

const texts = (feed: NewsFeed, now = 0): string[] => newsModel(feed, now).entries.map((e) => e.text);
const topics = (feed: NewsFeed, now = 0): string[] => newsModel(feed, now).entries.map((e) => e.topic);

/** Strip every AI foothold from a world — `relief-panel.test.ts`' own idiom, which is what pacifies it. */
function razeAi(state: State): void {
  for (const [id, b] of [...state.buildings]) if (b.owner === "ai" && b.type === "command") state.buildings.delete(id);
  for (const [id, u] of [...state.units]) if (u.owner === "ai" && u.type === "colonyship") state.units.delete(id);
}

/** A player Command Center on the seat — what `checkGalaxyProgress` calls a settled world. */
function settle(state: State): void {
  const base = state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  cc.constructing = false;
  state.buildings.set(cc.id, cc);
}

/** An AI Antimatter Gate at full charge — what `checkRivalGate` ascends. */
function ascendRival(galaxy: Galaxy, worldId: string): void {
  const state = galaxy.planets.get(worldId)!;
  const gate = makeBuilding("antimatter_gate", "ai", 720, 520);
  gate.constructing = false;
  (gate as unknown as { charge: number }).charge = 1;
  state.buildings.set(gate.id, gate);
}

const backgroundOf = (galaxy: Galaxy): string => [...galaxy.planets.keys()].find((id) => id !== galaxy.activeId)!;

/**
 * The three queues the vendored declarations do not carry — `relief-panel.ts`' `flags()` idiom,
 * which exists because `src/engine/types/` is the vendored engine's surface (ADR-0003) and this
 * project does not widen it from a test any more than from a panel.
 */
function queues(galaxy: Galaxy): {
  pacifyNotes: unknown[]; expansionNotes: unknown[]; rivalGateNotes?: unknown[];
} {
  return galaxy as unknown as { pacifyNotes: unknown[]; expansionNotes: unknown[]; rivalGateNotes?: unknown[] };
}

/* =================================================================================================
   ROW 93 — A COLONY'S NEWS, THROUGH THE ENGINE'S OWN SWEEP
   ================================================================================================= */

describe("row 93: news from a world you are not standing on", () => {
  it("carries the engine's own note type and the engine's own name for the world", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);

    expect(newsModel(feed, 0).entries, "the board opened with something on it").toEqual([]);

    ingest(feed, galaxy, 1, [{ type: "attacked", planetId: "ferros" }]);
    const [entry] = newsModel(feed, 1).entries;

    expect(entry!.source).toBe("colony");
    // Unnarrowed, exactly as `bridge/world.ts` hands it over: a fourth kind upstream must arrive as
    // itself rather than folded into one of these three.
    expect(entry!.topic).toBe("attacked");
    expect(entry!.planetId).toBe("ferros");
    // The engine's own `PLANETS` name, not the raw id — the same lookup `hud.ts` and `jump-panel.ts`
    // make, so a world is called one thing everywhere in this client.
    expect(entry!.text).toContain("Ferros Prime");
    expect(entry!.text).not.toContain("ferros");
  });

  it("reports a type it has never heard of rather than dropping it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    ingest(feed, galaxy, 1, [{ type: "besieged", planetId: "ferros" }]);
    // Two claims, and the second is the one that matters: it is kept AND it says what it is.
    expect(topics(feed, 1)).toEqual(["besieged"]);
    expect(texts(feed, 1)[0]).toContain("besieged");
  });

  it("takes a colony's loss from a real bridge, which is the only thing that drains it", () => {
    // End to end: `WorldBridge.step` runs `sweepColonies`, the shell drains, the feed is handed the
    // result. Nothing in this test types the string "lost".
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    const colonyId = backgroundOf(bridge.galaxy);
    const colony = bridge.galaxy.planets.get(colonyId)!;
    const base = colony.map.bases.player;
    for (let i = 0; i < 3; i++) {
      const b = makeBuilding("habitat", "player", base.x + 60 + i * 40, base.y + 60);
      b.constructing = false;
      b.buildProgress = 1;
      colony.buildings.set(b.id, b);
    }

    const feed = new NewsFeed();
    bridge.step(STEP_SECONDS);                                   // the sweep records `hadColony`
    ingest(feed, bridge.galaxy, bridge.galaxy.time, bridge.takeColonyNotes());
    expect(newsModel(feed, bridge.galaxy.time).entries, "a standing colony was news")
      .toEqual([]);

    for (const [id, b] of [...colony.buildings]) if (b.owner === "player") colony.buildings.delete(id);
    bridge.step(STEP_SECONDS);
    ingest(feed, bridge.galaxy, bridge.galaxy.time, bridge.takeColonyNotes());

    const model = newsModel(feed, bridge.galaxy.time);
    expect(model.entries.map((e) => e.topic), "the engine's own loss note never reached the board")
      .toEqual(["lost"]);
    expect(model.entries[0]!.planetId).toBe(colonyId);
  });

  it("takes a raid from the engine's own sweep and folds a minute of it into one line", () => {
    // `sweepColonies` raises `attacked` on every sweep that finds a fresh player death, and a
    // background world ticks every `BG_STEP` steps — so this is the one source that repeats, and the
    // one the merge window exists for.
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    const colonyId = backgroundOf(bridge.galaxy);
    const colony = bridge.galaxy.planets.get(colonyId)!;
    const base = colony.map.bases.player;
    const keep = makeBuilding("habitat", "player", base.x + 60, base.y + 60);
    keep.constructing = false;
    keep.buildProgress = 1;
    colony.buildings.set(keep.id, keep);

    const feed = new NewsFeed();
    bridge.step(STEP_SECONDS);
    ingest(feed, bridge.galaxy, bridge.galaxy.time, bridge.takeColonyNotes());

    let raids = 0;
    for (let i = 0; i < 60; i++) {
      // The engine's own event shape, which is what `sweepColonies` reads for this branch. The note
      // it then produces is the engine's, not this file's.
      colony.events.push({ type: "entityKilled", owner: "player" });
      bridge.step(STEP_SECONDS);
      const notes = bridge.takeColonyNotes();
      raids += notes.filter((n) => n.type === "attacked").length;
      ingest(feed, bridge.galaxy, bridge.galaxy.time, notes);
    }

    expect(raids, "the engine never raised a raid, so the merge below proves nothing")
      .toBeGreaterThan(1);
    const model = newsModel(feed, bridge.galaxy.time);
    expect(model.entries.length, "one raid became a wall of lines").toBe(1);
    expect(model.entries[0]!.count, "the line stands for one event, so nothing was folded")
      .toBe(raids);
    expect(model.total).toBe(raids);
  });

  it("opens a second line for a raid that comes back after the window", () => {
    // The other half of the merge, without which "one raid is one line" is satisfied by a feed that
    // never raises a second entry at all.
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    const note: ColonyNote = { type: "attacked", planetId: "ferros" };

    // The gap is a FIXED two minutes, not `NEWS_MERGE_SECONDS + ε`. A test that measures the window
    // with the constant it is testing moves with it, and passes just as happily against a window of
    // ten seconds as against one of a thousand years.
    expect(NEWS_MERGE_SECONDS, "the window is longer than the gap this test uses").toBeLessThan(120);
    expect(NEWS_MERGE_SECONDS, "the window is shorter than one exchange of fire").toBeGreaterThan(5);

    ingest(feed, galaxy, 10, [note]);
    ingest(feed, galaxy, 10 + NEWS_MERGE_SECONDS, [note]);
    expect(newsModel(feed, 0).entries.length, "the window closed early").toBe(1);

    ingest(feed, galaxy, 130, [note]);
    const model = newsModel(feed, 0);
    expect(model.entries.length, "a fresh raid two minutes later was buried in the old line").toBe(2);
    expect(model.entries[0]!.count).toBe(1);
    expect(model.entries[1]!.count).toBe(2);
  });

  it("re-announces a siege that never stops, because the window does not slide", () => {
    // `ALERT_WINDOW_SECONDS`' own reasoning, and the reason `at` is never touched on a merge: a
    // window measured from the LAST event never closes while the raid is on, so a twenty-minute
    // siege gets exactly one line — raised at the start, and never repeated. A player who dismissed
    // that line would never hear about the colony again while it was being taken apart.
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    const note: ColonyNote = { type: "attacked", planetId: "ferros" };
    for (let t = 0; t <= 100; t += 5) ingest(feed, galaxy, t, [note]);

    const model = newsModel(feed, 100);
    expect(model.entries.length, "a hundred seconds of siege produced one line and then silence")
      .toBeGreaterThan(1);
    // …and it is still a coalescing board, not one line per ping.
    expect(model.entries.length, "the window is not folding the siege at all").toBeLessThan(21);
    expect(model.total).toBe(21);
    // The half that matters to a player: dismissing the first line does not mute the siege.
    feed.markAllSeen();
    for (let t = 105; t <= 200; t += 5) ingest(feed, galaxy, t, [note]);
    expect(newsModel(feed, 200).unseen, "a dismissal silenced the rest of the siege")
      .toBeGreaterThan(0);
  });

  it("keeps two worlds under attack apart", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    ingest(feed, galaxy, 1, [
      { type: "attacked", planetId: "ferros" },
      { type: "attacked", planetId: "korrath" },
    ]);
    // The merge key is source + topic + WORLD. A board that keyed on the kind alone would call two
    // colonies falling at once one event — which is what an alert board keyed on position would do
    // with news that has no position.
    expect(newsModel(feed, 1).entries.map((e) => e.planetId)).toEqual(["korrath", "ferros"]);
  });

  it("does not resurrect a line the player dismissed while the raid is still on", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    const note: ColonyNote = { type: "attacked", planetId: "ferros" };
    ingest(feed, galaxy, 1, [note]);

    const id = newsModel(feed, 1).latestId!;
    expect(feed.markSeen(id)).toBe(true);
    expect(feed.markSeen(id), "dismissal is not idempotent").toBe(true);
    expect(feed.markSeen(id + 999), "a stranger's id was accepted").toBe(false);

    ingest(feed, galaxy, 2, [note]);
    const model = newsModel(feed, 2);
    // `AlertFeed.dismiss`' tombstone rule: the line keeps absorbing and stays dismissed, or a
    // dismissal during a siege lasts one tick.
    expect(model.entries[0]!.count).toBe(2);
    expect(model.unseen, "the dismissed line came back on the next tick of the same raid").toBe(0);
    expect(model.toast).toBeNull();
  });
});

/* =================================================================================================
   ROW 94 — THE QUEUES THE ENGINE FILLS FOR A UI THAT NEVER CAME
   ================================================================================================= */

describe("row 94: the toasts the engine queues for itself", () => {
  it("reads `galaxy.milestones` and leaves it exactly where it found it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);

    settle(activeState(galaxy));
    checkGalaxyProgress(galaxy);                                 // the ENGINE raises it
    expect(galaxy.milestones.length, "the engine queued nothing, so nothing below is proved").toBe(1);

    ingest(feed, galaxy, 5);
    const model = newsModel(feed, 5);
    expect(model.entries.length).toBe(1);
    expect(model.entries[0]!.source).toBe("milestone");
    expect(model.entries[0]!.topic).toBe("world:1");
    // `milestoneLabel`'s words, so the firework and the Records board cannot disagree.
    expect(model.entries[0]!.text).toContain("1 worlds settled");

    // **The whole of "who drains".** The queue is untouched, and the panel that reports it as a list
    // still reports it — a drainer here would have emptied a row that has already shipped.
    expect(galaxy.milestones, "the feed drained the engine's queue").toEqual(["world:1"]);
    expect(milestonesPanelModel(galaxy).fireworks.map((f) => f.id)).toEqual(["world:1"]);
  });

  it("advances its cursor rather than re-reading the whole queue", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);

    settle(activeState(galaxy));
    checkGalaxyProgress(galaxy);
    ingest(feed, galaxy, 5);
    ingest(feed, galaxy, 6);
    expect(newsModel(feed, 6).entries.length, "an undrained queue was read twice").toBe(1);

    // **The queue has to GROW for this to prove anything.** Re-reading an unchanged queue is caught
    // by a length check before the cursor is ever consulted, so a feed that ignored its cursor
    // entirely passes the two lines above. Here the engine appends a second milestone, and a feed
    // reading from zero would raise `world:1` again — folding it into the entry already on the board
    // and reporting a count of two for a firework that went off once.
    ascendRival(galaxy, backgroundOf(galaxy));
    checkRivalGate(galaxy);
    ingest(feed, galaxy, 7);
    const model = newsModel(feed, 7);
    expect(galaxy.milestones, "the engine did not append, so the cursor is untested")
      .toEqual(["world:1", "rival-gate"]);
    expect(model.entries.filter((e) => e.source === "milestone").map((e) => e.topic))
      .toEqual(["rival-gate", "world:1"]);
    expect(model.entries.every((e) => e.count === 1), "an entry was raised twice").toBe(true);
  });

  it("reads `pacifyNotes` and the `factionEcho` the same scan queues beside it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    const world = backgroundOf(galaxy);

    razeAi(galaxy.planets.get(world)!);
    checkDomination(galaxy);                                     // the ENGINE fills both queues
    ingest(feed, galaxy, 3);

    const model = newsModel(feed, 3);
    const sources = model.entries.map((e) => e.source);
    expect(sources, "the pacification never reached the board").toContain("pacified");
    expect(sources, "the faction echo never reached the board").toContain("expansion");

    const echo = model.entries.find((e) => e.source === "expansion")!;
    expect(echo.topic).toBe("factionEcho");
    // The faction's engine name, not its id — `FACTIONS` is asked, exactly as `PLANETS` is.
    expect(echo.faction).not.toBeNull();
    expect(echo.text).toContain("Vanguard Syndicate");

    expect(queues(galaxy).pacifyNotes, "the feed drained `pacifyNotes`").toHaveLength(1);
    expect(queues(galaxy).expansionNotes, "the feed drained `expansionNotes`").toHaveLength(1);
  });

  it("reads `rivalGateNotes` — the fourth queue the board row does not name", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    // Created lazily by `checkRivalGate` and rebuilt by nothing on load, so it is absent here and a
    // reader that assumed an array would have thrown on the first frame of every session.
    expect((galaxy as unknown as Record<string, unknown>).rivalGateNotes).toBeUndefined();
    const feed = watching(galaxy);

    const world = backgroundOf(galaxy);
    ascendRival(galaxy, world);
    checkRivalGate(galaxy);
    ingest(feed, galaxy, 9);

    const model = newsModel(feed, 9);
    const ascended = model.entries.find((e) => e.source === "rivalGate")!;
    expect(ascended.topic).toBe("ascended");
    expect(ascended.planetId).toBe(world);
    // The moment row 98 names: `checkRivalGate` nulls its own tracked record here, so the starmap's
    // mark clears at exactly the moment the race is lost. This is the only line that says so.
    expect(ascended.text).toContain("has completed");
    // One engine call, three queues: the milestone, the ascension and the claims burst.
    expect(model.entries.map((e) => e.source)).toContain("milestone");
    expect(model.entries.map((e) => e.source)).toContain("expansion");
  });

  it("keeps a note whose type it has never heard of, and drops one with no type at all", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    queues(galaxy).expansionNotes.push({ type: "annexed", planetId: "ferros", faction: "core" });
    queues(galaxy).expansionNotes.push({ planetId: "ferros" });
    ingest(feed, galaxy, 2);

    // `unknownStatuses`' reasoning: a kind swallowed is indistinguishable from one never raised. A
    // shape with no `type` carries nothing to show and is the only thing dropped.
    expect(topics(feed, 2)).toEqual(["annexed"]);
  });
});

/* =================================================================================================
   A CUMULATIVE QUEUE IS NOT A RECENT ONE
   ================================================================================================= */

describe("the backlog is not the news", () => {
  it("raises nothing for what was already queued when it started watching", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    settle(activeState(galaxy));
    checkGalaxyProgress(galaxy);
    razeAi(galaxy.planets.get(backgroundOf(galaxy))!);
    checkDomination(galaxy);
    // All four queues, `rivalGateNotes` included — it is created lazily, so a feed that primed only
    // the three the board row names would replay every rival-Gate event of a loaded run.
    ascendRival(galaxy, [...galaxy.planets.keys()].filter((id) => id !== galaxy.activeId)[1]!);
    checkRivalGate(galaxy);
    expect(galaxy.milestones.length + queues(galaxy).pacifyNotes.length
      + queues(galaxy).expansionNotes.length + (queues(galaxy).rivalGateNotes?.length ?? 0),
      "nothing was queued, so an empty board proves nothing").toBeGreaterThan(4);
    expect(queues(galaxy).rivalGateNotes, "the lazy queue never appeared").toHaveLength(1);

    const feed = new NewsFeed();
    ingest(feed, galaxy, 42);
    expect(newsModel(feed, 42).entries, "the whole run's fireworks fired at once on the first frame")
      .toEqual([]);
    expect(newsModel(feed, 42).since, "the board does not say when it started watching").toBe(42);

    // And the pairing: the very next thing the engine queues DOES arrive.
    galaxy.milestones.push("gate");
    ingest(feed, galaxy, 43);
    expect(newsModel(feed, 43).entries.map((e) => e.topic)).toEqual(["gate"]);
  });

  it("adopts the galaxy a load swapped in without replaying it", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    settle(activeState(bridge.galaxy));
    checkGalaxyProgress(bridge.galaxy);
    const feed = new NewsFeed();
    ingest(feed, bridge.galaxy, 1);

    const save = serializeGalaxy(bridge.galaxy);
    // Everything queued after the save is real news on the live galaxy...
    razeAi(bridge.galaxy.planets.get(backgroundOf(bridge.galaxy))!);
    checkDomination(bridge.galaxy);
    ingest(feed, bridge.galaxy, 2);
    expect(newsModel(feed, 2).entries.length).toBeGreaterThan(0);

    // ...and a load throws the whole session away, including its news. `deserializeGalaxy` rebuilds
    // every one of these queues empty, so a feed that had not noticed the swap would sit on a cursor
    // past the end of an array that is now length zero.
    expect(bridge.load(save), "the save did not load, so nothing below is about a load").toBe(true);
    ingest(feed, bridge.galaxy, 3);
    expect(deserializeGalaxy(save)!.milestones, "the load did not empty the queue").toEqual([]);
    expect(newsModel(feed, 3).entries, "news about a run that was thrown away survived the load")
      .toEqual([]);
    expect(newsModel(feed, 3).since, "the board did not restart on the loaded galaxy").toBe(3);

    // The pairing, and the reason the board is emptied rather than merely left alone: the SAME world
    // falls again on the loaded run. A board that had kept the old entry would have folded this into
    // it — same source, same topic, same world, inside the window — and reported one loss with a
    // count of two, spanning two universes.
    razeAi(bridge.galaxy.planets.get(backgroundOf(bridge.galaxy))!);
    checkDomination(bridge.galaxy);
    ingest(feed, bridge.galaxy, 4);
    const model = newsModel(feed, 4);
    expect(model.entries.map((e) => e.source), "a load replayed, swallowed or merged")
      .toEqual(["expansion", "pacified"]);
    expect(model.entries.every((e) => e.count === 1 && e.at === 4)).toBe(true);
  });

  it("resyncs and says so when a queue is emptied under it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    settle(activeState(galaxy));
    checkGalaxyProgress(galaxy);
    ingest(feed, galaxy, 1);
    expect(newsModel(feed, 1).resynced).toBe(0);

    // The one thing a cursor cannot survive silently: somebody else drains. Upstream's `boot.js`
    // does exactly this, so a future bridge-side drain would land here rather than as a news board
    // that quietly stops working.
    galaxy.milestones.length = 0;
    ingest(feed, galaxy, 2);
    expect(newsModel(feed, 2).resynced, "a queue vanished under the cursor and nothing said so").toBe(1);

    galaxy.milestones.push("gate");
    ingest(feed, galaxy, 3);
    expect(topics(feed, 3)[0], "the cursor never recovered").toBe("gate");
  });
});

/* =================================================================================================
   RELIEF IS AN EDGE, NOT A LATCH
   ================================================================================================= */

describe("`reliefNote` latches, so the feed watches `lastReliefTime` instead", () => {
  it("says nothing for the latch on its own", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    // Upstream's own toast flag, raised on every dispatch and lowered by nothing in this client. A
    // board that read it would show the same toast for the rest of the run.
    (galaxy as unknown as { reliefNote: boolean }).reliefNote = true;
    ingest(feed, galaxy, 1);
    ingest(feed, galaxy, 2);
    expect(newsModel(feed, 2).entries, "the latch was read as an event").toEqual([]);
  });

  it("raises one line per drop, on the clock the engine stamps", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);

    galaxy.lastReliefTime = 12;
    ingest(feed, galaxy, 12);
    ingest(feed, galaxy, 13);
    ingest(feed, galaxy, 14);
    expect(newsModel(feed, 14).entries.length, "one drop produced a line per frame").toBe(1);
    expect(newsModel(feed, 14).entries[0]!.source).toBe("relief");

    // A second drop is a second line: the edge is the VALUE changing, not the field existing.
    galaxy.lastReliefTime = 40;
    ingest(feed, galaxy, 40);
    expect(newsModel(feed, 40).entries.length).toBe(2);
  });

  it("does not announce a drop that happened before it started watching", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    galaxy.lastReliefTime = 5;
    const feed = watching(galaxy, 6);
    expect(newsModel(feed, 6).entries, "a loaded save's old rescue was announced as new").toEqual([]);
    galaxy.lastReliefTime = 30;
    ingest(feed, galaxy, 30);
    expect(newsModel(feed, 30).entries.length).toBe(1);
  });
});

/* =================================================================================================
   THE BOARD ITSELF
   ================================================================================================= */

describe("the board", () => {
  it("offers the newest unread line as a toast, and stops when its window closes", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    ingest(feed, galaxy, 10, [{ type: "lost", planetId: "ferros" }]);

    // Both edges are FIXED seconds either side of the window rather than the window itself, so a
    // toast that lasted no time at all — or forever — fails here rather than moving the goalposts.
    expect(NEWS_TOAST_SECONDS, "the toast is gone before a player could read it").toBeGreaterThan(3);
    expect(NEWS_TOAST_SECONDS, "the toast outlasts the merge window").toBeLessThan(NEWS_MERGE_SECONDS);

    expect(newsModel(feed, 10).toast?.planetId).toBe("ferros");
    expect(newsModel(feed, 13).toast, "the toast retired within three seconds").not.toBeNull();
    expect(newsModel(feed, 10 + NEWS_TOAST_SECONDS).toast, "the toast retired early").not.toBeNull();
    expect(newsModel(feed, 10 + NEWS_TOAST_SECONDS + 0.001).toast, "the toast never retired").toBeNull();
    expect(newsModel(feed, 10 + NEWS_MERGE_SECONDS).toast, "the toast never retired").toBeNull();
    // Retired from the toast, still on the board — which is the whole reason this is a board and not
    // the one-line notice it replaces.
    expect(newsModel(feed, 100).entries.length).toBe(1);
  });

  it("keeps the toast up while the thing it is about is still happening", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    const note: ColonyNote = { type: "attacked", planetId: "ferros" };
    ingest(feed, galaxy, 10, [note]);
    ingest(feed, galaxy, 25, [note]);
    // Measured from `lastAt`, not `at`: the raid is 15 s old and still going.
    expect(newsModel(feed, 25).toast, "a raid still in progress dropped off the toast").not.toBeNull();
    expect(newsModel(feed, 25 + NEWS_TOAST_SECONDS + 0.001).toast).toBeNull();
  });

  it("marks everything read in one go", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    ingest(feed, galaxy, 1, [
      { type: "lost", planetId: "ferros" },
      { type: "lost", planetId: "korrath" },
    ]);
    expect(newsModel(feed, 1).unseen).toBe(2);
    feed.markAllSeen();
    expect(newsModel(feed, 1).unseen).toBe(0);
    expect(newsModel(feed, 1).entries.length, "marking read deleted the history").toBe(2);
  });

  it("keeps the newest when it fills, and counts what it dropped", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    // A FIXED hundred, not `NEWS_LIMIT + 5`: a cap measured in units of itself is a cap that can be
    // raised to four thousand without a single assertion noticing.
    const SENT = 100;
    expect(NEWS_LIMIT, "the board is not bounded below what this test sends").toBeLessThan(SENT);
    for (let i = 0; i < SENT; i++) {
      // Distinct worlds, so nothing coalesces and the cap is what is being measured.
      ingest(feed, galaxy, i, [{ type: "lost", planetId: `w${i}` }]);
    }
    const model = newsModel(feed, SENT);
    expect(model.entries.length).toBe(NEWS_LIMIT);
    expect(model.dropped, "the cap discarded nothing, or discarded silently").toBe(SENT - NEWS_LIMIT);
    // Newest kept, oldest gone: a board that dropped the newest would stop working exactly when
    // something is happening.
    expect(model.entries[0]!.planetId).toBe(`w${SENT - 1}`);
    expect(model.entries.map((e) => e.planetId)).not.toContain("w0");
  });

  it("is a query: two reads of one feed agree, and neither changes it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    settle(activeState(galaxy));
    checkGalaxyProgress(galaxy);
    ingest(feed, galaxy, 1, [{ type: "attacked", planetId: "ferros" }]);

    // The property every drawer in this project relies on. `EconomyCache` and `GalaxyCache` prove
    // "nothing was rebuilt" by reference equality, which is only sound if a model consumes nothing.
    const a = newsModel(feed, 1);
    const b = newsModel(feed, 1);
    expect(b).toEqual(a);
    expect(galaxy.milestones.length, "reading the model drained the engine's queue").toBe(1);
    expect(feed.version, "reading the model changed the feed").toBe(newsModel(feed, 1) && feed.version);
  });

  it("bumps its version on every change, so a drawer can cache on it", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    const before = feed.version;
    ingest(feed, galaxy, 1);                                     // nothing happened
    expect(feed.version, "an empty observation counted as a change").toBe(before);
    ingest(feed, galaxy, 2, [{ type: "lost", planetId: "ferros" }]);
    expect(feed.version).toBeGreaterThan(before);
    const raised = feed.version;
    feed.markAllSeen();
    expect(feed.version, "a dismissal would not have redrawn the board").toBeGreaterThan(raised);
  });

  it("forgets everything on `clear`, without reusing a handle", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: SEAT });
    const feed = watching(galaxy);
    ingest(feed, galaxy, 1, [{ type: "lost", planetId: "ferros" }]);
    const id = newsModel(feed, 1).latestId!;

    feed.clear();
    expect(newsModel(feed, 1).entries).toEqual([]);
    expect(newsModel(feed, 1).since).toBeNull();

    ingest(feed, galaxy, 2, [{ type: "lost", planetId: "korrath" }]);
    // `AlertFeed.clear`' rule: the id counter does not reset, so a HUD holding a handle across the
    // clear cannot dismiss whatever is minted into that number next.
    expect(newsModel(feed, 2).latestId).not.toBe(id);
  });
});

/* =================================================================================================
   WHO DRAINS, AS A CLAIM ABOUT THE SOURCE

   Every behavioural test above says "the queue was still there afterwards", which is what a reader
   cares about. This says the stronger thing a passing test cannot: there is no code path here that
   could ever empty one, and none that reaches for the bridge's own drain. `save-panel.test.ts`'
   idiom — the panel is proved not to call `deserializeGalaxy` by reading it.
   ================================================================================================= */

describe("nothing in this module drains anything", () => {
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "ui", "news.ts"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never empties a queue, splices one, or shifts one", () => {
    // ADR-0008 §3: nothing above the bridge may write a sim field, and `galaxy.milestones` is one.
    // `this.entries.length = 0` in `adopt` is the feed's OWN array, so the scan is for a write
    // through anything that could be a galaxy.
    const writes = [...SOURCE.matchAll(/\b(?!this\.entries\b)[\w.]*(?:Notes|milestones)\s*(?:\.length\s*=|\.shift\(|\.splice\(|\.pop\()/g)];
    expect(writes.map((m) => m[0]), "a galaxy queue is written from `ui/`").toEqual([]);
  });

  it("never calls the bridge's own drain", () => {
    // `takeColonyNotes` is a *take*. A model that called it could not be called twice, which is
    // exactly what `EconomyCache` and `GalaxyCache` prove by reference equality — and the second
    // caller in a frame would silently get nothing.
    expect(SOURCE, "the feed drains the bridge itself").not.toMatch(/takeColonyNotes/);
    expect(SOURCE, "the feed reads the latch instead of the edge").not.toMatch(/reliefNote/);
  });
});
