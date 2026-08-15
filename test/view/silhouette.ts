// What a silhouette is, numerically — shared by the building and unit mesh tests.
//
// This is the honest, weaker stand-in for the blind readability test PRD §5 asks for and ADR-0011
// defers. It cannot tell whether a shape *reads*; it can tell whether two shapes are the same
// shape, which is the failure a person would spot instantly and which no other test would catch.
//
// **The width is measured by interpolating along triangle edges that cross the sample height**, not
// by looking for vertices near it. The first version did the latter — a band of ±15% of the height
// around each sample — and it has a hole that matters: when NEITHER mesh happens to have a vertex
// in the band, both widths come back 0 and the metric scores that as perfect agreement. It is not
// agreement, it is absence of evidence, and it dragged the Helium Bomb and the Skiff to within
// 0.223 of each other when their actual profiles are nothing alike (a 8.0-tall sphere against a
// 2.4-tall dart). Edge interpolation gives the true width of a polyhedron at any height, so a
// sample never comes back empty for a solid mesh.

export interface Mesh {
  positions: Float32Array;
  indices: Uint16Array;
  radius: number;
  height: number;
}

/** The widest horizontal extent of the mesh at height `y`, by edge interpolation. */
export function widthAt(mesh: Mesh, y: number): number {
  let widest = 0;
  const p = (v: number): [number, number, number] =>
    [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];

  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!].map(p);
    for (let e = 0; e < 3; e++) {
      const [ax, ay, az] = tri[e]!;
      const [bx, by, bz] = tri[(e + 1) % 3]!;
      // A vertex exactly at the sample height counts on its own; otherwise the edge has to span it.
      if (Math.abs(ay - y) < 1e-9) widest = Math.max(widest, Math.hypot(ax, az));
      if ((ay - y) * (by - y) > 0) continue;              // both ends the same side — no crossing
      if (Math.abs(by - ay) < 1e-9) continue;             // horizontal edge at another height
      const t = (y - ay) / (by - ay);
      if (t < 0 || t > 1) continue;
      widest = Math.max(widest, Math.hypot(ax + (bx - ax) * t, az + (bz - az) * t));
    }
  }
  return widest;
}

/** Footprint radius, height, and width at 25/50/75% of height. */
export function profileOf(mesh: Mesh): number[] {
  return [
    mesh.radius,
    mesh.height,
    ...[0.25, 0.5, 0.75].map((f) => widthAt(mesh, mesh.height * f)),
  ];
}

/**
 * Mean relative difference across the profile, 0 = identical.
 *
 * Relative rather than absolute so a Leviathan and a Ranger are compared on the same scale as two
 * Workers — a fixed tolerance in world units would be meaningless across a roster spanning 6 to 22.
 */
export function profileDistance(a: number[], b: number[]): number {
  return a.reduce((sum, v, k) => sum + Math.abs(v - b[k]!) / Math.max(v, b[k]!, 1e-6), 0) / a.length;
}
