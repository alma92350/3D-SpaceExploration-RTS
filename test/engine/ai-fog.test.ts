// P3-T15 — the AI opponent, live under its own fog.
//
// **This file is a proof, not a feature.** The engine already plays fair: `aiIntel.js` resolves
// every sighting through `state.fogs[owner]`, and what it has seen decays on an `INTEL_FADE` clock.
// None of that is built here. What did not exist was any way to *falsify* "the AI cheats" — which
// is the first thing a playtester assumes, costs nothing to say, and no amount of engine header
// comment answers. A comment claiming fairness is worth exactly what the comment in the file it
// describes is worth on the day upstream changes it.
//
// So the four claims below are each written to go RED under a specific, plausible way of being
// wrong, and each was mutation-tested against that mutation before being kept:
//
//   1. SOURCE      no AI module reads the player's fog, asserted against the engine's own text.
//   2. BEHAVIOUR   the AI values at exactly 0 an army it has not scouted, and the number moves on
//                  the same tick its own fog reaches that army — never a tick earlier.
//   3. MEMORY      what it did see fades over INTEL_FADE, and does not fade while still in sight.
//   4. ASYMMETRY   the two fogs are different objects with different contents in a running game —
//                  without which every claim above could be true and vacuous.
//
// Claim 4 is not padding. On a symmetric map at tick 0 the two grids can hold nearly the same
// thing, and a proof that "the AI sees only its own fog" says nothing at all if its own fog and the
// player's happen to agree. It is asserted first in spirit and last in file order.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  INTEL_FADE, INTEL_FULL, UNITS, isVisibleAt, makeBuilding, makeUnit, readEnemy, sightEnemy,
  updateIntel,
} from "../../src/engine/index.js";

const SEED = 20260814;

/* =================================================================================================
   1. THE SOURCE-LEVEL CLAIM — no AI module reads the player's fog

   Modelled on test/bridge/shots.test.ts's first test, and for the same reason: the invariant lives
   in upstream code this project does not own and does not edit (ADR-0003), so the only assertion
   with a shelf life is one made against the source itself.

   The hard part is not finding `state.fog`. It is telling three different things apart:

     • the AI reading the PLAYER's fog                       — the cheat, and the thing to catch
     • a header comment SAYING the AI does not do that        — prose, and there is a lot of it
     • a player-side helper reading the PLAYER's own fog      — correct, and it exists

   All three are present in `src/engine/engine/ai*.js` right now. A scanner that misses the first is
   vacuous; one that trips on the second cries wolf the day someone edits a comment; one that trips
   on the third is a false alarm that gets the whole test deleted. Getting the distinction right is
   the entire value of this section.
   ================================================================================================= */

const AI_DIR = new URL("../../src/engine/engine/", import.meta.url);

/**
 * Every `ai*.js` in the vendored engine, DISCOVERED rather than listed — so an AI module added
 * upstream tomorrow is scanned the day it lands, not the day someone remembers this file exists.
 * The count is asserted below: a glob that silently matches nothing is the classic way a
 * source-scanning test goes green forever.
 */
function aiModules(): string[] {
  return readdirSync(AI_DIR).filter((f) => /^ai.*\.js$/.test(f)).sort();
}

/**
 * Blank out every comment body, preserving newlines so line numbers still match the real file.
 *
 * THIS IS THE LOAD-BEARING LINE OF THE WHOLE SCAN. Three of the four occurrences of `state.fog` in
 * the AI modules today are prose — headers in `ai.js`, `aiMilitary.js` and `aiWorkers.js` promising
 * that the AI never touches it. Scanning raw text reports all three, the test is red on arrival,
 * and whoever inherits it deletes it. `test/engine/ai-fog.test.ts` proving nothing is strictly
 * worse than no such file, because it also stops anyone else writing one.
 *
 * Naive by design: it does not understand a `//` inside a string literal. Verified safe here —
 * there is no `://` anywhere in `ai*.js` — and the cost of being wrong is a false alarm on a
 * vendored file we would be reading anyway, not a missed cheat.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Every way an AI module could get its hands on the player's grid.
 *
 * `state.fog` is not a field of its own: `engine/state.js` builds `fogs` per owner and then aliases
 * `fog: fogs.player` and `fogAI: fogs.ai`. So the cheat has four spellings and they all have to be
 * here — a scanner that only knows `state.fog` misses `state.fogs.player`, which is precisely the
 * mutation this section was tested against.
 *
 * `\b` after `fog` is what keeps `state.fogAI` and `state.fogs[owner]` out of the first pattern:
 * both continue with a word character, so the boundary fails. That is deliberate — reading its OWN
 * grid is the behaviour under proof, not a violation of it.
 */
const FORBIDDEN: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\bstate\.fog\b/g, what: "state.fog — engine/state.js aliases that to fogs.player" },
  { re: /\bstate\.fogs\s*\.\s*player\b/g, what: "state.fogs.player" },
  { re: /\bstate\.fogs\s*\[\s*["']player["']\s*\]/g, what: 'state.fogs["player"]' },
  { re: /\bstate\.fogs\s*\[\s*enemyOwner\s*\]/g, what: "state.fogs[enemyOwner] — its opponent's grid" },
  { re: /\bstate\.fogs\s*\[\s*otherOwner\s*\(/g, what: "state.fogs[otherOwner(…)] — the same, via the helper" },
];

interface FogRead { file: string; line: number; fn: string; text: string; what: string }

/**
 * The nearest declaration at or above `line`, so a hit can be judged by WHO does it.
 *
 * The `\*?` and the arrow/function-expression arm are not defensive padding — mutation-testing this
 * file found them. A cheat planted inside `aiMilitary.js`'s `function* visibleEnemyCombatUnits` was
 * reported against `applyFocusFire()`, the nearest preceding *plain* declaration. It was still
 * caught, because neither name is exempt; but attribution that drifts upward is exactly how a hit
 * lands on an exempted name and gets waved through, so it is fixed rather than noted.
 */
function enclosingFunction(codeLines: string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    const l = codeLines[i]!;
    const decl = l.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    if (decl) return decl[1]!;
    // `const foo = (a, b) => …` and `const foo = function (…)`, both of which the engine uses.
    const assigned = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/);
    if (assigned) return assigned[1]!;
  }
  return "(module scope)";
}

/** Every read of the player's fog in one module's *code*, with the function responsible for it. */
function playerFogReads(file: string, source: string): FogRead[] {
  const code = codeOnly(source);
  const codeLines = code.split("\n");
  const rawLines = source.split("\n");
  const hits: FogRead[] = [];
  for (const { re, what } of FORBIDDEN) {
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split("\n").length;
      hits.push({ file, line, fn: enclosingFunction(codeLines, line), text: rawLines[line - 1]!.trim(), what });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * The one legitimate read of `state.fog` in the AI tree, pinned THREE ways: file, function, and the
 * exact statement.
 *
 * Not "aiWorkers.js is exempt" — that would licence a real cheat anywhere in a 500-line module, and
 * not "any hit attributed to this function", because attribution is a regex over someone else's
 * source and this file has already caught it drifting once. Pinning the text costs a deliberate
 * re-read on the day upstream touches that line, which is the correct price for the only hole in
 * the wall. The vendored tree is hashed byte-for-byte anyway (ADR-0003), so upstream moving this
 * line is already a reviewed event rather than a surprise.
 */
const ALLOWED: ReadonlyArray<{ file: string; fn: string; text: string; why: string }> = [
  {
    file: "aiWorkers.js",
    fn: "assignIdlePlayerGather",
    text: "idleGatherAssign(state, state.fog, workers);",
    why:
      "the PLAYER-side twin of assignIdleWorkers — engine/colonyPolicy.js calls it to put a " +
      "background colony's idle PLAYER workers back on a node. The workers it steers are the " +
      "player's, so state.fog IS its own fog: this is the own-fog rule holding for the other seat, " +
      "not an exception to it.",
  },
];

describe("the AI reads no fog but its own, in the engine's own source (P3-T15)", () => {
  it("scans a real, non-empty set of AI modules", () => {
    // The guard that keeps everything below from being a test of the empty set. A rename, a move,
    // or a reorganised vendor tree turns this whole section into `[] has no violations` — which is
    // green, permanent, and worthless.
    const modules = aiModules();
    expect(modules.length, "no ai*.js modules found — the vendored engine moved and this scan is now vacuous")
      .toBeGreaterThanOrEqual(10);
    for (const name of ["ai.js", "aiIntel.js", "aiMilitary.js", "aiEconomy.js", "aiWorkers.js"]) {
      expect(modules, `${name} is gone — the module this scan exists to police is not being scanned`)
        .toContain(name);
    }
  });

  it("never reaches for the player's grid, in any of its four spellings", () => {
    const unexpected: FogRead[] = [];
    const matched = new Set<string>();
    for (const file of aiModules()) {
      const src = readFileSync(new URL(file, AI_DIR), "utf8");
      for (const hit of playerFogReads(file, src)) {
        const allow = ALLOWED.find((a) => a.file === hit.file && a.fn === hit.fn && a.text === hit.text);
        if (allow) matched.add(`${allow.file}:${allow.fn}`);
        else unexpected.push(hit);
      }
    }

    expect(
      unexpected,
      unexpected.map((h) =>
        `${h.file}:${h.line} in ${h.fn}() reads ${h.what} — the AI is deciding off the PLAYER's ` +
        `vision, which is the definition of cheating.\n    ${h.text}`).join("\n  "),
    ).toEqual([]);

    // The other direction. An exemption whose code has gone is an exemption sitting open over
    // whatever takes that name next, and nothing else in this file would ever notice.
    for (const a of ALLOWED) {
      expect(
        matched.has(`${a.file}:${a.fn}`),
        `the exemption for ${a.file}:${a.fn}() no longer matches anything — delete it rather than ` +
        `leaving a hole open. It was granted because: ${a.why}`,
      ).toBe(true);
    }
  });

  it("would catch the cheat if it were there — every spelling, and not the prose", () => {
    // The anti-vacuity test, and the reason this section can be trusted at all. The scan above is a
    // regex over someone else's source: the way it fails is not by breaking, it is by quietly
    // matching nothing forever. So the scanner is run against sources that DO cheat, and against
    // ones that only talk about cheating.
    const cheats = [
      "function sightEnemy(state, owner) {\n  const fog = state.fog;\n}\n",
      "function sightEnemy(state, owner) {\n  const fog = state.fogs.player;\n}\n",
      'function sightEnemy(state, owner) {\n  const fog = state.fogs["player"];\n}\n',
      "function sightEnemy(state, owner) {\n  const fog = state.fogs[enemyOwner];\n}\n",
      "function sightEnemy(state, owner) {\n  const fog = state.fogs[otherOwner(owner)];\n}\n",
    ];
    for (const src of cheats) {
      const hits = playerFogReads("fixture.js", src);
      expect(hits.length, `the scanner did not flag a cheating source:\n${src}`).toBe(1);
      expect(hits[0]!.fn, "the scanner cannot say which function is cheating").toBe("sightEnemy");
    }

    // Attribution has to survive the shapes the engine actually declares functions in. This is a
    // regression test, not a hypothetical: a cheat planted in `aiMilitary.js`'s
    // `function* visibleEnemyCombatUnits` was originally reported against the plain function above
    // it. A hit blamed on the wrong function is a hit that can land on an exempted name.
    const shapes: ReadonlyArray<[string, string]> = [
      ["visibleEnemyCombatUnits", "function* visibleEnemyCombatUnits(state, owner) {\n  const fog = state.fog;\n}\n"],
      ["visibleEnemyCombatUnits", "function *visibleEnemyCombatUnits(state, owner) {\n  const fog = state.fog;\n}\n"],
      ["pickTarget", "const pickTarget = (state) => {\n  const fog = state.fog;\n};\n"],
      ["pickTarget", "const pickTarget = function (state) {\n  const fog = state.fog;\n};\n"],
    ];
    for (const [fn, src] of shapes) {
      const hits = playerFogReads("fixture.js", src);
      expect(hits.length, `the scanner missed a cheat in:\n${src}`).toBe(1);
      expect(hits[0]!.fn, `the cheat in ${fn} was blamed on ${hits[0]!.fn} — attribution has drifted`).toBe(fn);
    }

    // …and stays quiet on the three things that are not cheats: prose about the rule, the AI's own
    // grid, and the owner-generic read the whole engine actually uses.
    const innocent = [
      "// reads state.fog for the player, never for the AI\n/* state.fogs.player is not touched */\n",
      "function sightEnemy(state, owner) {\n  const fog = state.fogs[owner];\n}\n",
      "function assignIdleWorkers(state, workers, fog = state.fogAI) {\n  return fog;\n}\n",
    ];
    for (const src of innocent) {
      expect(
        playerFogReads("fixture.js", src),
        `the scanner cried wolf on legitimate source, which is how this test gets deleted:\n${src}`,
      ).toEqual([]);
    }
  });

  it("names the AI's own grid only where an owner-generic caller can override it", () => {
    // The mirror-image bug, and the one nobody looks for: `state.fogAI` is hardcoded to the "ai"
    // seat. Inside the body of an owner-generic function it would mean the PLAYER-side self-play
    // controller (state.playerAi) planning off the AI's vision — unfair in the other direction, and
    // invisible to every assertion above. Both occurrences today are default parameter values, so
    // an explicit fog always wins and only the legacy owner-"ai" call site ever reaches the alias.
    let occurrences = 0;
    for (const file of aiModules()) {
      const src = readFileSync(new URL(file, AI_DIR), "utf8");
      const code = codeOnly(src);
      const lines = code.split("\n");
      for (const m of code.matchAll(/\bstate\.fogAI\b/g)) {
        const line = code.slice(0, m.index).split("\n").length;
        occurrences++;
        expect(
          /function\s+[A-Za-z_$][\w$]*\s*\([^)]*=\s*state\.fogAI/.test(lines[line - 1]!),
          `${file}:${line} reads state.fogAI outside a default parameter — an owner-generic caller ` +
          `cannot override it there, so the "player" seat would plan off the AI's vision.\n    ` +
          `${src.split("\n")[line - 1]!.trim()}`,
        ).toBe(true);
      }
    }
    expect(occurrences, "no state.fogAI defaults left — this assertion is now scanning nothing")
      .toBeGreaterThan(0);
  });
});

/* =================================================================================================
   2. THE BEHAVIOURAL CLAIM — the AI values at 0 what it has not seen

   `sightEnemy(state, "ai")` is the lever: it is the live half of the belief, and every AI decision
   that depends on the enemy is downstream of it via `updateIntel`/`readEnemy`.
   ================================================================================================= */

/** Ore value of a unit type, the way `aiIntel.js` counts it — the sum of its cost commodities. */
function oreValue(type: string): number {
  const cost = (UNITS[type] as { cost?: Record<string, number> } | undefined)?.cost ?? {};
  return Object.values(cost).reduce((a, b) => a + b, 0);
}

/**
 * The AI's controller. Deliberately NOT on the declared `State` shape — it is the AI's private
 * scratch, not shared world state — so a narrow cast, used only to assert that it EXISTS. A
 * scenario with no controller is one where `readEnemy` returns its "never seen anything" default
 * for reasons that have nothing to do with fog, and every assertion below would pass on air.
 */
function aiController(state: State): Record<string, unknown> | undefined {
  return (state as unknown as { ai?: Record<string, unknown> }).ai;
}

/**
 * A fixed board: one Command Center a side, nothing else.
 *
 * Odyssey opens with a colony ship a side that deploys on its own schedule, which makes "what has
 * the AI seen by now" a function of the AI's own opening rather than of the scenario. Clearing them
 * and seating both bases by hand means every reveal below has exactly one cause.
 */
function scriptedMatch() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const state = bridge.state;
  for (const u of [...state.units.values()]) state.units.delete(u.id);
  const pb = state.map.bases.player;
  const ab = state.map.bases.ai;
  for (const b of [makeBuilding("command", "player", pb.x, pb.y), makeBuilding("command", "ai", ab.x, ab.y)]) {
    state.buildings.set(b.id, b);
  }
  bridge.step(STEP_SECONDS);   // one tick, so both fog grids are real rather than freshly zeroed
  return { bridge, state, pb, ab };
}

/** Eight Lancers at the player's own base — 1200 ore of army the AI has never laid eyes on. */
function playerArmy(state: State, at: { x: number; y: number }): Unit[] {
  const army: Unit[] = [];
  for (let i = 0; i < 8; i++) {
    const u = makeUnit("lancer", "player", at.x + 30 + (i % 4) * 12, at.y - 18 + Math.floor(i / 4) * 12);
    state.units.set(u.id, u);
    army.push(u);
  }
  return army;
}

/** Whether ANY of `army` currently stands in ground `owner`'s own fog has lit. */
function anyVisibleTo(state: State, owner: OwnerId, army: Unit[]): boolean {
  return army.some((u) => {
    const live = state.units.get(u.id);
    return !!live && isVisibleAt(state.fogs[owner], live.x, live.y);
  });
}

describe("the AI cannot see what it has not scouted (P3-T15)", () => {
  it("values a large unscouted army at exactly zero, and knows that it does not know", () => {
    const { bridge, state, pb } = scriptedMatch();
    const army = playerArmy(state, pb);
    bridge.step(STEP_SECONDS);

    // THE PREMISES, all four spelled out, because each has a way of quietly stopping being true and
    // taking the proof with it. The first draft of this test had none of them and passed with the
    // army parked outside the map — `isVisibleAt` returns false for an out-of-bounds point too, so
    // "the AI cannot see it" was true for entirely the wrong reason.
    expect(aiController(state), "no AI controller — every intel read would return a default").toBeDefined();
    expect(state.fogs.ai, "both sides are sharing one fog grid; there is nothing to be fair about")
      .not.toBe(state.fogs.player);
    for (const u of army) {
      expect(
        isVisibleAt(state.fogs.player, u.x, u.y),
        "the army is not in ground the PLAYER can see either — it is off the map or in a dead cell, " +
        "and the AI failing to see it proves nothing",
      ).toBe(true);
      expect(isVisibleAt(state.fogs.ai, u.x, u.y), "the AI can already see the army — this is not the hidden case")
        .toBe(false);
    }
    expect(oreValue("lancer"), "a Lancer is free, so an army of them is worth nothing to see").toBeGreaterThan(0);

    // THE CLAIM. Same instant, same army, same map — the only difference between 0 and 1200 is
    // whose fog is consulted.
    const seen = sightEnemy(state, "ai");
    expect(
      seen.mil,
      `the AI values ${seen.mil} ore of military it has never scouted — it is reading the player's fog`,
    ).toBe(0);

    // …and the belief built on it says "I do not know", not "they are peaceful". `posture === null`
    // is the distinction the whole confidence channel exists to keep, and an AI that collapsed the
    // two would raid into an army it never saw.
    updateIntel(state, "ai");
    const belief = readEnemy(state, "ai");
    expect(belief.posture, "the AI has formed an opinion about an enemy it has never seen").toBeNull();
    expect(belief.confidence, "confidence without a sighting").toBe(0);
  });

  it("sees the whole army the moment its own fog reaches it, and not one tick before", () => {
    // The other half, and the one that makes the half above mean something: a test that only
    // asserted "the AI sees nothing" would pass just as well against an AI that sees nothing ever.
    //
    // A Ranger is walked from the AI's base to the player's in forty scripted hops, one sim tick
    // each. At every hop two questions are asked independently — does the AI's own fog light the
    // ground any army unit stands on, and does `sightEnemy` value that army above zero — and the
    // answers must agree EVERY time. The equivalence is the assertion; the moment it flips is only
    // the evidence that both branches were exercised.
    const { bridge, state, pb, ab } = scriptedMatch();
    const army = playerArmy(state, pb);
    const scout = makeUnit("ranger", "ai", ab.x - 40, ab.y);
    scout.hp = scout.maxHp = 100000;   // it is walking into eight Lancers; the march must finish
    state.units.set(scout.id, scout);
    bridge.step(STEP_SECONDS);

    expect(sightEnemy(state, "ai").mil, "the march starts with the army already visible").toBe(0);
    expect(anyVisibleTo(state, "player", army), "the player cannot see their own army — the board is wrong")
      .toBe(true);

    const HOPS = 40;
    let firstFogHop = -1;
    let firstSightHop = -1;
    const ahead: string[] = [];
    for (let hop = 1; hop <= HOPS; hop++) {
      const live = state.units.get(scout.id);
      expect(live, `the scout died at hop ${hop} — the march never reached the army`).toBeDefined();
      const t = hop / HOPS;
      live!.x = ab.x + (pb.x + 60 - ab.x) * t;
      live!.y = ab.y + (pb.y - ab.y) * t;
      live!.order = null;
      bridge.step(STEP_SECONDS);   // the engine recomputes both fog grids inside the tick

      const fogReaches = anyVisibleTo(state, "ai", army);
      const valued = sightEnemy(state, "ai").mil > 0;
      if (valued && !fogReaches) ahead.push(`hop ${hop}`);
      if (fogReaches && firstFogHop < 0) firstFogHop = hop;
      if (valued && firstSightHop < 0) firstSightHop = hop;
      expect(
        valued,
        `hop ${hop}: the AI's own fog ${fogReaches ? "does" : "does not"} reach the army, but it ` +
        `values it at ${sightEnemy(state, "ai").mil} — sighting and fog have come apart`,
      ).toBe(fogReaches);
    }

    expect(ahead, `the AI valued the army before its fog reached it, at ${ahead.join(", ")}`).toEqual([]);
    expect(firstFogHop, "the scout never reached the army — both branches were never exercised")
      .toBeGreaterThan(0);
    expect(firstSightHop, "the AI never saw the army even once — only the blind branch was tested")
      .toBe(firstFogHop);

    // What it ends up believing is the whole army, valued the way the engine values it — so the
    // reveal is a real, complete sighting rather than one unit clipping a corner of a fog cell.
    expect(sightEnemy(state, "ai").mil, "the AI saw the army but valued only part of it")
      .toBe(army.length * oreValue("lancer"));
    updateIntel(state, "ai");
    const belief = readEnemy(state, "ai");
    expect(belief.posture, "the AI scouted a real army and still has no opinion").not.toBeNull();
    expect(belief.confidence, "a full sighting of 1200 ore left the AI unconfident").toBeGreaterThan(0);
  });
});

/* =================================================================================================
   3. THE MEMORY CLAIM — INTEL_FADE is the AI forgetting

   The half of fairness that is easy to miss. An AI that sees correctly but remembers forever is
   still omniscient after ten minutes of scouting, and the player who killed the scout got nothing
   for it. `aiIntel.js` stores a high-water mark and fades it AT THE READ; the header records that
   an earlier version faded the stored number and wrote it back, which compounded once per think
   cycle and emptied the documented four-minute memory in about sixty seconds. Both directions are
   asserted below, because that bug was green under every test that jumped the clock once.
   ================================================================================================= */

/**
 * Show the AI an army, then hide it, and return the belief `hidden` seconds later — having called
 * `updateIntel` every `cadence` seconds in between, exactly as a running match would.
 *
 * `state.time` is advanced by hand rather than by stepping four minutes of simulation. That is the
 * point: over 7200 real ticks the AI builds an army and goes looking, and a re-sighting resets the
 * very clock under test. This keeps the scenario the scenario — and the sighting itself, and the
 * hiding, still go through the engine's own fog pass.
 */
function beliefAfterHiding(hidden: number, cadence: number) {
  const { bridge, state, pb, ab } = scriptedMatch();
  const army = playerArmy(state, { x: ab.x - 60, y: ab.y });   // parked in the AI's own vision
  bridge.step(STEP_SECONDS);
  const premiseSeen = sightEnemy(state, "ai").mil;
  updateIntel(state, "ai");
  const peak = readEnemy(state, "ai").mil;

  for (const u of army) { u.x = pb.x + 30; u.y = pb.y; u.order = null; }
  bridge.step(STEP_SECONDS);
  const premiseHidden = sightEnemy(state, "ai").mil;

  const t0 = state.time;
  for (let t = cadence; t <= hidden; t += cadence) {
    state.time = t0 + t;
    updateIntel(state, "ai");   // the think cycles a real match would spend staring at nothing
  }
  state.time = t0 + hidden;
  return { premiseSeen, premiseHidden, peak, belief: readEnemy(state, "ai"), stillHidden: sightEnemy(state, "ai").mil };
}

describe("the AI forgets what it stopped being able to see (P3-T15)", () => {
  it("ships the memory windows the board names", () => {
    // Both are load-bearing constants quoted in the task and in the module header, and both are
    // exported for exactly this. Reading them from the engine and asserting nothing would let a
    // one-second INTEL_FADE pass every decay test in this file.
    expect(INTEL_FADE, "the four-minute memory is no longer four minutes").toBe(240);
    expect(INTEL_FULL, "the fully-informed threshold moved").toBe(900);
  });

  it("decays a sighting to nothing over INTEL_FADE, in a straight line", () => {
    const half = beliefAfterHiding(INTEL_FADE / 2, 1.5);
    expect(half.premiseSeen, "the AI never saw the army — there is nothing to forget").toBeGreaterThan(0);
    expect(half.peak, "the sighting was not folded into the belief").toBe(half.premiseSeen);
    expect(half.premiseHidden, "the army never actually left the AI's vision").toBe(0);
    expect(half.stillHidden, "the army wandered back into vision and reset the clock under test").toBe(0);

    // Halfway through the window, half the belief is left. Asserted as a band rather than a point
    // because the two engine ticks that reveal and hide the army cost a few hundredths of a second
    // of sim time each.
    expect(
      half.belief.mil / half.peak,
      `${INTEL_FADE / 2}s after losing sight the AI still credits the enemy with ` +
      `${half.belief.mil.toFixed(0)} of ${half.peak} ore — the fade is not running`,
    ).toBeCloseTo(0.5, 2);

    const gone = beliefAfterHiding(INTEL_FADE, 1.5);
    expect(
      gone.belief.mil,
      "a full INTEL_FADE after losing sight the AI still believes in an army it cannot see",
    ).toBe(0);
    expect(gone.belief.confidence, "confidence outlived the belief it was measuring").toBe(0);
  });

  it("does not decay while the army stays in sight", () => {
    // The other direction, and the one that stops "it decays" being satisfied by an AI whose memory
    // is simply broken. Same clock, same think cycles, army never moves.
    const { bridge, state, ab } = scriptedMatch();
    playerArmy(state, { x: ab.x - 60, y: ab.y });
    bridge.step(STEP_SECONDS);
    const live = sightEnemy(state, "ai").mil;
    expect(live, "the army is not in the AI's vision — this is not the in-sight case").toBeGreaterThan(0);

    const t0 = state.time;
    for (let t = 1.5; t <= INTEL_FADE + 30; t += 1.5) {
      state.time = t0 + t;
      updateIntel(state, "ai");
    }
    const belief = readEnemy(state, "ai");
    expect(
      belief.mil,
      `after ${INTEL_FADE + 30}s of continuous sight the AI has forgotten an army standing in front of it`,
    ).toBe(live);
    expect(belief.confidence, "a continuously-observed enemy left the AI unconfident").toBe(1);
    expect(belief.age, "the AI thinks its own live sighting is stale").toBe(0);
  });

  it("fades on elapsed time, not on how often it thinks", () => {
    // The regression the module header records, and the reason the two tests above are not enough:
    // the old code faded the stored peak and wrote the faded value back, so the decay compounded
    // once per think cycle and its real rate depended on cadence. Every test that jumped the clock
    // in one hop was green throughout. Three cadences spanning three orders of magnitude — the
    // engine's own 1.5s think interval, every sim tick, and a single hop — must agree.
    const window = INTEL_FADE / 2;
    const thinkCycle = beliefAfterHiding(window, 1.5).belief.mil;
    const everyTick = beliefAfterHiding(window, STEP_SECONDS).belief.mil;
    const oneHop = beliefAfterHiding(window, window).belief.mil;

    expect(thinkCycle, "the fade is not running at all").toBeGreaterThan(0);
    expect(
      everyTick,
      `${Math.round(window / STEP_SECONDS)} think cycles left ${everyTick.toFixed(0)} ore where 1 left ` +
      `${oneHop.toFixed(0)} — the fade is compounding per call, so the AI's memory empties at a rate ` +
      `set by its own cadence rather than by INTEL_FADE`,
    ).toBeCloseTo(oneHop, 6);
    expect(thinkCycle, "the think-cadence fade disagrees with a single hop").toBeCloseTo(oneHop, 6);
  });
});

/* =================================================================================================
   4. THE ASYMMETRY CLAIM — the two fogs really do hold different things

   Everything above is conditional on this. If `state.fogs.ai` and `state.fogs.player` agreed, an AI
   reading either would behave identically and every proof in this file would be green and empty.
   ================================================================================================= */

describe("the two fogs are genuinely different fields (P3-T15)", () => {
  it("are distinct objects, and the aliases point where they claim to", () => {
    // The whole source-level section rests on this: `state.fog` means the player's grid and
    // `state.fogAI` means the AI's. If the aliases were ever swapped or collapsed, that scan would
    // be policing the wrong names and would say so in neither direction.
    const { state } = scriptedMatch();
    expect(state.fog, "state.fog is no longer the player's grid").toBe(state.fogs.player);
    expect(state.fogAI, "state.fogAI is no longer the AI's grid").toBe(state.fogs.ai);
    expect(state.fogs.player, "the two sides share one grid — neither can be blind to the other")
      .not.toBe(state.fogs.ai);
    expect(state.fogs.ai.visible, "the two grids share one backing array").not.toBe(state.fogs.player.visible);
  });

  it("light different ground in a running game, in both directions", () => {
    // "Different" has to mean each side sees something the other does not. A one-sided difference
    // would be satisfied by an AI whose vision is a superset of the player's — which is what
    // cheating looks like from the outside.
    const { bridge, state, pb, ab } = scriptedMatch();
    playerArmy(state, pb);
    playerArmy(state, { x: ab.x - 60, y: ab.y });   // and something of the player's out by the AI
    for (let t = 0; t < 30; t++) bridge.step(STEP_SECONDS);

    const p = state.fogs.player.visible;
    const a = state.fogs.ai.visible;
    expect(p.length, "the two grids are different sizes").toBe(a.length);
    let onlyPlayer = 0;
    let onlyAi = 0;
    for (let i = 0; i < p.length; i++) {
      if (p[i] && !a[i]) onlyPlayer++;
      if (a[i] && !p[i]) onlyAi++;
    }
    expect(onlyPlayer, "there is no ground the player can see and the AI cannot").toBeGreaterThan(0);
    expect(onlyAi, "there is no ground the AI can see and the player cannot").toBeGreaterThan(0);

    // And there is real darkness left on both sides — a fully-explored map would make every
    // "cannot see it" assertion in this file trivially unreachable rather than proven.
    const dark = (f: Fog) => [...f.explored].filter((c) => !c).length;
    expect(dark(state.fogs.player), "the player has explored the entire map").toBeGreaterThan(0);
    expect(dark(state.fogs.ai), "the AI has explored the entire map — nothing can be hidden from it")
      .toBeGreaterThan(0);
  });
});
