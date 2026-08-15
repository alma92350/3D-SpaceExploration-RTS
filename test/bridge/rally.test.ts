// P5-T15 — PARITY row 8: rally lines, where the client had every part except the line.
//
// The `rally` overlay kind has been in `renderer/port.ts` since Phase 1 and BOTH product renderers
// draw it; the only caller was `view/landing.ts`, drawing to a landing point. `building.rally` is
// on every building the engine mints, `issueSetRally` writes it and `updateProduction` reads it
// fresh at every spawn — and nothing between the two ever crossed the bridge.
//
// The three filters (the viewer's own, producers only, selected only) are the whole design, so most
// of this file is about them. The one that is not ours is `produces`: upstream states it in its own
// data, five building defs over, and this file asks the engine's table rather than repeating it.

import { describe, expect, it } from "vitest";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { BUILDINGS, issueSetRally, makeBuilding } from "../../src/engine/index.js";

const SEED = 20260814;

function world() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);
  return { bridge, base, cc };
}

/** Every building type the engine will let train something — asked, never listed. */
const PRODUCERS = Object.keys(BUILDINGS)
  .filter((t) => (BUILDINGS[t] as { produces?: string[] }).produces?.length);

function select(bridge: WorldBridge, ...ids: string[]): void {
  bridge.state.selection.length = 0;
  for (const id of ids) bridge.state.selection.push(id);
  bridge.step(STEP_SECONDS);
}

describe("a rally line reaches the view at all", () => {
  it("runs from the selected producer to the point the engine will actually send units to", () => {
    const { bridge, cc } = world();
    select(bridge, cc.id);

    const r = bridge.snapshot.rally;
    expect(r.count, "the Command Center is selected and produces six unit types, and drew no line").toBe(1);
    expect(r.fromX[0]).toBeCloseTo(cc.x, 3);
    expect(r.fromY[0]).toBeCloseTo(cc.y, 3);
    // The engine's own field, not a re-derivation. `makeBuilding` mints it at (x+60, y+60) and
    // `updateProduction` walks every new unit there, so the default is a real destination rather
    // than a null — which is exactly why it is drawn rather than hidden until someone sets one.
    expect(r.toX[0], "the line does not end at `building.rally`").toBeCloseTo(cc.rally.x, 3);
    expect(r.toY[0]).toBeCloseTo(cc.rally.y, 3);
    expect(cc.rally.x, "the engine stopped seeding a default rally").toBeCloseTo(cc.x + 60, 3);
  });

  it("follows issueSetRally — the engine export row 8's trace names", () => {
    const { bridge, cc } = world();
    select(bridge, cc.id);
    const before = { x: bridge.snapshot.rally.toX[0]!, y: bridge.snapshot.rally.toY[0]! };

    issueSetRally(bridge.state.buildings.get(cc.id)!, cc.x - 200, cc.y + 140);
    bridge.step(STEP_SECONDS);

    const r = bridge.snapshot.rally;
    expect(r.count, "the line vanished when the rally moved").toBe(1);
    expect(r.toX[0], "the line still points at the old rally point").toBeCloseTo(cc.x - 200, 3);
    expect(r.toY[0]).toBeCloseTo(cc.y + 140, 3);
    expect(Math.hypot(r.toX[0]! - before.x, r.toY[0]! - before.y), "the rally never moved at all")
      .toBeGreaterThan(50);
  });

  it("carries one line per selected producer, and drops with the selection", () => {
    const { bridge, base, cc } = world();
    const barracks = makeBuilding("barracks", "player", base.x + 80, base.y + 40);
    bridge.state.buildings.set(barracks.id, barracks);

    select(bridge, cc.id, barracks.id);
    expect(bridge.snapshot.rally.count, "two selected producers, two lines").toBe(2);

    select(bridge);
    expect(
      bridge.snapshot.rally.count,
      "a line survived the selection being cleared — every building carries a rally from birth, so " +
      "an unselected base would draw one diagonal stub per factory and say nothing",
    ).toBe(0);
  });
});

describe("the three filters", () => {
  it("draws nothing for a building that does not train units, per the engine's own table", () => {
    // Upstream states this rule in its data: `refinery`, `habitat`, `foundry`, `market` and
    // `datacenter` each carry a comment saying that having no `produces` keeps them "out of the
    // rally-point UI and rally rendering". Swept over every type rather than spot-checked, because
    // a hand-written list of producers is precisely what P4-T14 deleted from the build menu.
    const { bridge, base } = world();
    expect(PRODUCERS.length, "no building in the roster produces anything").toBeGreaterThan(0);
    expect(PRODUCERS.length, "every building type produces — there is no filter left to test")
      .toBeLessThan(Object.keys(BUILDINGS).length);

    let i = 0;
    for (const type of Object.keys(BUILDINGS)) {
      const b = makeBuilding(type, "player", base.x - 300 + (i % 12) * 40, base.y + 200 + Math.floor(i / 12) * 40);
      bridge.state.buildings.set(b.id, b);
      select(bridge, b.id);
      expect(
        bridge.snapshot.rally.count,
        PRODUCERS.includes(type)
          ? `${type} trains ${(BUILDINGS[type] as { produces?: string[] }).produces!.join(", ")} and drew no rally line`
          : `${type} trains nothing and drew a rally line anyway — the engine's own defs say a ` +
            `building with no \`produces\` stays out of rally rendering`,
      ).toBe(PRODUCERS.includes(type) ? 1 : 0);
      bridge.state.buildings.delete(b.id);
      i++;
    }
  });

  it("draws nothing for an ENEMY producer, even one the player has selected", () => {
    // `applySelect` accepts any entity a player can click, and buildings cross this bridge on
    // EXPLORED memory — so without the ownership filter an hour-old scouting pass keeps a live line
    // running out of an enemy factory, naming where their reinforcements will arrive.
    const { bridge, base } = world();
    const theirs = makeBuilding("barracks", "ai", base.x + 100, base.y);
    bridge.state.buildings.set(theirs.id, theirs);
    select(bridge, theirs.id);

    expect(bridge.state.selection, "the enemy barracks was refused by the selection itself, so this " +
      "test is not exercising the ownership filter").toContain(theirs.id);
    let onSnapshot = false;
    const e = bridge.snapshot.entities;
    for (let i = 0; i < e.count; i++) if (e.ids[i] === -Number(theirs.id.slice(1)) - 1) onSnapshot = true;
    expect(onSnapshot, "the enemy barracks is not even in the snapshot, so nothing is being filtered")
      .toBe(true);
    expect(
      bridge.snapshot.rally.count,
      "an enemy producer's rally point crossed the bridge — that is where their next wave gathers",
    ).toBe(0);
  });

  it("ignores selected UNITS, which have no rally at all", () => {
    const { bridge, cc } = world();
    const worker = [...bridge.state.units.values()].find((u) => u.owner === "player");
    expect(worker, "the opening has no player unit to select").toBeDefined();
    select(bridge, worker!.id);
    expect(bridge.snapshot.rally.count).toBe(0);

    // …and a mixed selection still draws the producer's, rather than giving up on the whole list.
    select(bridge, worker!.id, cc.id);
    expect(bridge.snapshot.rally.count, "a unit in the selection suppressed the building's line").toBe(1);
  });
});

describe("the rally table keeps the snapshot's contracts", () => {
  it("allocates nothing once it has grown to the selection", () => {
    const { bridge, base } = world();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const b = makeBuilding("barracks", "player", base.x - 200 + i * 30, base.y + 120);
      bridge.state.buildings.set(b.id, b);
      ids.push(b.id);
    }
    select(bridge, ...ids);
    expect(bridge.snapshot.rally.count).toBe(12);

    const before = bridge.snapshot.rally.fromX;
    for (let t = 0; t < 40; t++) bridge.step(STEP_SECONDS);
    expect(bridge.snapshot.rally.count).toBe(12);
    expect(bridge.snapshot.rally.fromX, "the rally table reallocated on a steady selection").toBe(before);
  });

  it("is rebuilt every tick rather than accumulated", () => {
    const { bridge, cc } = world();
    for (let t = 0; t < 20; t++) select(bridge, cc.id);
    expect(bridge.snapshot.rally.count, "lines accumulated across ticks").toBe(1);
  });
});
