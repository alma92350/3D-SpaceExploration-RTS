// P5-T07 through the app's own step — relief is not a function anyone has to call.
//
// `test/ui/relief-panel.test.ts` drives `stepGalaxy` directly, which is the engine's loop rather
// than this client's. That distinction has already cost this project one row: `sweepColonies` was
// never called by anything, so P4-T06's colony income was a rate nobody banked and the panel was
// correctly reporting money that never arrived (`test/bridge/galaxy-step.test.ts`). Relief runs
// inside `stepGalaxy`'s own ~1 Hz sweep rather than beside it, so it does not have that shape of
// hole — but "it does not" is a claim, and this file is the check: a `WorldBridge`, stepped exactly
// as `Game` steps it, rescues a wiped-out player and puts the ship in the snapshot the renderer
// draws from.
//
// The last test is the other end of the row. A surrender is the only terminal state an Odyssey has,
// and what it does to the running game is worth pinning: the seat stops (`tick` returns on
// `state.over`) while the galaxy clock keeps running, so the snapshot freezes on the last frame of
// the run. That is the state a game-over screen is drawn over.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { SNAP_PLAYER, numericId } from "../../src/bridge/snapshot.js";
import { applyIntent } from "../../src/bridge/commands.js";
import { idsInBox } from "../../src/input/intents.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { RELIEF_COOLDOWN, surrenderGalaxy } from "../../src/engine/index.js";
import { reliefPanelModel } from "../../src/ui/relief-panel.js";
import { scorePanelModel } from "../../src/ui/score-panel.js";

const SEED = 20260815;
const SEAT = "helix";

/** A bridge whose player has lost everything, everywhere. */
function wipedOut(): WorldBridge {
  const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
  for (const state of bridge.galaxy.planets.values()) {
    for (const [id, u] of [...state.units]) if (u.owner === "player") state.units.delete(id);
    for (const [id, b] of [...state.buildings]) if (b.owner === "player") state.buildings.delete(id);
  }
  expect(reliefPanelModel(bridge.galaxy).hasFoothold, "the wipe left a foothold").toBe(false);
  return bridge;
}

/** Player colony ships on the seat, as the engine holds them. */
const ships = (bridge: WorldBridge): string[] =>
  [...bridge.state.units.values()].filter((u) => u.owner === "player" && u.type === "colonyship").map((u) => u.id);

/** …and as the RENDERER would see them: the same ships, out of the snapshot's own tables. */
function snapshotShips(bridge: WorldBridge): number {
  const snap = bridge.snapshot;
  let n = 0;
  for (let i = 0; i < snap.entities.count; i++) {
    if (snap.entities.owner[i] !== SNAP_PLAYER) continue;
    if (snap.typeNames[snap.entities.typeIndex[i]!] === "colonyship") n++;
  }
  return n;
}

/** Step the app's own loop callback until relief lands. Returns the galaxy time it arrived at. */
function stepUntilRelief(bridge: WorldBridge, limitSeconds = RELIEF_COOLDOWN * 3): number | null {
  for (let i = 0; i < Math.round(limitSeconds / STEP_SECONDS); i++) {
    bridge.step(STEP_SECONDS);
    if (ships(bridge).length > 0) return bridge.galaxy.time;
  }
  return null;
}

describe("relief arrives through the step the app actually runs (P5-T07)", () => {
  it("rescues a wiped-out player, and the ship reaches the snapshot", () => {
    const bridge = wipedOut();
    expect(reliefPanelModel(bridge.galaxy).status).toBe("due");

    const at = stepUntilRelief(bridge);
    expect(at, "nothing in this client drives the rescue scan").not.toBeNull();
    expect(bridge.state.over, "the wipeout ended the run").toBe(false);
    expect(ships(bridge), "no relief ship exists on the seat").toHaveLength(1);

    // It is not drawable on the tick it appears, and that is not a bug: a wiped-out player has no
    // eyes anywhere, and the world's fog for that tick was computed inside `tick()` before the
    // galaxy's rescue scan ran. `extractUnits` gates on LIVE vision (F-06), so the ship is dark for
    // exactly one step and then lights its own ground. Worth pinning because it is the difference
    // between "the toast fired and nothing is there" and a bridge that dropped the ship.
    expect(snapshotShips(bridge), "the ship was extracted through fog it had not yet lifted").toBe(0);
    bridge.step(STEP_SECONDS);
    expect(snapshotShips(bridge), "the relief ship never crossed the bridge — a player cannot see it")
      .toBe(1);

    const model = reliefPanelModel(bridge.galaxy);
    expect(model.status, "the panel does not know the rescue landed").toBe("held");
    expect(model.lastReliefTime).toBe(at);
    expect(model.footholds.map((f) => f.planetId)).toEqual([SEAT]);
  });

  it("holds the second rescue for the cooldown the panel is showing", () => {
    const bridge = wipedOut();
    const first = stepUntilRelief(bridge)!;
    for (const id of ships(bridge)) bridge.state.units.delete(id);

    const waiting = reliefPanelModel(bridge.galaxy);
    expect(waiting.status).toBe("waiting");
    expect(waiting.secondsUntilEligible, "the panel is not counting down after a farmed drop")
      .toBeCloseTo(RELIEF_COOLDOWN, 6);

    // Halfway through the wait: still nothing, and the panel still says why.
    for (let i = 0; i < Math.round(RELIEF_COOLDOWN / 2 / STEP_SECONDS); i++) bridge.step(STEP_SECONDS);
    const half = reliefPanelModel(bridge.galaxy);
    expect(ships(bridge), "a second ship arrived inside the cooldown").toEqual([]);
    expect(half.status, "the panel calls a rate-limited wait 'due'").toBe("waiting");
    expect(half.secondsUntilEligible).toBeGreaterThan(0);
    expect(half.secondsUntilEligible).toBeLessThan(waiting.secondsUntilEligible);

    const second = stepUntilRelief(bridge)!;
    expect(second - first, "the cooldown did not hold across the bridge's own step")
      .toBeGreaterThanOrEqual(RELIEF_COOLDOWN);
    expect(reliefPanelModel(bridge.galaxy).secondsUntilEligible, "the countdown did not reset")
      .toBeCloseTo(RELIEF_COOLDOWN, 6);
  });

  it("stops the seat when the run is surrendered, and says so on both panels", () => {
    const bridge = new WorldBridge({ seed: SEED, worldId: SEAT });
    for (let i = 0; i < 20; i++) bridge.step(STEP_SECONDS);
    const running = bridge.state.time;
    expect(running, "the bridge never advanced the seat at all").toBeGreaterThan(0);

    surrenderGalaxy(bridge.galaxy);

    const galaxyBefore = bridge.galaxy.time;
    for (let i = 0; i < 20; i++) bridge.step(STEP_SECONDS);

    // `tick` returns immediately on `state.over`, so the world the player is looking at freezes on
    // its last frame — while the galaxy clock keeps counting, which is what the relief cooldown is
    // measured on and why it is worth knowing that the two now disagree.
    expect(bridge.state.time, "a surrendered seat kept simulating").toBe(running);
    expect(bridge.galaxy.time, "the galaxy clock stopped too").toBeGreaterThan(galaxyBefore);

    expect(reliefPanelModel(bridge.galaxy).surrender.state).toBe("surrendered");
    expect(reliefPanelModel(bridge.galaxy).status).toBe("ended");
    const ending = scorePanelModel(bridge.galaxy).ending;
    expect(ending.over).toBe(true);
    expect(ending.bySurrender, "the ending screen cannot tell a surrender from a defeat").toBe(true);
    // `state.winner` is not on the vendored `State` declaration, so it is read the way
    // `src/ui/colony-panel.ts` reads `state.background`.
    expect(ending.winner).toBe((bridge.state as unknown as { winner?: string }).winner);
  });
});

/* =================================================================================================
   THE DEFECT, INVERTED — the relief ship can be clicked

   This section was written the other way up. Found by writing the test above and pinned rather than
   fixed, because the codec is `src/bridge/snapshot.ts` and this row could not touch it; it asserted
   what happened TODAY so the defect could not change in either direction without a reviewed red.
   The codec was then fixed, this went red on the very first assertion, and it is inverted here
   rather than deleted — the scenario (wipe a player out, wait for the engine to rescue them, box-
   select the rescue) is expensive to build and is exactly what a regression would need.

   The mechanism, in three lines that were individually reasonable:

     • Entities that cross worlds get their own id scheme. `checkGalaxyRescue` mints the relief ship
       as `"g" + galaxy.entitySeq` and `jumpCapital` mints jump riders exactly the same way — the
       engine's comment on the relief line says "galaxy id scheme (as in jumpCapital)".
     • `numericId` packed an engine id into the snapshot's `Int32Array` by dropping the first
       character and sign-flipping buildings, so `"g1"` and `"u1"` both packed to 2.
     • Every decoder in this client — `intents.ts`, `hud.ts`, `game.ts`, `building-panel.ts`, four
       copies of the same three lines — unpacked a positive number as `u${n - 1}`. There was no `g`.

   What a player lost: a box-select over a relief colony ship yielded the id `u1`, `applySelect`
   dropped it (`getEntity` finds nothing), and the selection stayed EMPTY — so the one ship the
   engine sends a wiped-out player to re-found from could not be selected, moved or deployed. When a
   `u`-unit with the same number existed it was worse than a dead click: the wrong unit was
   selected, and every subsequent order went to it.

   Its blast radius was wider than this row. Every jump rider carries a `g` id too (P4-T04), so the
   same dead click applied to a whole expedition the moment it landed — which is why it was pinned
   here rather than described in a comment and forgotten.

   The fix gave each of the engine's id namespaces its own band. A second collision fell out of
   writing it, and `test/bridge/id-codec.test.ts` covers both: wreck and crater deposits are named
   off the entity that died there (`wreck-u12-ore`), `parseInt` answered NaN, and an `Int32Array`
   stores NaN as 0 — so every salvage node and every crater in the game shared the id 0 and decoded
   to `n-1`. Neither could be right-clicked either.
   ================================================================================================= */

describe("the relief ship is addressable through the snapshot (P5-T07)", () => {
  it("keeps the galaxy id scheme distinct, so a box-select selects the ship the engine sent", () => {
    expect(numericId("g1"), "`g` and `u` collapsed onto one band again").not.toBe(numericId("u1"));

    const bridge = wipedOut();
    const at = stepUntilRelief(bridge);
    expect(at, "no relief ship, so there is nothing to click").not.toBeNull();

    const shipId = ships(bridge)[0]!;
    expect(shipId, "the relief ship is no longer minted under the galaxy id scheme").toMatch(/^g\d+$/);
    bridge.step(STEP_SECONDS);   // one more, so the ship has lifted its own fog (see above)
    expect(snapshotShips(bridge), "the ship never reached the snapshot at all").toBe(1);

    // A box-select over the whole world — the widest gesture a player has.
    const picked = idsInBox(bridge.snapshot, -1e6, -1e6, 1e6, 1e6);
    expect(picked, "the ship is not being picked up by a box-select at all — a different bug")
      .toHaveLength(1);
    expect(picked[0], "the decoder does not return the engine's own id").toBe(shipId);
    expect(bridge.state.units.has(picked[0]!), "the decoded id names no live unit").toBe(true);

    // …and the order actually lands, which is the thing the player was failing to do. `select` is
    // the engine's own applySelect, so this is the click, not a re-derivation of it.
    applyIntent(bridge.state, { kind: "select", ids: picked, additive: false }, bridge.galaxy);
    expect(bridge.state.selection, "the ship decodes but will not select").toEqual([shipId]);
  });
});
