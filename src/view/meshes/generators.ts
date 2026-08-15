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
  // Phase 2 — the six silhouette families (ADR-0013). Budgets are tighter than Phase 1's because
  // there are far more of these on the field at once: a 300-building base is the perf scene.
  factory: 60,
  powerplant: 50,
  relay: 40,
  fortress: 60,
  works: 50,
  port: 80,
  civic: 60,
  plasmarig: 80,
  gate: 90,
  // Phase 2's two remaining families (ADR-0014).
  freighter: 50,
  volatile: 30,
  // Phase 3 — the nine units that had no mesh at all and rendered as Workers (ADR-0016).
  // Budgets sized by how many are on screen at once: a Ranger scouts alone and a Leviathan is a
  // capital ship you own two of, while a Wraith comes in packs.
  ranger: 40,
  wraith: 40,
  mender: 55,
  breacher: 55,
  heliumbomb: 70,
  aegis: 60,
  colossus: 60,
  dreadnought: 70,
  leviathan: 90,
};

/** The nine types Phase 1 draws, plus the shared node and imposter meshes. */
export const MVP_MESHES = [
  // The colony ship leads the list because it is the first thing a player ever sees: in Odyssey
  // both sides land with one instead of a placed Command Center (engine/colony.js), and deploying
  // it is the opening move. The PRD's MVP roster does not name it; the MVP cannot start without it.
  "colonyship", "worker", "skiff", "bastion", "lancer",
  "command", "barracks", "habitat", "turret", "refinery",
  "node", "imposter",
  // Phase 2's families. Nine meshes for the nineteen buildings the MVP did not draw (ADR-0013).
  "factory", "powerplant", "relay", "fortress", "works", "port", "civic", "plasmarig", "gate",
  // One hull for the four logistics units, and a second deposit mesh (ADR-0014). `node` keeps its
  // name and becomes the rock — renaming it would churn the perf baseline for nothing.
  "freighter", "volatile",
  // Phase 3 — nine silhouettes, one per unit, no families (ADR-0016). Measured: 37 batches today,
  // 55 with these, against a derived ceiling of 83, so the budget that forced ADR-0013's and
  // ADR-0014's families simply does not bind here.
  "ranger", "wraith", "mender", "breacher", "heliumbomb", "aegis", "colossus", "dreadnought",
  "leviathan",
] as const;

/** Every mesh the game builds. `MVP_MESHES` kept its name; this is what to iterate. */
export const MESH_IDS = MVP_MESHES;

export type MeshId = (typeof MVP_MESHES)[number];

/**
 * Engine building type → the mesh that draws it (ADR-0013).
 *
 * This table is the reason a building type added upstream cannot silently render as a fallback
 * block: `test/view/building-meshes.test.ts` fails on any type missing from it, and names the type.
 *
 * A family shares a *role*, and that is the point — the player is not being asked to tell a Chip
 * Fab from a Smelter by shape, they are being told "that shape is a factory", which is the read
 * that matters when scanning a base. Identity comes from the panel, not the roofline.
 */
/**
 * Engine commodity → the deposit mesh that draws it (ADR-0014).
 *
 * Two, not five and not three. Deposits never take the imposter path — `pushNodes` batches at
 * `LOD_MESH` unconditionally — so every deposit mesh costs its batch at every zoom, and the
 * metallic-versus-crystalline distinction is one a player makes in the build menu rather than by
 * looking at the ground. Anything not listed is a rock.
 */
export const DEPOSIT_FAMILY: Readonly<Record<string, MeshId>> = {
  ore: "node",
  metals: "node",
  crystals: "node",
  radioactives: "node",
  ice: "volatile",
  gas: "volatile",
  biomass: "volatile",
  spice: "volatile",
  relics: "volatile",
};

/** Which mesh draws a deposit of `com`. Unknown commodities are rock, which is the safe default. */
export function meshIdForCommodity(com: string): MeshId {
  return DEPOSIT_FAMILY[com] ?? "node";
}

/**
 * Engine unit type → its mesh. The four logistics units share one hull (ADR-0014): they are the
 * same silhouette at any distance a player cares about, and they differ in capacity, which is a
 * number rather than a shape. Cargo is a per-instance shade, not a second mesh.
 */
export const UNIT_FAMILY: Readonly<Record<string, MeshId>> = {
  hauler: "freighter",
  heavyhauler: "freighter",
  bulkfreighter: "freighter",
  freighter: "freighter",
};

export const BUILDING_FAMILY: Readonly<Record<string, MeshId>> = {
  // Phase 1's five keep their own meshes: they are the ones a player acts on constantly.
  command: "command",
  barracks: "barracks",
  habitat: "habitat",
  turret: "turret",
  refinery: "refinery",

  // The industrial chain — nine buildings, one shed with a stack.
  smelter: "factory",
  assembler: "factory",
  chipfab: "factory",
  machineworks: "factory",
  antimatterforge: "factory",
  aifoundry: "factory",
  torpedoworks: "factory",
  chemplant: "factory",
  fabricator: "factory",

  // Power. A squat drum, and the relay mast that extends its reach one hop.
  reactor: "powerplant",
  combustor: "powerplant",
  biomassreactor: "powerplant",
  substation: "relay",

  // Static defence beyond the Sentinel Turret.
  bastille: "fortress",
  aegisbastion: "fortress",
  torpedobattery: "fortress",

  // Military upgrade halls.
  foundry: "works",
  arsenal: "works",

  // Landmarks: the buildings a player navigates by, so they stay distinct and stay tall.
  spaceport: "port",
  stardock: "port",
  market: "civic",
  datacenter: "civic",
  plasmarig: "plasmarig",
  antimatter_gate: "gate",
};

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

function freighter(): MeshData {
  const b = new Builder();
  // A hull with an open hold. The hold is the read: a laden freighter brightens (per-instance
  // shade), so the shape has to have somewhere for cargo to visibly be.
  b.box(3.2, 0, 2.0, 7.0, HULL[0], HULL[1], HULL[2], 0.35);
  b.box(2.4, 2.0, 4.2, 4.6, DARK[0], DARK[1], DARK[2], 0.15);          // the hold
  b.box(1.8, 2.0, 4.8, 1.6, TRIM[0], TRIM[1], TRIM[2], 0.9, 0, 5.2);   // the cab, forward
  return b.finish("freighter");
}

function volatileNode(): MeshData {
  const b = new Builder();
  // Deliberately NOT a rock: a low, wide pool with a raised lip, so ice, gas and biomass read as
  // "something pooled here" rather than "something to mine". Neutral, like the rock — a deposit
  // must never be mistakable for a unit.
  // Five-sided, like the rock, because six put it at 36 triangles against a 30 budget and the
  // sixth side buys nothing at this size. The proportion is what separates the two, not the
  // facet count: this is low and wide where the rock is tall and narrow.
  b.prism(5, 10, 8.5, 0, 2.2, 0.38, 0.46, 0.52, 0);
  b.prism(5, 7, 5.5, 2.2, 4.4, 0.46, 0.58, 0.62, 0);
  return b.finish("volatile");
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

// --- Phase 2's six families (ADR-0013) -------------------------------------------------------

function factory(): MeshData {
  const b = new Builder();
  // A long shed with an off-centre stack. The stack is the whole read: it is what separates
  // "something is being made here" from a barracks or a hall at 210 units of distance.
  b.box(13, 0, 6.5, 9, HULL[0], HULL[1], HULL[2], 0.28);
  b.box(9, 6.5, 9, 6.5, DARK[0], DARK[1], DARK[2], 0.12);
  b.prism(6, 3, 2.6, 9, 19, TRIM[0], TRIM[1], TRIM[2], 0.5, 0, -4.5);
  return b.finish("factory");
}

function powerplant(): MeshData {
  const b = new Builder();
  // A squat drum, wider than it is tall — the opposite proportion to a factory, deliberately, so
  // the two never confuse at a glance. Every source in this game burns fuel, so it reads as a tank.
  b.prism(8, 11, 10, 0, 7, DARK[0], DARK[1], DARK[2], 0.2);
  b.prism(8, 10, 9.5, 7, 9.5, TRIM[0], TRIM[1], TRIM[2], 0.65);
  return b.finish("powerplant");
}

function relay(): MeshData {
  const b = new Builder();
  // A thin mast on a small pad. Narrow and tall enough to spot, small enough in footprint that a
  // player reads it as infrastructure rather than as a building worth defending.
  b.box(4.5, 0, 2, 4.5, DARK[0], DARK[1], DARK[2], 0.15);
  b.prism(4, 1.4, 0.9, 2, 16, TRIM[0], TRIM[1], TRIM[2], 0.7, Math.PI / 4);
  return b.finish("relay");
}

function fortress(): MeshData {
  const b = new Builder();
  // A walled block: a wide, LOW outer wall with a modest core inside it. The first attempt was
  // taller and narrower and the profile test failed it — it came within 8% of the Refinery, which
  // means the two would have been the same shape on the field however different their vertices.
  // Low and wide is the read that says "this holds ground" and it is nothing else's proportion.
  b.box(15, 0, 3.5, 15, DARK[0], DARK[1], DARK[2], 0.2);
  b.box(7, 3.5, 10, 7, HULL[0], HULL[1], HULL[2], 0.6);
  return b.finish("fortress");
}

function works(): MeshData {
  const b = new Builder();
  // A hall — a plain long roof, no stack. Reads as "military support" next to the factory's stack
  // and the fortress's step.
  b.box(11, 0, 9, 14, HULL[0], HULL[1], HULL[2], 0.4);
  b.box(4, 9, 11.5, 12, TRIM[0], TRIM[1], TRIM[2], 0.75);
  return b.finish("works");
}

function port(): MeshData {
  const b = new Builder();
  // A landing ring on legs. The tallest thing a player builds before the Gate, and the one they
  // navigate by when their army is halfway across the map.
  b.prism(8, 15, 13, 0, 4, DARK[0], DARK[1], DARK[2], 0.2);
  b.box(2, 4, 22, 2, HULL[0], HULL[1], HULL[2], 0.3);
  b.prism(8, 13, 11, 22, 28, TRIM[0], TRIM[1], TRIM[2], 0.7);
  return b.finish("port");
}

function civic(): MeshData {
  const b = new Builder();
  // A slab tower: flat-sided and rectangular where every other tall thing is round. The Market and
  // the Datacenter are where a player goes to *read* something, and they sit near the base core.
  b.box(9, 0, 20, 6, HULL[0], HULL[1], HULL[2], 0.35);
  b.box(6.5, 20, 23, 4, TRIM[0], TRIM[1], TRIM[2], 0.8);
  return b.finish("civic");
}

function plasmarig(): MeshData {
  const b = new Builder();
  // A derrick over a wellhead. Its value depends on where it is put (the survey), so it has to be
  // findable from across the map to judge whether it was put well.
  b.prism(6, 10, 9, 0, 3, DARK[0], DARK[1], DARK[2], 0.15);
  b.prism(4, 6, 1.6, 3, 26, TRIM[0], TRIM[1], TRIM[2], 0.6, Math.PI / 4);
  return b.finish("plasmarig");
}

function gate(): MeshData {
  const b = new Builder();
  // The Antimatter Gate: the win condition, and it should look like one. A ring on a plinth,
  // taller than anything else in the game.
  b.prism(8, 17, 16, 0, 5, DARK[0], DARK[1], DARK[2], 0.2);
  b.box(2.5, 5, 30, 12, HULL[0], HULL[1], HULL[2], 0.35, -11);
  b.box(2.5, 5, 30, 12, HULL[0], HULL[1], HULL[2], 0.35, 11);
  b.box(13, 30, 34, 3, TRIM[0], TRIM[1], TRIM[2], 0.85);
  return b.finish("gate");
}

/* ---------------------------------------------------------------------------------------------
   Phase 3 — the nine units that had no mesh (ADR-0016).

   Shape follows FUNCTION, because function is what ADR-0016 spent 18 draw calls to make readable.
   Size follows `UNITS[type].radius`, because that is the number collision, selection and the
   imposter quad already use — art that drifts from it makes the picture lie about the game.

   The two unarmed units are the sharp cases and get the most distinctive shapes in the roster: a
   Mender that reads as a fighter gets focused by an enemy and abandoned by its own player, and a
   Helium Bomb that reads as anything else is the most expensive misread available in this game.
   --------------------------------------------------------------------------------------------- */

function ranger(): MeshData {
  const b = new Builder();
  // The scout: 115 speed against a Worker's 60, and the unit a player tracks constantly across an
  // unexplored map. A narrow spire — the smallest footprint in the roster carrying the tallest
  // thing relative to its width, so it reads at the edge of vision where scouts actually live.
  b.prism(4, 3.4, 2.2, 0, 1.6, DARK[0], DARK[1], DARK[2], 0.2, Math.PI / 4);
  b.box(1.1, 1.6, 4.6, 1.1, HULL[0], HULL[1], HULL[2], 0.4);
  b.box(0.55, 4.6, 6.4, 0.55, TRIM[0], TRIM[1], TRIM[2], 0.95);      // the sensor mast
  return b.finish("ranger");
}

function wraith(): MeshData {
  const b = new Builder();
  // Fast striker: 104 speed, 22 attack, 84 hp — it arrives, kills something and leaves. A swept
  // delta like the Skiff's, but with a raked dorsal fin that gives it a height the Skiff has not
  // got, because the two are the same tactical shape and must not be the same visual one.
  b.tri(0, 1.2, 5.6, 4.4, 0.5, -3.2, -4.4, 0.5, -3.2, HULL[0], HULL[1], HULL[2], 0.5);
  b.tri(0, 1.2, 5.6, 0, 0, -2.0, 4.4, 0.5, -3.2, DARK[0], DARK[1], DARK[2], 0.2);
  b.tri(0, 1.2, 5.6, -4.4, 0.5, -3.2, 0, 0, -2.0, DARK[0], DARK[1], DARK[2], 0.2);
  b.tri(-4.4, 0.5, -3.2, 4.4, 0.5, -3.2, 0, 0, -2.0, DARK[0], DARK[1], DARK[2], 0.2);
  b.box(0.45, 1.2, 5.0, 2.6, TRIM[0], TRIM[1], TRIM[2], 0.9, 0, -0.8);   // the fin
  return b.finish("wraith");
}

function mender(): MeshData {
  const b = new Builder();
  // NO WEAPON. Nothing on this model points forward, which is the whole design: every armed unit in
  // the roster has a barrel, a nose or a prow, and this one deliberately has none. A narrow stalk
  // carrying a wide emitter dish — the only unit that is wider at the top than at the bottom, which
  // is a silhouette no fighter can accidentally acquire.
  b.prism(6, 2.2, 1.8, 0, 2.2, DARK[0], DARK[1], DARK[2], 0.15);
  b.box(0.7, 2.2, 5.6, 0.7, HULL[0], HULL[1], HULL[2], 0.35);
  b.prism(6, 4.6, 5.4, 5.6, 7.6, TRIM[0], TRIM[1], TRIM[2], 0.9);        // the dish, flaring UPWARD
  return b.finish("mender");
}

function breacher(): MeshData {
  const b = new Builder();
  // Siege at 150 range and 50 speed: it sits still and hits things it cannot see the far side of.
  // A long, low sled — the lowest profile of anything armed — with a forward-raked barrel that is
  // most of its length.
  b.box(4.6, 0, 1.6, 5.0, HULL[0], HULL[1], HULL[2], 0.4);
  b.box(2.6, 1.6, 2.8, 3.0, TRIM[0], TRIM[1], TRIM[2], 0.8);
  b.box(0.7, 1.9, 2.6, 6.0, DARK[0], DARK[1], DARK[2], 0.1, 0, 4.6);     // the barrel, overhanging the nose
  return b.finish("breacher");
}

function heliumbomb(): MeshData {
  const b = new Builder();
  // A 3 000-damage blast in a radius, carried by something with no attack at all. The only sphere
  // in the game: two tapered prisms meeting at the waist, so the widest point of the silhouette is
  // its middle rather than its base. Nothing else in the roster has that profile, which is the
  // point — this is the one unit whose identity a player must never have to guess at.
  b.prism(8, 2.6, 6.6, 0.9, 4.2, DARK[0], DARK[1], DARK[2], 0.15);
  b.prism(8, 6.6, 1.8, 4.2, 8.0, TRIM[0], TRIM[1], TRIM[2], 0.85);
  b.box(2.2, 0, 1.1, 2.2, HULL[0], HULL[1], HULL[2], 0.3);               // the cradle it rides on
  return b.finish("heliumbomb");
}

function aegis(): MeshData {
  const b = new Builder();
  // 26 range and 360 hp: it has to close, and it exists to be shot at. A wide forward shield plate,
  // broader than it is deep and low to the ground — the opposite proportion to the Colossus, which
  // is the unit it must never be confused with.
  b.box(7.2, 0, 1.8, 3.0, HULL[0], HULL[1], HULL[2], 0.4);
  b.box(4.6, 1.8, 2.6, 2.0, DARK[0], DARK[1], DARK[2], 0.2);
  b.box(8.4, 0.5, 3.4, 0.8, TRIM[0], TRIM[1], TRIM[2], 0.9, 0, 2.8);     // the shield, spanning the front
  return b.finish("aegis");
}

function colossus(): MeshData {
  const b = new Builder();
  // 185 range, 32 speed, 42 attack on 150 hp — a glass cannon that shells from beyond sight. The
  // tallest unit in the game and the thinnest above its base: a vertical mortar tube, so the thing
  // a player reads from across the field is "that one is aimed at the sky".
  b.prism(6, 6.2, 5.0, 0, 2.2, DARK[0], DARK[1], DARK[2], 0.2);
  b.prism(6, 3.4, 2.6, 2.2, 4.0, HULL[0], HULL[1], HULL[2], 0.4);
  b.prism(6, 1.9, 1.7, 4.0, 12.8, TRIM[0], TRIM[1], TRIM[2], 0.85);      // the tube
  return b.finish("colossus");
}

function dreadnought(): MeshData {
  const b = new Builder();
  // 340 hp, 26 attack, 68 range: the line-holder. Broad and layered — a stack of receding decks, so
  // it reads as mass rather than as reach. Deliberately blockier than the Aegis, which is the other
  // heavy, and much lower than the Colossus, which is the other big gun.
  b.box(7.0, 0, 2.6, 5.2, HULL[0], HULL[1], HULL[2], 0.4);
  b.box(5.2, 2.6, 4.6, 3.8, DARK[0], DARK[1], DARK[2], 0.25);
  b.box(3.2, 4.6, 6.2, 2.4, TRIM[0], TRIM[1], TRIM[2], 0.85);
  b.box(0.9, 3.0, 3.9, 4.4, DARK[0], DARK[1], DARK[2], 0.1, 0, 4.6);     // twin forward guns
  return b.finish("dreadnought");
}

function leviathan(): MeshData {
  const b = new Builder();
  // 900 hp, 70 attack, 200 range, gated behind a Stardock: the capital ship, and the largest thing
  // on the field short of a Command Center. A long slab hull with a raised spine and a prow that
  // pushes its footprint well past everything else.
  b.prism(6, 8.6, 7.2, 0, 3.6, HULL[0], HULL[1], HULL[2], 0.35);
  b.box(4.4, 3.6, 6.4, 6.0, DARK[0], DARK[1], DARK[2], 0.25);
  b.box(2.2, 6.4, 9.2, 3.0, TRIM[0], TRIM[1], TRIM[2], 0.85);
  b.box(1.8, 0.8, 3.4, 4.0, DARK[0], DARK[1], DARK[2], 0.15, 0, 8.4);    // the prow
  return b.finish("leviathan");
}

const GENERATORS: Record<MeshId, () => MeshData> = {
  colonyship, worker, skiff, bastion, lancer, command, barracks, habitat, turret, refinery,
  node, imposter,
  factory, powerplant, relay, fortress, works, port, civic, plasmarig, gate,
  freighter, volatile: volatileNode,
  ranger, wraith, mender, breacher, heliumbomb, aegis, colossus, dreadnought, leviathan,
};

/** Build the whole MVP mesh set. Called once, at boot. */
export function buildMeshes(): MeshData[] {
  return MVP_MESHES.map((id) => GENERATORS[id]());
}

/**
 * Which mesh draws a given engine type.
 *
 * Buildings go through `BUILDING_FAMILY` (ADR-0013); units keep their own meshes. The fallback is
 * a worker-sized block, which is why a test asserts every engine building type is in the table —
 * a missing one does not crash, it renders as a small grey lump and nobody notices for a phase.
 */
export function meshIdForType(type: string): MeshId {
  const family = BUILDING_FAMILY[type] ?? UNIT_FAMILY[type];
  if (family) return family;
  return (MVP_MESHES as readonly string[]).includes(type) ? (type as MeshId) : "worker";
}
