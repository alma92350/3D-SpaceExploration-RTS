// P2-T04 — every building in the game has a mesh, and the families read apart (ADR-0013).
//
// The first test is the one that stops a silent regression: upstream can add a building type, and
// without this the new type falls through `meshIdForType`'s default and renders as a worker-sized
// block. Nothing else in the suite would notice — it would look like a small building.
//
// The second is the honest, weaker stand-in for the legibility playtest that ADR-0011 defers. It
// cannot tell whether a shape *reads*; it can tell whether two shapes are the same shape, which is
// the failure a person would spot instantly and which no other test here would catch.

import { describe, expect, it } from "vitest";
import { BUILDING_FAMILY, MESH_IDS, TRIANGLE_BUDGET, buildMeshes, meshIdForType } from "../../src/view/meshes/generators.js";
import { BUILDINGS } from "../../src/engine/index.js";

const meshes = buildMeshes();
const byId = new Map(meshes.map((m) => [m.id, m]));

describe("the building mesh set", () => {
  it("has a mesh for every building type the engine defines", () => {
    const unmapped = Object.keys(BUILDINGS).filter((type) => !BUILDING_FAMILY[type]);
    expect(
      unmapped,
      `these building types would silently render as a fallback block:\n  ${unmapped.join(", ")}\n` +
      `Add each to BUILDING_FAMILY in src/view/meshes/generators.ts.`,
    ).toEqual([]);
  });

  it("routes every building type to a mesh that was actually built", () => {
    for (const type of Object.keys(BUILDINGS)) {
      const id = meshIdForType(type);
      expect(byId.has(id), `${type} → ${id}, which is not in the built mesh set`).toBe(true);
    }
  });

  it("keeps the draw-call ceiling reachable: at most 14 building meshes (ADR-0013)", () => {
    // 14 × 2 owners is ADR-0012's 28. One more mesh is two more draw calls, and the budget is the
    // thing ADR-0006 says is never negotiated away quietly — so it is negotiated away loudly here.
    const buildingMeshes = new Set(Object.keys(BUILDINGS).map(meshIdForType));
    expect(buildingMeshes.size).toBeLessThanOrEqual(14);
  });

  it("keeps every mesh inside its declared triangle budget", () => {
    for (const mesh of meshes) {
      const budget = TRIANGLE_BUDGET[mesh.id];
      expect(budget, `${mesh.id} has no declared budget`).toBeDefined();
      expect(mesh.triangles, `${mesh.id} is over budget`).toBeLessThanOrEqual(budget!);
    }
  });

  it("builds identical geometry every time", () => {
    // Determinism is not a nicety here: the perf baseline and the render-contract tests both
    // compare against numbers produced by an earlier run of these generators.
    const again = buildMeshes();
    for (const mesh of meshes) {
      const twin = again.find((m) => m.id === mesh.id)!;
      expect(Array.from(twin.positions)).toEqual(Array.from(mesh.positions));
    }
  });

  it("gives the six families silhouettes that differ from each other", () => {
    // A proxy for legibility, and named as one. It compares the profile — footprint radius, height,
    // and the width at three heights — because that is what survives at 210 units of camera
    // distance. Two families whose profiles match within 10% would be indistinguishable on the
    // field however different their vertices are.
    const families = [...new Set(Object.values(BUILDING_FAMILY))];
    const profiles = new Map(families.map((id) => [id, profileOf(byId.get(id)!)]));

    for (let i = 0; i < families.length; i++) {
      for (let j = i + 1; j < families.length; j++) {
        const a = profiles.get(families[i]!)!;
        const b = profiles.get(families[j]!)!;
        const distance = a.reduce((sum, v, k) => sum + Math.abs(v - b[k]!) / Math.max(v, b[k]!, 1e-6), 0) / a.length;
        expect(
          distance,
          `${families[i]} and ${families[j]} have the same profile — they would look identical on the field`,
        ).toBeGreaterThan(0.1);
      }
    }
  });

  it("makes the four landmarks the tallest things on the field", () => {
    // The buildings a player navigates by have to win the skyline, or navigating by them fails.
    const landmarks = ["port", "civic", "plasmarig", "gate"];
    const ordinary = MESH_IDS.filter((id) => !landmarks.includes(id) && byId.get(id)!.height > 0
      && !["command", "imposter", "node"].includes(id));
    const shortestLandmark = Math.min(...landmarks.map((id) => byId.get(id)!.height));
    const tallestOrdinary = Math.max(...ordinary.map((id) => byId.get(id)!.height));
    expect(shortestLandmark, "a landmark must stand above the ordinary roofline").toBeGreaterThan(tallestOrdinary);
  });
});

/** Footprint radius, height, and width at 25/50/75% of height — what a silhouette is, numerically. */
function profileOf(mesh: { positions: Float32Array; radius: number; height: number }): number[] {
  const widths = [0.25, 0.5, 0.75].map((f) => {
    const y = mesh.height * f;
    let widest = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      // A band around the sample height, so a mesh with few horizontal edges still registers.
      if (Math.abs(mesh.positions[i + 1]! - y) > mesh.height * 0.15) continue;
      widest = Math.max(widest, Math.hypot(mesh.positions[i]!, mesh.positions[i + 2]!));
    }
    return widest;
  });
  return [mesh.radius, mesh.height, ...widths];
}
