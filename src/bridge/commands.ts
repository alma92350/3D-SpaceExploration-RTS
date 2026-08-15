// Player intent → engine commands (ADR-0008 §3).
//
// Input produces plain intent objects; this module is the only place they become engine calls, and
// it calls exactly the functions the 2D client calls (`engine/commands.js`, `engine/production.js`).
// Nothing above the bridge may write a sim field. That is not tidiness — it is what makes
// determinism testable: a recorded intent stream plus a seed reproduces a run exactly (P1-T21).
//
// Intents are data, not closures, for the same reason: a closure cannot be recorded, replayed, or
// sent through a `postMessage` to a Worker.

import {
  BUILDINGS, TECHS, UNITS, buy, canAfford, cancelProduction, cancelResearch, canPlaceBuilding,
  deployColonyShip, getEntity, isElectrifiable, issueAttack, issueAttackMove,
  issueBuild, issueCancelRecycle, issueGather, issueHold, issueMove, issuePatrol, issueRecycle,
  UPGRADES, committedDoctrine, researchUpgrade,
  FORMATION_SHAPES, LEADER_POSITIONS, issueEscort, issueHoldFormation, lightFuse,
  issueSetLogiPriority, issueSetRally, issueStop, prereqsMet, queueProduction, researchTech,
  sampleTerrain, sell, tradeables,
} from "../engine/index.js";

export type Intent =
  | { kind: "select"; ids: string[]; additive: boolean }
  | { kind: "move"; x: number; y: number; queue: boolean }
  | { kind: "attackMove"; x: number; y: number; queue: boolean }
  | { kind: "attack"; targetId: string; queue: boolean }
  | { kind: "gather"; nodeId: string; queue: boolean }
  | { kind: "stop" }
  | { kind: "hold" }
  | { kind: "patrol"; x: number; y: number }
  | { kind: "build"; buildingType: string; x: number; y: number }
  | { kind: "train"; buildingId: string; unitType: string }
  | { kind: "cancelTrain"; buildingId: string; queueIndex: number }
  | { kind: "setRally"; buildingId: string; x: number; y: number }
  | { kind: "deploy" }
  // --- Phase 2, the economy (P2-T03) ---
  | { kind: "pause"; buildingId: string; paused: boolean }
  | { kind: "electrify"; buildingId: string; on: boolean }
  | { kind: "research"; buildingId: string; techId: string }
  | { kind: "cancelResearch"; buildingId: string; index: number }
  | { kind: "recycle"; entityId: string }
  | { kind: "cancelRecycle"; entityId: string }
  | { kind: "trade"; com: string; qty: number; side: "buy" | "sell" }
  | { kind: "logiPriority"; buildingId: string; priority: "high" | "normal" | "low" }
  | { kind: "doctrine"; buildingId: string; upgradeId: string }
  // --- Phase 3, combat (P3-T11, P3-T12) ---
  | { kind: "escort"; targetId: string; queue: boolean }
  | { kind: "holdFormation"; shape: string; leaderPos: string }
  | { kind: "moveInFormation"; x: number; y: number; shape: string; leaderPos: string; queue: boolean }
  // --- Phase 3, the Helium Bomb (P3-T10) ---
  | { kind: "armBomb"; unitId: string; armed: boolean }
  | { kind: "detonate"; unitId: string };

/**
 * Apply one intent. Returns a player-facing reason when the engine refused, or null on success.
 *
 * Refusals are returned rather than thrown: "not enough ore" is an ordinary outcome of clicking a
 * button, and an exception in the sim step would take the frame with it.
 *
 * `galaxy` is here because trade is galaxy-scoped — credits live above the world, and `buy`/`sell`
 * move them. Passing it rather than reaching for a module global keeps the bridge a function of
 * its arguments, which is what lets the determinism harness replay one.
 */
export function applyIntent(state: State, intent: Intent, galaxy: Galaxy): string | null {
  switch (intent.kind) {
    case "select":
      return applySelect(state, intent.ids, intent.additive);

    case "move":
      issueMove(selectedUnits(state), intent.x, intent.y, intent.queue);
      return null;

    case "attackMove":
      issueAttackMove(selectedUnits(state), intent.x, intent.y, intent.queue);
      return null;

    case "attack": {
      const target = getEntity(state, intent.targetId);
      if (!target) return null;                      // it died between the click and the tick
      issueAttack(selectedUnits(state), intent.targetId, intent.queue);
      return null;
    }

    case "gather": {
      const workers = selectedUnits(state).filter((u) => UNITS[u.type]?.canGather);
      if (workers.length === 0) return null;
      issueGather(workers, intent.nodeId, intent.queue);
      return null;
    }

    case "escort": {
      const target = getEntity(state, intent.targetId);
      if (!target) return null;                      // it died between the click and the tick
      // The target is filtered out of its own escort: a ship cannot ring itself, and the engine
      // documents that the caller is the one who has to do it.
      const units = selectedUnits(state).filter((u) => u.id !== intent.targetId);
      if (units.length === 0) return null;
      issueEscort(units, intent.targetId, intent.queue);
      return null;
    }

    case "holdFormation": {
      const units = selectedUnits(state);
      if (units.length === 0) return null;
      if (!FORMATION_SHAPES.includes(intent.shape)) return `Unknown formation ${intent.shape}`;
      if (!LEADER_POSITIONS.includes(intent.leaderPos)) return `Unknown leader position ${intent.leaderPos}`;
      issueHoldFormation(units, intent.shape, intent.leaderPos);
      return null;
    }

    case "moveInFormation": {
      const units = selectedUnits(state);
      if (units.length === 0) return null;
      if (!FORMATION_SHAPES.includes(intent.shape)) return `Unknown formation ${intent.shape}`;
      if (!LEADER_POSITIONS.includes(intent.leaderPos)) return `Unknown leader position ${intent.leaderPos}`;
      // `issueMove` has taken a formation argument since before this project existed; the MVP just
      // never passed one (P3-T11).
      issueMove(units, intent.x, intent.y, intent.queue, { shape: intent.shape, leaderPos: intent.leaderPos });
      return null;
    }

    // --- The Helium Bomb (P3-T10) -----------------------------------------------------------
    //
    // These are the only intents in this module that write a sim field instead of calling an
    // `issue*` function, and that is worth saying out loud rather than leaving for someone to
    // notice. There is no engine command: `bomb.armed` is a direct flip, and the engine's OWN AI
    // does exactly this (`aiSuperweapon.js`: `bomb.armed = true; lightFuse(state, bomb)`), as does
    // upstream's HUD. So the player side and the AI side arm a bomb through identical code, which
    // is the property that matters — not whether a wrapper function exists.
    //
    // The header's rule about the module still holds where it counts: this runs inside
    // `applyIntent`, so it happens at a tick boundary in the recorded intent order like every other
    // command. A flip done anywhere else would desync a replay, which is exactly why the flip is
    // HERE and not in the input layer.
    case "armBomb": {
      const bomb = bombOrNull(state, intent.unitId);
      if (!bomb) return null;                          // gone, or not a bomb — not an error
      if (intent.armed) {
        bomb.armed = true;
        return null;
      }
      // Disarming cuts a lit fuse. That is upstream's documented behaviour (engine/bomb.js's header
      // names `disarm` as the reversible half and says it cuts the fuse), but its implementation
      // lives in a UI file outside the vendored subset — so this line is the one rule in P3-T10 the
      // bridge writes rather than calls. It is a two-field reset with no derived state behind it.
      bomb.armed = false;
      bomb.fuseUntil = null;
      return null;
    }

    case "detonate": {
      const bomb = bombOrNull(state, intent.unitId);
      if (!bomb) return null;
      // An unarmed bomb ignores all three triggers, and "Detonate Now" is one of them. Arming is
      // the commitment; letting this path skip it would make the confirmation dialog decorative.
      if (!bomb.armed) return "The bomb is not armed";
      // `lightFuse`, not `detonateBomb`: the player's own trigger is a FUSE, so the four seconds
      // exist for everyone including the player who pressed it. Detonating on the spot here would
      // give the player's own trigger a property the enemy's proximity trigger does not have.
      lightFuse(state, bomb);
      return null;
    }

    case "stop":
      issueStop(selectedUnits(state));
      return null;

    case "hold":
      issueHold(selectedUnits(state));
      return null;

    case "patrol": {
      const units = selectedUnits(state);
      if (units.length === 0) return null;
      // A patrol is a there-and-back between where the unit stands and where the player clicked.
      // The engine takes the point list; building it here keeps the input layer free of sim shapes.
      for (const u of units) issuePatrol([u], [{ x: u.x, y: u.y }, { x: intent.x, y: intent.y }]);
      return null;
    }

    case "build":
      return applyBuild(state, intent.buildingType, intent.x, intent.y);

    case "train": {
      const b = state.buildings.get(intent.buildingId);
      if (!b) return null;
      const def = UNITS[intent.unitType];
      if (!def) return null;
      if (def.cost && !canAfford(state.players[b.owner].resources, def.cost))
        return `Not enough resources for ${def.name}`;
      return queueProduction(state, intent.buildingId, intent.unitType)
        ? null
        : `${def.name} cannot be trained here`;
    }

    case "cancelTrain":
      cancelProduction(state, intent.buildingId, intent.queueIndex);
      return null;

    case "setRally": {
      const b = state.buildings.get(intent.buildingId);
      if (!b) return null;
      issueSetRally(b, intent.x, intent.y);
      return null;
    }

    case "deploy": {
      // The Odyssey opening. `deployColonyShip` validates the footprint STRICTLY — the Command
      // Center lands exactly where the ship is parked, with no sliding — so a blocked deploy is a
      // "move and try again", and the message has to say that rather than just "blocked".
      const ship = selectedUnits(state).find((u) => u.type === "colonyship");
      if (!ship) return "Select a colony ship to deploy";
      return deployColonyShip(state, ship.id)
        ? null
        : "Not enough clear ground here — move the colony ship and try again";
    }

    // --- Phase 2 -------------------------------------------------------------------------------
    //
    // Every case below is "ask the engine, report what it said". Two of them — pause and electrify
    // — set a field directly, and that is not a shortcut: upstream has no command function for
    // either, because upstream's own HUD flips the flag (see `engine/industry.js`'s note on
    // `electrified`). Where the engine *does* own a predicate we use it, which is why electrify
    // asks `isElectrifiable` instead of listing types here.

    case "pause": {
      const b = state.buildings.get(intent.buildingId);
      if (!b) return null;                             // recycled or destroyed since the click
      b.paused = intent.paused;
      return null;
    }

    case "electrify": {
      const b = state.buildings.get(intent.buildingId);
      if (!b) return null;
      if (!isElectrifiable(b.type)) return `${BUILDINGS[b.type]?.name ?? b.type} cannot be electrified`;
      b.electrified = intent.on;
      return null;
    }

    case "research": {
      const tech = TECHS[intent.techId];
      if (!tech) return "Unknown technology";
      if (!state.buildings.get(intent.buildingId)) return null;
      // `researchTech` checks the building, the prerequisites and the cost. Predicting any of that
      // here would be a second copy of the tech tree, wrong the day upstream edits the first.
      return researchTech(state, intent.buildingId, intent.techId)
        ? null
        : `Cannot research ${tech.name} yet`;
    }

    case "cancelResearch":
      cancelResearch(state, intent.buildingId, intent.index);
      return null;

    case "doctrine": {
      const def = UPGRADES[intent.upgradeId];
      if (!def) return "Unknown upgrade";
      if (!state.buildings.get(intent.buildingId)) return null;
      // The refusal has to distinguish the permanent case from the temporary one. `researchUpgrade`
      // returns a bare `false` whether the player is short of crystals or has closed this path for
      // the rest of the match, and those two send them to completely different places — so the
      // doctrine lock is read (never re-derived) to phrase it.
      if (researchUpgrade(state, intent.buildingId, intent.upgradeId)) return null;
      const chosen = committedDoctrine(state, state.buildings.get(intent.buildingId)!.owner);
      return chosen && def.doctrine && chosen !== def.doctrine
        ? `${def.name} is closed — you committed to the ${chosen} doctrine`
        : `Cannot research ${def.name} yet`;
    }

    case "recycle": {
      const entity = getEntity(state, intent.entityId);
      if (!entity) return null;
      issueRecycle([entity]);
      return null;
    }

    case "cancelRecycle": {
      const entity = getEntity(state, intent.entityId);
      if (!entity) return null;
      issueCancelRecycle([entity]);
      return null;
    }

    case "trade": {
      // Both sides clamp themselves: `sell` sells only what is held, `buy` buys only what the
      // credits cover, and each returns what actually moved. So the refusal is "the engine moved
      // nothing", which cannot disagree with the engine the way a pre-check would.
      //
      // `commodityAvailable` is deliberately NOT used as that pre-check: it answers "can this be
      // got on this world at all" (a deposit exists, or some is held) and returns a BOOLEAN.
      // Comparing it to a quantity reads as `true < 25` and refuses every trade — which is what
      // the first draft of this did.
      if (!tradeables(state).includes(intent.com)) return `${intent.com} cannot be traded here`;
      return intent.side === "sell"
        ? (sell(galaxy, state, intent.com, intent.qty) > 0 ? null : "Not enough to sell")
        : (buy(galaxy, state, intent.com, intent.qty) > 0 ? null : "Not enough credits");
    }

    case "logiPriority": {
      if (!state.buildings.get(intent.buildingId)) return null;
      issueSetLogiPriority(state, intent.buildingId, intent.priority);
      return null;
    }

    default: {
      // Exhaustiveness: adding an intent without handling it is a compile error, not a silent drop.
      const never: never = intent;
      throw new Error(`unhandled intent ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Placement validity, asked of the engine rather than re-derived (P1-T18).
 *
 * Three independent rules, and the reason each is here rather than in the view: terrain buildability
 * and collision are the engine's own (`sampleTerrain`, `canPlaceBuilding`), and build reach is the
 * order's own precondition. Re-implementing any of them in the ghost is how a ghost turns green on
 * ground the engine then refuses.
 */
export interface PlacementCheck {
  valid: boolean;
  reason: string | null;
  /** True when the ground itself is fine and only the worker's distance is wrong. */
  outOfReach: boolean;
}

export function checkPlacement(state: State, buildingType: string, x: number, y: number): PlacementCheck {
  const def = BUILDINGS[buildingType];
  if (!def) return { valid: false, reason: "Unknown structure", outOfReach: false };
  if (x < 0 || y < 0 || x > state.map.width || y > state.map.height)
    return { valid: false, reason: "Outside the map", outOfReach: false };
  if (!sampleTerrain(state.map.terrain, x, y).buildable)
    return { valid: false, reason: "Cannot build on rough ground", outOfReach: false };
  if (!canPlaceBuilding(state, buildingType, x, y))
    return { valid: false, reason: "Blocked", outOfReach: false };
  if (def.cost && !canAfford(state.players.player.resources, def.cost))
    return { valid: false, reason: `Not enough resources for ${def.name}`, outOfReach: false };
  if (!prereqsMet(state, "player", def))
    return { valid: false, reason: `${def.name} needs a prerequisite building`, outOfReach: false };
  return { valid: true, reason: null, outOfReach: false };
}

function applyBuild(state: State, buildingType: string, x: number, y: number): string | null {
  const check = checkPlacement(state, buildingType, x, y);
  if (!check.valid) return check.reason;
  const worker = selectedUnits(state).find((u) => UNITS[u.type]?.buildCategories?.length);
  if (!worker) return "Select a worker first";
  return issueBuild(state, worker.id, buildingType, x, y) ? null : "That worker cannot build there";
}

/**
 * Selection is sim state (`state.selection`) upstream, and stays sim state here.
 *
 * Tempting to keep it in the view instead — it is not a rule, after all. But every command function
 * reads it, the save round-trips it, and a selection that lived in two places would drift the first
 * time a selected unit died. Enemy entities are selectable (you can inspect them) but the command
 * path filters to your own, exactly as upstream does.
 */
function applySelect(state: State, ids: string[], additive: boolean): null {
  if (!additive) state.selection.length = 0;
  for (const id of ids) {
    if (!getEntity(state, id)) continue;
    if (!state.selection.includes(id)) state.selection.push(id);
  }
  return null;
}

/**
 * The player's own Helium Bomb by id, or null (P3-T10).
 *
 * Owner-checked here rather than at the call sites, because both callers write a sim field and the
 * one thing neither may ever do is write it on somebody else's unit. `role === "bomb"` is the
 * engine's own discriminator — `UNITS.heliumbomb.role`, the same field `sim.js` branches on to run
 * the fuse at all — so a second bomb type added upstream is armable here on the day it exists.
 */
function bombOrNull(state: State, id: string): Unit | null {
  const u = state.units.get(id);
  if (!u || u.owner !== "player") return null;
  return UNITS[u.type]?.role === "bomb" ? u : null;
}

function selectedUnits(state: State): Unit[] {
  const out: Unit[] = [];
  for (const id of state.selection) {
    const u = state.units.get(id);
    if (u && u.owner === "player") out.push(u);
  }
  return out;
}
