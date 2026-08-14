// P1-T08, Node half — the conformance suite against the implementations that need no GPU.
//
// The browser half (`e2e/conformance.spec.ts`) runs the identical suite against all three
// implementations under a real rasteriser. This one runs in a second, on every save, against the
// recording fake — which is what makes the suite part of the red-green loop rather than something
// you find out about after a two-minute browser run.

import { describe, expect, it } from "vitest";
import { runConformance } from "../../src/view/renderer/conformance.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";

const meshes = buildMeshes();

describe("RecordingRenderer conformance", () => {
  const cases = runConformance({ create: () => new RecordingRenderer(), meshes });

  it("runs a suite worth having", () => {
    expect(cases.length).toBeGreaterThan(8);
  });

  for (const c of cases) {
    it(c.name, () => {
      expect(c.ok, c.detail).toBe(true);
    });
  }
});

describe("the fake is stricter than the real thing, not looser", () => {
  // A fake that forgives what a real renderer would not is a fake that teaches the wrong lesson —
  // tests pass, the browser breaks. These are the misuses it must refuse.
  it("refuses a draw outside a frame", () => {
    const r = new RecordingRenderer();
    r.registerMeshes(meshes);
    expect(() => r.drawTerrain({
      positions: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0),
      triangles: 0, version: 1, width: 1, height: 1,
    })).toThrow(/outside a frame/);
  });

  it("refuses a second beginFrame without an endFrame", () => {
    const r = new RecordingRenderer();
    r.beginFrame(camera());
    expect(() => r.beginFrame(camera())).toThrow(/call order/);
  });

  it("refuses an unregistered mesh", () => {
    const r = new RecordingRenderer();
    r.registerMeshes(meshes);
    r.beginFrame(camera());
    expect(() => r.drawInstances({
      mesh: "not-a-mesh", owner: 0, lod: 0, count: 1,
      xyz: new Float32Array(3), yaw: new Float32Array(1), scale: new Float32Array(1), shade: new Float32Array(1),
    })).toThrow(/unregistered mesh/);
  });

  it("refuses an empty instanced batch", () => {
    // An empty draw call still costs a state change. The composer must skip it, not submit it.
    const r = new RecordingRenderer();
    r.registerMeshes(meshes);
    r.beginFrame(camera());
    expect(() => r.drawInstances({
      mesh: meshes[0]!.id, owner: 0, lod: 0, count: 0,
      xyz: new Float32Array(0), yaw: new Float32Array(0), scale: new Float32Array(0), shade: new Float32Array(0),
    })).toThrow(/empty batch/);
  });

  it("refuses an overlay packed at the wrong stride", () => {
    const r = new RecordingRenderer();
    r.beginFrame(camera());
    expect(() => r.drawOverlay({
      kind: "healthbar", count: 1, stride: 3, data: new Float32Array(3),
    })).toThrow(/stride/);
  });

  it("refuses a fog upload mid-frame", () => {
    const r = new RecordingRenderer();
    r.beginFrame(camera());
    expect(() => r.setFog({ cols: 1, rows: 1, cell: 40, state: new Uint8Array(1), version: 1 }))
      .toThrow(/per tick/);
  });
});

function camera() {
  return {
    viewProj: new Float32Array(16),
    eyeX: 0, eyeY: 100, eyeZ: 0,
    targetX: 0, targetY: 0,
    yaw: 0, pitch: 1, distance: 100,
    viewportWidth: 1280, viewportHeight: 720,
  };
}
