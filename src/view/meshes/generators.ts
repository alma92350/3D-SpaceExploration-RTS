// Procedural low-poly meshes for the MVP roster (ADR-0005 §3, P1-T06).
//
// No textures, no normal maps, no glTF, no asset pipeline: every mesh is built at boot from a
// parameterised generator. That is not a shortcut, it is the CPU-only budget (ADR-0006) —
// on a software rasteriser fill rate is the enemy, so flat-shaded vertex colours over a few dozen
// triangles is both the cheapest thing to draw and the easiest thing to read.
//
// The silhouettes deliberately echo the 2D client's vector art (risk R2): a Skiff is a forward
// dart, a Bastion is a squat hexagonal block, a Lancer is a long barrel on a narrow chassis. A
// player who knows the 2D game should recognise every unit in the first frame, from the shape
// alone, before colour or size registers.
//
// Two hard rules, both asserted by tests:
//   • **Deterministic.** Same generator, same vertices, every run and every machine. No `Math.random`.
//   • **Budgeted.** Every mesh declares a triangle ceiling. 200 units × 60 triangles is 12k
//     triangles a frame, which a software rasteriser can carry; 200 × 600 is not.

import { type MeshData } from "../renderer/port.js";

/** Per-mesh triangle ceilings. Exceeding one is a test failure, not a judgement call. */
export const TRIANGLE_BUDGET: Readonly<Record<string, number>> = {
  colonyship: 70,
  worker: 40,
  skiff: 40,
  bastion: 60,
  lancer: 60,
  command: 90,
  barracks: 70,
  habitat: 60,
  turret: 60,
  refinery: 70,
  node: 30,
  imposter: 2,
};

/** The nine types Phase 1 draws, plus the shared node and imposter meshes. */
export const MVP_MESHES = [
  // The colony ship leads the list because it is the first thing a player ever sees: in Odyssey
  // both sides land with one instead of a placed Command Center (engine/colony.js), and deploying
  // it is the opening move. The PRD's MVP roster does not name it; the MVP cannot start without it.
  "colonyship", "worker", "skiff", "bastion", "lancer",
  "command", "barracks", "habitat", "turret", "refinery",
  "node", "imposter",
] as const;

export type MeshId = (typeof MVP_MESHES)[number];

// ---------------------------------------------------------------------------
// A tiny mesh builder. Positions are model space with the origin at the ground
// contact point and +Y up, so an instance transform is just (position, yaw, scale).
// ---------------------------------------------------------------------------

class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly mix: number[] = [];
  private readonly idx: number[] = [];

  /** Add one triangle with a flat colour. Vertices are never shared: flat shading needs the split. */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, b: number, ownerMix: number,
  ): void {
    const base = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { this.col.push(r, g, b); this.mix.push(ownerMix); }
    this.idx.push(base, base + 1, base + 2);
  }

  /**
   * A quad, as two triangles.
   *
   * **Winding matters and is easy to get wrong.** Vertices must be counter-clockwise as seen from
   * OUTSIDE the surface, because the instance material culls back faces — that culling is a real
   * fill-rate saving at T0 (ADR-0006), and it is also what turns a wrongly-wound mesh into a
   * hollow shape whose far side shows through. Every primitive below has had its normals checked
   * against `test/view/mesh-winding.test.ts`; add a new one and add it there too.
   */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    r: number, g: number, b: number, ownerMix: number,
  ): void {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b, ownerMix);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, r, g, b, ownerMix);
  }

  /**
   * A prism: an n-sided polygon extruded upward, optionally tapered.
   * The workhorse — most of the roster is one or two of these.
   */
  prism(
    sides: number, radius: number, topRadius: number, baseY: number, topY: number,
    r: number, g: number, b: number, ownerMix: number, rotation = 0, shadeTop = 1.12,
  ): void {
    for (let i = 0; i < sides; i++) {
      const a0 = rotation + (i / sides) * Math.PI * 2;
      const a1 = rotation + ((i + 1) / sides) * Math.PI * 2;
      const x0 = Math.cos(a0), z0 = Math.sin(a0);
      const x1 = Math.cos(a1), z1 = Math.sin(a1);
      // Side facets alternate slightly in brightness. With no lighting at T0 this is the only
      // thing that keeps a cylinder from reading as a flat blob.
      const facet = 0.88 + 0.12 * ((i % 2) === 0 ? 1 : 0);
      // Bottom-near → top-near → top-far → bottom-far: counter-clockwise seen from outside the
      // barrel. The obvious ordering (both bottom vertices first) winds the other way and turns
      // the prism inside out.
      this.quad(
        x0 * radius, baseY, z0 * radius,
        x0 * topRadius, topY, z0 * topRadius,
        x1 * topRadius, topY, z1 * topRadius,
        x1 * radius, baseY, z1 * radius,
        r * facet, g * facet, b * facet, ownerMix,
      );
      if (topRadius > 0.001) {
        this.tri(
          0, topY, 0,
          x1 * topRadius, topY, z1 * topRadius,
          x0 * topRadius, topY, z0 * topRadius,
          r * shadeTop, g * shadeTop, b * shadeTop, ownerMix,
        );
      }
    }
  }

  /** An axis-aligned box. Cheaper and blockier than a prism — good for buildings. */
  box(
    hx: number, y0: number, y1: number, hz: number,
    r: number, g: number, b: number, ownerMix: number, offsetX = 0, offsetZ = 0,
  ): void {
    const x0 = offsetX - hx, x1 = offsetX + hx, z0 = offsetZ - hz, z1 = offsetZ + hz;
    // Top face: near edge first, then far, so the normal points up rather than into the box.
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, r * 1.15, g * 1.15, b * 1.15, ownerMix);
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, r, g, b, ownerMix);
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, r * 0.8, g * 0.8, b * 0.8, ownerMix);
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, r * 0.9, g * 0.9, b * 0.9, ownerMix);
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, r * 0.72, g * 0.72, b * 0.72, ownerMix);
  }

  finish(id: string): MeshData {
    const positions = new Float32Array(this.pos);
    let radius = 0;
    let height = 0;
    for (let i = 0; i < positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot(positions[i]!, positions[i + 2]!));
      height = Math.max(height, positions[i + 1]!);
    }
    return {
      id,
      positions,
      colors: new Float32Array(this.col),
      ownerMix: new Float32Array(this.mix),
      indices: new Uint16Array(this.idx),
      triangles: this.idx.length / 3,
      radius,
      height,
    };
  }
}

// Neutral greys the owner colour is mixed into. Full owner colour everywhere makes a unit read as
// a coloured lump; keeping hull panels neutral and hero surfaces team-coloured is what lets a
// player pick their own units out of a melee at a glance.
const HULL = [0.62, 0.66, 0.72] as const;
const DARK = [0.30, 0.33, 0.39] as const;
const TRIM = [0.85, 0.87, 0.92] as const;

function colonyship(): MeshData {
  const b = new Builder();
  // Big, slab-sided and unmistakable — it must read as "this is not a unit, this is your base in
  // transit" from the first frame, at any zoom, next to a worker a fifth its size.
  b.prism(6, 15, 12, 0, 6, HULL[0], HULL[1], HULL[2], 0.3);
  b.prism(6, 11, 7, 6, 14, TRIM[0], TRIM[1], TRIM[2], 0.8);
  b.box(2.2, 0, 5, 9, DARK[0], DARK[1], DARK[2], 0.15, 0, 13);     // the landing skid, pointing forward
  return b.finish("colonyship");
}

function worker(): MeshData {
  const b = new Builder();
  b.prism(6, 3.4, 2.6, 0, 3.6, HULL[0], HULL[1], HULL[2], 0.35);
  b.box(1.5, 3.6, 5.0, 1.5, TRIM[0], TRIM[1], TRIM[2], 0.9);       // team-coloured cab
  b.box(1.0, 0.4, 2.4, 3.6, DARK[0], DARK[1], DARK[2], 0.1);       // the tool arm, pointing forward
  return b.finish("worker");
}

function skiff(): MeshData {
  const b = new Builder();
  // A forward dart: nose at +Z, swept wings. The 2D Skiff is a triangle and this keeps that read.
  // The belly vertex sits at exactly y=0 — every mesh's origin is its ground contact point, and a
  // hovering unit would sit visibly above its own selection ring and blob shadow.
  b.tri(0, 1.4, 6.2, 2.8, 0.8, -3.4, -2.8, 0.8, -3.4, HULL[0], HULL[1], HULL[2], 0.55);   // upper deck
  b.tri(0, 1.4, 6.2, 0, 0, -2.2, 2.8, 0.8, -3.4, DARK[0], DARK[1], DARK[2], 0.2);          // starboard underside
  b.tri(0, 1.4, 6.2, -2.8, 0.8, -3.4, 0, 0, -2.2, DARK[0], DARK[1], DARK[2], 0.2);         // port underside
  b.tri(-2.8, 0.8, -3.4, 2.8, 0.8, -3.4, 0, 0, -2.2, DARK[0], DARK[1], DARK[2], 0.2);      // stern
  b.box(0.9, 1.2, 2.4, 1.6, TRIM[0], TRIM[1], TRIM[2], 0.95, 0, 0.4);
  return b.finish("skiff");
}

function bastion(): MeshData {
  const b = new Builder();
  // Squat, wide, hexagonal — reads as "slow and hard to kill" at any zoom.
  b.prism(6, 5.4, 4.6, 0, 3.2, HULL[0], HULL[1], HULL[2], 0.45, Math.PI / 6);
  b.prism(6, 3.4, 2.2, 3.2, 5.2, TRIM[0], TRIM[1], TRIM[2], 0.85, Math.PI / 6);
  b.box(1.1, 1.0, 2.2, 2.4, DARK[0], DARK[1], DARK[2], 0.1, 0, 3.0);
  return b.finish("bastion");
}

function lancer(): MeshData {
  const b = new Builder();
  // A long barrel on a narrow chassis. The barrel is the whole silhouette — it is what says
  // "outranges you" from across the map.
  b.box(2.0, 0, 2.6, 3.6, HULL[0], HULL[1], HULL[2], 0.4);
  b.box(1.3, 2.6, 4.2, 1.8, TRIM[0], TRIM[1], TRIM[2], 0.9);
  b.prism(4, 0.8, 0.8, 3.0, 3.0, DARK[0], DARK[1], DARK[2], 0.1);
  b.box(0.6, 3.0, 3.8, 5.4, DARK[0], DARK[1], DARK[2], 0.15, 0, 4.0);
  return b.finish("lancer");
}

function command(): MeshData {
  const b = new Builder();
  b.prism(8, 20, 17, 0, 9, HULL[0], HULL[1], HULL[2], 0.35);
  b.prism(8, 11, 8, 9, 18, TRIM[0], TRIM[1], TRIM[2], 0.75);
  b.prism(4, 3.2, 0.6, 18, 26, DARK[0], DARK[1], DARK[2], 0.5, Math.PI / 4);
  return b.finish("command");
}

function barracks(): MeshData {
  const b = new Builder();
  b.box(15, 0, 8, 11, HULL[0], HULL[1], HULL[2], 0.35);
  b.box(11, 8, 13, 7, TRIM[0], TRIM[1], TRIM[2], 0.7);
  b.box(3.5, 0, 9.5, 1.5, DARK[0], DARK[1], DARK[2], 0.1, 0, 11);   // the door, so it reads directional
  return b.finish("barracks");
}

function habitat(): MeshData {
  const b = new Builder();
  // A dome — the only round silhouette on the field, because a supply-blocked player scans for
  // Habitats specifically and shape finds them faster than colour. Two stacked prisms rather than
  // three: eight sides read as round at MVP zoom, and the third ring cost 24 triangles to smooth
  // a curve nobody sees from 400 units up.
  b.prism(8, 12, 9.5, 0, 5, HULL[0], HULL[1], HULL[2], 0.3);
  b.prism(8, 9.5, 0, 5, 12, TRIM[0], TRIM[1], TRIM[2], 0.6);
  return b.finish("habitat");
}

function turret(): MeshData {
  const b = new Builder();
  b.prism(6, 8, 7, 0, 4, DARK[0], DARK[1], DARK[2], 0.25);
  b.prism(6, 5.5, 4.5, 4, 9, HULL[0], HULL[1], HULL[2], 0.7);
  b.box(1.0, 6.0, 7.6, 6.5, TRIM[0], TRIM[1], TRIM[2], 0.85, 0, 5.0);
  return b.finish("turret");
}

function refinery(): MeshData {
  const b = new Builder();
  b.box(14, 0, 7, 12, HULL[0], HULL[1], HULL[2], 0.3);
  b.prism(8, 5, 5, 7, 20, TRIM[0], TRIM[1], TRIM[2], 0.55, 0);      // the stack
  b.prism(8, 6.5, 6.5, 0, 11, DARK[0], DARK[1], DARK[2], 0.15, 0);
  return b.finish("refinery");
}

function node(): MeshData {
  const b = new Builder();
  // Resource nodes are neutral: no owner mix at all, so a deposit can never be mistaken for a unit.
  b.prism(5, 9, 4, 0, 6, 0.55, 0.50, 0.42, 0);
  b.prism(5, 4.5, 1.5, 6, 11, 0.68, 0.62, 0.50, 0, 0.6);
  return b.finish("node");
}

function imposter(): MeshData {
  const b = new Builder();
  // The LOD fallback: one camera-facing quad. The renderer billboards it; the geometry only has to
  // be a unit square standing on the ground.
  b.quad(-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, 1, 1, 1, 1);
  return b.finish("imposter");
}

const GENERATORS: Record<MeshId, () => MeshData> = {
  colonyship, worker, skiff, bastion, lancer, command, barracks, habitat, turret, refinery,
  node, imposter,
};

/** Build the whole MVP mesh set. Called once, at boot. */
export function buildMeshes(): MeshData[] {
  return MVP_MESHES.map((id) => GENERATORS[id]());
}

/** Which mesh draws a given engine type. Unknown types fall back to a worker-sized block. */
export function meshIdForType(type: string): MeshId {
  return (MVP_MESHES as readonly string[]).includes(type) ? (type as MeshId) : "worker";
}
