// The vendored simulation's data shapes, as TypeScript sees them (ADR-0003, ADR-0007, P0-T05).
//
// The engine is JavaScript with JSDoc types and is never edited here, so these declarations are
// the one thing in the pair that CAN silently drift: upstream could rename a field and nothing
// would complain at compile time. `test/engine/declarations.test.ts` is the counterweight — it
// builds a real world through this surface and asserts each declared field is actually there, so
// drift surfaces as a red test rather than as `undefined` in a frame.
//
// Only what this project reads is declared. Deliberately: transcribing 15.6k lines would create a
// second source of truth for the rules, which is the thing ADR-0003 exists to prevent. Need
// another field? Declare it and extend the conformance test in the same commit.

declare global {
  type OwnerId = "player" | "ai";

  interface Resources { [commodity: string]: number }

  interface TerrainDef {
    name: "open" | "rough" | "high";
    speedMult: number;
    sightMult: number;
    buildable: boolean;
    combatMult: number;
  }

  /** The coarse per-cell terrain field. This grid IS the 3D heightmap (ADR-0004). */
  interface TerrainGrid {
    cols: number;
    rows: number;
    cell: number;
    type: Uint8Array;
  }

  interface ResourceNode {
    id: string;
    com: string;
    amount: number;
    max: number;
    x: number;
    y: number;
    home?: boolean;
    hidden?: boolean;
  }

  interface GameMap {
    width: number;
    height: number;
    nodes: ResourceNode[];
    terrain: TerrainGrid;
    bases: Record<OwnerId, { x: number; y: number }>;
    modifiers?: Record<string, unknown>;
  }

  interface Fog {
    cols: number;
    rows: number;
    explored: Uint8Array;
    visible: Uint8Array;
  }

  interface UnitOrder {
    type: string;
    x?: number;
    y?: number;
    targetId?: string;
    nodeId?: string;
  }

  interface Unit {
    kind: "unit";
    id: string;
    type: string;
    owner: OwnerId;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    order: UnitOrder | null;
    orderQueue: UnitOrder[];
    cargo: { com: string | null; qty: number } | null;
    kills?: number;
    hold?: boolean;
    dead?: boolean;
  }

  interface Building {
    kind: "building";
    id: string;
    type: string;
    owner: OwnerId;
    x: number;
    y: number;
    radius: number;
    hp: number;
    maxHp: number;
    constructing: boolean;
    buildProgress: number;
    queue: Array<{ unitType: string; progress: number }>;
    targetId: string | null;
    rally: { x: number; y: number };
    tier?: number;
    dead?: boolean;
    // --- economy (Phase 2). All optional: a Command Center has none of them. ---
    /** Local input larder, filled by worker service runs. Not the owner's stockpile. */
    input?: Resources;
    /** Local output buffer, drained by worker haul runs. A full one stalls the factory. */
    store?: Resources;
    /** Player-paused: banks nothing, consumes nothing, drops its grid draw to a trickle. */
    paused?: boolean;
    /** Fuel-burning sources only: true while actually fed. Sources grant no power when false. */
    powered?: boolean;
    /** Being scrapped back into resources (recycle.js). A progress record, not a flag. */
    recycling?: { progress: number; time: number };
    /** Electrified for the +30% boost, at the cost of ELECTRIFY_POWER of grid draw. */
    electrified?: boolean;
    /** Research queued at a Datacenter, in order. The head of it is the job in progress. */
    researchQueue?: Array<{ techId: string; progress: number }>;
    /** Which end of the logistics queue this building sits at (`LOGI_PRIORITIES`). */
    logiPriority?: "high" | "normal" | "low";
    /**
     * Committed job tallies, written by `countLogistics` — which is a MUTATOR, not a query.
     * Read these; never call it from above the bridge (see src/ui/operations-panel.ts).
     */
    haulers?: number;
    servers?: number;
  }

  type Entity = Unit | Building;

  interface UnitDef {
    id: string;
    name: string;
    hp: number;
    radius: number;
    speed?: number;
    sight?: number;
    range?: number;
    attack?: number;
    cooldown?: number;
    cost?: Resources;
    altCost?: Resources;
    buildTime?: number;
    supplyCost?: number;
    role?: string;
    canGather?: boolean;
    /** Freighters and haulers: how much freight they carry. Absent for everything else. */
    cargoHold?: number;
    buildCategories?: string[];
    odysseyOnly?: boolean;
    requires?: string[];
  }

  interface BuildingDef {
    id: string;
    name: string;
    hp: number;
    radius: number;
    cost?: Resources;
    buildTime?: number;
    sight?: number;
    produces?: string[];
    requires?: string[];
    category?: string;
    supplyGrants?: number;
    isCommandCenter?: boolean;
    attack?: number;
    range?: number;
    odysseyOnly?: boolean;
    // --- economy (Phase 2) ---
    /** Grid capacity this building contributes, if it is a power source. */
    energyGrants?: number;
    /** Reference grid reach; a consumer's efficiency band is its distance divided by this. */
    powerRange?: number;
    /** A Substation relays the grid one hop, never through another relay. */
    powerRelay?: boolean;
    /** Fuel-burning source: which fuels it accepts and how fast it burns them. */
    combust?: { fuels: string[]; rate: number };
    /** Plasma Rig: the nuclear fuel draw per second. */
    rig?: { nuclear: number; [k: string]: unknown };
    /** Batches per second at full power. */
    prodRate?: number;
    storeCap?: number;
    inputCap?: number;
  }

  interface PlayerSide {
    id: OwnerId;
    faction: string;
    isAI: boolean;
    resources: Resources;
    color: string;
    upgrades: Record<string, unknown>;
  }

  interface SimEvent { type: string; [k: string]: unknown }

  interface State {
    time: number;
    tick: number;
    over: boolean;
    seed: number | null;
    planetId: string;
    endless: boolean;
    map: GameMap;
    owners: OwnerId[];
    players: Record<OwnerId, PlayerSide>;
    units: Map<string, Unit>;
    buildings: Map<string, Building>;
    selection: string[];
    fogs: Record<OwnerId, Fog>;
    fog: Fog;
    fogAI: Fog;
    events: SimEvent[];
    /** Odyssey only: the world's commodity market (`engine/market.js`). */
    market: MarketState;
  }

  /** Per-world commodity market. Prices move with what has been traded into and out of it. */
  interface MarketState {
    base: Record<string, number>;
    pressure: Record<string, number>;
    glut: Record<string, number>;
  }

  interface Galaxy {
    seed: number;
    credits: number;
    activeId: string;
    worlds: string[];
    planets: Map<string, State>;
    settings: Record<string, unknown>;
    tick: number;
    time: number;
    discovered: Set<string>;
    milestones: unknown[];
  }

  interface GameStateOpts {
    planetId?: string;
    rng?: () => number;
    seed?: number;
    sizeMult?: number;
    resourceMult?: number;
    endless?: boolean;
    playerFaction?: string;
    aiFaction?: string;
    difficulty?: string;
    popCap?: number | null;
  }

  interface GalaxyOpts {
    seed?: number;
    difficulty?: string;
    sizeMult?: number;
    resourceMult?: number;
    playerFaction?: string;
    aiApm?: number | null;
    aiMicro?: boolean;
    aiStrategy?: string;
    startId?: string;
    popCap?: number | null;
  }

  interface PlanetDef {
    id: string;
    name: string;
    tag?: string;
    x: number;
    industry?: number;
    tech?: number;
    faction?: string;
    deposits: Record<string, number>;
  }

  interface CommodityDef { name: string; [k: string]: unknown }
}

export {};
