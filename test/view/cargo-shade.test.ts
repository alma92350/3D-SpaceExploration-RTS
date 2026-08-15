// P2-T05 (the cargo half) — a laden hauler reads as laden, and costs nothing to say so.
//
// The whole point is the second half of that sentence. A second "laden" mesh would be the obvious
// implementation and it would cost a draw call per owner for a cue that is a single number; the
// instance batch already carries a per-instance `shade`, which is exactly the knob ADR-0006 says
// to reach for ("uniqueness comes from instance attributes, not per-entity materials").
//
// So the assertion is a pair: the laden unit must LOOK different, and the batch count must NOT
// change. Either half alone would pass a wrong implementation.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { SnapshotExtractor } from "../../src/bridge/snapshot.js";
import { activeState, createGalaxy, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;

/** One hauler at the base, carrying `qty` of ore (0 for empty). */
function render(qty: number) {
  const state = activeState(createGalaxy({ seed: SEED, startId: "helix" }));
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const base = state.map.bases.player;

  const hauler = makeUnit("hauler", "player", base.x, base.y);
  // `cargo` is the engine's own shape — a commodity and a quantity. The snapshot turns it into
  // FLAG_CARRYING plus a 0..1 fullness, which is what the view sees.
  hauler.cargo = { com: qty > 0 ? "ore" : null, qty };
  state.units.set(hauler.id, hauler);

  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);

  const snap = new SnapshotExtractor(state.map)
    .extract(state, { viewer: "player", credits: 0, supplyUsed: 0, supplyCap: 0 });
  renderer.setFog(snap.fog);

  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x, base.y);
  const terrain = buildTerrainMesh(field, { relief: true, apron: 0 });
  new SceneComposer(field).compose(renderer, snap, rig.update(1280, 720), TIERS.T2, terrain, 0, null);

  const batch = renderer.lastFrame.batches.find((b) => b.mesh === "freighter");
  return { renderer, batch, snap };
}

describe("a laden hauler", () => {
  it("is drawn with a different shade from an empty one", () => {
    const empty = render(0);
    const laden = render(10);

    expect(empty.batch, "the hauler should be drawn with the freighter hull").toBeDefined();
    expect(laden.batch).toBeDefined();
    expect(
      laden.batch!.shade[0],
      "a laden hauler looks identical to an empty one — the cargo cue is not reaching the instance",
    ).not.toBeCloseTo(empty.batch!.shade[0]!, 5);
  });

  it("costs no extra draw call to say so", () => {
    // The half that makes the first half worth having. A "laden" mesh would pass the test above
    // and fail this one, which is exactly the implementation this is written to rule out.
    const empty = render(0);
    const laden = render(10);
    const keys = (r: typeof empty) =>
      new Set(r.renderer.lastFrame.batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));

    expect(keys(laden).size, "carrying cargo added a batch").toBe(keys(empty).size);
  });

  it("scales with how full the hold is, not just whether it is carrying", () => {
    // The snapshot carries a 0..1 fullness, and throwing it away for a boolean would lose the
    // difference between a hauler on its way home and one that has barely started.
    const light = render(2);
    const full = render(10);
    expect(light.batch!.shade[0]).not.toBeCloseTo(full.batch!.shade[0]!, 5);
  });

  it("leaves buildings alone — construction still owns the shade there", () => {
    // Construction progress already drives shade for buildings (P1-T09). Cargo must not fight it.
    const { renderer } = render(10);
    const command = renderer.lastFrame.batches.find((b) => b.mesh === "command");
    if (command) expect(command.shade[0]).toBeCloseTo(1, 5);
  });
});
