// Mesh winding: every face points outward (P1-T06).
//
// This test exists because the bug it catches is invisible to every other test in the project and
// obvious to anyone looking at the screen. The instance material culls back faces — worth real fill
// rate at T0 (ADR-0006) — so a face wound the wrong way is not drawn, and the model's far side
// shows through where its near side should be. Draw calls, triangle counts, budgets and the
// conformance suite are all perfectly green while a Command Center renders as four splayed petals.
//
// ADR-0009 accepts that "it looks wrong" is a hole covered by human review. This is the part of
// that hole that can be closed with arithmetic, so it is.

import { describe, expect, it } from "vitest";
import { buildMeshes } from "../../src/view/meshes/generators.js";

interface Face {
  normal: [number, number, number];
  centroid: [number, number, number];
}

function faces(mesh: { positions: Float32Array; indices: Uint16Array }): Face[] {
  const out: Face[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const p = (v: number): [number, number, number] =>
      [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
    const [ax, ay, az] = p(a);
    const [bx, by, bz] = p(b);
    const [cx, cy, cz] = p(c);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.push({
      normal: [nx / len, ny / len, nz / len],
      centroid: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
    });
  }
  return out;
}

const meshes = buildMeshes();

describe("mesh winding", () => {
  it("has meshes to check", () => {
    expect(meshes.length).toBeGreaterThan(9);
  });

  for (const mesh of meshes) {
    // A single open quad: it has no cap and encloses no volume, so neither check below applies. It
    // used to be skipped here as "a billboard the renderer faces", which was false — no renderer
    // ever faced it (P6-T07) — and its facing is now pinned by `lod-imposter.test.ts` instead,
    // which checks the same outward-normal definition this file uses.
    if (mesh.id === "imposter") continue;

    it(`${mesh.id}: no cap above the ground faces straight down`, () => {
      // An upward-facing surface wound backwards is the most common way to break a procedural
      // mesh, and the one that looks worst: the top of the model vanishes and you see its inside.
      //
      // The threshold is "straight down" (−0.98), not merely "downward", and that is deliberate: a
      // Skiff's hull sides slope under the wings and legitimately face down at −0.93. An inverted
      // box top or prism cap is exactly (0, −1, 0), so this catches the bug without outlawing a
      // shape. The volume check below is the independent second opinion.
      const offenders = faces(mesh).filter((f) => f.normal[1] < -0.98 && f.centroid[1] > 0.5);
      expect(
        offenders.map((f) => `y=${f.centroid[1].toFixed(1)} normal=${f.normal.map((n) => n.toFixed(2)).join(",")}`),
        `${mesh.id} has ${offenders.length} downward-facing triangles above the ground — the mesh is inside out`,
      ).toEqual([]);
    });

    it(`${mesh.id}: no face is wound so it faces the model's own axis`, () => {
      // The prism-side failure: side quads wound the wrong way point INTO the barrel, so a drum
      // reads as a hollow ring. Faces of an attached detail can legitimately sit inside the main
      // body, so only faces on the model's outer shell are judged.
      const radius = mesh.radius;
      const offenders = faces(mesh).filter((f) => {
        if (Math.abs(f.normal[1]) > 0.6) return false;                  // near-horizontal: covered above
        const [cx, , cz] = f.centroid;
        const dist = Math.hypot(cx, cz);
        if (dist < radius * 0.75) return false;                          // interior detail, not the shell
        return (f.normal[0] * cx + f.normal[2] * cz) / (dist || 1) < -0.1;
      });
      expect(
        offenders.map((f) => `at (${f.centroid[0].toFixed(1)}, ${f.centroid[2].toFixed(1)})`),
        `${mesh.id} has ${offenders.length} outer faces pointing inward — a prism or box is wound backwards`,
      ).toEqual([]);
    });
  }

  it("the whole roster encloses positive volume", () => {
    // A cheap global sanity check: for a surface wound outward, the divergence-theorem volume is
    // positive. The meshes are open at the bottom (no unit shows its underside), so this is a sign
    // test rather than an exact measurement — but a mesh turned inside out flips the sign.
    for (const mesh of meshes) {
      if (mesh.id === "imposter") continue;
      let volume = 0;
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const v = (k: number): [number, number, number] => {
          const idx = mesh.indices[i + k]!;
          return [mesh.positions[idx * 3]!, mesh.positions[idx * 3 + 1]!, mesh.positions[idx * 3 + 2]!];
        };
        const [ax, ay, az] = v(0);
        const [bx, by, bz] = v(1);
        const [cx, cy, cz] = v(2);
        volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
      expect(volume, `${mesh.id} encloses negative volume — it is inside out`).toBeGreaterThan(0);
    }
  });
});
