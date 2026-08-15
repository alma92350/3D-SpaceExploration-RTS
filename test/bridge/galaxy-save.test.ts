// P4-T09 — the galaxy save round-trips.
//
// **This file is a proof, not a feature.** `serializeGalaxy`/`deserializeGalaxy` have existed
// upstream since before this project started, and PRD §5 names their correctness as one of Phase
// 4's three exit criteria. What did not exist was any way to falsify it — and a galaxy save is
// exactly the kind of thing that looks fine and is not, because **the seat is the only part
// anybody looks at after a load**. Three background worlds, a lane, a policy store and a credit
// balance can all be quietly gone while the world on screen is perfect.
//
// The whole task therefore turns on ONE trap, and everything below is arranged around it:
//
//   **A fresh galaxy round-trips even if serialization drops everything.** `createGalaxy` is a pure
//   function of its seed, and `deserializeGalaxy` regenerates every world's map from that same
//   seed. Save a galaxy nobody has played, drop the entire payload, reload — and it comes back
//   identical, because it was never anything but its seed. So the scenario here is deliberately
//   expensive to build: a second world settled through the engine's own `jumpCapital`, three
//   background worlds run 65 sim-seconds off their opening, a Freight Lane that has actually moved
//   cargo, a colony standing order that has actually sold into a market, and credits that are
//   neither 500 nor a round number. `the premise` below asserts that divergence explicitly, world
//   by world — without it every claim in this file is green and empty.
//
// The four claims, each mutation-tested against the way it could be wrong (see the file's closing
// notes for the mutation log):
//
//   1. ROUND TRIP    the whole galaxy hashes identically across a serialise/deserialise, and the
//                    same hash separates it from a same-seed galaxy nobody has played.
//   2. BACKGROUND    each background world's OWN entities, stockpiles, node depletion, fog memory
//                    and market pressure survive — asserted per world, and asserted to differ from
//                    what the seed alone would regenerate.
//   3. STRUCTURES    lanes, assigned ships and colony policies each survive INDEPENDENTLY, so a
//                    partial loss is attributable to the structure that lost it.
//   4. IT KEEPS      a restored galaxy STEPS identically for 400 further ticks. This is the
//      RUNNING      strongest assertion here and the only one that catches the roster trap
//                   `stepGalaxy`'s own cache comment describes: `deserializeGalaxy` REBUILDS
//                   `galaxy.worlds` rather than mutating it, the background round-robin keys on
//                   each world's index in that array, and a save that restored the data but broke
//                   the roster would pass claims 1-3 and then never tick a colony again.
//
// One real defect fell out of writing this, and it is NOT fixed here (ADR-0003 — the vendored
// engine is upstream's). It is pinned by its own section at the bottom of the file, so that it
// cannot change in either direction without a reviewed red: **a world that has grown battle
// wreckage or a bomb crater does not round-trip its market prices.**

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  BG_STEP, GALAXY_SAVE_VERSION, LANE_PERIOD, ODYSSEY_WORLDS, UNITS,
  assignShipToLane, createGalaxy, createLane, deployColonyShip, deserializeGalaxy, getColonyPolicy,
  jumpCapital, jumpCost, makeBuilding, makeUnit, serializeGalaxy, serializeGalaxyString,
  setColonyPolicy, stepGalaxy, sweepColonies,
} from "../../src/engine/index.js";

const SEED = 20260814;

/** The world the scenario opens on, and the world it settles from there. */
const HOME = "helix";
const SETTLED = "ferros";

/* =================================================================================================
   THE DIGEST

   Deliberately NOT `test/determinism/replay.ts`'s `hashState`, and that is a decision rather than
   duplication. Two reasons, both about what each digest is FOR:

     • `hashState` hashes one world's *simulation*. A galaxy save also has to carry the things that
       are not simulation — a world's market price book, its neighbour's stance, its fog memory, its
       node depletion, the pending craters that have not matured yet — plus everything that lives
       ABOVE a world: credits, the seat, lanes, policies, the roster and the two id counters.
     • P4-T11 is expected to widen `hashState` (a jump moves `galaxy.activeId`, which it does not
       cover today). A save proof that went red because a determinism fixture changed its digest
       would be a proof nobody trusts.

   What is deliberately EXCLUDED, and why each exclusion is safe rather than convenient:

     • `state.events`     drained every frame by the app (and by `sweepColonies` for a colony).
                          The save does not carry them and should not — they are this tick's news.
                          Checked rather than assumed: `sweepColonies`' notification pass is the
                          ONLY place in the engine that reads them, and it feeds a UI toast, never
                          sim state — so losing them cannot make two galaxies diverge.
     • `fog.visible`      recomputed by `updateFog` on load, by design. Only `explored` — the
                          permanent scouted memory — is persisted, so only `explored` is hashed.
     • per-tick tallies   `_gi`, `haulers`, `servers`, `repairers`, `menderClaims`, `ferriers`,
                          `miners`, `anvils`, `powered`, `fuel`, `lastYield`, `lastTier`. Every one
                          is stamped fresh by the next tick; `serPlanet` strips them by name.
     • `galaxy.*Notes`    `colonyNotes`, `pacifyNotes`, `expansionNotes`, `milestones` — transient
                          UI queues the app drains. Rebuilt empty, harmlessly, on load.

   Everything else is in, and each line below is a claim that the save carries that field.
   ================================================================================================= */

/**
 * A canonical string for an arbitrary JSON-ish value: keys sorted, numbers at six decimals.
 *
 * `null`, `undefined` and *absent* all collapse to one token. That is not slack — a JSON save has
 * no way to carry the difference (`JSON.stringify` drops `undefined` outright), and the engine
 * reads every one of these fields through `??`, which treats all three the same. `state.ai
 * .nextWaveAt` is exactly this case: live it is `null`, restored it is `undefined`, and
 * `aiMilitary.js` reads `controller.nextWaveAt ?? 0` either way.
 */
function stable(v: unknown): string {
  if (v === null || v === undefined) return "~";
  if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(6) : String(v);
  if (typeof v !== "object") return JSON.stringify(v) ?? "~";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${k}:${stable(o[k])}`).join(",")}}`;
}

/**
 * A number at six decimals, or a legible token when it is not a number at all.
 *
 * Every field hashed below arrives off untrusted save data, and a digest that threw on a dropped
 * one would report a mutation as a crash inside the test harness rather than as the named
 * round-trip failure it is. Found by mutation-testing: deleting the node `amount` from `serPlanet`
 * left `n.amount` undefined and the first version of this file died on `.toFixed`.
 */
const n6 = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(6) : `<${String(v)}>`);

/**
 * A commodity buffer as a stable string. An EMPTY buffer and NO buffer read the same, because they
 * are the same thing to the sim — `cleanEntity` gives every building an `input` object on load
 * whether or not the live one had grown one yet, and a test that called that a lost field would be
 * reporting on the loader's constructor rather than on the save.
 */
function buf(b: Resources | undefined | null): string {
  if (!b) return "-";
  return Object.keys(b).sort().map((k) => `${k}=${n6(b[k] ?? 0)}`).join("|") || "-";
}

/**
 * The engine-internal per-world fields this project does not otherwise read.
 *
 * Narrow casts rather than declarations, following `test/engine/ai-fog.test.ts`'s treatment of
 * `state.ai`: these are the simulation's own bookkeeping, not part of the surface `src/` consumes,
 * and declaring them in `types/` would invite something above the bridge to start reading them.
 */
interface WorldInternals {
  background?: boolean;
  diplomacy?: Record<string, unknown>;
  ai?: Record<string, unknown>;
  playerAi?: Record<string, unknown> | null;
  craters?: Array<Record<string, unknown>>;
  wrecks?: Array<Record<string, unknown>>;
}
const internals = (s: State): WorldInternals => s as unknown as WorldInternals;

/** A unit's Odyssey-only cargo fields — a freighter's hold and its Freight Lane booking. */
interface UnitFreight { freight?: Resources; laneId?: string }
const freightOf = (u: Unit): UnitFreight => u as unknown as UnitFreight;

/**
 * One world's whole persisted state.
 *
 * Entities are walked in sorted-id order so `Map` insertion order cannot move the hash on its own;
 * `map.nodes` likewise, because a crater or wreck node is appended at whatever position it matured
 * at. Where ORDER is itself load-bearing it is asserted separately rather than hashed — see the
 * planet-order and lane-order assertions below.
 */
function hashWorld(state: State): string {
  const h = createHash("sha256");
  const x = internals(state);
  h.update(`world ${state.planetId} seed=${state.seed} bg=${x.background ? 1 : 0} endless=${state.endless ? 1 : 0}\n`);
  h.update(`tick=${state.tick};time=${n6(state.time)};over=${state.over ? 1 : 0}\n`);

  for (const owner of state.owners) {
    const p = state.players[owner];
    h.update(`${owner} ${p.faction} ai=${p.isAI ? 1 : 0} res=${buf(p.resources)} up=${stable(p.upgrades)}\n`);
  }

  for (const u of [...state.units.values()].sort(byId)) {
    const f = freightOf(u);
    h.update(`u ${u.id} ${u.type} ${u.owner} ${n6(u.x)} ${n6(u.y)} ${n6(u.hp)}`);
    h.update(` o=${stable(u.order)} q=${stable(u.orderQueue)} cargo=${stable(u.cargo)}`);
    // The two fields a lane's whole delivery cycle runs on: the hold it fills and the booking that
    // says which route it is standing on. Neither is in `hashState`, and losing either would leave
    // the lane structurally perfect and functionally dead.
    h.update(` freight=${buf(f.freight)} lane=${f.laneId ?? "-"} hold=${u.hold ? 1 : 0}\n`);
  }

  for (const b of [...state.buildings.values()].sort(byId)) {
    h.update(`b ${b.id} ${b.type} ${b.owner} ${n6(b.x)} ${n6(b.y)} ${n6(b.hp)}`);
    h.update(` c=${b.constructing ? 1 : 0} bp=${n6(b.buildProgress)} q=${stable(b.queue)} rq=${stable(b.researchQueue)}`);
    h.update(` t=${b.tier ?? "-"} rally=${stable(b.rally)} target=${b.targetId ?? "-"}`);
    h.update(` p=${b.paused ? 1 : 0} e=${b.electrified ? 1 : 0} lp=${b.logiPriority ?? "-"} rc=${stable(b.recycling)}`);
    h.update(` in=${buf(b.input)} out=${buf(b.store)} dig=${n6(b.digProgress ?? 0)}/${b.digCount ?? 0}\n`);
  }

  // Node depletion is the single most valuable thing a save carries per world and the easiest to
  // lose, because the map itself regenerates from the seed and looks right without it. Crater and
  // wreck nodes are hashed with their WHOLE shape: they do not exist in that regeneration at all.
  for (const n of [...state.map.nodes].sort(byId)) {
    h.update(`n ${n.id} ${n.com} ${n6(n.amount)}/${n6(n.max)} ${n6(n.x)} ${n6(n.y)}`);
    h.update(` ${n.crater ? "crater" : n.wreck ? "wreck" : "map"}\n`);
  }

  h.update(`market base=${buf(state.market.base)} pressure=${buf(state.market.pressure)} glut=${buf(state.market.glut)}\n`);
  h.update(`diplomacy=${stable(x.diplomacy)}\n`);
  h.update(`ai=${stable(x.ai)} playerAi=${stable(x.playerAi)}\n`);
  h.update(`craters=${stable(x.craters)} wrecks=${stable(x.wrecks)}\n`);
  for (const owner of state.owners) h.update(`fog:${owner}=${digestBytes(state.fogs[owner].explored)}\n`);
  return h.digest("hex");
}

/**
 * The whole galaxy: every world, plus everything that lives above one.
 *
 * `galaxy.planets` is walked in MAP ORDER rather than sorted, because that order is load-bearing:
 * `sweepColonies` and `runColonyPolicies` both iterate it, and both module headers name it as the
 * fixed order their determinism rests on. Same for `galaxy.lanes` and each lane's `shipIds` —
 * `runLanes` walks them in place and sums capacity as it goes.
 */
function hashGalaxy(galaxy: Galaxy): string {
  const h = createHash("sha256");
  h.update(`galaxy seed=${galaxy.seed} active=${galaxy.activeId} credits=${n6(galaxy.credits)}\n`);
  h.update(`tick=${galaxy.tick};time=${n6(galaxy.time)};laneSeq=${galaxy.laneSeq};entitySeq=${galaxy.entitySeq}\n`);
  h.update(`roster=${galaxy.worlds.join(",")}\n`);
  h.update(`settings=${stable(galaxy.settings)}\n`);
  h.update(`wonBy=${galaxy.wonBy ?? "-"} relief=${stable(galaxy.lastReliefTime)}\n`);
  for (const [name, set] of [["pacified", galaxy.pacified], ["reached", galaxy.reached],
    ["discovered", galaxy.discovered], ["rivalAscended", galaxy.rivalAscended]] as const) {
    h.update(`${name}=${members(set).join(",")}\n`);
  }
  h.update(`claims=${pairs(galaxy.claims).map(([k, v]) => `${k}:${v}`).join(",")}\n`);
  for (const lane of galaxy.lanes) {
    h.update(`lane ${lane.id} ${lane.from}->${lane.to} com=${lane.commodities.join(",")} ships=${lane.shipIds.join(",")}\n`);
  }
  for (const [id, policy] of pairs(galaxy.colonyPolicies)) h.update(`policy ${id}=${stable(policy)}\n`);
  for (const [id, state] of galaxy.planets) h.update(`planet ${id}=${hashWorld(state)}\n`);
  return h.digest("hex");
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);

/**
 * A `Set`/`Map` that may not exist yet, as an array — absent and empty read the same.
 *
 * Not defensive padding: `createGalaxy` does NOT build `colonyPolicies` or `rivalAscended`
 * (`setColonyPolicy` and `checkRivalGate` create them on first use), while `deserializeGalaxy`
 * always builds both. So a loaded galaxy legitimately carries two collections a freshly-created one
 * does not, and a hash that could not compare the two would fail on the seed-divergence premise
 * rather than on anything about the save.
 */
const members = <T,>(s: Set<T> | undefined): T[] => (s ? [...s] : []);
const pairs = <V,>(m: Map<string, V> | undefined): Array<[string, V]> => (m ? [...m] : []);

/** A fog grid as a short digest — the grids are thousands of cells and only equality matters. */
function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/* =================================================================================================
   THE SCENARIO

   Built through the engine's own commands wherever one exists — `deployColonyShip`, `createLane`,
   `assignShipToLane`, `setColonyPolicy`, `jumpCapital` — so what is saved is a galaxy the game
   could actually produce, not a hand-assembled object graph that happens to serialise.

   The three hand-placed pieces are a completed Spaceport, a hauler and a second colony ship. Each
   is placed rather than built for one reason: building them takes thousands of ticks of economy the
   save proof does not depend on, and `makeBuilding`/`makeUnit` are the engine's own constructors.
   ================================================================================================= */

interface Scenario {
  galaxy: Galaxy;
  /** The world the run started on. A settled COLONY by the time the save is taken. */
  home: State;
  /** The world the expedition settled. The active seat by the time the save is taken. */
  settled: State;
  laneId: string;
  haulerId: string;
  /** Credits the jump actually cost. Non-zero is what makes `settled` a genuinely NEW world. */
  jumpFuel: number;
}

/**
 * Every step that CAN be refused is checked here, in the builder, rather than left to the premise
 * tests further down. A scenario that quietly stopped being the scenario — a jump the treasury
 * could not afford, a hauler the lane would not take — would leave every claim in this file green
 * and describing something smaller than it says it does.
 */
function settledGalaxy(): Scenario {
  const galaxy = createGalaxy({ seed: SEED, startId: HOME });
  const home = galaxy.planets.get(HOME)!;

  // A real base: the opening colony ship deploys into a Command Center with its workers.
  const opening = [...home.units.values()].find((u) => u.owner === "player" && u.type === "colonyship")!;
  expect(opening, "the opening world has no colony ship — the Odyssey opening has changed").toBeDefined();
  expect(deployColonyShip(home, opening.id), "the opening colony ship would not deploy").toBeTruthy();

  // A completed launch pad. It is BOTH the jump's origin and the lane's catchment — `createLane`
  // and `jumpCapital` reuse the same `playerSpaceports` test, deliberately.
  const base = home.map.bases.player;
  const pad = makeBuilding("spaceport", "player", base.x + 70, base.y + 40);
  pad.constructing = false;
  pad.buildProgress = 1;
  home.buildings.set(pad.id, pad);

  // Stock for the lane to move and the standing order to sell.
  Object.assign(home.players.player.resources, { ore: 900, crystals: 400, metals: 350, alloys: 220, spice: 120 });

  const hauler = makeUnit("hauler", "player", pad.x + 20, pad.y + 12);
  home.units.set(hauler.id, hauler);
  const expedition = makeUnit("colonyship", "player", pad.x - 24, pad.y + 8);
  home.units.set(expedition.id, expedition);

  // The lane is created and crewed BEFORE the jump on purpose: `stagedRiders` skips a ship that is
  // booked onto a lane (`!u.laneId`), so the hauler stays behind to work the route instead of being
  // swept off-world by the very jump that gives the route a destination.
  const lane = createLane(galaxy, HOME, SETTLED, ["ore", "crystals"]);
  expect(lane, "the lane was refused — both worlds must already exist in the galaxy").not.toBeNull();
  expect(
    assignShipToLane(galaxy, lane!.id, hauler.id),
    "the lane refused the hauler — it must be a player freighter standing within JUMP_LOAD_RADIUS " +
    "of one of the SOURCE world's own completed Spaceports",
  ).toBe(true);

  // 30 sim-seconds with every world running, so the three background colonies drift off their
  // opening positions before anything is saved.
  advance(galaxy, 600);

  // Settle the second world, through the engine's own jump.
  const jumpFuel = jumpCost(galaxy, SETTLED);
  expect(galaxy.credits, `the treasury cannot fund the ${jumpFuel}-credit jump`).toBeGreaterThanOrEqual(jumpFuel);
  expect(jumpCapital(galaxy, SETTLED), "the jump was refused — there would be only one settled world")
    .not.toBeNull();
  const settled = galaxy.planets.get(SETTLED)!;
  const rider = [...settled.units.values()].find((u) => u.owner === "player" && u.type === "colonyship");
  expect(rider, "the colony ship did not ride along, so the destination can never be settled").toBeDefined();
  expect(deployColonyShip(settled, rider!.id), "the colony ship would not deploy on the new world").toBeTruthy();

  // A standing order on the world just left — `runColonyPolicies` acts on BACKGROUND worlds only,
  // so this only does anything because the jump demoted `home` to a colony.
  setColonyPolicy(galaxy, HOME, {
    autoSell: { enabled: true, floors: { ore: 200, crystals: 50 } },
    workerTarget: 4,
  });

  // 35 more sim-seconds: long enough for the lane to fire (LANE_PERIOD is 200 ticks) and for the
  // throttled galaxy scans to run the standing order several times.
  advance(galaxy, 700);

  return { galaxy, home, settled, laneId: lane!.id, haulerId: hauler.id, jumpFuel };
}

/**
 * `n` fixed steps of the whole galaxy, banking colony income as the app does.
 *
 * `stepGalaxy` does NOT call `sweepColonies` — the app drives it — so a test that only stepped
 * would leave `galaxy.credits` untouched by the colony economy and would be saving a less
 * interesting number than a real session has.
 */
function advance(galaxy: Galaxy, n: number): void {
  for (let i = 0; i < n; i++) {
    stepGalaxy(galaxy, STEP_SECONDS);
    sweepColonies(galaxy, STEP_SECONDS);
  }
}

/** A same-seed galaxy nobody has played — what the seed ALONE regenerates. */
const pristine = () => createGalaxy({ seed: SEED, startId: HOME });

/* =================================================================================================
   THE PREMISE — this galaxy is worth saving

   Every claim below is conditional on this section. A galaxy that is still its own seed round-trips
   through a serializer that drops the entire payload, so if these assertions ever stop holding, the
   rest of the file is green and proves nothing.
   ================================================================================================= */

describe("the premise: the galaxy has diverged from its seed (P4-T09)", () => {
  it("holds two settled worlds, three background colonies, and a seat that moved", () => {
    const { galaxy, home, settled, jumpFuel } = settledGalaxy();
    const fresh = pristine();

    expect(galaxy.activeId, "the expedition never arrived — the seat is still the opening world").toBe(SETTLED);
    // A free jump means the destination was already reached, which would make this a return trip
    // rather than a settlement — and a world already in `discovered` is a world the save has an
    // easier time with.
    expect(jumpFuel, "the second world cost nothing to reach — it was not a new world").toBeGreaterThan(0);
    expect(fresh.activeId, "the fresh galaxy already sits where this one jumped to").toBe(HOME);
    expect(internals(home).background, "the world we left is not a background colony").toBe(true);
    expect(internals(settled).background, "the seat is flagged as a background world").toBe(false);

    // "Settled" means a player Command Center standing on it, on both worlds. Without the second
    // one the board's "two settled worlds" is one settled world and a landing party.
    for (const [name, state] of [[HOME, home], [SETTLED, settled]] as const) {
      const ccs = [...state.buildings.values()].filter((b) => b.owner === "player" && b.type === "command");
      expect(ccs.length, `${name} has no player Command Center — it is not a settled world`).toBeGreaterThan(0);
    }

    // The living galaxy: worlds nobody has visited that are nonetheless running.
    const background = [...galaxy.planets].filter(([, s]) => internals(s).background);
    expect(background.length, "no background colonies — claim 2 would have nothing to prove")
      .toBeGreaterThanOrEqual(3);
    for (const [id, s] of background) {
      expect(s.tick, `${id} has never ticked — the background scheduler is not running`).toBeGreaterThan(0);
    }
  });

  it("would NOT round-trip by accident: every world already differs from what the seed regenerates", () => {
    // The assertion this whole file rests on, made per world rather than in aggregate. A galaxy-wide
    // "the hashes differ" would be satisfied by ONE changed world while the other three were still
    // pristine — and those three are exactly the ones a save is most likely to drop.
    const { galaxy } = settledGalaxy();
    const fresh = pristine();

    expect(hashGalaxy(galaxy), "the played galaxy hashes the same as one nobody has touched")
      .not.toBe(hashGalaxy(fresh));

    for (const [id, state] of galaxy.planets) {
      const seedOnly = fresh.planets.get(id);
      expect(seedOnly, `${id} is not in a fresh galaxy at all, so it cannot be compared`).toBeDefined();
      expect(
        hashWorld(state),
        `${id} is byte-identical to what its seed regenerates — a serializer that dropped this ` +
        `world entirely would still "round-trip" it`,
      ).not.toBe(hashWorld(seedOnly!));
    }

    // …and the galaxy-level numbers are not their defaults either.
    expect(galaxy.credits, "credits are still the opening 500 — the economy never ran").not.toBe(500);
    expect(galaxy.tick, "the galaxy clock never advanced").toBeGreaterThan(1000);
    expect(galaxy.lanes.length, "no lane exists to lose").toBe(1);
    expect(pairs(galaxy.colonyPolicies).length, "no colony policy exists to lose").toBe(1);
    expect(galaxy.discovered.size, "the second world was never marked reached").toBe(2);
  });

  it("the lane really moved cargo and the standing order really sold", () => {
    // Structure is not function. A lane that exists but has never delivered, and a policy that is
    // stored but has never fired, would both survive a save that carried nothing but their fields —
    // and claim 3 would be asserting on decoration.
    const { galaxy, home, settled } = settledGalaxy();

    expect(UNITS.hauler?.cargoHold, "the hauler is no longer a freighter, so no lane can crew it")
      .toBeGreaterThan(0);
    expect(galaxy.lanes[0]!.shipIds, "the lane has no crew, so it can never have moved anything")
      .toHaveLength(1);

    // The source world started with 900 ore and 400 crystals. Between the lane hauling them out and
    // the standing order selling the surplus, both are far below where they started, and the
    // destination's stockpile is far above what it began with.
    expect(home.players.player.resources.ore, "the source world's ore never left").toBeLessThan(900);
    expect(home.players.player.resources.crystals, "the source world's crystals never left").toBeLessThan(400);
    expect(settled.players.player.resources.ore, "nothing was ever delivered down the lane")
      .toBeGreaterThan(900);

    // A four-figure treasury can only have come from the market. The opening 500 pays for the jump,
    // and the flat colony income this scenario earns over its ~35 seconds of colony time is worth
    // well under a hundred credits (COLONY_INCOME_PER_BUILDING x COLONY_INCOME_CAP = 1.8/s) — so
    // this threshold separates auto-sell revenue from the passive rate rather than merely detecting
    // that credits moved at all.
    expect(galaxy.credits, "the standing order never sold anything into the market").toBeGreaterThan(1000);
  });
});

/* =================================================================================================
   1 + 2 + 3. THE ROUND TRIP

   `serializeGalaxy` returns a DETACHED object and `serializeGalaxyString` the JSON string; both are
   exercised, because the app's autosave path uses the string and a divergence between the two would
   only ever surface in production.
   ================================================================================================= */

describe("the galaxy save round-trips to an identical hash (P4-T09)", () => {
  it("hashes identically across a serialise/deserialise, through both public savers", () => {
    const { galaxy } = settledGalaxy();
    const before = hashGalaxy(galaxy);

    const save = serializeGalaxy(galaxy);
    expect(save.v, "the save does not stamp the version the loader checks").toBe(GALAXY_SAVE_VERSION);

    const restored = deserializeGalaxy(save)!;
    expect(restored, "deserializeGalaxy returned nothing for a save it had just written").toBeTruthy();
    expect(hashGalaxy(restored), "the galaxy did not survive its own save").toBe(before);

    // The string saver is the one autosave actually uses (it stringifies once instead of
    // stringify -> parse -> stringify). It must produce the same galaxy as the object saver.
    const viaString = deserializeGalaxy(JSON.parse(serializeGalaxyString(galaxy)))!;
    expect(hashGalaxy(viaString), "serializeGalaxyString and serializeGalaxy disagree").toBe(before);

    // Saving must not disturb the thing being saved — the running session continues after an
    // autosave, and `serializeGalaxy` hands its caller a detached copy for exactly that reason.
    expect(hashGalaxy(galaxy), "serialising the galaxy mutated it").toBe(before);
  });

  it("restores the galaxy-level fields, each named so a single loss is attributable", () => {
    const { galaxy } = settledGalaxy();
    const restored = deserializeGalaxy(serializeGalaxy(galaxy))!;

    expect(restored.activeId, "the seat moved on load — the player wakes up on the wrong world")
      .toBe(galaxy.activeId);
    expect(restored.credits, "credits did not survive").toBeCloseTo(galaxy.credits, 6);
    expect(restored.seed, "the seed did not survive, so every future world would regenerate differently")
      .toBe(galaxy.seed);
    expect(restored.tick, "the galaxy tick counter reset — the background round-robin restarts mid-cycle")
      .toBe(galaxy.tick);
    expect(restored.time, "the galaxy clock reset").toBeCloseTo(galaxy.time, 6);
    expect(restored.laneSeq, "the lane-id counter reset — the next lane created would collide")
      .toBeGreaterThanOrEqual(galaxy.laneSeq);
    expect([...restored.discovered], "the reached-worlds set did not survive").toEqual([...galaxy.discovered]);
    expect(restored.settings, "the galaxy settings did not survive — the next jump builds a different world")
      .toMatchObject({ difficulty: galaxy.settings.difficulty, playerFaction: galaxy.settings.playerFaction });

    // The roster, in order. Order is not cosmetic: `stepGalaxy` schedules a background world by its
    // INDEX here, so a reordered roster is a re-phased simulation.
    expect(restored.worlds, "the world roster changed shape on load").toEqual(galaxy.worlds);
    expect(restored.worlds, "the roster no longer covers every world the engine knows")
      .toEqual(expect.arrayContaining([...ODYSSEY_WORLDS]));

    // And the planet map's own iteration order, which `sweepColonies` and `runColonyPolicies` both
    // depend on by name.
    expect([...restored.planets.keys()], "the planets came back in a different order")
      .toEqual([...galaxy.planets.keys()]);
  });

  it("restores each BACKGROUND world's own state — the half nobody would notice was gone", () => {
    // Claim 2, and the one this task exists for. The seat is rendered, so a lost seat is a bug
    // report within seconds; a background colony is a number on a starmap, and a save that quietly
    // regenerated it from its seed would look completely normal.
    const { galaxy } = settledGalaxy();
    const restored = deserializeGalaxy(serializeGalaxy(galaxy))!;
    const fresh = pristine();

    const background = [...galaxy.planets].filter(([, s]) => internals(s).background).map(([id]) => id);
    expect(background.length, "there are no background worlds in this scenario").toBeGreaterThanOrEqual(3);

    for (const id of background) {
      const live = galaxy.planets.get(id)!;
      const back = restored.planets.get(id)!;
      expect(back, `${id} is missing from the restored galaxy entirely`).toBeDefined();

      // The pieces first, then the whole world as the catch-all. That order is deliberate: the
      // hash says only "this world changed", and a named line above it is what turns a red run
      // into a diagnosis.
      expect(internals(back).background, `${id} came back as a foreground world`).toBe(true);
      expect(back.units.size, `${id} lost units`).toBe(live.units.size);
      expect(back.buildings.size, `${id} lost buildings`).toBe(live.buildings.size);
      expect(back.players.player.resources, `${id}'s player stockpile did not survive`)
        .toEqual(live.players.player.resources);
      expect(back.players.ai.resources, `${id}'s neighbour's stockpile did not survive`)
        .toEqual(live.players.ai.resources);
      expect(back.tick, `${id}'s own tick counter reset`).toBe(live.tick);
      expect(back.time, `${id}'s own clock reset`).toBeCloseTo(live.time, 6);
      expect(back.map.nodes.map((n) => n.amount), `${id}'s node depletion was regenerated from the seed`)
        .toEqual(live.map.nodes.map((n) => n.amount));
      expect(digestBytes(back.fogs.player.explored), `${id}'s scouted fog memory was lost`)
        .toBe(digestBytes(live.fogs.player.explored));
      expect(back.market.pressure, `${id}'s market pressure was lost`).toEqual(live.market.pressure);
      expect(internals(back).diplomacy, `${id}'s neighbour's stance was lost`)
        .toMatchObject(internals(live).diplomacy!);
      expect(hashWorld(back), `${id} did not survive the save, in a field none of the lines above names`)
        .toBe(hashWorld(live));

      // The anti-vacuity half. Every assertion above would also pass if the loader simply rebuilt
      // this world from its seed and the live one had never diverged.
      const seedOnly = fresh.planets.get(id)!;
      expect(hashWorld(back), `${id} came back as its pristine seed state, not as the world that was saved`)
        .not.toBe(hashWorld(seedOnly));
    }
  });

  it("restores the lane, its commodity filter, and the ship booked onto it", () => {
    const { galaxy, laneId, haulerId } = settledGalaxy();
    const restored = deserializeGalaxy(serializeGalaxy(galaxy))!;

    expect(restored.lanes.length, "the lane is gone").toBe(galaxy.lanes.length);
    const lane = restored.lanes.find((l) => l.id === laneId);
    expect(lane, `lane ${laneId} did not come back under its own id — every UI action addresses it by id`)
      .toBeDefined();
    expect(lane!.from, "the lane's source world was lost").toBe(HOME);
    expect(lane!.to, "the lane's destination was lost").toBe(SETTLED);
    expect(lane!.commodities, "the lane's commodity filter was lost — it would ship everything instead")
      .toEqual(["ore", "crystals"]);
    expect(lane!.shipIds, "the lane came back with no crew, so it would move nothing").toEqual([haulerId]);

    // The back-reference, which is a separate structure and can be lost on its own: `stagedRiders`
    // reads `u.laneId` to keep a lane's ship from being swept off-world by the next jump.
    const ship = restored.planets.get(HOME)!.units.get(haulerId);
    expect(ship, "the lane's hauler is not on the source world any more").toBeDefined();
    expect(freightOf(ship!).laneId, "the ship's own lane booking was lost — the next jump would take it")
      .toBe(laneId);
  });

  it("restores the colony policy through the same validator a live edit goes through", () => {
    const { galaxy } = settledGalaxy();
    const restored = deserializeGalaxy(serializeGalaxy(galaxy))!;

    expect(pairs(restored.colonyPolicies), "the policy store did not come back")
      .toEqual(pairs(galaxy.colonyPolicies));
    const policy = getColonyPolicy(restored, HOME);
    const live = getColonyPolicy(galaxy, HOME);
    expect(policy.autoSell.enabled, "auto-sell came back switched off").toBe(true);
    expect(policy.autoSell.floors, "the per-commodity floors were lost, so auto-sell would dump everything")
      .toEqual({ ore: 200, crystals: 50 });
    expect(policy.workerTarget, "the sustain-workers target was lost").toBe(live.workerTarget);
    expect(policy, "the restored policy differs from the live one").toEqual(live);

    // A world with no policy still reads as the fully-off default rather than as undefined — that is
    // `sanitizePolicy(null)`, and it is what keeps a colony that predates the feature inert.
    const none = getColonyPolicy(restored, SETTLED);
    expect(none, "a world with no stored policy did not read back as the off default")
      .toEqual({ autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
  });
});

/* =================================================================================================
   4. IT KEEPS RUNNING

   The strongest claim in the task, and the only one that catches the roster trap. Everything above
   compares two galaxies at rest; this compares their FUTURES.

   The one piece of machinery it needs is the module-global entity-id counter (`engine/state.js`).
   Both galaxies mint ids from it, so stepping them back to back would interleave their id streams
   and produce a difference that has nothing to do with the save. `deserializeGalaxy` rewinds the
   counter to the save's own `nextEntityId` — so a load is itself the rewind, and the order below is
   deliberate: serialise, step the ORIGINAL forward, and only then load, which puts the counter back
   exactly where the original started from. That the two runs then mint identical ids is part of
   what is being proved, not something worked around.
   ================================================================================================= */

describe("a restored galaxy keeps simulating identically (P4-T09)", () => {
  it("steps 400 further ticks to the same hash as the galaxy it was saved from", () => {
    const { galaxy } = settledGalaxy();
    const save = serializeGalaxy(galaxy);

    // Long enough to cross every schedule in the galaxy scheduler at least once: the background
    // round-robin (BG_STEP), the throttled galaxy scans that run colony policies, and a full lane
    // delivery cycle. A shorter run could pass with the whole background layer switched off.
    const TICKS = 400;
    expect(TICKS, "the run is shorter than one lane cycle, so lanes would never fire after the load")
      .toBeGreaterThan(LANE_PERIOD);
    expect(TICKS, "the run is shorter than one background round-robin").toBeGreaterThan(BG_STEP);

    const ticksBefore = new Map([...galaxy.planets].map(([id, s]) => [id, s.tick]));
    advance(galaxy, TICKS);
    const future = hashGalaxy(galaxy);

    const restored = deserializeGalaxy(save)!;
    advance(restored, TICKS);

    expect(
      hashGalaxy(restored),
      "the restored galaxy diverged from the one it was saved from within 400 ticks — the DATA " +
      "round-tripped but the simulation did not resume from it",
    ).toBe(future);

    // …and every world actually moved during those ticks. Two galaxies that both froze would agree
    // perfectly, which is precisely how the roster trap would slip past a hash comparison.
    for (const [id, state] of galaxy.planets) {
      expect(state.tick, `${id} did not tick at all over ${TICKS} galaxy ticks — it is off the schedule`)
        .toBeGreaterThan(ticksBefore.get(id)!);
    }
  });

  it("keeps ticking a background world whose roster entry the save predates", () => {
    // THE ROSTER TRAP, driven directly. `stepGalaxy` schedules a background world by its index in
    // `galaxy.worlds`; a save written before a world joined the roster carries a SHORT `worlds`, and
    // a loader that trusted it verbatim would leave every newer world at index -1 — data intact,
    // permanently frozen. `deserializeGalaxy` appends the missing ids, which is the repair this
    // asserts. Cheap to lose: nothing else in the engine would ever complain.
    const { galaxy } = settledGalaxy();
    const save = JSON.parse(serializeGalaxyString(galaxy)) as Record<string, unknown>;

    const stale = [HOME, SETTLED];
    save.worlds = stale;
    const restored = deserializeGalaxy(save)!;

    expect(restored.worlds.slice(0, 2), "the save's own roster order was not preserved").toEqual(stale);
    for (const id of ODYSSEY_WORLDS) {
      expect(restored.worlds, `${id} was never appended to the short roster`).toContain(id);
    }

    const before = new Map([...restored.planets].map(([id, s]) => [id, s.tick]));
    advance(restored, 400);
    for (const [id, state] of restored.planets) {
      expect(
        state.tick,
        `${id} never ticked after loading a save whose roster predates it — it is scheduled at ` +
        `index ${restored.worlds.indexOf(id)}, and the background round-robin has dropped it`,
      ).toBeGreaterThan(before.get(id)!);
    }
  });

  it("keeps the lane delivering after a load", () => {
    // The functional half of claim 3. A lane can round-trip every field it has and still be dead:
    // `runLanes` revalidates its crew each cycle and silently drops a ship that is not a live player
    // freighter parked at one of the source world's own pads.
    const { galaxy } = settledGalaxy();
    const restored = deserializeGalaxy(serializeGalaxy(galaxy))!;
    expect(restored.lanes.length, "the lane did not come back at all, so there is nothing to run")
      .toBe(galaxy.lanes.length);
    const src = restored.planets.get(HOME)!;
    const dst = restored.planets.get(SETTLED)!;

    // Restock the source so there is something for the route to carry.
    src.players.player.resources.ore = 2000;
    const delivered = dst.players.player.resources.ore ?? 0;

    advance(restored, LANE_PERIOD + 1);

    expect(restored.lanes[0]!.shipIds, "the lane's crew was dropped on the first cycle after loading")
      .toEqual(galaxy.lanes[0]!.shipIds);
    expect(dst.players.player.resources.ore, "the lane stopped delivering after the load")
      .toBeGreaterThan(delivered);
    expect(src.players.player.resources.ore, "the delivery was created rather than moved").toBeLessThan(2000);
  });
});

/* =================================================================================================
   THE VERSION GATE

   `GALAXY_SAVE_VERSION` is asserted by what it DOES rather than by what it equals — a constant
   compared against itself is a tautology. What matters is that a save the loader cannot understand
   is refused BEFORE the running session is torn down, so a bad file costs the player nothing.
   ================================================================================================= */

describe("the save version gate (P4-T09)", () => {
  it("refuses a save whose version it does not recognise, and says which", () => {
    const { galaxy } = settledGalaxy();
    const good = serializeGalaxy(galaxy);
    expect(good.v, "the writer and the loader disagree about the current version").toBe(GALAXY_SAVE_VERSION);

    for (const v of [GALAXY_SAVE_VERSION + 1, GALAXY_SAVE_VERSION - 1, "1", null]) {
      const bad = { ...good, v };
      expect(() => deserializeGalaxy(bad), `a save stamped ${JSON.stringify(v)} loaded anyway`)
        .toThrow(/unsupported galaxy save version/);
    }

    // A save with NO version at all — a hand-written file, or a payload from something that is not
    // this game. It must be refused by the same gate rather than defaulted into.
    const { v: _dropped, ...versionless } = good;
    expect(() => deserializeGalaxy(versionless), "a versionless payload was loaded as if it were current")
      .toThrow(/unsupported galaxy save version/);
  });

  it("rejects structurally impossible saves while the running game is still intact", () => {
    // The reason the gate throws instead of returning a half-built galaxy: the caller tears the live
    // game down only AFTER a load succeeds. A save that parses and then explodes on the first frame
    // has already cost the player the session they were in.
    const { galaxy } = settledGalaxy();
    const good = serializeGalaxy(galaxy);
    const before = hashGalaxy(galaxy);

    expect(() => deserializeGalaxy({ ...good, planets: [] }), "a save with no planets was accepted")
      .toThrow(/no planets/);
    expect(() => deserializeGalaxy({ ...good, worlds: ["not-a-world"] }), "a save naming no real world was accepted")
      .toThrow(/no recognised worlds/);
    expect(
      () => deserializeGalaxy({ ...good, activeId: ODYSSEY_WORLDS.find((w) => !galaxy.planets.has(w)) }),
      "a save whose seat has no planet payload was accepted — boot would crash reading it",
    ).toThrow(/no active planet/);
    expect(() => deserializeGalaxy("not a save"), "a non-object payload was accepted").toThrow();

    expect(hashGalaxy(galaxy), "a rejected load damaged the galaxy that was already running").toBe(before);

    // And the session really does continue: the rejected loads left the module-global entity-id
    // counter alone, so the live galaxy keeps minting ids and stepping normally.
    advance(galaxy, 100);
    expect(galaxy.tick, "the live galaxy stopped stepping after a rejected load").toBeGreaterThan(0);
  });
});

/* =================================================================================================
   THE DEFECT — a world that has been fought over does not round-trip its prices

   Found while writing the hash above, reported rather than fixed (ADR-0003: the vendored engine is
   upstream's, and `npm run check:vendor` hashes it byte for byte).

   The mechanism, in four lines that are individually reasonable:

     • `engine/galaxy.js` `buildPlanetState` computes a world's price book ONCE, at creation:
       `state.market = createMarket(state)`. Nothing recomputes it for the rest of the game.
     • `createMarket` derives every raw commodity's `base` from the map's node set —
       `share = total[com] / sum` over every node's `max` (engine/market.js).
     • Battle wreckage (`engine/wreckage.js` `spawnWreckNodes`) and Helium Bomb craters
       (`engine/bomb.js` `spawnCraterNode`) PUSH NEW NODES onto that set as a game is played.
     • `engine/persist.js` `deserializeGalaxy` re-runs `createMarket(state)` on load — AFTER
       `rehydratePlanet` has re-added those wreck/crater nodes — and `galaxyPayload` saves only
       `market.pressure` and `market.glut`, never `base`. So the recomputation is the only source of
       truth on load, and there is nothing to notice the drift.

   What a player loses: save a game after any battle that left wreckage, reload, and the prices on
   that world are quoted off a different book. It is not confined to the commodity the wreckage was
   made of — `sum` moves, so every raw commodity's share moves with it, and the shift grows with how
   much wreckage a world has accumulated. Measured below on an ordinary twelve-Lancer skirmish:
   radioactives 29 -> 31, about 7%, from four wreck nodes.

   FIXED UPSTREAM in 50ceb88 (issue #92), reported from here. The section is INVERTED rather than
   deleted: the scenario — a real twelve-Lancer fight, run 3 000 ticks so the dead mature into wreck
   NODES — is expensive to build and is exactly what a regression would need. So it now asserts the
   price book survives, and the note above is kept because it is why the test exists at all.

   The fix skips wreck and crater nodes in `createMarket` rather than persisting `base`, which
   changes nothing during play: at world creation there are none to skip, so the only call affected
   is the one on load, and it now reproduces creation.
   ================================================================================================= */

describe("market prices survive a save on a fought-over world (was issue #92)", () => {
  it("re-derives the same price book on load, from a node set that has grown wreckage", () => {
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const state = galaxy.planets.get(HOME)!;
    const bookAtCreation = { ...state.market.base };

    // An ordinary fight, through nothing but the engine's own combat: two lines of Lancers meet.
    const base = state.map.bases.player;
    for (let i = 0; i < 6; i++) {
      const mine = makeUnit("lancer", "player", base.x + 200 + i * 14, base.y);
      const theirs = makeUnit("lancer", "ai", base.x + 214 + i * 14, base.y + 6);
      state.units.set(mine.id, mine);
      state.units.set(theirs.id, theirs);
    }
    // Long enough for the dead to become wreck SITES and for those sites to mature into nodes
    // (WRECK_SPAWN_DELAY is 45 sim-seconds).
    for (let i = 0; i < 3000; i++) stepGalaxy(galaxy, STEP_SECONDS);

    const wreckNodes = state.map.nodes.filter((n) => n.wreck || n.crater);
    expect(wreckNodes.length, "the battle left no wreckage — this scenario is not the one under test")
      .toBeGreaterThan(0);
    expect(state.market.base, "the live price book was recomputed during play, which would change this analysis")
      .toEqual(bookAtCreation);

    const restored = deserializeGalaxy(serializeGalaxy(galaxy))!;
    const back = restored.planets.get(HOME)!;

    // The wreckage itself round-trips correctly — that half works, and is what makes the price
    // drift so easy to miss.
    expect(back.map.nodes.filter((n) => n.wreck || n.crater).map((n) => n.id).sort(),
      "the wreck nodes themselves were lost, which is a different (larger) bug than the one pinned here")
      .toEqual(wreckNodes.map((n) => n.id).sort());

    const moved = Object.keys(state.market.base).filter((com) => state.market.base[com] !== back.market.base[com]);
    expect(
      moved,
      `the price book moved across a save on a world carrying ${wreckNodes.length} wreck nodes: ` +
      moved.map((c) => `${c} ${state.market.base[c]} -> ${back.market.base[c]}`).join(", ") +
      ". This is issue #92 regressing — `createMarket` must skip nodes flagged `wreck` or `crater`.",
    ).toEqual([]);
    expect(back.market.pressure, "market PRESSURE does survive — only the base is re-derived")
      .toEqual(state.market.pressure);
  });

  it("is invisible on a world that has never been fought over, which is why it survived this long", () => {
    // The control. Without it, the section above would read as "market prices never round-trip",
    // which is both wrong and the kind of overstatement that gets a bug report ignored.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    for (let i = 0; i < 200; i++) stepGalaxy(galaxy, STEP_SECONDS);
    const state = galaxy.planets.get(HOME)!;
    expect(state.map.nodes.some((n) => n.wreck || n.crater), "this control world already has wreckage")
      .toBe(false);

    const back = deserializeGalaxy(serializeGalaxy(galaxy))!.planets.get(HOME)!;
    expect(back.market.base, "a world with no wreck or crater nodes round-trips its price book exactly")
      .toEqual(state.market.base);
  });
});

/* =================================================================================================
   MUTATION LOG — every claim above was made to fail before it was kept.

   Each mutation was applied to `src/engine/engine/persist.js`, this file run against it, and the
   engine then restored byte-exactly (verified with `npm run check:vendor` and an empty
   `git diff -- src/engine/`). Read the right-hand column as "what a reviewer would see", not just
   "it went red" — a mutation caught only by a hash mismatch is one this file cannot diagnose.

     • drop `lanes` from `galaxyPayload`            -> 4 red: the lane claim names it, the
                                                       keeps-delivering claim names it, plus the
                                                       hash and the 400-tick future
     • drop `colonyPolicies` from `galaxyPayload`   -> 3 red: policy claim names it
     • drop a BACKGROUND planet from `galaxyPayload`-> 4 red: "nimbus is missing from the restored
                                                       galaxy entirely", and the planet-order line
     • drop `activeId` from `galaxyPayload`         -> 10 red: refused by the structural gate before
                                                       anything loads, which is the designed
                                                       behaviour — a bad save must not cost the
                                                       running session
     • drop `credits` from `galaxyPayload`          -> 3 red: "credits did not survive"
     • drop node `amount` from `serPlanet`          -> 3 red: "node depletion was regenerated from
                                                       the seed". The first draft of `hashWorld`
                                                       died on `.toFixed` here instead of asserting;
                                                       `n6` above exists because of that.
     • drop `market.pressure` from `galaxyPayload`  -> 3 red: the background world's pressure line
     • blank the saved `fog` explored grid          -> 3 red: the background world's fog line
     • drop the roster-append loop in
       `deserializeGalaxy`                          -> 1 red, and ONLY the roster-trap test. Every
                                                       hash claim stays green. That is the entire
                                                       reason that test exists, and the clearest
                                                       evidence in this file that a hash comparison
                                                       is not sufficient on its own.
     • drop `laneId` from the unit payload, KEEPING
       the load-time back-stamp                     -> GREEN, correctly. The back-stamp
                                                       (`u.laneId = lane.id`) is a redundant second
                                                       carrier, not the primary one — worth knowing,
                                                       and not something to assert away.
     • drop BOTH the unit payload's `laneId` and
       the back-stamp                               -> 3 red: "the ship's own lane booking was
                                                       lost", which is what proves that claim is
                                                       not riding on the hash alone.
   ================================================================================================= */
