// P2-T16 — `rigSurvey` results render inside `SURVEY_RADIUS`, and the rolled `YIELD_TIERS` tier is
// shown from `rigInfo` and never re-derived.
//
// The survey half has a trap that compiles, runs, and looks right: `rigSurvey` takes the node list
// as an argument precisely so the UI can pass the DISCOVERED ones while the sim uses all of them.
// Hand it `state.map.nodes` and the placement reading silently becomes a preview of the sim's own
// answer — every undiscovered deposit on the map, leaked through a build ghost. The first test
// below is the one that catches that, and it is the reason this file exists at all.

import { describe, expect, it } from "vitest";
import { rigSurveyModel, rigYieldModel } from "../../src/ui/rig-panel.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  PLASMA_VEINS, SURVEY_RADIUS, YIELD_TIERS, isNodeDiscovered, makeBuilding, rigInfo, rigSurvey,
} from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base };
}

/** A spot with at least one discovered vein deposit in range — otherwise every survey is blind. */
function surveyableSpot(bridge: WorldBridge): { x: number; y: number } {
  const fog = bridge.state.fog;
  const node = bridge.state.map.nodes.find(
    (n) => PLASMA_VEINS.includes(n.com) && isNodeDiscovered(fog, n),
  );
  expect(node, "the opening should have a discovered vein deposit").toBeDefined();
  return { x: node!.x + 30, y: node!.y + 30 };
}

describe("the placement survey", () => {
  it("reads only the deposits the player has discovered, never the whole map", () => {
    // The trap. `rigSurvey` is pure over the node list it is given, so passing all nodes compiles
    // and produces a *better* reading — which is exactly the problem: it would be the sim's answer,
    // built from caches the player has never scouted.
    //
    // The spot is FOUND rather than hardcoded: somewhere the two surveys genuinely disagree, so the
    // assertion cannot pass by the two happening to coincide. On this seed there are eight, and the
    // one used reads "fair crystals" from all nodes and "poor ore" from what the player has seen.
    const { bridge } = world();
    const state = bridge.state;
    const fog = state.fog;
    const all = state.map.nodes;
    const discovered = all.filter((n) => isNodeDiscovered(fog, n));
    expect(
      discovered.length,
      "this opening reveals everything, so the two surveys cannot differ and this test proves nothing",
    ).toBeLessThan(all.length);

    const spot = all
      .filter((n) => !isNodeDiscovered(fog, n) && PLASMA_VEINS.includes(n.com))
      .find((n) => {
        const a = rigSurvey(all, state.planetId, n.x, n.y);
        const b = rigSurvey(discovered, state.planetId, n.x, n.y);
        return a.likelyVein !== b.likelyVein;
      });
    expect(spot, "no spot on this map distinguishes the two surveys").toBeDefined();

    const leaked = rigSurvey(all, state.planetId, spot!.x, spot!.y);
    const honest = rigSurvey(discovered, state.planetId, spot!.x, spot!.y);
    const model = rigSurveyModel(state, "player", spot!.x, spot!.y);

    expect(
      model.likelyVein,
      `the survey reported "${model.likelyVein}" where an all-nodes read says "${leaked.likelyVein}" ` +
      `and the player's own knowledge says "${honest.likelyVein}" — it is reading through the fog`,
    ).toBe(honest.likelyVein);
    expect(model.likelyVein).not.toBe(leaked.likelyVein);
    expect(model.richness).toBeCloseTo(honest.richness, 9);
    expect(model.richness).not.toBeCloseTo(leaked.richness, 6);
    // And nothing undiscovered is listed as evidence, either.
    for (const seen of model.seen) {
      expect(
        discovered.some((n) => n.x === seen.x && n.y === seen.y),
        "an undiscovered deposit was listed as evidence for the reading",
      ).toBe(true);
    }
  });

  it("is blind where the player has discovered nothing, however much is really there", () => {
    // The strongest form of the same rule: a spot with no discovered vein in range at all must read
    // as a blind gamble even when the sim knows perfectly well what is underneath.
    const { bridge } = world();
    const state = bridge.state;
    const fog = state.fog;
    const all = state.map.nodes;
    const discovered = all.filter((n) => isNodeDiscovered(fog, n));

    const blindSpot = all
      .filter((n) => !isNodeDiscovered(fog, n) && PLASMA_VEINS.includes(n.com))
      .find((h) => !discovered.some(
        (d) => PLASMA_VEINS.includes(d.com) && Math.hypot(d.x - h.x, d.y - h.y) < SURVEY_RADIUS,
      ));
    expect(blindSpot, "every hidden deposit on this map has a discovered neighbour in range").toBeDefined();

    expect(
      rigSurvey(all, state.planetId, blindSpot!.x, blindSpot!.y).likelyVein,
      "the premise: an all-nodes survey WOULD read this spot",
    ).not.toBeNull();

    const model = rigSurveyModel(state, "player", blindSpot!.x, blindSpot!.y);
    expect(model.blind).toBe(true);
    expect(model.likelyVein).toBeNull();
    expect(model.seen).toEqual([]);
  });

  it("matches the engine's own reading over the same discovered nodes", () => {
    const { bridge } = world();
    const spot = surveyableSpot(bridge);
    const fog = bridge.state.fog;
    const discovered = bridge.state.map.nodes.filter((n) => isNodeDiscovered(fog, n));
    const engine = rigSurvey(discovered, bridge.state.planetId, spot.x, spot.y);
    const model = rigSurveyModel(bridge.state, "player", spot.x, spot.y);

    expect(model.likelyVein).toBe(engine.likelyVein);
    expect(model.confidence).toBeCloseTo(engine.confidence, 9);
    expect(model.richness).toBeCloseTo(engine.richness, 9);
    // The label is the engine's word, not a re-bucketing of the number — a second set of thresholds
    // would disagree with the engine's at exactly the boundaries a player notices.
    expect(model.richLabel).toBe(engine.richLabel);
  });

  it("lists only what is inside SURVEY_RADIUS, on the engine's own strict cut", () => {
    // `surfaceSurvey` skips a deposit at `d >= SURVEY_RADIUS`, so a deposit exactly on the line
    // contributes nothing. Showing it beside the number it did not contribute to would be a small,
    // permanent lie about where the reading came from.
    const { bridge } = world();
    const spot = surveyableSpot(bridge);
    const model = rigSurveyModel(bridge.state, "player", spot.x, spot.y);

    expect(model.radius).toBe(SURVEY_RADIUS);
    expect(model.seen.length).toBeGreaterThan(0);
    for (const n of model.seen) expect(n.distance).toBeLessThan(SURVEY_RADIUS);

    const distances = model.seen.map((n) => n.distance);
    expect(distances, "nearest first").toEqual([...distances].sort((a, b) => a - b));
  });

  it("distinguishes a blind spot from a merely uncertain one", () => {
    // A single deposit in range gives confidence 1.0 and is still a guess: the sim picks from all
    // nodes. So "blind" is the engine's null vein, not a low confidence — inferring one from the
    // other would call a perfectly confident one-deposit reading a blind spot, or worse, the reverse.
    const { bridge } = world();
    const spot = surveyableSpot(bridge);
    const model = rigSurveyModel(bridge.state, "player", spot.x, spot.y);
    expect(model.blind).toBe(false);
    expect(model.likelyVein).not.toBeNull();
    expect(model.confidence).toBeGreaterThan(0);
    expect(model.confidence).toBeLessThanOrEqual(1);
  });

  it("shows every tier a dig could strike, with the engine's own multipliers", () => {
    const { bridge } = world();
    const model = rigSurveyModel(bridge.state, "player", ...Object.values(surveyableSpot(bridge)) as [number, number]);
    expect(model.tiers.map((t) => t.name)).toEqual(YIELD_TIERS.map((t) => t.name));
    expect(model.tiers.map((t) => t.mult)).toEqual(YIELD_TIERS.map((t) => t.mult));
  });
});

describe("the rig's yield readout", () => {
  function riggedWorld() {
    const { bridge, base } = world();
    const spot = surveyableSpot(bridge);
    const rig = makeBuilding("plasmarig", "player", spot.x, spot.y);
    bridge.state.buildings.set(rig.id, rig);
    return { bridge, base, rig };
  }

  it("exists at all — the Plasma Rig is a real building type", () => {
    const { bridge, rig } = riggedWorld();
    expect(rigYieldModel(bridge.state, rig.id), "plasmarig is not a rig def").not.toBeNull();
  });

  it("reports nothing for a building that is not a rig", () => {
    // `rigInfo` returns null for anything without a `rig` def, and deferring to it means this panel
    // does not carry its own list of which buildings dig.
    const { bridge } = riggedWorld();
    const cc = [...bridge.state.buildings.values()].find((b) => b.type === "command")!;
    expect(rigYieldModel(bridge.state, cc.id)).toBeNull();
  });

  it("takes the rolled tier from the engine and never derives it from the yield", () => {
    // `lastTier` is `rollTier`'s result — a hash of the rig id and dig counter, biased by richness.
    // `lastYield / baseYield` would agree today and diverge silently the first time an upgrade or a
    // planet scale touches the yield, showing a plausible tier the rig did not roll.
    const { bridge, rig } = riggedWorld();
    const live = bridge.state.buildings.get(rig.id)!;
    for (const tier of YIELD_TIERS) {
      live.lastTier = tier.name;
      live.lastYield = 1;                                  // deliberately inconsistent with the tier
      const model = rigYieldModel(bridge.state, rig.id)!;
      expect(model.lastTier, "the tier must be the engine's own name").toBe(tier.name);
      expect(model.lastTierMult, `${tier.name} must resolve through YIELD_TIERS`).toBe(tier.mult);
      expect(model.lastYield, "the yield is reported as-is beside it").toBe(1);
    }
  });

  it("has no tier before the first dig, rather than a plausible default", () => {
    const { bridge, rig } = riggedWorld();
    const model = rigYieldModel(bridge.state, rig.id)!;
    expect(model.lastTier).toBeNull();
    expect(model.lastTierMult, "a default 'low' would read as a struck seam that never happened").toBeNull();
  });

  it("names the stop reason in the engine's own gating order", () => {
    // A rig with no fuel AND a full buffer is stopped by the fuel. Reporting the buffer would send
    // the player to haul away output, which changes nothing.
    const { bridge, rig } = riggedWorld();
    const state = bridge.state;
    const live = state.buildings.get(rig.id)!;

    state.players.player.resources.radioactives = 0;
    const info = rigInfo(state, live)!;
    expect(info.nuclearOk, "the premise: no nuclear fuel").toBe(false);
    expect(rigYieldModel(state, rig.id)!.stoppedBy).toBe("noFuel");

    state.players.player.resources.radioactives = 9999;
    // No power source anywhere, so the owner-wide throttle is 0.
    expect(rigInfo(state, live)!.throttle).toBe(0);
    expect(rigYieldModel(state, rig.id)!.stoppedBy).toBe("noPower");
  });

  it("mirrors `rigInfo` field for field, so the two cannot drift", () => {
    const { bridge, rig } = riggedWorld();
    const info = rigInfo(bridge.state, bridge.state.buildings.get(rig.id)!)!;
    const model = rigYieldModel(bridge.state, rig.id)!;
    expect(model.vein).toBe(info.vein);
    expect(model.richness).toBeCloseTo(info.richness, 9);
    expect(model.richLabel).toBe(info.richLabel);
    expect(model.progress).toBe(info.progress);
    expect(model.stored).toBe(info.stored);
    expect(model.storeCap).toBe(info.storeCap);
    expect(model.throttle).toBe(info.throttle);
  });
});
