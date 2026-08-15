// P5-T05 / P5-T06 — the Gate race and the conquest count, held against what the starmap already draws.
//
// The rival Gate is the one alert the ENGINE raises for itself. `galaxyStatus().rivalGate` is
// commented "starmap alert" upstream, `bridge/galaxy-snapshot.ts` copies it into `rivalGateIndex` and
// `rivalGateCharge`, and `view/starmap.ts`'s `alertForWorld` turns that index into the mark on the
// plate. So there is already a surface saying who is charging a Gate, and a panel that answered the
// same question from its own scan would be a second source that agrees until it does not.
//
// This file is the proof that there is only one source. Every scenario below builds the galaxy
// snapshot and the panel model from the SAME galaxy and asserts they say the same thing — the same
// world, the same charge, and the same nothing when there is nothing. It also asserts the conquest
// numbers the milestones panel shows are the ones the starmap already counts with.
//
// And it pins the one place where the two surfaces are honestly different, because that difference
// is the row's finding rather than a defect: when a rival Gate COMPLETES, `checkRivalGate` ascends
// the world and clears its own tracked record, so the snapshot's alert goes away. The map cannot
// distinguish "the race was lost" from "there was never a race". The panel reports `rivalAscended`,
// which is the engine's own latch, and that is the only thing on either surface that can.
//
// The trap this file is arranged against: a comparison that passes because both sides are empty.
// Every "they agree that there is none" assertion sits next to the same galaxy where they agree
// there IS one, and the charge is a value neither side could have guessed.

import { describe, expect, it } from "vitest";
import {
  checkDomination, checkRivalGate, createGalaxy, makeBuilding,
} from "../../src/engine/index.js";
import { GalaxySnapshotExtractor, NO_WORLD, type GalaxySnapshot } from "../../src/bridge/galaxy-snapshot.js";
import { ALERT_NONE, ALERT_RIVAL_GATE, alertForWorld } from "../../src/view/starmap.js";
import { gatePanelModel } from "../../src/ui/gate-panel.js";
import { milestonesPanelModel } from "../../src/ui/milestones-panel.js";

const SEED = 20260815;
const HOME = "helix";

const snapshotOf = (g: Galaxy): GalaxySnapshot => new GalaxySnapshotExtractor().extract(g);

/** Raise an AI Gate on `worldId` at `charge`. `charge` is undeclared on `Building` — a narrow cast. */
function rivalGateOn(g: Galaxy, worldId: string, charge: number): Building {
  const state = g.planets.get(worldId)!;
  const b = makeBuilding("antimatter_gate", "ai", 720, 520);
  (b as unknown as { charge: number }).charge = charge;
  state.buildings.set(b.id, b);
  return b;
}

function razeAiCommand(state: State): void {
  for (const [id, b] of [...state.buildings]) if (b.owner === "ai" && b.type === "command") state.buildings.delete(id);
  for (const [id, u] of [...state.units]) if (u.owner === "ai" && u.type === "colonyship") state.units.delete(id);
}

/** Which world the STARMAP is alerting on, by id, or null. Read back through the view's own function. */
function alertedWorld(snap: GalaxySnapshot): string | null {
  let found: string | null = null;
  for (let i = 0; i < snap.worlds.count; i++) {
    if (alertForWorld(snap, i) !== ALERT_RIVAL_GATE) continue;
    expect(found, "the starmap raised two rival-Gate alerts at once").toBeNull();
    found = snap.worlds.ids[i]!;
  }
  return found;
}

/* =================================================================================================
   THE RIVAL GATE — one source, two surfaces
   ================================================================================================= */

describe("the Gate panel and the starmap read the same rival Gate (P5-T05)", () => {
  it("agree on the world and on the charge, with a charge neither could have guessed", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    g.discovered.add("glacius");
    rivalGateOn(g, "glacius", 0.37);
    checkRivalGate(g);

    const snap = snapshotOf(g);
    const model = gatePanelModel(g);

    expect(snap.rivalGateIndex, "the rival Gate did not cross the bridge").not.toBe(NO_WORLD);
    expect(model.rival, "the rival Gate did not reach the panel").not.toBeNull();
    expect(snap.worlds.ids[snap.rivalGateIndex], "panel and starmap named different worlds")
      .toBe(model.rival!.worldId);
    expect(snap.rivalGateCharge, "panel and starmap disagree about how far along it is")
      .toBeCloseTo(model.rival!.charge, 9);
    expect(model.rival!.charge).toBeCloseTo(0.37, 9);
    expect(alertedWorld(snap), "the plate is marking a different world from the panel")
      .toBe(model.rival!.worldId);
  });

  it("agree on a world the player has never reached — the alert is not fog-gated", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    expect(g.discovered.has("ferros"), "the fixture is not testing an undiscovered world").toBe(false);
    rivalGateOn(g, "ferros", 0.62);
    checkRivalGate(g);

    const snap = snapshotOf(g);
    const model = gatePanelModel(g);
    expect(alertedWorld(snap)).toBe("ferros");
    expect(model.rival!.worldId).toBe("ferros");
    expect(snap.rivalGateCharge).toBeCloseTo(model.rival!.charge, 9);
  });

  it("agree there is none, on a galaxy where they agreed there was one a moment earlier", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });
    const gate = rivalGateOn(g, "ferros", 0.5);
    checkRivalGate(g);
    expect(alertedWorld(snapshotOf(g))).toBe("ferros");
    expect(gatePanelModel(g).rival).not.toBeNull();

    // Razed. The engine's tracked record is stale until the next scan; both surfaces go quiet now.
    g.planets.get("ferros")!.buildings.delete(gate.id);

    const snap = snapshotOf(g);
    expect(snap.rivalGateIndex).toBe(NO_WORLD);
    expect(snap.rivalGateCharge).toBe(0);
    expect(alertedWorld(snap)).toBeNull();
    expect(gatePanelModel(g).rival, "the panel kept alerting on rubble the starmap had dropped").toBeNull();
  });

  it("agree on WHICH rival, when the engine has two to choose between", () => {
    // `korrath` is roster index 0 and charging harder; `glacius` is more developed, and development
    // is what `checkRivalGate` selects on. Both surfaces must name the engine's choice.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    for (let i = 0; i < 6; i++) {
      const b = makeBuilding("reactor", "ai", 700 + i * 40, 400);
      g.planets.get("glacius")!.buildings.set(b.id, b);
    }
    rivalGateOn(g, "korrath", 0.9);
    rivalGateOn(g, "glacius", 0.05);
    checkRivalGate(g);

    const snap = snapshotOf(g);
    const model = gatePanelModel(g);
    expect(model.rival!.worldId).toBe("glacius");
    expect(alertedWorld(snap), "the starmap marked a world the panel did not").toBe("glacius");
    expect(snap.rivalGateCharge).toBeCloseTo(0.05, 9);
    // The louder Gate is not alerted on, on either surface.
    const korrath = snap.worlds.ids.indexOf("korrath");
    expect(alertForWorld(snap, korrath)).toBe(ALERT_NONE);
  });

  it("the alert disappears when the rival WINS, and only the panel still says what happened", () => {
    // The finding. `checkRivalGate` nulls its own tracked record on ascension, so the starmap's
    // alert — which IS that field — stops being drawn at the exact moment it mattered most.
    const g = createGalaxy({ seed: SEED, startId: HOME });
    g.discovered.add("ferros");
    const gate = rivalGateOn(g, "ferros", 0.95);
    checkRivalGate(g);
    expect(alertedWorld(snapshotOf(g))).toBe("ferros");

    (gate as unknown as { charge: number }).charge = 1;
    checkRivalGate(g);

    const snap = snapshotOf(g);
    const model = gatePanelModel(g);

    // The map now looks exactly like a galaxy in which nobody ever built one.
    expect(snap.rivalGateIndex).toBe(NO_WORLD);
    expect(alertedWorld(snap)).toBeNull();
    expect(model.rival, "the panel must agree with the engine that nothing is tracked").toBeNull();

    // …and the panel carries the state the map structurally cannot.
    expect(model.rivalAscended, "the race was lost and no surface said so").toBe(true);
    expect(model.ascendedWorlds).toEqual(["ferros"]);
    expect(milestonesPanelModel(g).named.find((r) => r.id === "rival-gate")!.reached,
      "the engine's own `rival-gate` milestone did not reach the milestones panel").toBe(true);

    // A galaxy where nobody ever raced looks the same on the map and different in the panel.
    const quiet = createGalaxy({ seed: SEED, startId: HOME });
    expect(snapshotOf(quiet).rivalGateIndex).toBe(NO_WORLD);
    expect(gatePanelModel(quiet).rivalAscended, "an untouched galaxy claims an ascension").toBe(false);
  });
});

/* =================================================================================================
   DOMINATION — the same count the starmap already carries
   ================================================================================================= */

describe("the milestones panel counts conquest with the starmap's own numbers (P5-T06)", () => {
  it("reports the bridge's pacified count and target, and moves with them", () => {
    const g = createGalaxy({ seed: SEED, startId: HOME });

    const empty = snapshotOf(g);
    expect(milestonesPanelModel(g).domination.pacified).toBe(empty.pacifiedCount);
    expect(milestonesPanelModel(g).domination.target).toBe(empty.dominationTarget);

    razeAiCommand(g.planets.get("korrath")!);
    razeAiCommand(g.planets.get("glacius")!);
    checkDomination(g);

    const snap = snapshotOf(g);
    const d = milestonesPanelModel(g).domination;
    expect(snap.pacifiedCount, "the fixture pacified nothing").toBe(2);
    expect(d.pacified, "the panel counted conquest differently from the starmap").toBe(snap.pacifiedCount);
    expect(d.target).toBe(snap.dominationTarget);
    expect(d.totalWorlds).toBe(snap.worlds.count);
    // …and the worlds it names are the ones the starmap marks pacified.
    const marked = snap.worlds.ids.filter((_, i) => snap.worlds.pacified[i] === 1);
    expect(marked, "the starmap's own pacified column is empty — this comparison proves nothing")
      .toHaveLength(2);
    expect(d.worlds, "the panel's pacified worlds are not the starmap's").toEqual(marked);
  });
});
