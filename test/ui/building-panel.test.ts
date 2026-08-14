// P2-T09 — the building detail panel's model (ADR-0012 §4).
//
// A pure function of a snapshot, tested without a DOM, and its own module rather than another
// branch of `hudModel` — which is already 300 lines for one panel, and six more panels in one
// function is a function nobody can test a branch of.
//
// The property that matters most: **the stop reason is not computed here.** The snapshot carries
// the engine's own `buildingConcern` code, and this turns it into a sentence. A panel that instead
// looked at the buffers and decided for itself would disagree with the simulation the first time
// upstream reorders `updateProduction`'s gating — and the disagreement would read as the UI lying,
// because it would be.

import { describe, expect, it } from "vitest";
import { buildingPanelModel } from "../../src/ui/building-panel.js";
import {
  CONCERN_BUFFER_FULL, CONCERN_NONE, CONCERN_NO_POWER, CONCERN_PAUSED, CONCERN_STARVED,
  CONCERN_THROTTLED, FLAG_BUILDING_KIND, ProductionTable, type BuildingBuffers, type Snapshot,
} from "../../src/bridge/snapshot.js";

/** The smallest snapshot with one selected building in it. */
function snapshotWith(opts: {
  type?: string;
  concern?: number;
  fed?: number;
  output?: number;
  recipe?: number;
  buffers?: BuildingBuffers;
  selected?: boolean;
} = {}): Snapshot {
  const production = new ProductionTable(4);
  production.concern[0] = opts.concern ?? CONCERN_NONE;
  production.fed[0] = opts.fed ?? 0.5;
  production.output[0] = opts.output ?? 0.25;
  production.recipe[0] = opts.recipe ?? 0;

  const entities = {
    count: 1,
    ids: Int32Array.of(-1),                     // b0 → negative, per `numericId`
    typeIndex: Uint8Array.of(0),
    owner: Uint8Array.of(0),
    flags: Uint8Array.of(FLAG_BUILDING_KIND),
    hp: Float32Array.of(400),
    maxHp: Float32Array.of(400),
  };

  const buffers = new Map<string, BuildingBuffers>();
  if (opts.buffers) buffers.set("b0", opts.buffers);

  return {
    typeNames: [opts.type ?? "smelter"],
    recipeNames: ["smelt"],
    entities,
    production,
    buffers,
    selection: opts.selected === false ? [] : ["b0"],
    stockpile: {},
  } as unknown as Snapshot;
}

describe("the building detail panel", () => {
  it("is empty unless exactly one building is selected", () => {
    expect(buildingPanelModel(snapshotWith({ selected: false })).building).toBeNull();
  });

  it("names the building and its recipe in the engine's own terms", () => {
    const model = buildingPanelModel(snapshotWith({
      buffers: {
        input: { ore: 12 }, output: { metals: 4 },
        recipe: { id: "smelt", out: "metals", qty: 2, in: { ore: 2, energy: 2 }, kind: "refine" },
        inputCap: 40, outputCap: 60,
      },
    }));
    expect(model.building?.label).toBe("Smelter");
    // The recipe reads as the engine states it, inputs first — a player checking "why is this
    // stopped" needs to see what it eats, not a prose summary of it.
    expect(model.recipeText).toBe("2 ore → 2 metals");
  });

  it("turns each engine stop code into a sentence that names the actual cause", () => {
    // Every one of these is a DIFFERENT thing to do about it, which is the whole reason the codes
    // are distinct: starved means haul inputs, buffer-full means haul output away, no-power means
    // build or fuel a reactor, throttled means the grid is oversubscribed.
    const cases: Array<[number, RegExp]> = [
      [CONCERN_NONE, /running/i],
      [CONCERN_PAUSED, /paused/i],
      [CONCERN_NO_POWER, /power/i],
      [CONCERN_STARVED, /input|starved|waiting/i],
      [CONCERN_BUFFER_FULL, /full|haul/i],
      [CONCERN_THROTTLED, /throttl|grid/i],
    ];
    for (const [code, pattern] of cases) {
      const model = buildingPanelModel(snapshotWith({ concern: code }));
      expect(model.statusText, `code ${code} produced "${model.statusText}"`).toMatch(pattern);
    }
  });

  it("distinguishes a stall a player must act on from one they need not", () => {
    // Throttled is a warning: the factory IS producing, just slower. Starved is a stop. A panel
    // that painted both the same colour would send a player to fix the wrong thing.
    expect(buildingPanelModel(snapshotWith({ concern: CONCERN_THROTTLED })).severity).toBe("warn");
    expect(buildingPanelModel(snapshotWith({ concern: CONCERN_STARVED })).severity).toBe("bad");
    expect(buildingPanelModel(snapshotWith({ concern: CONCERN_PAUSED })).severity).toBe("paused");
    expect(buildingPanelModel(snapshotWith({ concern: CONCERN_NONE })).severity).toBe("ok");
  });

  it("shows buffer levels only when the selection carried them", () => {
    // Q-07: buffers arrive for the selection only. With none, the panel shows the summary rather
    // than inventing zeroes — "0 ore" and "we don't know" are different claims.
    const without = buildingPanelModel(snapshotWith({}));
    expect(without.inputs).toEqual([]);
    expect(without.outputs).toEqual([]);

    const withBuffers = buildingPanelModel(snapshotWith({
      buffers: {
        input: { ore: 12, crystals: 3 }, output: { metals: 4 },
        recipe: { id: "smelt", out: "metals", qty: 2, in: { ore: 2, energy: 2 }, kind: "refine" },
        inputCap: 40, outputCap: 60,
      },
    }));
    expect(withBuffers.inputs).toEqual([
      { com: "ore", qty: 12, cap: 40, fraction: 0.3 },
      { com: "crystals", qty: 3, cap: 40, fraction: 0.075 },
    ]);
    expect(withBuffers.outputs).toEqual([{ com: "metals", qty: 4, cap: 60, fraction: 4 / 60 }]);
  });

  it("offers pause and electrify only where they mean something", () => {
    // A Habitat has no recipe to pause. Offering the button anyway and having the engine ignore it
    // is the "button that does nothing" failure F-07 exists to prevent.
    expect(buildingPanelModel(snapshotWith({ type: "smelter" })).canPause).toBe(true);
    expect(buildingPanelModel(snapshotWith({ type: "habitat", recipe: -1 })).canPause).toBe(false);
  });

  it("is a pure function — the same snapshot gives the same model", () => {
    const snap = snapshotWith({ concern: CONCERN_STARVED });
    expect(buildingPanelModel(snap)).toEqual(buildingPanelModel(snap));
  });
});
