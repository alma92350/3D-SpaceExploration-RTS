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
  canJumpTo, jumpCost, jumpCapital, spaceportTier, upgradeSpaceport, SPACEPORT_MAX_TIER,
  createLane, deleteLane, assignShipToLane, unassignShipFromLane, setColonyPolicy,
  issueSetLogiPriority, issueSetRally, issueStop, prereqsMet, queueProduction, researchTech,
  sampleTerrain, sell, tradeables,
  offerTribute, offerGift, fulfillRequest, tributeCost, surrenderGalaxy,
  // --- Phase 5's parity close-out (P5-T13, PARITY.md §5.2 rows 31–40) ---------------------------
  canBuildType, FREIGHTER_AI_TECH,
  issueAssistBuild, issueFerryFreighter, issueRepair, issueScout, issueServiceBuilding,
  issueSetAILogistics, issueSetCollectPoint, issueSetHomeBase,
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
  /**
   * Cancel one queued unit (row 32). **Both payload fields are optional and that is the row.**
   *
   * The intent has existed since Phase 1 with `buildingId` and `queueIndex` required, and nothing
   * on either end of it — because nothing that could produce it can see either number. A gesture
   * cannot: `input/` has no selection and no queue. So the bridge resolves both, the same way
   * `deploy` has resolved its colony ship since the MVP: absent `buildingId` means every selected
   * player building, and absent `queueIndex` means the NEWEST job — "undo the last thing I
   * queued", which is the only one a player can name without pointing at it. A panel that CAN
   * point still passes both, so widening this broke nothing.
   */
  | { kind: "cancelTrain"; buildingId?: string; queueIndex?: number }
  /**
   * Set a rally point (row 31), and rally-TO-NODE with it.
   *
   * `nodeId` is upstream's own fourth argument and the reason this intent could not simply be
   * wired as it stood: `issueSetRally(building, x, y, nodeId)` makes a worker spawn already mining
   * the node the rally sits on, and an intent carrying only x/y is a rally point quietly worse than
   * upstream's for exactly the unit that needs it most. `buildingId` is optional for
   * `cancelTrain`'s reason.
   */
  | { kind: "setRally"; buildingId?: string; x: number; y: number; nodeId?: string | null }
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
  | { kind: "detonate"; unitId: string }
  // --- Phase 4, the galaxy (P4-T04 … P4-T08) ---
  //
  // These are the first intents that act on the GALAXY rather than on the seat, which is why
  // `applyIntent` has taken a `galaxy` argument since Phase 2's trade. A jump changes
  // `galaxy.activeId`, so it is the one intent in this union that changes which world the next
  // intent applies to — recorded in the stream like everything else, which is what keeps a replay
  // that crosses a jump reproducible (P4-T11).
  | { kind: "jump"; destId: string; landingX?: number; landingY?: number }
  | { kind: "upgradeSpaceport"; buildingId: string }
  | { kind: "createLane"; from: string; to: string; commodities: string[] }
  | { kind: "deleteLane"; laneId: string }
  | { kind: "assignLane"; laneId: string; unitId: string }
  | { kind: "unassignLane"; laneId: string; unitId: string }
  | { kind: "colonyPolicy"; planetId: string; patch: Record<string, unknown> }
  // --- Phase 5 (P5-T04, P5-T07) -----------------------------------------------------------------
  //
  // The three diplomacy levers carry a `planetId` for the reason `colonyPolicy` does: a colony's
  // stance with its neighbour is as real as the seat's, and a player looking at the starmap is
  // deciding about a world they are not standing on.
  | { kind: "tribute"; planetId: string }
  | { kind: "gift"; planetId: string; com: string; qty: number }
  | { kind: "fulfilFavor"; planetId: string }
  /** The one terminal choice. Galaxy-scoped, so it takes nothing. */
  | { kind: "surrender" }
  // --- Phase 5's parity close-out (P5-T13, PARITY.md §5.2 rows 33–40) ----------------------------
  //
  // Eight orders the engine has always had and this client has never given anybody a way to reach.
  // Every one of them names only what the CLICK found — a target, or nothing at all — because the
  // actor is the selection and the selection is sim state the input layer cannot see. That is the
  // `deploy`/`stop`/`hold` shape, not a new one: the bridge filters the selection with the engine's
  // OWN predicate (`canLogisticsType`'s field, `role`, `canBuildType`), so an order can never be
  // offered to a unit the engine would silently skip.
  //
  // `queue` rides along wherever the engine takes a `queue` argument, so shift-click chains a
  // logistics job exactly as it chains a move.
  /** Row 33: the explicit "go fix that", the one a player gives when the automation picks wrong. */
  | { kind: "repair"; targetId: string; queue: boolean }
  /** Row 34: the manual counterpart to `assignHaul` — carry this building's inputs in, output out. */
  | { kind: "serviceBuilding"; buildingId: string; queue: boolean }
  /** Row 35. Takes nothing: scout mode is a stance, not a destination (`scout.js` picks the ground). */
  | { kind: "scout" }
  /** Row 36: more hands on a site already founded and already paid for. */
  | { kind: "assistBuild"; buildingId: string; queue: boolean }
  /** Row 37: a worker loading a landed freighter, which is not the freighter acting on its own. */
  | { kind: "ferryFreighter"; freighterId: string; queue: boolean }
  /** Row 38: the multi-base control — which Command Center's territory a hauler stays loyal to. */
  | { kind: "setHomeBase"; ccId: string }
  /**
   * Rows 39 and 40, the two freighter modes. `on` is optional because the gesture is a TOGGLE and
   * only the simulation knows which way it is pointing; absent, the bridge flips it. A panel that
   * has already read the flag passes it, so the button and the key cannot disagree.
   */
  | { kind: "collectPoint"; on?: boolean }
  | { kind: "aiLogistics"; on?: boolean };

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

    // --- The galaxy (P4-T04 … P4-T08) -------------------------------------------------------
    //
    // Every one asks the engine and reports its refusal; none re-derives a rule. `jumpCapital`
    // returns null for *every* reason it can refuse — no port and nowhere to fall back, not enough
    // credits, same world — so the phrasing below asks the engine's own predicates to find out
    // WHICH, rather than guessing. A message naming the wrong reason is worse than none.
    case "jump": {
      if (intent.destId === galaxy.activeId) return null;
      if (!canJumpTo(galaxy, intent.destId)) {
        return "No Spaceport here, and no base to fall back to on that world";
      }
      const cost = jumpCost(galaxy, intent.destId);
      if (galaxy.credits < cost) return `A jump there costs ${Math.ceil(cost)} credits`;
      const landingPoint = intent.landingX !== undefined && intent.landingY !== undefined
        ? { x: intent.landingX, y: intent.landingY }
        : undefined;
      return jumpCapital(galaxy, intent.destId, { landingPoint }) ? null : "The jump was refused";
    }

    case "upgradeSpaceport": {
      const b = state.buildings.get(intent.buildingId);
      if (!b || b.owner !== "player") return null;
      if (b.type !== "spaceport") return null;
      if (spaceportTier(b) >= SPACEPORT_MAX_TIER) return "The pad is already at its highest tier";
      return upgradeSpaceport(state, b) ? null : "Not enough ore to extend the pad";
    }

    case "createLane":
      return createLane(galaxy, intent.from, intent.to, intent.commodities)
        ? null
        : "That lane cannot be opened";

    case "deleteLane":
      deleteLane(galaxy, intent.laneId);
      return null;

    case "assignLane":
      return assignShipToLane(galaxy, intent.laneId, intent.unitId)
        ? null
        : "That ship cannot be crewed onto the lane";

    case "unassignLane":
      unassignShipFromLane(galaxy, intent.laneId, intent.unitId);
      return null;

    case "colonyPolicy":
      // `sanitizePolicy` is the engine's own validator and `setColonyPolicy` runs it. Clamping up
      // here would put a second opinion beside it — and `MAX_WORKER_TARGET` is a clamp a UI must
      // SHOW rather than silently apply, which is a panel's job, not this module's.
      setColonyPolicy(galaxy, intent.planetId, intent.patch);
      return null;

    // --- Phase 5 -------------------------------------------------------------------------------
    //
    // All four ask the engine and report its answer. The refusals are worth reading together,
    // because the engine says `false` for several different reasons and a player needs the right
    // one: `offerTribute` refuses on price, `offerGift` on an empty stockpile (an over-ask is a
    // SMALLER gift, never a refusal — the engine clamps to `floor(held)`), and `fulfillRequest` on
    // three separate things the diplomacy panel already distinguishes.
    case "tribute": {
      const world = worldOrNull(galaxy, intent.planetId);
      if (!world) return "That world has no record to appease";
      if (offerTribute(galaxy, world)) return null;
      const dip = (world as unknown as { diplomacy?: object }).diplomacy;
      // The price, not "it failed" — tribute escalates 1.55x a payment, so the number is the whole
      // explanation and `tributeCost` is the only thing that knows it.
      return dip
        ? `Not enough credits — this tribute costs ${tributeCost(dip)}`
        : "This world has no neighbour to appease";
    }

    case "gift": {
      const world = worldOrNull(galaxy, intent.planetId);
      if (!world) return "That world has no record to give to";
      return offerGift(world, intent.com, intent.qty)
        ? null
        : `No ${intent.com} in the stockpile to give`;
    }

    case "fulfilFavor": {
      const world = worldOrNull(galaxy, intent.planetId);
      if (!world) return "That world has no record to answer";
      return fulfillRequest(galaxy, world) ? null : "That request has lapsed, or the stock is short";
    }

    case "surrender":
      // `surrenderGalaxy` returns NOTHING — not even P2-T12's bare `false` — and refuses silently on
      // a seat that is already over. So this asks the question the engine will not answer.
      //
      // It matters because of the HUD's own rule: a struck-through button still enqueues, "so the
      // engine's own refusal is what explains it" (`HudAction`). For every other command that
      // holds. For this one the engine says nothing, and a click on a struck-through Surrender
      // would produce no message at all — which is the silent failure `relief-panel.ts`'s
      // three-valued `surrender` state was written to name.
      if (state.over === true) return "This run has already ended";
      surrenderGalaxy(galaxy);
      return null;

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

    case "cancelTrain": {
      // **The one order in this whole group that ANSWERS.** `cancelProduction` returns a boolean —
      // false for a building that is gone and for an index with no job, true when it spliced one
      // out and refunded what was actually charged for it (`job.alt ? def.altCost : def.cost`). So
      // "did anything happen" is the engine's own verdict here, never a re-read of the queue.
      const targets = buildingsFor(state, intent.buildingId);
      if (targets.length === 0) return "Select a building with something in its production queue";
      let cancelled = 0;
      // The LAST job, not the first: cancelling the head would abort the unit already being built,
      // which is not what "cancel" means to a player who has just over-queued. An index the caller
      // named wins, and an empty queue makes this `-1` — which `cancelProduction` answers `false`
      // to, exactly as it does for any other index with no job.
      for (const b of targets) {
        if (cancelProduction(state, b.id, intent.queueIndex ?? b.queue.length - 1)) cancelled++;
      }
      return cancelled > 0 ? null : "Nothing is queued there to cancel";
    }

    case "setRally": {
      const targets = buildingsFor(state, intent.buildingId);
      if (targets.length === 0) return "Select a building to set its rally point";
      // `issueSetRally` accepts ANY building and returns nothing, so it cannot say that a rally on
      // a Smelter is a control that does nothing. `production.js` reads `building.rally` at the
      // moment a unit spawns, and the only buildings that ever spawn one are the ones
      // `queueProduction` itself gates on — `BUILDINGS[type].produces`. That field is the engine's
      // own answer to "does anything ever come out of here", so it is the filter, and a selection
      // with none of them is refused rather than silently accepted.
      const producers = targets.filter((b) => BUILDINGS[b.type]?.produces?.length);
      if (producers.length === 0) {
        return `${nameOfBuilding(targets[0]!)} trains no units — a rally point there would do nothing`;
      }
      for (const b of producers) issueSetRally(b, intent.x, intent.y, intent.nodeId ?? null);
      return null;
    }

    // --- Phase 5's parity close-out (P5-T13, PARITY.md §5.2 rows 33–40) --------------------------
    //
    // Read these together, because they share one shape and one problem. **Every engine function
    // below returns `void`.** Not P2-T12's bare `false`, not `surrenderGalaxy`'s nothing-at-all on
    // one path — nothing, ever, on any path. Each silently skips whatever in the selection it does
    // not accept and silently accepts targets its own per-tick update then throws away. So each
    // case here asks the question the engine will not answer, using the engine's own predicate, and
    // asks it BEFORE the call rather than trying to detect afterwards that nothing happened.
    //
    // The predicates are quoted, never invented:
    //
    //   • `canLogisticsType(u.type)` gates repair / service / ferry, and is part of home base.
    //   • `UNITS[u.type].role` gates scout ("scout") and both freighter modes ("freighter").
    //   • `canBuildType(u.type, b.type)` IS `canBuildCategory(u.type, BUILDINGS[b.type].category)`,
    //     which is what `issueAssistBuild` filters on and what `issueBuild` gates founding on.
    //   • `UNITS[f.type].cargoHold` is what `updateFerry` nulls a ferry target for, and what
    //     `assignFerry` scans for. A hold-less freighter accepts the order and never loads.
    //   • `zoneFirst`'s `pinned` test — own, finished, `isCommandCenter` — is what makes a home
    //     base take effect. `issueSetHomeBase` writes `u.homeCC` whatever id it is handed.

    case "repair": {
      const target = getEntity(state, intent.targetId);
      if (!target) return null;                        // it died between the click and the tick
      // `issueRepair` checks no owner and neither does `updateRepairJob`, so the engine will
      // happily have a worker heal the enemy's Command Center. Owner-checked here for the reason
      // `bombOrNull` is: the one thing a command may never do is act on somebody else's entity.
      if (target.owner !== "player") return "That is not yours to repair";
      // `updateRepairJob`'s own first line drops the job on a constructing target. An order given
      // here would vanish on the very next tick with nothing said.
      const site = state.buildings.get(intent.targetId);
      if (site?.constructing) return `${nameOfBuilding(site)} is still being built — send builders`;
      const units = selectedUnits(state).filter((u) => canLogisticsType(u.type));
      if (units.length === 0) return `Only a ${logisticsNames()} can be sent to repair`;
      issueRepair(units, intent.targetId, intent.queue);
      return null;
    }

    case "serviceBuilding": {
      const b = state.buildings.get(intent.buildingId);
      if (!b) return null;
      if (b.owner !== "player") return "That is not yours to service";
      // `updateService`'s own `if (!b || b.constructing)` — same drop, same silence, as repair.
      if (b.constructing) return `${nameOfBuilding(b)} is still being built — send builders`;
      const units = selectedUnits(state).filter((u) => canLogisticsType(u.type));
      if (units.length === 0) return `Only a ${logisticsNames()} can run a service round trip`;
      // A manual service on a building with no recipe and no output buffer is NOT a no-op: the
      // engine's `order.manual && b` branch parks the worker beside it and keeps it there until
      // re-ordered. That is upstream's documented behaviour for a hand-assigned worker, so it is
      // left alone rather than second-guessed here.
      issueServiceBuilding(units, b.id, intent.queue);
      return null;
    }

    case "scout": {
      const units = selectedUnits(state).filter((u) => UNITS[u.type]?.role === "scout");
      if (units.length === 0) return `Only a ${roleNames("scout")} can scout`;
      issueScout(units);
      return null;
    }

    case "assistBuild": {
      const b = state.buildings.get(intent.buildingId);
      if (!b) return null;
      if (b.owner !== "player") return "That is not yours to build";
      // The other half of repair's line, and the engine draws it: a finished building takes a
      // repair job and refuses a build one; an unfinished one takes a build job and drops a repair.
      if (!b.constructing) return `${nameOfBuilding(b)} is already finished`;
      const units = selectedUnits(state).filter((u) => canBuildType(u.type, b.type));
      if (units.length === 0) return `Nothing selected can build a ${nameOfBuilding(b)}`;
      // The TYPE as well as the id, because the engine resolves the category from the type rather
      // than from the placed building — `BUILDINGS[buildingType]?.category`, not `b.category`.
      issueAssistBuild(units, b.id, b.type, intent.queue);
      return null;
    }

    case "ferryFreighter": {
      const ship = state.units.get(intent.freighterId);
      if (!ship) return null;
      if (ship.owner !== "player") return "That is not your ship";
      // `updateFerry` nulls its target on `!UNITS[f.type]?.cargoHold` and the job goes with it.
      // The plain `freighter` really has none — `entities.js` gives a hold to `hauler`,
      // `heavyhauler` and `bulkfreighter` only — so this is a live case, not padding.
      if (!UNITS[ship.type]?.cargoHold) {
        return `${UNITS[ship.type]?.name ?? ship.type} has no hold to load`;
      }
      // **No `u.id !== ship.id` here, unlike `escort` — and that is a decision, not an omission.**
      // The first draft had one, and mutation testing found it unreachable: `canLogisticsType` is
      // already false for every freighter role, so the ship can never be in its own crew. The
      // engine agrees on purpose rather than by accident — `sim.js` offers `assignFerry` only to
      // logistics types, "never ferry — a freighter doesn't ferry another freighter". A guard no
      // test can reach is the kind of unreachable code this project keeps finding; the filter
      // below is what does the work and the test says so.
      const units = selectedUnits(state).filter((u) => canLogisticsType(u.type));
      if (units.length === 0) return `Only a ${logisticsNames()} can load a freighter`;
      issueFerryFreighter(units, ship.id, intent.queue);
      return null;
    }

    case "setHomeBase": {
      const cc = state.buildings.get(intent.ccId);
      if (!cc) return null;
      // `zoneFirst`'s `pinned`, condition for condition. An override failing any of the three is
      // IGNORED there and written anyway by `issueSetHomeBase`, so this is the only place it can
      // be caught — and a home base that is silently ignored is the whole multi-base control
      // reading as broken.
      if (cc.owner !== "player") return "That is not your base";
      if (!BUILDINGS[cc.type]?.isCommandCenter) return `${nameOfBuilding(cc)} is not a Command Center`;
      if (cc.constructing) return `${nameOfBuilding(cc)} is still being built`;
      const units = selectedUnits(state).filter(keepsHomeBase);
      if (units.length === 0) return "Nothing selected keeps a home base";
      issueSetHomeBase(units, cc.id);
      return null;
    }

    case "collectPoint": {
      const ships = selectedUnits(state).filter((u) => UNITS[u.type]?.role === "freighter");
      if (ships.length === 0) return `Only a ${roleNames("freighter")} can be a collection point`;
      const on = intent.on ?? !ships.every((u) => (u as FreighterModes).collectPoint === true);
      // `issueSetCollectPoint` takes every freighter role, and `assignShuttle` only ever moves a
      // ship with a hold — `freightUsed` is 0 and `freightRoom` is 0 without `cargoHold`, so the
      // run it offers can never start. Switching a hold-less ship on is accepted by the engine and
      // does nothing; the engine draws no such line, so this does, before anything is written.
      if (on && !ships.some((u) => UNITS[u.type]?.cargoHold)) {
        return `${UNITS[ships[0]!.type]?.name ?? ships[0]!.type} has no hold — it would collect nothing`;
      }
      issueSetCollectPoint(ships, on);
      return null;
    }

    case "aiLogistics": {
      const ships = selectedUnits(state).filter((u) => UNITS[u.type]?.role === "freighter");
      if (ships.length === 0) return `Only a ${roleNames("freighter")} can be automated`;
      const on = intent.on ?? !ships.every((u) => (u as FreighterModes).aiLogistics === true);
      // The research gate, asked BEFORE the order. `issueSetAILogistics` skips an unresearched
      // freighter silently and returns nothing, so without this the key is simply dead until a
      // tech the player may not know exists has been finished. Standing DOWN is never gated —
      // upstream's own comment — so the question is only asked when switching on.
      if (on && !state.players.player.upgrades[FREIGHTER_AI_TECH]) {
        return `${TECHS[FREIGHTER_AI_TECH]?.name ?? FREIGHTER_AI_TECH} has not been researched`;
      }
      issueSetAILogistics(ships, on, state);
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

/**
 * One world's state by id, or null if the galaxy has never instantiated it.
 *
 * An unvisited world in `ODYSSEY_WORLDS` has no `State` at all until `addPlanet` makes one, so this
 * is a real case rather than defensive padding: the starmap draws every world in the roster and a
 * diplomacy control on one the player has never reached must refuse rather than throw.
 */
function worldOrNull(galaxy: Galaxy, planetId: string): State | null {
  return galaxy.planets.get(planetId) ?? null;
}

function selectedUnits(state: State): Unit[] {
  const out: Unit[] = [];
  for (const id of state.selection) {
    const u = state.units.get(id);
    if (u && u.owner === "player") out.push(u);
  }
  return out;
}

/* =================================================================================================
   P5-T13 — what the ten orders needed that the façade does not carry.

   Three narrow shapes and four helpers, each one quoting the engine rather than paraphrasing it.
   The casts follow `ui/gate-panel.ts`'s precedent: a field that exists in the vendored JavaScript,
   is read by exactly one place, and has never been declared — written down next to that place.
   ================================================================================================= */

/**
 * `UnitDef.canLogistics` — the flag `entities.js`' `canLogisticsType` is, in full:
 * `return !!UNITS[unitType]?.canLogistics;`
 *
 * The predicate itself does not cross the façade and neither does the field, so this is a
 * transcription of a one-line engine function, not a second opinion about which units haul. The
 * fix belongs in `src/engine/index.ts` (export `canLogisticsType`) and in `UnitDef` (declare the
 * flag); both are ADR-0003 territory and this file may not touch either.
 */
interface LogisticsDef { canLogistics?: boolean }

/** The two freighter modes, as `commands.js` writes them. `Unit` declares neither. */
interface FreighterModes { collectPoint?: boolean; aiLogistics?: boolean }

/** `issueServiceBuilding` / `issueFerryFreighter` / `issueRepair`'s own gate, and half of home base. */
function canLogisticsType(type: string): boolean {
  return !!(UNITS[type] as LogisticsDef | undefined)?.canLogistics;
}

/**
 * `issueSetHomeBase`'s filter, expression for expression:
 * `canLogisticsType(u.type) || UNITS[u.type]?.role === "support" || UNITS[u.type]?.role === "freighter"`.
 *
 * Wider than every other order in this group — a Mender and a freighter both consult a home zone —
 * which is exactly why it is written out rather than assumed to be the logistics set again.
 */
function keepsHomeBase(u: Unit): boolean {
  const role = UNITS[u.type]?.role;
  return canLogisticsType(u.type) || role === "support" || role === "freighter";
}

/**
 * The buildings an order applies to: the one named, or the whole selection.
 *
 * Owner-filtered on both paths. A named id comes from a panel and a selection comes from
 * `state.selection`, and neither is trustworthy about ownership — enemy entities are selectable
 * here (you can inspect them) exactly as they are upstream.
 */
function buildingsFor(state: State, buildingId?: string): Building[] {
  if (buildingId !== undefined) {
    const b = state.buildings.get(buildingId);
    return b && b.owner === "player" ? [b] : [];
  }
  const out: Building[] = [];
  for (const id of state.selection) {
    const b = state.buildings.get(id);
    if (b && b.owner === "player") out.push(b);
  }
  return out;
}

function nameOfBuilding(b: Building): string {
  return BUILDINGS[b.type]?.name ?? b.type;
}

/**
 * Every unit the engine gives `role`, by name — so a refusal names UNITS, not a role string.
 *
 * Asked of `UNITS` rather than typed in, which is the difference between a message that stays true
 * when upstream adds a second scout and one that starts lying on that day.
 */
function roleNames(role: string): string {
  return joinNames(Object.values(UNITS).filter((d) => d.role === role).map((d) => d.name), role);
}

/** The same, for the logistics flag — which is a flag rather than a role, so it needs its own pass. */
function logisticsNames(): string {
  const names = Object.entries(UNITS).filter(([type]) => canLogisticsType(type)).map(([, d]) => d.name);
  return joinNames(names, "logistics unit");
}

function joinNames(names: string[], fallback: string): string {
  if (names.length === 0) return fallback;
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
