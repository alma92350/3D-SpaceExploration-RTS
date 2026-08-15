// The snapshot: the read-only, flat, typed-array description of what can be drawn (ADR-0008).
//
// `view/` consumes this and never the engine's own state. Three reasons, in order of how expensive
// they are to discover late:
//
//   1. The engine mutates entity objects in place. A renderer holding references renders half-
//      updated ticks, and a renderer that writes one is a determinism bug you find in Phase 5.
//   2. ADR-0006 forbids allocation in a steady-state frame. Parallel typed arrays, sized once and
//      reused, are the only shape that holds at 400 entities and 60 fps.
//   3. Everything here is structurally serialisable, so moving the sim into a Worker later is a
//      change to this module and nothing above it.
//
// **Fog is applied here, not in the renderer.** An entity the player cannot see is absent from the
// snapshot entirely (PRD F-02, F-06). Filtering in the view would mean the hidden entity's position
// had already crossed the boundary, and "the renderer knows but does not draw" is how information
// leaks — through a selection box, a minimap dot, or a stray sort order.

import {
  BOMB_BLAST_RADIUS, BOMB_CORE_RADIUS, BOMB_FUSE_DELAY, BUILDINGS, COM, FOG_CELL_SIZE, POWER_TIERS, UNITS,
  buildingConcern, inputCapOf, inputTotal, isNodeDiscovered, isVisibleAt, onPowerGrid,
  powerEfficiency, recipeOf, storeCapOf, storeTotal,
  type Recipe,
} from "../engine/index.js";

/** Owner encoded as a small integer — it indexes palettes and batch keys every frame. */
export const SNAP_PLAYER = 0;
export const SNAP_AI = 1;

/** Bit flags on a snapshot entity. Cheaper than parallel boolean arrays and easier to extend. */
export const FLAG_SELECTED = 1 << 0;
export const FLAG_CONSTRUCTING = 1 << 1;
export const FLAG_CARRYING = 1 << 2;
export const FLAG_MOVING = 1 << 3;
export const FLAG_BUILDING_KIND = 1 << 4;

/** Fog states, matching `FogField` in the renderer port. */
export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1;
export const FOG_VISIBLE = 2;

/**
 * Why a producer is not producing, as a small integer.
 *
 * These are the engine's `buildingConcern` codes and nothing else — the bridge maps its strings to
 * numbers and does not decide anything (ADR-0012 §5). The priority order is the engine's too, so
 * the badge on a building can never disagree with what the simulation is doing to it.
 */
export const CONCERN_NONE = 0;
export const CONCERN_PAUSED = 1;
export const CONCERN_NO_POWER = 2;
export const CONCERN_NO_FUEL = 3;
export const CONCERN_STARVED = 4;
export const CONCERN_BUFFER_FULL = 5;
export const CONCERN_THROTTLED = 6;

/**
 * What a building is *doing*, as opposed to what is *wrong* with it (P2-T08).
 *
 * These are ours, and they live in their own array rather than as extra `CONCERN_*` values, for the
 * reason ADR-0012 §5 gives: `concern` is `buildingConcern`'s own answer, mapped to an integer and
 * not otherwise touched, so that a badge can never disagree with the simulation. Appending a code
 * we invented to that enum would quietly make it a *mixture* of the engine's answer and ours, and
 * the next person to trust the comment would be wrong.
 *
 * The distinction they add is the one the board flagged as the failure mode worth designing
 * against: a building with nothing wrong with it can still be **doing nothing**, and "idle" reading
 * the same as "working" is how a player loses ten minutes to a Barracks they forgot to queue.
 *
 * `ACTIVITY_NONE` covers everything that has no work to have: a turret, a Habitat, a wall.
 */
export const ACTIVITY_NONE = 0;
/** Producing or training right now. */
export const ACTIVITY_WORKING = 1;
/** Able to work and not working — an empty training queue, today's only case. */
export const ACTIVITY_IDLE = 2;

/**
 * Power bands, as stored per cell of the power field.
 *
 * `POWER_NONE` means "no grid reaches here" — either the owner has no active source at all, or
 * this cell is past the outermost band the engine counts as on-grid. The other four are
 * `POWER_TIERS` index + 1, so the view maps a band to a colour without ever seeing the engine's
 * cost multipliers (Q-08).
 */
export const POWER_NONE = 0;

/**
 * Where a deposit came from (P3-T08, P3-T09, ADR-0018).
 *
 * The engine turns battlefield debris and bomb craters into ordinary `ResourceNode`s carrying a
 * `wreck` or `crater` flag, and is explicit that they are otherwise indistinguishable from natural
 * ground. Both flags reached the bridge and were discarded here — exactly as `comIndex` was before
 * P2-T17 — so salvage rendered as an ore seam and a crater as ground that had always been there.
 */
export const NODE_NATURAL = 0;
export const NODE_SALVAGE = 1;
export const NODE_CRATER = 2;

const CONCERN_CODES: Record<string, number> = {
  noPower: CONCERN_NO_POWER,
  noFuel: CONCERN_NO_FUEL,
  starved: CONCERN_STARVED,
  bufferFull: CONCERN_BUFFER_FULL,
  throttled: CONCERN_THROTTLED,
};

/**
 * A parallel-array table of drawable entities.
 *
 * `x`/`y` are this tick's simulation position; `prevX`/`prevY` are last tick's, for interpolation.
 * There is no `z` and there never will be — elevation is derived in the view (ADR-0004), and
 * `test/architecture/layering.test.ts` fails the build if one appears here.
 */
export class EntityTable {
  capacity: number;
  count = 0;

  ids: Int32Array;
  /** Index into the snapshot's `typeNames`. A string per entity per frame would be the whole budget. */
  typeIndex: Uint8Array;
  owner: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  hp: Float32Array;
  maxHp: Float32Array;
  radius: Float32Array;
  facing: Float32Array;
  flags: Uint8Array;
  /** Veterancy rank 0–3 for units; Spaceport-style tier for buildings. Drives the chevron overlay. */
  rank: Uint8Array;
  /** 0..1 — build progress for buildings, cargo fullness for anything with a hold. */
  progress: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ids = new Int32Array(capacity);
    this.typeIndex = new Uint8Array(capacity);
    this.owner = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.hp = new Float32Array(capacity);
    this.maxHp = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.facing = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.rank = new Uint8Array(capacity);
    this.progress = new Float32Array(capacity);
  }

  /**
   * Grow to at least `needed`, in powers of two, preserving nothing.
   *
   * Called from the extractor, which runs on a sim tick — not on a render frame (ADR-0008's
   * "growth is power-of-two and off-frame"). Doubling means a match that peaks at 400 units
   * reallocates a handful of times in its first minute and never again.
   */
  ensure(needed: number): boolean {
    if (needed <= this.capacity) return false;
    let next = this.capacity || 64;
    while (next < needed) next *= 2;
    const grown = new EntityTable(next);
    this.capacity = next;
    this.ids = grown.ids;
    this.typeIndex = grown.typeIndex;
    this.owner = grown.owner;
    this.x = grown.x;
    this.y = grown.y;
    this.prevX = grown.prevX;
    this.prevY = grown.prevY;
    this.hp = grown.hp;
    this.maxHp = grown.maxHp;
    this.radius = grown.radius;
    this.facing = grown.facing;
    this.flags = grown.flags;
    this.rank = grown.rank;
    this.progress = grown.progress;
    return true;
  }
}

/** Resource nodes: static except for `amount`, so they get their own smaller table. */
export class NodeTable {
  capacity: number;
  count = 0;
  ids: Int32Array;
  comIndex: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  /** Remaining fraction 0..1 — the mesh shrinks as a deposit is worked out. */
  remaining: Float32Array;
  /**
   * Where the deposit came from: `NODE_NATURAL`, `NODE_SALVAGE` or `NODE_CRATER` (ADR-0018).
   *
   * The engine makes all three the same kind of object on purpose — `bomb.js` says a crater is
   * "indistinguishable to gather.js/rendering/fog from anything engine/map.js generated" — so this
   * byte is the only thing that separates a battlefield from a landscape.
   */
  kind: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ids = new Int32Array(capacity);
    this.comIndex = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.remaining = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 32;
    while (next < needed) next *= 2;
    const grown = new NodeTable(next);
    this.capacity = next;
    this.ids = grown.ids;
    this.comIndex = grown.comIndex;
    this.x = grown.x;
    this.y = grown.y;
    this.remaining = grown.remaining;
    this.kind = grown.kind;
  }
}

export interface SnapshotResources {
  ore: number;
  crystals: number;
  radioactives: number;
  supplyUsed: number;
  supplyCap: number;
  credits: number;
}

/**
 * The four numbers every building carries, parallel to `EntityTable` (ADR-0012 §1).
 *
 * Four, not twenty-three: a commodity buffer is only ever *displayed*, and the only building whose
 * buffers are on screen is the one the player clicked. What the *world* needs is enough to make a
 * stalled smelter look stalled from across the map, and that is this.
 */
export class ProductionTable {
  capacity: number;

  /** Index into `Snapshot.recipeNames`, or -1 for anything without a recipe. */
  recipe: Int8Array;
  /** Input-larder fullness, 0..1. How well fed it is. */
  fed: Float32Array;
  /** Output-buffer fullness, 0..1. At 1 the factory stalls until something hauls it away. */
  output: Float32Array;
  /** One of the `CONCERN_*` codes. */
  concern: Uint8Array;
  /** One of the `ACTIVITY_*` codes. Ours, not the engine's — see `ACTIVITY_IDLE`. */
  activity: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.recipe = new Int8Array(capacity).fill(-1);
    this.fed = new Float32Array(capacity);
    this.output = new Float32Array(capacity);
    this.concern = new Uint8Array(capacity);
    this.activity = new Uint8Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 64;
    while (next < needed) next *= 2;
    const grown = new ProductionTable(next);
    this.capacity = next;
    this.recipe = grown.recipe;
    this.fed = grown.fed;
    this.output = grown.output;
    this.concern = grown.concern;
    this.activity = grown.activity;
  }
}

/**
 * Guard-aura projectors — the Aegis unit and the Aegis Bastion (P3-T04).
 *
 * The engine rebuilds `state.anvils` every tick from live positions (`collectAnvils`, sim.js), so
 * this is a copy of the engine's own list rather than anything derived: the radius is
 * `guardAura.range` and nothing here recomputes it. Position is re-read every tick because the
 * Aegis *unit* moves, and a ring left behind where it used to be would be worse than no ring.
 *
 * The damage multiplier deliberately does NOT cross. It is a number for a panel, not a shape, and
 * carrying it beside a radius on the same row is how one gets drawn as the other.
 */
export class AuraTable {
  capacity: number;
  count = 0;
  x: Float32Array;
  y: Float32Array;
  /** World units. The engine's `guardAura.range` — 96 for the Aegis, 130 for the Bastion. */
  radius: Float32Array;
  owner: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.owner = new Uint8Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 16;
    while (next < needed) next *= 2;
    const grown = new AuraTable(next);
    this.capacity = next;
    this.x = grown.x;
    this.y = grown.y;
    this.radius = grown.radius;
    this.owner = grown.owner;
  }
}

/** An armed bomb whose fuse has not been lit. `fuse` carries this instead of a countdown. */
export const FUSE_UNLIT = -1;

/**
 * Helium Bombs the player is entitled to see, and where they will reach (P3-T10).
 *
 * **Derived from unit state, not from the `bombFused` event — and that is the opposite of the answer
 * ADR-0023 gives for shots.** The two are worth contrasting, because the rule is not "always read
 * the event": it is *read the thing that describes what you are drawing*. A tracer is a MOMENT, and
 * `attackHit` is a moment — one per landed hit, carrying both ends of the line. A blast warning is a
 * STATE that lasts four seconds, and `bombFused` is a moment too: it fires *once*, on the tick the
 * fuse lights, so a warning built on it would be correct for one tick in eighty and a player who
 * looked away would get none at all. `bomb.fuseUntil` is the field that persists for the whole four
 * seconds. Worse, disarming cuts a lit fuse and emits nothing, so an event-driven warning would keep
 * counting down to a blast that is never coming.
 *
 * (ADR-0017 drew the same contrast the other way round, on a premise PARITY §7.1 disproved: it said
 * a shot leaves no trace and a diff was the only honest signal. It leaves `attackHit`.)
 *
 * Both radii cross, because the engine's own `bombDetonated` event carries both. One ring cannot
 * describe this blast: at `core` everything dies outright, at `blast` the damage has fallen to zero,
 * and a single circle would either overstate the threat at the rim or hide it at the centre.
 */
export class BombTable {
  capacity: number;
  count = 0;
  /**
   * `BOMB_FUSE_DELAY`, carried once for the whole table rather than per row.
   *
   * The view needs it to draw a countdown as a *fraction*, and `view/` may not import the engine
   * (ADR-0008) — so without this the only way to draw an arc is a hardcoded 4 that agrees with the
   * engine until someone tunes the fuse. It is a table-level scalar because it is one constant, not
   * a property of any particular bomb.
   */
  fuseDelay = 0;
  x: Float32Array;
  y: Float32Array;
  /** `BOMB_CORE_RADIUS` — inside this, everything takes the flat peak hit. */
  core: Float32Array;
  /** `BOMB_BLAST_RADIUS` — damage reaches zero here. */
  blast: Float32Array;
  /** Sim seconds left on a lit fuse, or `FUSE_UNLIT` for an armed bomb that has not been tripped. */
  fuse: Float32Array;
  owner: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.core = new Float32Array(capacity);
    this.blast = new Float32Array(capacity);
    this.fuse = new Float32Array(capacity);
    this.owner = new Uint8Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 8;
    while (next < needed) next *= 2;
    const grown = new BombTable(next);
    this.capacity = next;
    this.x = grown.x;
    this.y = grown.y;
    this.core = grown.core;
    this.blast = grown.blast;
    this.fuse = grown.fuse;
    this.owner = grown.owner;
  }
}

/**
 * Shots that landed this tick (P6-T01, ADR-0023 — which supersedes ADR-0017).
 *
 * **A shot is the engine's own `attackHit` event, read rather than derived.** `combat.js:187`
 * pushes one inside `performAttack` — shared by mobile units, workers and turrets — carrying
 * `fromX`/`fromY` (the shooter) and `x`/`y` (the target), **both stamped before the corpse is
 * removed**. So the tracer's two endpoints arrive with the shot and nothing has to be looked up.
 *
 * ADR-0017 derived a shot by diffing `attackTimer` instead, on a premise PARITY §7.1 checked
 * against the source and found false. Measured cost of the derivation, on a Skiff right-clicked
 * onto a Worker: **10 shots, 0 tracers, 10 `dropped`** — because the endpoint came from
 * `unit.autoTarget` and an explicitly ordered attack takes its target off `unit.order`, leaving
 * `combat.js:65` (the only line in the engine that writes `autoTarget`) unreachable. Two more
 * losses the ADR did not know about are recorded in ADR-0023's Context.
 *
 * **`dropped` survives, with a narrower job.** It no longer counts an endpoint that could not be
 * resolved — the event carries both, so there is nothing to resolve. It counts an `attackHit` whose
 * four coordinates are not all finite numbers, which is the single assumption this whole design
 * rests on: if upstream ever ships a hit without both endpoints, the tracer set shrinks silently and
 * this is what says so. It must stay 0.
 */
export class ShotTable {
  capacity: number;
  count = 0;
  /** `attackHit` events whose endpoints were not four finite numbers. Must stay 0. */
  dropped = 0;
  fromX: Float32Array;
  fromY: Float32Array;
  toX: Float32Array;
  toY: Float32Array;
  owner: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.fromX = new Float32Array(capacity);
    this.fromY = new Float32Array(capacity);
    this.toX = new Float32Array(capacity);
    this.toY = new Float32Array(capacity);
    this.owner = new Uint8Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 64;
    while (next < needed) next *= 2;
    const grown = new ShotTable(next);
    this.capacity = next;
    this.fromX = grown.fromX;
    this.fromY = grown.fromY;
    this.toX = grown.toX;
    this.toY = grown.toY;
    this.owner = grown.owner;
  }
}

/**
 * Hits that LANDED this tick, from the engine's own `attackHit` event (P5-T15; PARITY rows 66–68).
 *
 * **The engine has been describing every hit since before Phase 3 was scoped and nothing read it.**
 * `combat.js` pushes an `attackHit` inside `performAttack` — shared by mobile units and turrets —
 * and hangs three presentation-only fields on it, each with a comment naming the thing that was
 * meant to draw it: `heavy` "so a siege hit thumps deeper", `bonus` "so a counter-triangle hit …
 * telegraphs too", and `splashRadius` "so renderEffects.js can draw an impact ring". Zero sim
 * effect; the engine's own comment says the flags "are read only by the UI layer".
 *
 * ADR-0017 opens by stating there is no combat event but `entityKilled`. PARITY §7.1 checked that
 * against the vendored source and it is false — sixteen event types, and this is one of them. P5-T15
 * left the tracer's derivation alone and read the event only for the three cue flags; **P6-T01 then
 * measured the derivation's cost and ADR-0023 moved the tracer onto this same event.** So this table
 * and `ShotTable` are now two readings of one payload, and they gate on different halves of it on
 * purpose — see the fog paragraph below.
 *
 * All three fields are the engine's answers, copied and not re-derived (ADR-0012 §5). That matters
 * most for `splashRadius`: it is `def.splash.radius`, a WEAPON property, and the alternative — the
 * view looking a radius up from a unit type — is impossible anyway (ADR-0008 forbids `view/` the
 * engine) and would be a second opinion about a number the event already states.
 *
 * **Fog: live vision at the impact point, and deliberately not the `explored` rule `DeathTable`
 * uses.** A death leaves a wreck deposit the player will walk up to later, so remembering one is
 * honest. A hit is a fight happening *now*: a mark on remembered-but-unseen ground would say "an
 * enemy is standing exactly here, this instant" — the same leak ADR-0017 §4 rejects for tracers and
 * ADR-0023 §3 carries forward, and worse, because a ring is a point rather than a line.
 *
 * **The two gates read the same event and ask different questions of it, deliberately.** A tracer is
 * gated on `fromX`/`fromY` (can I see the shooter?) and an impact on `x`/`y` (can I see where it
 * landed?), which is what lets a player shot from the dark see the hit on their own unit — always on
 * ground they can see — while the line that would point straight back at the artillery stays
 * suppressed. ADR-0017 filed "shot from the dark shows nothing" as a known cost; this is the half of
 * it that is bought back, and it survives ADR-0023 unchanged.
 */
export class ImpactTable {
  capacity: number;
  count = 0;
  /** The engine's `ev.x`/`ev.y` — the TARGET's position, which is where the damage landed. */
  x: Float32Array;
  y: Float32Array;
  /** The ATTACKER's owner, as the event carries it. The shot's colour, not the target's. */
  owner: Uint8Array;
  /** 1 when `def.bonusVsBuildings` applied — a siege weapon on a structure (row 66). */
  heavy: Uint8Array;
  /** 1 when `def.bonusVs[target.type]` applied — the counter triangle, landing (row 67). */
  bonus: Uint8Array;
  /**
   * The weapon's own `def.splash.radius` in world units, or 0 for a weapon with no splash (row 68).
   *
   * Zero rather than a sentinel: "no splash" and "a splash of nothing" are the same picture, so
   * unlike `BombTable.fuse`'s `FUSE_UNLIT` there is no state here that a number cannot say.
   */
  splashRadius: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.owner = new Uint8Array(capacity);
    this.heavy = new Uint8Array(capacity);
    this.bonus = new Uint8Array(capacity);
    this.splashRadius = new Float32Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 64;
    while (next < needed) next *= 2;
    const grown = new ImpactTable(next);
    this.capacity = next;
    this.x = grown.x;
    this.y = grown.y;
    this.owner = grown.owner;
    this.heavy = grown.heavy;
    this.bonus = grown.bonus;
    this.splashRadius = grown.splashRadius;
  }
}

/**
 * Where a selected producer sends what it builds (P5-T15; PARITY row 8).
 *
 * The `rally` overlay kind has existed in `renderer/port.ts` since Phase 1 and **both product
 * renderers already draw it** — the only caller was `view/landing.ts`, drawing a line to a landing
 * point. The battlefield never pushed one, so the engine's `building.rally` reached nothing.
 *
 * Three filters, each of them a decision rather than an omission:
 *
 *   • **The viewer's own buildings only.** An enemy's rally point is where their reinforcements
 *     will arrive, which is intel a player has to scout for. Buildings cross this bridge on
 *     *explored* memory, so without this an hour-old scouting pass would keep drawing a live line
 *     out of an enemy factory. No further fog rule is needed once this one is in place: a player is
 *     never fogged from their own base.
 *   • **Producers only** — `BUILDINGS[type].produces`. This is upstream's own rule, not ours, and
 *     the engine states it in its data: `refinery`, `habitat`, `foundry`, `market` and `datacenter`
 *     each carry a comment saying that having no `produces` "keeps it out of the rally-point UI and
 *     rally rendering". Only `command`, `barracks` and `stardock` train anything.
 *   • **Selected only.** The same rule Q-07 applies to a building's commodity buffers: the
 *     expensive detail belongs to the thing the player clicked. `makeBuilding` gives *every*
 *     building a rally at `(x + 60, y + 60)` from birth, so drawing every producer's would paint an
 *     identical diagonal stub out of every factory in the base — and a cue on all of them is not a
 *     cue (the same argument `hasStatusGlyph` makes for badges).
 *
 * That default is not a null and is not treated as one: `updateProduction` really does send new
 * units to it, so the stub is where they will really walk. Drawing it is how a player learns the
 * rally point exists at all — which matters here more than usual, since the order that MOVES it
 * (`issueSetRally`) has had an intent and no producer since Phase 1 (PARITY row 31).
 *
 * `nodeId` deliberately does not cross. Rally-to-node makes a new worker spawn already mining, and
 * it is a difference in what happens on arrival rather than in where the line goes; carrying it
 * would widen the `rally` overlay's stride, which `view/landing.ts` shares.
 */
export class RallyTable {
  capacity: number;
  count = 0;
  /** The building. Owner is not carried: only the viewer's own ever cross. */
  fromX: Float32Array;
  fromY: Float32Array;
  /** `building.rally` — where the next unit out of it walks. */
  toX: Float32Array;
  toY: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.fromX = new Float32Array(capacity);
    this.fromY = new Float32Array(capacity);
    this.toX = new Float32Array(capacity);
    this.toY = new Float32Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 8;
    while (next < needed) next *= 2;
    const grown = new RallyTable(next);
    this.capacity = next;
    this.fromX = grown.fromX;
    this.fromY = grown.fromY;
    this.toX = grown.toX;
    this.toY = grown.toY;
  }
}

/**
 * Entities that died this tick — the one combat cue the engine hands over ready-made (P3-T07).
 *
 * `WorldBridge.step` used to clear `state.events` and throw the contents away, on the grounds that
 * nothing consumed them in the MVP. This is what consumes them. Per-tick, never a running log: a
 * twenty-minute match would otherwise accumulate every death it ever saw.
 */
export class DeathTable {
  capacity: number;
  count = 0;
  x: Float32Array;
  y: Float32Array;
  owner: Uint8Array;
  /** 1 for a building, 0 for a unit — a base going down reads differently from a skirmisher. */
  isBuilding: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.owner = new Uint8Array(capacity);
    this.isBuilding = new Uint8Array(capacity);
  }

  ensure(needed: number): void {
    if (needed <= this.capacity) return;
    let next = this.capacity || 32;
    while (next < needed) next *= 2;
    const grown = new DeathTable(next);
    this.capacity = next;
    this.x = grown.x;
    this.y = grown.y;
    this.owner = grown.owner;
    this.isBuilding = grown.isBuilding;
  }
}

/** The full commodity buffers of one selected building. Only the selection gets these (Q-07). */
export interface BuildingBuffers {
  input: Record<string, number>;
  output: Record<string, number>;
  recipe: Recipe | null;
  /** Per-commodity larder capacity, so a panel can draw a bar rather than a bare number. */
  inputCap: number;
  outputCap: number;
}

/**
 * Everything a frame may read. Versions let the view cache derived work (meshes, fog textures,
 * HUD strings) without diffing: a counter that has not moved means nothing changed.
 */
export interface Snapshot {
  tick: number;
  time: number;
  /** Bumped on every extraction. The interpolator uses it to detect a tick boundary. */
  version: number;
  entities: EntityTable;
  nodes: NodeTable;
  /** Guard-aura projectors the player can see (P3-T04). */
  auras: AuraTable;
  /** Armed Helium Bombs the player is entitled to see (P3-T10). */
  bombs: BombTable;
  /** Shots that landed this tick, from the engine's own `attackHit` (P6-T01, ADR-0023). */
  shots: ShotTable;
  /** Hits that landed this tick, from the engine's own `attackHit` (P5-T15, rows 66–68). */
  impacts: ImpactTable;
  /** Rally lines for the selected producers the viewer owns (P5-T15, row 8). */
  rally: RallyTable;
  /** Entities that died this tick, from the engine's own events (P3-T07). */
  deaths: DeathTable;
  /** Stable index → engine type name. Grows only when a type is first seen. */
  typeNames: string[];
  comNames: string[];
  fog: {
    cols: number;
    rows: number;
    cell: number;
    state: Uint8Array;
    /** Bumped only when the field actually changed — the renderer re-uploads on this. */
    version: number;
  };
  map: {
    width: number;
    height: number;
    baseX: number;
    baseY: number;
  };
  resources: SnapshotResources;
  /**
   * The viewer's whole stockpile, every commodity the engine knows, absent meaning 0.
   *
   * `resources` above stays as the MVP's hot four because the resource bar reads them every frame
   * and they are the ones with dedicated slots in it. This is the rest, for the panels.
   */
  stockpile: Record<string, number>;
  /** Parallel to `entities`. */
  production: ProductionTable;
  /** Stable index → recipe id, the same trick `typeNames` plays. */
  recipeNames: string[];
  /** Full buffers, for the selection only. Keyed by engine id. */
  buffers: Map<string, BuildingBuffers>;
  /**
   * The power grid as a field of bands at fog resolution, updated only when the set of active
   * sources changes — the same version-counter contract fog has, for the same reason (Q-08).
   */
  power: {
    cols: number;
    rows: number;
    cell: number;
    state: Uint8Array;
    version: number;
  };
  /** Selected entity ids, as engine strings — the HUD needs identity, not just a flag. */
  selection: string[];
  /** Numeric ids that existed last tick and do not exist now. Interpolation reads it. */
  removed: Set<number>;
  /** Numeric ids that appeared this tick. They must not interpolate in from a stale position. */
  spawned: Set<number>;
}

/**
 * Engine ids packed into the one `Int32Array` every hot table is made of, and back again.
 *
 * The simulation mints ids in namespaces it keeps **deliberately** apart, and says so in its own
 * comments — `engine/bomb.js` on `crater-${bomb.id}`: *"so it can never collide with a
 * map-generated node's `n<N>` id scheme — the two id spaces are namespaced apart by construction"*.
 * There are five:
 *
 *   • `u12` — a unit.               `b7` — a building.               `n3` — a map deposit.
 *   • `g4`  — anything the GALAXY minted: the relief ship `checkGalaxyRescue` sends a wiped-out
 *     player, and every rider `jumpCapital` lands on a new world. Both from `galaxy.entitySeq`.
 *   • `wreck-u12-ore`, `crater-bomb3-ore` — salvage and crater deposits, named off the entity that
 *     died there. **No number to pack at all.**
 *
 * This used to be `Number.parseInt(id.slice(1))`, sign-flipped for buildings, which collapsed all
 * five onto one. Two live breakages came out of that, both of them a dead click on the exact
 * object the player was told to click:
 *
 *   • `n7`, `u7` and `g7` all packed to **8**. So `entityAt` resolved the relief ship's `g1` to
 *     `u1` — which either names nothing (the selection stays empty) or names a *different unit*,
 *     which is worse: every subsequent order goes to it. Whole expeditions land under `g` ids.
 *   • `parseInt("reck-u12-ore")` is **NaN**, and an `Int32Array` stores NaN as **0**. Every wreck
 *     and every crater on the map packed to the same 0 and decoded to the id `n-1`, so no salvage
 *     deposit and no crater in the game could be right-clicked (ADR-0018, shipped in Phase 3).
 *
 * So each namespace gets its own band, and ids with nothing to pack are interned. Buildings keep
 * the sign convention because `isBuildingId` is what lets a single number carry the kind — and
 * they can keep it: `jumpCapital` re-ids **riders only**, so no building ever carries a `g`.
 */
// 16.7 M ids per namespace against four bands, inside `Int32Array`'s 2.1 B with two orders of
// magnitude spare. A counter that reached the band edge would encode into its NEIGHBOUR's space and
// decode as the wrong kind — silently, which is the failure mode this whole rewrite exists to
// remove — so `numericId` interns anything that big instead. That is slower and correct rather than
// fast and wrong, and it is what makes the codec total for *every* counter value rather than for
// the ones a match happens to reach.
const ID_BAND = 1 << 24;
const BAND_GALAXY = ID_BAND;
const BAND_NODE = 2 * ID_BAND;
const BAND_OPAQUE = 3 * ID_BAND;

/**
 * `wreck-…` / `crater-…` ids, interned in first-seen order — the one namespace with no counter to
 * read. Hashing them would reintroduce exactly the collision this exists to remove.
 *
 * It only grows, which is deliberate and cheap: the entries are the strings the engine already
 * holds, and a match makes hundreds, not millions. Two worlds can mint the same `wreck-u12-ore`,
 * and that is fine — a snapshot only ever holds the active seat, so they never coexist in one
 * table, and the same string mapping to the same integer is the correct answer anyway.
 */
const opaqueIds: string[] = [];
const opaqueIndex = new Map<string, number>();

export function numericId(id: string): number {
  // Hand-rolled rather than `parseInt(id.slice(1))`, because `slice` allocates a string and this
  // runs for every entity and every node, every tick (ADR-0006: no per-frame allocation). Falling
  // out of it: "the digits ran out" is a branch here, where it used to be a silent NaN.
  const len = id.length;
  if (len < 2) return intern(id);
  let n = 0;
  for (let i = 1; i < len; i++) {
    const d = id.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return intern(id);
    n = n * 10 + d;
  }
  const kind = id.charCodeAt(0);
  // Buildings own the ENTIRE negative half and are not banded, so they need no bound and must not
  // take the guard below: interning one would hand it a positive id, and `isBuildingId` — the only
  // channel the snapshot has for an entity's kind — would then call a building a unit.
  if (kind === 98 /* 'b' */) return -(n + 1);
  if (n + 1 >= ID_BAND) return intern(id);  // see ID_BAND: never encode into the next band
  switch (kind) {
    case 117: return n + 1;                 // 'u'
    case 103: return BAND_GALAXY + n + 1;   // 'g'
    case 110: return BAND_NODE + n + 1;     // 'n'
    default:  return intern(id);            // a namespace this client has not met yet
  }
}

/**
 * The inverse. **This is the only one** — it used to be copied into `intents.ts`, `hud.ts`,
 * `game.ts` and `building-panel.ts`, four transcriptions of three lines, and all four were wrong
 * in the same two ways because that is what four copies of a rule do.
 */
export function engineId(numeric: number): string {
  if (numeric < 0) return `b${-numeric - 1}`;
  if (numeric > BAND_OPAQUE) return opaqueIds[numeric - BAND_OPAQUE - 1] ?? "";
  if (numeric > BAND_NODE) return `n${numeric - BAND_NODE - 1}`;
  if (numeric > BAND_GALAXY) return `g${numeric - BAND_GALAXY - 1}`;
  // Zero is not a packed id — nothing encodes to it now that NaN cannot. Naming it beats returning
  // the confident lie `u-1`.
  return numeric === 0 ? "" : `u${numeric - 1}`;
}

function intern(id: string): number {
  let i = opaqueIndex.get(id);
  if (i === undefined) {
    i = opaqueIds.length;
    opaqueIds.push(id);
    opaqueIndex.set(id, i);
  }
  return BAND_OPAQUE + i + 1;
}

export function isBuildingId(numeric: number): boolean {
  return numeric < 0;
}

/**
 * How full a unit's hold is, 0..1 — the cargo cue's whole input (P2-T05, P2-T07).
 *
 * The denominator is the engine's own `tripCapacity` rule (`cargoCap ?? cargoHold`, engine/haul.js).
 * It used to be the literal `10`, which is the Worker's `cargoCap` and nothing else's: a Hauler
 * holds 250 and a Bulk Freighter 1600, so ten crates aboard — four percent, or half of one — read
 * as a **full** hold. Every logistics unit in the game showed a laden cue from its first crate and
 * never changed again, which is precisely the state P2-T05's shade was added to distinguish.
 *
 * Zero-capacity units are real: the scenario-spawned `freighter` defines neither field, so the
 * engine's own rule gives it 0 and it can never legitimately load. Fullness is undefined there, not
 * infinite — and the arithmetic matters more than it looks, because this number rides the instance
 * `shade` into a vertex buffer, where one NaN corrupts a whole batch rather than one unit.
 */
/**
 * What a building is doing (P2-T08) — `ACTIVITY_*`, derived here and clearly ours.
 *
 * A building is IDLE when it *could* be working and is not. Today that means one thing: it trains
 * units (`def.produces`) and its queue is empty. That is deliberately narrower than it sounds — a
 * factory with a recipe is never idle, because the engine always has a reason it is stopped and
 * `buildingConcern` will have named it (starved, buffer full, no power). Reporting such a factory
 * as *both* starved and idle would give the frame two badges saying different things about the same
 * building, and the player would have to guess which one to act on.
 *
 * Anything under construction or being recycled reports NONE: it is mid-transition, its state is
 * already carried by the construction cue, and a badge on a half-built shell reads as a fault.
 */
export function activityOf(b: Building, hasRecipe: boolean, concern: number): number {
  if (b.constructing || b.recycling) return ACTIVITY_NONE;
  const produces = BUILDINGS[b.type]?.produces;
  if (produces && produces.length > 0) {
    // Only `command`, `barracks` and `stardock` train, and none of the three has a recipe, so this
    // branch and the next never overlap and no precedence between them has to be invented.
    return b.queue.length > 0 ? ACTIVITY_WORKING : ACTIVITY_IDLE;
  }
  if (!hasRecipe) return ACTIVITY_NONE;
  // A factory is WORKING only when nothing is stopping it. Reporting a starved smelter as working
  // because it holds a recipe would put a lie in the data that today's view happens not to read —
  // and the next reader would find it the hard way.
  return concern === CONCERN_NONE || concern === CONCERN_THROTTLED ? ACTIVITY_WORKING : ACTIVITY_NONE;
}

export function cargoFullness(u: Unit): number {
  if (!u.cargo || !(u.cargo.qty > 0)) return 0;
  const def = UNITS[u.type] as { cargoCap?: number; cargoHold?: number } | undefined;
  const cap = def?.cargoCap ?? def?.cargoHold ?? 0;
  if (!(cap > 0)) return 0;
  return Math.min(1, u.cargo.qty / cap);
}

export interface ExtractOptions {
  /** Which side's fog decides visibility. Always "player" in the MVP; an argument for Observer Mode. */
  viewer: OwnerId;
  /** Galaxy-wide credits, which live above the world state. */
  credits: number;
  /** Supply is a derived engine query; the caller passes it so the bridge stays a pure copier. */
  supplyUsed: number;
  supplyCap: number;
}

/**
 * Extract a snapshot from engine state, reusing the previous one's buffers.
 *
 * Allocation-free in the steady state: the only allocations are the growth path (power of two, on
 * a tick) and first-sight type-name registration (bounded by the roster size).
 */
export class SnapshotExtractor {
  readonly snapshot: Snapshot;

  private readonly typeIndexByName = new Map<string, number>();
  private readonly comIndexByName = new Map<string, number>();
  private readonly recipeIndexById = new Map<string, number>();
  private readonly facingById = new Map<number, number>();
  /** Reused buffer records, so selecting and deselecting all day allocates nothing. */
  private readonly bufferPool: BuildingBuffers[] = [];
  private powerHash = -1;
  /**
   * numeric id → offset into `prevBuf`, rebuilt from the previous extraction each tick.
   *
   * **Interpolation only, since ADR-0023.** ADR-0017 also used it to place the endpoint of a killing
   * shot, which is what made `extractShots` ordering-sensitive; the `attackHit` event carries that
   * endpoint itself, so nothing in the shot path consults this any more.
   */
  private readonly prevPos = new Map<number, number>();
  private prevBuf: Float32Array;
  private fogHash = -1;

  constructor(map: GameMap, initialCapacity = 256) {
    const cols = Math.ceil(map.width / FOG_CELL_SIZE);
    const rows = Math.ceil(map.height / FOG_CELL_SIZE);
    this.prevBuf = new Float32Array(initialCapacity * 2);
    this.snapshot = {
      tick: 0,
      time: 0,
      version: 0,
      entities: new EntityTable(initialCapacity),
      nodes: new NodeTable(Math.max(32, map.nodes.length)),
      auras: new AuraTable(16),
      bombs: new BombTable(8),
      shots: new ShotTable(64),
      impacts: new ImpactTable(64),
      rally: new RallyTable(8),
      deaths: new DeathTable(32),
      typeNames: [],
      comNames: [],
      fog: { cols, rows, cell: FOG_CELL_SIZE, state: new Uint8Array(cols * rows), version: 0 },
      map: { width: map.width, height: map.height, baseX: map.bases.player.x, baseY: map.bases.player.y },
      resources: { ore: 0, crystals: 0, radioactives: 0, supplyUsed: 0, supplyCap: 0, credits: 0 },
      // Every commodity gets its slot up front. A panel reading `undefined ore` looks like a crash,
      // and pre-seeding costs 23 numbers once rather than a branch per read forever.
      stockpile: Object.fromEntries(Object.keys(COM).map((c) => [c, 0])),
      production: new ProductionTable(initialCapacity),
      recipeNames: [],
      buffers: new Map(),
      power: { cols, rows, cell: FOG_CELL_SIZE, state: new Uint8Array(cols * rows), version: 0 },
      selection: [],
      removed: new Set(),
      spawned: new Set(),
    };
  }

  extract(state: State, opts: ExtractOptions): Snapshot {
    const snap = this.snapshot;
    const fog = state.fogs[opts.viewer];
    snap.entities.ensure(state.units.size + state.buildings.size);
    snap.production.ensure(snap.entities.capacity);
    this.rememberPreviousPositions();

    const e = snap.entities;
    const selected = state.selection;
    let n = 0;

    for (const b of state.buildings.values()) {
      // Buildings are revealed by the *explored* memory, not by live vision: a base you scouted an
      // hour ago is still there, and forgetting it is worse than the small intel it gives. Their
      // positions never change, so this leaks nothing the player did not already earn.
      if (!isVisibleAt(fog, b.x, b.y) && !exploredAt(fog, b.x, b.y)) continue;
      const id = numericId(b.id);
      e.ids[n] = id;
      e.typeIndex[n] = this.typeIdx(b.type);
      e.owner[n] = b.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      e.x[n] = b.x;
      e.y[n] = b.y;
      e.prevX[n] = b.x;                      // buildings never move; prev === current always
      e.prevY[n] = b.y;
      e.hp[n] = b.hp;
      e.maxHp[n] = b.maxHp;
      e.radius[n] = b.radius || BUILDINGS[b.type]?.radius || 16;
      e.facing[n] = 0;
      e.flags[n] = FLAG_BUILDING_KIND
        | (b.constructing ? FLAG_CONSTRUCTING : 0)
        | (selected.includes(b.id) ? FLAG_SELECTED : 0);
      e.rank[n] = Math.min(3, b.tier ?? 0);
      e.progress[n] = b.constructing ? b.buildProgress : 1;
      this.extractProduction(state, b, n);
      n++;
    }

    for (const u of state.units.values()) {
      // Units move, so live vision — not memory — decides. This is the line that makes F-06 true.
      if (!isVisibleAt(fog, u.x, u.y)) continue;
      const id = numericId(u.id);
      const prev = this.prevPos.get(id);
      const px = prev === undefined ? u.x : this.prevBuf[prev]!;
      const py = prev === undefined ? u.y : this.prevBuf[prev + 1]!;

      e.ids[n] = id;
      e.typeIndex[n] = this.typeIdx(u.type);
      e.owner[n] = u.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      e.x[n] = u.x;
      e.y[n] = u.y;
      e.prevX[n] = px;
      e.prevY[n] = py;
      e.hp[n] = u.hp;
      e.maxHp[n] = u.maxHp;
      e.radius[n] = UNITS[u.type]?.radius ?? 6;

      // Facing is presentation, derived from this tick's own movement (ADR-0004: decoration is
      // allowed, feeding back into the sim is not). A stationary unit keeps its last heading —
      // snapping to zero would make an idle army all face north the moment it stopped.
      const dx = u.x - px;
      const dy = u.y - py;
      const moved = dx * dx + dy * dy;
      const facing = moved > 1e-6 ? Math.atan2(dx, dy) : (this.facingById.get(id) ?? 0);
      e.facing[n] = facing;
      this.facingById.set(id, facing);

      e.flags[n] = (u.cargo && u.cargo.qty > 0 ? FLAG_CARRYING : 0)
        | (moved > 1e-4 ? FLAG_MOVING : 0)
        | (selected.includes(u.id) ? FLAG_SELECTED : 0);
      e.rank[n] = rankOf(u.kills ?? 0);
      e.progress[n] = cargoFullness(u);
      const p = snap.production;
      p.recipe[n] = -1;
      p.fed[n] = 0;
      p.output[n] = 0;
      p.concern[n] = CONCERN_NONE;
      n++;
    }

    e.count = n;
    this.diffLifetimes();
    // **No ordering here is load-bearing any more, and that is a change worth stating rather than a
    // comment worth deleting.** Until ADR-0023 this line read "`extractShots` FIRST", because a
    // killing shot's endpoint came out of `prevPos` and `rememberPreviousPositions` refills it.
    // Shots are now read off `attackHit`, which stamps both endpoints before the corpse is removed,
    // so every extractor below reads only `state` and this tick's events. The three that consume
    // `state.events` — shots, impacts, deaths — must still run before `WorldBridge.step` drains the
    // list, which it does after `refresh()` returns, not inside this method.
    this.extractShots(state, fog);
    this.extractImpacts(state, fog);
    this.extractDeaths(state, fog);
    this.extractRally(state, opts.viewer);
    this.extractNodes(state, fog);
    this.extractAuras(state, fog);
    this.extractBombs(state, fog);
    this.extractFog(fog);
    this.extractPower(state, opts.viewer);

    const res = state.players.player.resources;
    const r = snap.resources;
    r.ore = res.ore ?? 0;
    r.crystals = res.crystals ?? 0;
    r.radioactives = res.radioactives ?? 0;
    r.supplyUsed = opts.supplyUsed;
    r.supplyCap = opts.supplyCap;
    r.credits = opts.credits;

    // The whole stockpile, over the same object every tick.
    const stock = snap.stockpile;
    for (const com in stock) stock[com] = res[com] ?? 0;

    this.extractBuffers(state);

    snap.selection.length = 0;
    for (const id of selected) snap.selection.push(id);

    snap.tick = state.tick;
    snap.time = state.time;
    snap.version++;
    return snap;
  }

  private typeIdx(name: string): number {
    let i = this.typeIndexByName.get(name);
    if (i === undefined) {
      i = this.snapshot.typeNames.length;
      this.snapshot.typeNames.push(name);
      this.typeIndexByName.set(name, i);
    }
    return i;
  }

  /**
   * The four-number production summary for one building.
   *
   * The stop reason is `buildingConcern`'s, mapped to an integer and not otherwise touched. It is
   * tempting to derive it here — the buffers are right there — and it would be wrong within one
   * upstream change to `updateProduction`'s gating order, which is the exact disagreement
   * ADR-0012 §5 exists to prevent.
   */
  private extractProduction(state: State, b: Building, n: number): void {
    const p = this.snapshot.production;
    const recipe = recipeOf(b);
    p.recipe[n] = recipe ? this.recipeIdx(recipe.id) : -1;

    const inputCap = inputCapOf(b.type);
    const outputCap = storeCapOf(b.type);
    // Fullness of the scarcest input, not the total: a larder holding 40 ore and no crystals is
    // starved, and an average would report it comfortably half full.
    p.fed[n] = inputCap > 0 ? clamp01(scarcestInput(b, recipe, inputCap)) : 0;
    p.output[n] = outputCap > 0 ? clamp01(storeTotal(b) / outputCap) : 0;

    const concern = buildingConcern(state, b);
    const code = concern === null
      ? CONCERN_NONE
      : concern.level === "paused"
        ? CONCERN_PAUSED
        : (CONCERN_CODES[concern.code ?? ""] ?? CONCERN_NONE);
    p.concern[n] = code;
    p.activity[n] = activityOf(b, !!recipe, code);
  }

  /**
   * Full commodity buffers, for the selection only (Q-07).
   *
   * The map is cleared and refilled from a pool each tick rather than rebuilt, so a player who
   * drags a selection box around for ten minutes allocates the same handful of objects.
   */
  private extractBuffers(state: State): void {
    const buffers = this.snapshot.buffers;
    let pooled = 0;
    for (const entry of buffers.values()) this.bufferPool[pooled++] = entry;
    buffers.clear();

    let taken = 0;
    for (const id of state.selection) {
      const b = state.buildings.get(id);
      if (!b) continue;
      const recipe = recipeOf(b) ?? null;
      const entry = this.bufferPool[taken++] ?? { input: {}, output: {}, recipe: null, inputCap: 0, outputCap: 0 };
      // Clearing rather than replacing keeps the objects' shape stable for the JIT and keeps this
      // allocation-free; a fresh `{...b.input}` per tick is exactly what ADR-0006 forbids.
      for (const com in entry.input) delete entry.input[com];
      for (const com in entry.output) delete entry.output[com];
      for (const com in b.input) entry.input[com] = b.input[com]!;
      for (const com in b.store) entry.output[com] = b.store[com]!;
      entry.recipe = recipe;
      entry.inputCap = inputCapOf(b.type);
      entry.outputCap = storeCapOf(b.type);
      buffers.set(id, entry);
    }
    for (let i = taken; i < pooled; i++) this.bufferPool.length = taken;
  }

  /**
   * The power grid as a band per fog cell.
   *
   * Recomputed only when the set of active sources changes — which is what makes asking the engine
   * per cell affordable. The cost is `cells × buildings` inside `powerEfficiency`, about 300k
   * iterations on this map at 300 buildings, paid on a tick where a reactor was built, paused,
   * destroyed or ran dry. Every other tick is one pass over the source list to hash it.
   */
  private extractPower(state: State, viewer: OwnerId): void {
    const field = this.snapshot.power;
    let hash = 0;
    for (const b of state.buildings.values()) {
      if (b.owner !== viewer) continue;
      const def = BUILDINGS[b.type];
      if (!def) continue;
      if (!((def.energyGrants ?? 0) > 0 || def.powerRelay)) continue;
      // Position never changes, but every input to the field's shape does: whether it is finished,
      // switched off by hand, or (for a fuel burner) actually fed.
      hash = (hash * 31 + numericId(b.id)
        + (b.constructing ? 1 : 0) * 3
        + (b.paused ? 1 : 0) * 7
        + (b.powered ? 1 : 0) * 13) | 0;
    }
    if (hash === this.powerHash) return;
    this.powerHash = hash;

    for (let row = 0; row < field.rows; row++) {
      for (let col = 0; col < field.cols; col++) {
        const x = (col + 0.5) * field.cell;
        const y = (row + 0.5) * field.cell;
        // Off the grid entirely reads as POWER_NONE rather than as the neutral "linked" tier the
        // engine returns when there is no source to be far from — painting an ungridded map as
        // fully on-grid would be a confident lie.
        field.state[row * field.cols + col] = onPowerGrid(state, viewer, x, y)
          ? POWER_TIERS.indexOf(powerEfficiency(state, viewer, x, y)) + 1
          : POWER_NONE;
      }
    }
    field.version++;
  }

  private recipeIdx(id: string): number {
    let i = this.recipeIndexById.get(id);
    if (i === undefined) {
      i = this.snapshot.recipeNames.length;
      this.snapshot.recipeNames.push(id);
      this.recipeIndexById.set(id, i);
    }
    return i;
  }

  private comIdx(name: string): number {
    let i = this.comIndexByName.get(name);
    if (i === undefined) {
      i = this.snapshot.comNames.length;
      this.snapshot.comNames.push(name);
      this.comIndexByName.set(name, i);
    }
    return i;
  }

  /** Growth for the previous-position buffer. Named `ensure*` — see the allocation scan in
   *  `test/architecture/layering.test.ts`, which reads method names to tell setup from a frame. */
  private ensurePrevBuffer(capacity: number): void {
    if (this.prevBuf.length >= capacity * 2) return;
    this.prevBuf = new Float32Array(capacity * 2);
  }

  private rememberPreviousPositions(): void {
    const e = this.snapshot.entities;
    this.ensurePrevBuffer(e.capacity);
    this.prevPos.clear();
    for (let i = 0; i < e.count; i++) {
      const off = i * 2;
      this.prevBuf[off] = e.x[i]!;
      this.prevBuf[off + 1] = e.y[i]!;
      this.prevPos.set(e.ids[i]!, off);
    }
  }

  /** Who arrived and who left, so the interpolator can refuse to slide either across the map. */
  private diffLifetimes(): void {
    const snap = this.snapshot;
    const e = snap.entities;
    snap.spawned.clear();
    snap.removed.clear();
    for (let i = 0; i < e.count; i++) if (!this.prevPos.has(e.ids[i]!)) snap.spawned.add(e.ids[i]!);
    if (this.prevPos.size === 0) return;
    const live = new Set<number>();
    for (let i = 0; i < e.count; i++) live.add(e.ids[i]!);
    for (const id of this.prevPos.keys()) {
      if (!live.has(id)) {
        snap.removed.add(id);
        this.facingById.delete(id);
      }
    }
  }

  private extractNodes(state: State, fog: Fog): void {
    const nodes = this.snapshot.nodes;
    nodes.ensure(state.map.nodes.length);
    let n = 0;
    for (const node of state.map.nodes) {
      // A charted deposit stays on the map once explored; a hidden cache only exists once scouted
      // (upstream's `isNodeDiscovered`). Using the engine's own predicate keeps what the 3D view
      // shows, what the minimap dots and what a right-click can target in agreement.
      if (!exploredAt(fog, node.x, node.y) || !isNodeDiscovered(fog, node)) continue;
      nodes.ids[n] = numericId(node.id);
      nodes.comIndex[n] = this.comIdx(node.com);
      nodes.x[n] = node.x;
      nodes.y[n] = node.y;
      nodes.remaining[n] = node.max > 0 ? node.amount / node.max : 0;
      // Origin, straight off the engine's own flags. A node with neither reads as natural, which is
      // the safe default: a false "a fight happened here" is worse than a missed one.
      nodes.kind[n] = node.wreck ? NODE_SALVAGE : node.crater ? NODE_CRATER : NODE_NATURAL;
      n++;
    }
    nodes.count = n;
  }

  /**
   * Shots that landed this tick, read off `attackHit` (P6-T01, ADR-0023) — see `ShotTable`.
   *
   * **No ordering constraint, and the removal of one is the point.** ADR-0017's version had to run
   * before `rememberPreviousPositions` because a killing shot's endpoint came out of `prevPos`. The
   * event stamps `x`/`y` from the target and `fromX`/`fromY` from the attacker *before*
   * `removeEntity`, so a target that died on this tick needs no fallback and nothing here reads
   * `prevPos` at all. The only remaining requirement is the one `extractImpacts` and `extractDeaths`
   * already share: `state.events` must not have been drained yet, and `WorldBridge.step` drains it
   * after extraction (P3-T07).
   *
   * **This set is "shots that landed", not "shots that were fired", and the difference is exactly
   * one case.** `performAttack` has a single early return before the push — `detonateIfAttacked` —
   * so a hit on an ARMED Helium Bomb resets the shooter's cooldown and emits no `attackHit`. That
   * shot draws no tracer, which is a real regression against the diff and is argued in ADR-0023 §4
   * rather than assumed away; `test/bridge/shots.test.ts` pins the early return against the source
   * so a miss chance added upstream cannot widen the gap silently.
   */
  private extractShots(state: State, fog: Fog): void {
    const shots = this.snapshot.shots;
    shots.count = 0;
    shots.dropped = 0;
    const events = state.events ?? [];
    // Sized to the whole event list, exactly as `extractImpacts` and `extractDeaths` are: one pass,
    // no counting pass, and the over-estimate is bounded by a tick's events. It is also SMALLER than
    // ADR-0017's `units + buildings` in every scene measured — 622 hits across 400 ticks of a
    // 120-unit fight, against a table cut for 120 shooters firing at once, every tick.
    shots.ensure(events.length);
    for (const ev of events) {
      if (ev.type !== "attackHit") continue;
      const fromX = ev.fromX as number;
      const fromY = ev.fromY as number;
      const toX = ev.x as number;
      const toY = ev.y as number;
      // The one thing this design rests on, checked rather than trusted: a hit with both endpoints.
      // Counted rather than skipped, because a tracer set that quietly shrinks is what P6-T01 was
      // filed about (`ShotTable.dropped`). Before the fog gate, so a malformed event in the dark is
      // still counted rather than swallowed by the gate.
      if (!(Number.isFinite(fromX) && Number.isFinite(fromY) && Number.isFinite(toX) && Number.isFinite(toY))) {
        shots.dropped++;
        continue;
      }
      // Fog: a tracer from an unseen shooter is a line pointing straight at it (ADR-0017 §4, carried
      // forward by ADR-0023 §3). Gated on the SHOOTER's own position at the moment it fired, which
      // the event states — `extractImpacts` gates the same event on where the shot landed.
      if (ev.owner !== "player" && !isVisibleAt(fog, fromX, fromY)) continue;
      const n = shots.count;
      shots.fromX[n] = fromX;
      shots.fromY[n] = fromY;
      shots.toX[n] = toX;
      shots.toY[n] = toY;
      shots.owner[n] = ev.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      shots.count = n + 1;
    }
  }

  /**
   * Landed hits, from the engine's own `attackHit` events (P5-T15) — see `ImpactTable`.
   *
   * Shares its whole input with `extractShots` since ADR-0023 and differs only in which endpoint it
   * takes and which one it gates on. Neither has an ordering constraint: the event carries the
   * impact position itself, so nothing here consults `prevPos` and a target that died on this same
   * tick needs no fallback. That is the whole difference between reading an event and deriving one.
   *
   * The three payload fields are copied and never re-derived. `heavy` in particular is *not*
   * `owner !== target.owner && target is a building` or any other reconstruction: it is
   * `def.bonusVsBuildings && target.kind === "building"`, which is a question about the ATTACKER's
   * weapon that the event has already answered and this side of the bridge cannot ask.
   */
  private extractImpacts(state: State, fog: Fog): void {
    const impacts = this.snapshot.impacts;
    impacts.count = 0;
    const events = state.events ?? [];
    // Sized to the whole event list rather than to the hits in it: one pass, no counting pass, and
    // the over-estimate is bounded by a tick's events. `DeathTable` sizes itself the same way.
    impacts.ensure(events.length);
    for (const ev of events) {
      if (ev.type !== "attackHit") continue;
      const x = ev.x as number;
      const y = ev.y as number;
      // Live vision, not the explored memory `extractDeaths` uses. See `ImpactTable`: a hit is a
      // fight happening now, and a mark on remembered ground names an enemy's position this tick.
      if (!isVisibleAt(fog, x, y)) continue;
      const n = impacts.count;
      impacts.x[n] = x;
      impacts.y[n] = y;
      impacts.owner[n] = ev.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      impacts.heavy[n] = ev.heavy ? 1 : 0;
      impacts.bonus[n] = ev.bonus ? 1 : 0;
      // `undefined` for a weapon with no splash — the engine writes the field either way, so this
      // reads it either way rather than testing for its presence.
      impacts.splashRadius[n] = (ev.splashRadius as number | undefined) ?? 0;
      impacts.count = n + 1;
    }
  }

  /**
   * Rally lines for the viewer's own selected producers (P5-T15) — see `RallyTable` for the three
   * filters and why each one is there.
   *
   * `produces` is asked of the engine's own `BUILDINGS` table rather than listed here, because a
   * hand-written list of "the buildings that train things" is exactly the shape P4-T14 deleted:
   * upstream adds a producer and the client silently keeps the old three.
   */
  private extractRally(state: State, viewer: OwnerId): void {
    const rally = this.snapshot.rally;
    rally.count = 0;
    rally.ensure(state.selection.length);
    for (const id of state.selection) {
      const b = state.buildings.get(id);
      // A selection may hold units and enemy buildings alike — `applySelect` accepts any entity the
      // player can click, and only the orders downstream of it are owner-gated.
      if (!b || b.owner !== viewer) continue;
      if (!(BUILDINGS[b.type]?.produces?.length)) continue;
      const point = b.rally;
      // Every building is minted with one, but a save from an older build or a hand-made state need
      // not have: a missing rally is no line rather than a line to the origin.
      if (!point) continue;
      const n = rally.count;
      rally.fromX[n] = b.x;
      rally.fromY[n] = b.y;
      rally.toX[n] = point.x;
      rally.toY[n] = point.y;
      rally.count = n + 1;
    }
  }

  /**
   * Deaths, from the engine's own `entityKilled` events (P3-T07).
   *
   * Per tick, never a running log: `WorldBridge` drains `state.events` after every step, and a
   * twenty-minute match would otherwise accumulate every death it ever saw.
   */
  private extractDeaths(state: State, fog: Fog): void {
    const deaths = this.snapshot.deaths;
    deaths.count = 0;
    const events = state.events ?? [];
    deaths.ensure(events.length);
    for (const ev of events) {
      if (ev.type !== "entityKilled") continue;
      const x = ev.x as number;
      const y = ev.y as number;
      // Explored, not visible: a wreck the player walks up to later should still have flashed. But
      // a death in ground they have never seen is not theirs to know about.
      if (!exploredAt(fog, x, y)) continue;
      const n = deaths.count;
      deaths.x[n] = x;
      deaths.y[n] = y;
      deaths.owner[n] = ev.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      deaths.isBuilding[n] = ev.kind === "building" ? 1 : 0;
      deaths.count = n + 1;
    }
  }

  /**
   * The engine's own aura list, fog-gated (P3-T04).
   *
   * `state.anvils` is rebuilt every tick by `collectAnvils` from live positions and already excludes
   * a bastion that has not finished standing — so this copies rather than decides. The one judgement
   * made here is visibility: an enemy aura shows only where the player can actually see its
   * projector, because a ring visible through fog is a map hack with a nice name.
   */
  private extractAuras(state: State, fog: Fog): void {
    const auras = this.snapshot.auras;
    const anvils = state.anvils ?? [];
    auras.ensure(anvils.length);
    let n = 0;
    for (const a of anvils) {
      // Live vision, not memory: the Aegis unit moves, and an aura remembered where it used to be
      // would tell a player their army is protected somewhere it is not.
      if (a.owner !== "player" && !isVisibleAt(fog, a.x, a.y)) continue;
      auras.x[n] = a.x;
      auras.y[n] = a.y;
      auras.radius[n] = a.range;
      auras.owner[n] = a.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      n++;
    }
    auras.count = n;
  }

  /**
   * Armed Helium Bombs and their reach (P3-T10).
   *
   * Two different questions get two different answers, and conflating them would be a real leak:
   *
   *   • **The player's own armed bomb** shows its rings unconditionally. This is a planning tool,
   *     and it is the one unit where the radius IS the decision — the blast is not owner-exempt, so
   *     the ring is mostly a picture of which of the player's own units are standing in it.
   *   • **An enemy bomb** shows nothing until its fuse is lit, and then only on live vision. An
   *     un-fused enemy bomb's ring would hand over a number the player has not earned: they could
   *     walk an army around a device they were never told was armed. A lit fuse is different — it is
   *     four seconds of a blast already happening, and the engine emits `bombFused` for exactly that
   *     reason. Live vision rather than memory, on the same rule as the guard aura: a warning
   *     remembered where a bomb used to be is a warning about ground that is now safe.
   *
   * The countdown is `fuseUntil - state.time`, never a timer counted down up here. The engine will
   * detonate on its own clock, so a second clock above the bridge is a second answer to the same
   * question, and the one on screen is the one that would be wrong.
   */
  private extractBombs(state: State, fog: Fog): void {
    const bombs = this.snapshot.bombs;
    bombs.count = 0;
    bombs.fuseDelay = BOMB_FUSE_DELAY;
    let n = 0;
    for (const u of state.units.values()) {
      if (UNITS[u.type]?.role !== "bomb" || !u.armed) continue;
      const lit = u.fuseUntil != null;
      if (u.owner !== "player") {
        if (!lit || !isVisibleAt(fog, u.x, u.y)) continue;
      }
      bombs.ensure(n + 1);
      bombs.x[n] = u.x;
      bombs.y[n] = u.y;
      bombs.core[n] = BOMB_CORE_RADIUS;
      bombs.blast[n] = BOMB_BLAST_RADIUS;
      // Clamped at zero: the blast fires on the tick `state.time` reaches `fuseUntil`, and a frame
      // interpolated past that would otherwise render a negative countdown.
      bombs.fuse[n] = lit ? Math.max(0, u.fuseUntil! - state.time) : FUSE_UNLIT;
      bombs.owner[n] = u.owner === "player" ? SNAP_PLAYER : SNAP_AI;
      n++;
    }
    bombs.count = n;
  }

  private extractFog(fog: Fog): void {
    const f = this.snapshot.fog;
    let hash = 0;
    for (let i = 0; i < f.state.length; i++) {
      const v = fog.visible[i] === 1 ? FOG_VISIBLE : fog.explored[i] === 1 ? FOG_EXPLORED : FOG_UNEXPLORED;
      f.state[i] = v;
      // A cheap order-sensitive rolling hash. Scanning ~1000 bytes per tick is far less work than
      // re-uploading a texture on every one of the 3 frames that tick spans, which is the whole
      // reason `version` exists (ADR-0006: the fog is one lookup, updated once per tick).
      hash = (hash * 31 + v * (i + 1)) | 0;
    }
    if (hash !== this.fogHash) {
      this.fogHash = hash;
      f.version++;
    }
  }
}

function exploredAt(fog: Fog, x: number, y: number): boolean {
  const cx = Math.floor(x / FOG_CELL_SIZE);
  const cy = Math.floor(y / FOG_CELL_SIZE);
  if (cx < 0 || cy < 0 || cx >= fog.cols || cy >= fog.rows) return false;
  return fog.explored[cy * fog.cols + cx] === 1;
}

/** Veterancy rank from kill count — upstream's 3/8/18 thresholds (universe digest §5). */
function rankOf(kills: number): number {
  return kills >= 18 ? 3 : kills >= 8 ? 2 : kills >= 3 ? 1 : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * How fed a factory is: the fullness of its *scarcest* required input.
 *
 * Averaging would report a larder holding a recipe's ore but none of its crystals as half full,
 * when the factory is stopped dead. Energy is skipped because it is a power flow rather than a
 * hauled good (`updateProduction` skips it for the same reason).
 */
function scarcestInput(b: Building, recipe: Recipe | null | undefined, cap: number): number {
  if (!recipe) return cap > 0 ? inputTotal(b) / cap : 0;
  let worst = 1;
  const input = b.input ?? {};
  for (const com in recipe.in) {
    if (com === "energy") continue;
    worst = Math.min(worst, (input[com] ?? 0) / cap);
  }
  return worst;
}
