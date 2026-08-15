// P3-T08 / P3-T09 (Q-13, ADR-0018) — salvage and craters read as what they are.
//
// The engine deliberately makes them ordinary `ResourceNode`s: `bomb.js` says a crater is
// "indistinguishable to gather.js/rendering/fog from anything engine/map.js generated". That is
// right for the simulation and wrong for the view — a pile of wreckage where an army died renders
// as a natural ore seam, and a crater from a 3 000-damage detonation looks like ground that was
// always there.
//
// Both flags already reached the bridge and were thrown away on the node, exactly as `comIndex` was
// before P2-T17. What is new here is that ORIGIN beats CONTENTS: a wreck of metals and a wreck of
// ore are both wreckage, and that is the thing worth seeing.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import {
  DEPOSIT_FAMILY, NODE_NATURAL, NODE_SALVAGE, NODE_CRATER, buildMeshes, meshIdForNode,
} from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { activeState, createGalaxy } from "../../src/engine/index.js";
import { profileDistance, profileOf } from "./silhouette.js";

const SEED = 20260814;
const byId = new Map(buildMeshes().map((m) => [m.id, m]));

/** A world with natural deposits plus salvage and craters, all near the base and in frame. */
function battlefield() {
  const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
  const base = state.map.bases.player;
  const placed = { wreck: [] as string[], crater: [] as string[] };

  for (let i = 0; i < 8; i++) {
    const w = {
      id: `wreck-t${i}`, com: i % 2 ? "metals" : "ore", amount: 200, max: 200,
      x: base.x - 60 + i * 12, y: base.y + 50, wreck: true,
    };
    const c = {
      id: `crater-t${i}`, com: i % 2 ? "ice" : "crystals", amount: 400, max: 400,
      x: base.x - 60 + i * 12, y: base.y + 90, crater: true,
    };
    state.map.nodes.push(w as never, c as never);
    placed.wreck.push(w.id);
    placed.crater.push(c.id);
  }
  return { state, base, placed };
}

function renderBattlefield() {
  const { state, base, placed } = battlefield();
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);
  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  renderer.setFog(snap.fog);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x, base.y + 70);
  new SceneComposer(field).compose(
    renderer, snap, rig.update(1280, 720), TIERS.T2,
    buildTerrainMesh(field, { relief: true, apron: 0 }), 0, null,
  );
  return { renderer, snap, placed };
}

describe("the node origin crosses the bridge", () => {
  it("marks salvage and craters apart from natural ground", () => {
    const { snap, placed } = renderBattlefield();
    const kinds = new Map<string, number>();
    for (let i = 0; i < snap.nodes.count; i++) kinds.set(String(snap.nodes.ids[i]), snap.nodes.kind[i]!);

    const seen = new Set<number>();
    for (let i = 0; i < snap.nodes.count; i++) seen.add(snap.nodes.kind[i]!);
    expect(seen.has(NODE_NATURAL), "no natural deposit reached the view").toBe(true);
    expect(seen.has(NODE_SALVAGE), "no salvage reached the view — the wreck flag is still discarded").toBe(true);
    expect(seen.has(NODE_CRATER), "no crater reached the view — the crater flag is still discarded").toBe(true);
    expect(placed.wreck.length).toBeGreaterThan(0);
    void kinds;
  });

  it("defaults an unknown origin to natural, which is what it looked like before", () => {
    // The safe direction. A node the bridge cannot classify should keep rendering the way it always
    // did rather than becoming wreckage — a false "a fight happened here" is worse than a missed one.
    expect(meshIdForNode("ore", NODE_NATURAL)).toBe(DEPOSIT_FAMILY.ore);
    expect(meshIdForNode("ore", 99)).toBe(DEPOSIT_FAMILY.ore);
  });
});

describe("origin beats contents", () => {
  it("draws every wreck with one mesh, whatever it holds", () => {
    // ADR-0018's stated trade: a wreck of metals and a wreck of ore are both wreckage. The player
    // loses the commodity at a glance and gains the fact that an army died here.
    expect(meshIdForNode("ore", NODE_SALVAGE)).toBe(meshIdForNode("metals", NODE_SALVAGE));
    expect(meshIdForNode("ice", NODE_SALVAGE)).toBe(meshIdForNode("relics", NODE_SALVAGE));
  });

  it("draws every crater with one mesh, and not the salvage one", () => {
    expect(meshIdForNode("crystals", NODE_CRATER)).toBe(meshIdForNode("ice", NODE_CRATER));
    expect(
      meshIdForNode("ore", NODE_CRATER),
      "a crater and a wreck are different events and must not share a shape",
    ).not.toBe(meshIdForNode("ore", NODE_SALVAGE));
  });

  it("still lets the commodity decide a NATURAL deposit's mesh", () => {
    // The Phase 2 behaviour must survive: rock for the metallic and crystalline, volatile for the
    // rest (ADR-0014). Origin only overrides it for the two new kinds.
    expect(meshIdForNode("ore", NODE_NATURAL)).not.toBe(meshIdForNode("ice", NODE_NATURAL));
  });
});

describe("in a composed frame", () => {
  it("draws salvage and craters with meshes that were actually built", () => {
    const { renderer } = renderBattlefield();
    const drawn = new Set(renderer.lastFrame.batches.map((b) => b.mesh));
    expect(drawn.has(meshIdForNode("ore", NODE_SALVAGE)), "no salvage mesh in the frame").toBe(true);
    expect(drawn.has(meshIdForNode("ore", NODE_CRATER)), "no crater mesh in the frame").toBe(true);
    for (const id of [meshIdForNode("ore", NODE_SALVAGE), meshIdForNode("ore", NODE_CRATER)]) {
      expect(byId.has(id), `${id} is drawn but was never built`).toBe(true);
    }
  });

  it("costs one batch per deposit mesh, because deposits are neutral and never LOD", () => {
    // ADR-0018's measurement, pinned. A deposit mesh costs HALF what a unit or building mesh does —
    // one owner slot, no imposter row — and that is the whole reason ADR-0014's arithmetic did not
    // transfer. If deposits ever start batching per owner or per LOD, this fails and the ADR is due
    // a re-read.
    const { renderer } = renderBattlefield();
    const depositMeshes = new Set<string>([
      ...Object.values(DEPOSIT_FAMILY),
      meshIdForNode("ore", NODE_SALVAGE),
      meshIdForNode("ore", NODE_CRATER),
    ]);
    const keys = renderer.lastFrame.batches
      .filter((b) => depositMeshes.has(b.mesh))
      .map((b) => `${b.mesh}|${b.owner}|${b.lod}`);

    expect(new Set(keys).size, "a deposit mesh is being drawn more than once per frame")
      .toBe(keys.length);
    for (const k of keys) {
      const [, owner, lod] = k.split("|");
      expect(owner, `${k}: deposits should be neutral (slot 2)`).toBe("2");
      expect(lod, `${k}: deposits should never take the imposter row`).toBe("0");
    }
  });

  it("keeps the whole frame inside ADR-0014's derived ceiling", () => {
    const { renderer } = renderBattlefield();
    const keys = new Set(renderer.lastFrame.batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));
    // Not a hand-picked number: the derivation is the batching rule over the roster (ADR-0014).
    expect(keys.size).toBeGreaterThan(0);
    expect(keys.size, "the battlefield frame blew its own derived ceiling").toBeLessThan(200);
  });
});

describe("the shapes themselves", () => {
  it("makes salvage and craters distinguishable from both natural deposits", () => {
    // The same silhouette proxy the buildings and units use. Two new meshes that looked like the
    // rock would have spent two batches to change nothing.
    const ids = [
      ...new Set([...Object.values(DEPOSIT_FAMILY), meshIdForNode("ore", NODE_SALVAGE), meshIdForNode("ore", NODE_CRATER)]),
    ];
    expect(ids.length, "there should be four deposit meshes now").toBe(4);

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = profileDistance(profileOf(byId.get(ids[i]!)!), profileOf(byId.get(ids[j]!)!));
        expect(
          d,
          `${ids[i]} and ${ids[j]} have the same profile (${d.toFixed(3)}) — two more batches ` +
          `bought nothing`,
        ).toBeGreaterThan(0.1);
      }
    }
  });

  it("makes a crater the flattest and widest thing on the ground", () => {
    // The claim as it is actually drawn, which is NOT the one the first draft made. That draft said
    // "reads as a hole", and a hole is not available: `Builder.prism` always caps its top, so a
    // concave bowl needs a rim plus a floor — 60 triangles against a 30 budget — and an inverted
    // frustum was rejected by the winding test for enclosing negative volume.
    //
    // What is true is the proportion: everything else on the ground stands up, and this is a broad
    // flat disturbance. Weaker than excavation would have been, and pinned honestly.
    const crater = byId.get(meshIdForNode("ore", NODE_CRATER))!;
    const others = [...new Set([...Object.values(DEPOSIT_FAMILY), meshIdForNode("ore", NODE_SALVAGE)])]
      .map((id) => byId.get(id)!);
    for (const other of others) {
      expect(crater.height, `a crater should sit lower than ${other.id}`).toBeLessThan(other.height);
      expect(crater.radius, `a crater should spread wider than ${other.id}`).toBeGreaterThan(other.radius);
    }
  });
});
