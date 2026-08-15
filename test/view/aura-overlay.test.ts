// P3-T04 in the frame, and the half of P3-T03 it settles.
//
// Three of the four static defences share the `fortress` mesh — `bastille`, `torpedobattery` and
// `aegisbastion` — and the buildings draw-call cap is a hard, hand-written 28 sitting at exactly 28
// (ADR-0012 §3, ADR-0013). So the Aegis Bastion cannot be told apart by giving it a mesh; there is
// no slot, and taking one would need an ADR arguing against the number the cap exists to defend.
//
// The aura settles it instead, and settles it *better*: the ring is not an arbitrary badge meaning
// "this one is different", it is the building's actual function drawn at the engine's own radius.
// One overlay layer for the whole frame, against two batches a mesh would have cost.
//
// The last test here is deliberately an admission rather than a pass.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes, meshIdForType } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { OVERLAY_STRIDE } from "../../src/view/renderer/port.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { BUILDINGS, activeState, createGalaxy, makeBuilding } from "../../src/engine/index.js";

const SEED = 20260814;
const LADDER = ["turret", "bastille", "torpedobattery", "aegisbastion"] as const;

/** A base with one of each static defence, rendered once. */
function ladderScene() {
  const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const base = state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  state.buildings.set(cc.id, cc);

  const placed = new Map<string, Building>();
  LADDER.forEach((type, i) => {
    const b = makeBuilding(type, "player", base.x + 60 + i * 44, base.y + 40);
    state.buildings.set(b.id, b);
    placed.set(type, b);
  });
  // `collectAnvils` runs inside the tick, so the aura list only exists after one.
  state.anvils = [...state.buildings.values()]
    .filter((b) => BUILDINGS[b.type]?.guardAura && !b.constructing)
    .map((b) => ({
      id: b.id, owner: b.owner, x: b.x, y: b.y,
      range: BUILDINGS[b.type]!.guardAura!.range,
      mult: BUILDINGS[b.type]!.guardAura!.damageTakenMult,
    }));

  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);
  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  renderer.setFog(snap.fog);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x + 100, base.y + 40);
  new SceneComposer(field).compose(
    renderer, snap, rig.update(1280, 720), TIERS.T2,
    buildTerrainMesh(field, { relief: true, apron: 0 }), 0, null,
  );
  return { renderer, placed };
}

function auraNear(renderer: RecordingRenderer, b: Building): number | null {
  const layer = renderer.lastFrame.overlays.find((o) => o.kind === "aura");
  if (!layer) return null;
  const stride = OVERLAY_STRIDE.aura;
  for (let i = 0; i < layer.count; i++) {
    const off = i * stride;
    if (Math.abs(layer.data[off]! - b.x) > 0.01) continue;
    if (Math.abs(layer.data[off + 2]! - b.y) > 0.01) continue;
    return layer.data[off + 3]!;
  }
  return null;
}

describe("the guard aura in a composed frame", () => {
  it("draws a ring at the engine's radius, on the building that has no attack", () => {
    const { renderer, placed } = ladderScene();
    const bastion = placed.get("aegisbastion")!;
    expect(BUILDINGS.aegisbastion!.attack, "the premise: this building does not shoot").toBeUndefined();
    expect(auraNear(renderer, bastion), "no aura ring reached the frame")
      .toBe(BUILDINGS.aegisbastion!.guardAura!.range);
  });

  it("draws no ring around anything that shoots", () => {
    const { renderer, placed } = ladderScene();
    for (const type of ["turret", "bastille", "torpedobattery"] as const) {
      expect(BUILDINGS[type]!.attack, `${type} should be armed`).toBeGreaterThan(0);
      expect(auraNear(renderer, placed.get(type)!), `${type} drew an aura it does not have`).toBeNull();
    }
  });

  it("costs one draw call for the whole frame, not one per aura", () => {
    // The reason this is an overlay rather than a mesh: the buildings cap is at 28 of 28, and a
    // per-state mesh would need an ADR arguing against the number that cap exists to defend.
    const { renderer } = ladderScene();
    const auraLayers = renderer.lastFrame.overlays.filter((o) => o.kind === "aura");
    expect(auraLayers.length).toBe(1);
    expect(auraLayers[0]!.count).toBeGreaterThan(0);
  });

  it("adds no instance batch at all", () => {
    // A ring is geometry a naive implementation would push as a mesh. The whole argument for the
    // overlay is that it does not, so it is asserted rather than assumed.
    const { renderer } = ladderScene();
    const buildingBatches = new Set(
      renderer.lastFrame.batches
        .filter((b) => (["fortress", "turret"] as string[]).includes(b.mesh))
        .map((b) => `${b.mesh}|${b.owner}|${b.lod}`),
    );
    // Two meshes, one owner: the four defences cost two batches between them, aura or no aura.
    expect(buildingBatches.size).toBe(2);
  });

  it("records what the ladder still does NOT distinguish (P3-T03 is not closed)", () => {
    // An admission, kept as a test so it cannot quietly stop being true. The Aegis Bastion is now
    // readable — it wears a ring nothing else does. The Bastille and the Torpedo Battery are still
    // the same shape as each other: 32 damage at 115 range against 55 at 180, ammo-fed, one mesh.
    //
    // If a future change gives either its own mesh this test fails, which is the intent: closing
    // that gap costs two batches against a cap at exactly 28, and it should not happen by accident.
    const sharing = LADDER.filter((t) => meshIdForType(t) === "fortress");
    expect(
      sharing,
      "the fortress family changed — if a defence gained its own mesh, check the 28 cap and P3-T03",
    ).toEqual(["bastille", "torpedobattery", "aegisbastion"]);

    const armedSharers = sharing.filter((t) => (BUILDINGS[t]!.attack ?? 0) > 0);
    expect(
      armedSharers,
      "two armed static defences still share one silhouette and differ only in reach — " +
      "the aura closed the Aegis Bastion's half of P3-T03, not this half",
    ).toEqual(["bastille", "torpedobattery"]);
  });
});
