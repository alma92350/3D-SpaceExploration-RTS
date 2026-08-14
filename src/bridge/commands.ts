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
  BUILDINGS, UNITS, canAfford, cancelProduction, canPlaceBuilding, deployColonyShip, getEntity,
  issueAttack, issueAttackMove, issueBuild, issueGather, issueHold, issueMove, issuePatrol,
  issueSetRally, issueStop, prereqsMet, queueProduction, sampleTerrain,
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
  | { kind: "deploy" };

/**
 * Apply one intent. Returns a player-facing reason when the engine refused, or null on success.
 *
 * Refusals are returned rather than thrown: "not enough ore" is an ordinary outcome of clicking a
 * button, and an exception in the sim step would take the frame with it.
 */
export function applyIntent(state: State, intent: Intent): string | null {
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

function selectedUnits(state: State): Unit[] {
  const out: Unit[] = [];
  for (const id of state.selection) {
    const u = state.units.get(id);
    if (u && u.owner === "player") out.push(u);
  }
  return out;
}
