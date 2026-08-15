// Gestures → intents (P1-T11). Pure translation: no DOM, no engine, no side effects.
//
// Every mouse gesture and hotkey in the MVP arrives here as a described event and leaves as at most
// one `Intent`. Keeping it pure is what makes the input layer testable at all — the alternative is
// a browser test per gesture — and it is what guarantees ADR-0008's rule that nothing above the
// bridge writes sim state: this module *cannot*, it has nothing to write to.
//
// The gesture vocabulary is upstream's, letter for letter, because a returning 2D player should not
// have to relearn their hands (persona P1). Left-click selects, left-drag box-selects, double-click
// selects the type on screen, right-click is the context order (move / attack / gather, decided by
// what is under the cursor).
//
// The keys are the ones that surprise people, and they are upstream's for a reason worth writing
// down: **stop is X, not S**, because W/A/S/D pan the camera (PRD §5) and upstream gave the pan
// keys priority. `A` genuinely does double duty there — it pans left AND arms attack-move — and
// that is upstream's own resolution, kept deliberately rather than "fixed" into a third dialect.
// Camera rotation gets `,` and `.` because upstream has already spent Q and E on select-army and
// scout; binding rotation to them now would collide the day Phase 3 adds those orders.
//
// ================================================================================================
// P5-T13 — the ten orders with no way in (PARITY.md §5.2, rows 31–40)
// ================================================================================================
//
// A third of the verb list the 2D game gives a player had no gesture, no button and no intent. Two
// of them (`setRally`, `cancelTrain`) had an intent since Phase 1 with **no producer on either
// end**. They arrive here as keys and gestures rather than as HUD buttons because that is what they
// are in the 2D game, and because the reachability failure this project has now recorded six times
// is specifically the failure of building a panel and never wiring it (PARITY §7.4).
//
// **Where the letters came from, and where upstream's letters ran out.** Upstream's `input.js` is
// NOT vendored (PARITY §6.3 — half the parity surface never was), so for these ten there is no
// upstream letter to copy the way X and H were copied. Only one of the ten has an upstream letter
// at all, and this file has been holding it since the MVP: the paragraph above reserves **E for
// scout**, and row 35 is `issueScout`. It is spent here exactly as it was reserved.
//
// For the other nine the board is what P4-T13 left it: **I, J, K, U** free, `J` deliberately
// unbound (`test/input/intents.test.ts` uses it as its example of a key this module does not own,
// and a guard worth having is worth not weakening), `Q` still held for upstream's select-army. Four
// letters against nine orders, so the rest take **Shift on the letter the order is named for** —
// the `Shift+O` = detonate idiom this file already has, one order per letter rather than nine more
// letters this board does not have:
//
//   Shift+R  Repair (33)            bare R is patrol
//   Shift+F  Ferry (37)             bare F cycles the formation shape
//   Shift+H  Home base (38)         bare H is hold
//   Shift+P  collection Point (39)  bare P is protect/escort
//   Shift+L  ai Logistics (40)      bare L opens the logistics board — the same subject, one level
//                                   down: the board reads the haulers, this hands a ship to them
//
// **Shift is never put on X.** `test/input/intents.test.ts`'s "caps lock does not disarm the army"
// pins `Shift+X` to stop, and a key that stops the army is not one to overload.
//
// The two bare letters that are spent, and honestly:
//
//   I / Shift+I  Service a building (34) / Assist build (36). One letter for two orders because
//                **the engine itself makes them exclusive**: `updateService` drops a service job on
//                a `constructing` target on the very next tick, and a build order is the only thing
//                that helps one. Bare I is the finished building, Shift+I the unfinished one.
//   U            Set rally (31). Rally's own letters — R, A, L, Y — are patrol, pan/attack-move,
//                the logistics board and the starmap. U carries no meaning and this file has a
//                precedent for saying so: "a doomsday device ended up on O rather than on B".
//
// And one that is not a letter at all:
//
//   Delete       Cancel a queued unit (32). The letter board has none to spare, "remove the last
//                thing I added" is what this key means everywhere else, and it costs the letters
//                nothing. Not Backspace — that still navigates in some browsers.
//
// `K` is left free on purpose. A bare letter is the scarce thing here; a Shift slot is not.
// (**P6-T11 has spent it**, on the one control that had no other way in at all — see below.)
//
// **Row 38's gesture is upstream's, and this client cannot have it.** `engine/gather.js`'s
// `zoneFirst` names it out loud — a home base is set by "a right-click on a Command Center with
// eligible units selected". This client's right-click is the single context order (move / attack /
// gather) and its only modifier is the queue, so taking that gesture would cost every player the
// ability to right-click their own base to walk there. Shift+H instead, and the reason recorded
// here rather than left for someone to wonder about.
//
// **What these gestures deliberately do NOT do.** None of the six new modes inspects the snapshot
// to decide whether the thing under the cursor is a legal target. That is not laziness: the legal
// targets are the engine's business (`canLogisticsType`, `canBuildType`, `cargoHold`,
// `isCommandCenter`, `constructing`), and the bridge is where the engine can be asked (ADR-0012
// §5). A miss — a click that found no entity at all — cancels the mode rather than being swallowed,
// which is `escort`'s rule and for `escort`'s reason.
//
// ================================================================================================
// P6-T11 — keyboard-only PLAY, which is not the same clause as a keyboard-navigable HUD
// ================================================================================================
//
// P6-T03 made every HUD control reachable with Tab. The GAME was still mouse-only, and this module
// is where that was true: **`translateKey` produced no `select` of any kind**, so no worker and no
// building could ever be chosen without a click, and a control group had nothing to assign.
//
// **And it was worse than "awkward without a mouse" — it was a dead end at t=0.** Both the row that
// filed this and an earlier agent's report said the opening colony ship begins selected, so the
// first sixty seconds work and the problem hides. Measured, that is false: `state.selection` is
// `[]`, `hudModel.canDeploy` is false, the action row is EMPTY, and the HUD's own prompt reads
// *"Click your colony ship to select it."* A keyboard-only player reached a game that told them to
// use a mouse and offered no other way forward. `test/ui/keyboard-play.test.ts` opens with that
// measurement, because a premise nobody checked is how the gap survived six phases.
//
// PRD §5's Phase 6 scope says **"keyboard-only play"** in those words; N-05 says "keyboard-navigable
// UI". They are two clauses and P6-T03 discharged one.
//
// A mouse answers two questions this board never had another answer for — **which thing** (the
// click picks it out of the world) and **where** (the cursor is a point). Everything else a player
// needs was already bound. So this row is two keys, one per question, and nothing else:
//
//   Q / Shift+Q   WHICH. Q selects every visible entity of the next TYPE the player owns; Shift+Q
//                 steps through that type one at a time. Wrapping, so the whole roster is reachable
//                 from anywhere in it.
//   K / Shift+K   WHERE. **The camera centre is the cursor.** One press acts on it: it completes an
//                 armed mode (the left click those twelve modes are waiting for), or issues the
//                 context order (the right click) when nothing is armed.
//
// **Q is upstream's own letter, held in reserve by this file since the MVP** — the paragraph above
// reserves "Q and E for select-army and scout", E was spent on `scout` by P5-T13, and this is the
// other half of the same reservation. Bare Q *is* select-army when the army is one type; it is the
// general case, because a keyboard also has to be able to reach a worker and a Command Center, and
// upstream's own `sameTypeAs` (this file's double-click) is already the shape of "all of those".
//
// **K is the last free bare letter and this is what one is for**: the control that has no other way
// in at all. `J` stays unbound — `test/input/intents.test.ts` uses it as its example of a key this
// module does not own, and that guard is what would catch a letter quietly acquiring a binding.
//
// **Not Enter and not Space, and that is the important negative.** They are the obvious keys and
// they are exactly the ones P6-T03 had to fight: `ui/hud-focus.ts` owns Enter and Space *while the
// ring holds focus*, because the browser fires a focused button on Space while `translateKey` reads
// Space as focus-last-alert — one keystroke, two commands. Giving either a world meaning would
// rebuild that hazard on purpose: the same press would place a building or press whatever control
// the player happens to be standing on, decided by invisible state. A letter has no such problem —
// the ring passes everything that is not Tab/Enter/Space/Escape straight through — so `K` works
// with a HUD button focused, which is where a keyboard player spends much of their time.
//
// **Why the camera and not a reticle.** The obvious alternative is a modal cursor: a mark the
// player drives with its own keys, drawn over the world. That is a second camera to steer, a second
// thing to draw, and a mode to enter and leave. The camera already *is* a reticle — it is centred
// on screen by construction, W/A/S/D and the arrows already point it (PRD §5), and a player looks
// at the thing they are about to act on anyway. The cheapest cursor is the one that is already on
// screen and already driven, and it costs no key at all.
//
// **What this deliberately does not give a keyboard.** There is no keyboard left-click on empty
// ground, so there is no "click nothing to deselect" and no select-by-pointing: `Q` is the
// selection control and it always lands on something. Both were priced against a third binding on a
// board with two letters left, and neither is needed to play — nothing in the game requires an
// empty selection, and every per-entity ORDER already takes its target from the crosshair through
// the modes above (repair, service, assist, ferry, home base, escort).

import { type Intent } from "../bridge/commands.js";
import { type Snapshot, FLAG_BUILDING_KIND, engineId, numericId } from "../bridge/snapshot.js";

export type MouseButton = "left" | "right" | "middle";

export interface PointerGesture {
  readonly type: "click" | "doubleClick" | "boxSelect" | "contextClick";
  readonly button: MouseButton;
  /** Simulation coordinate the gesture resolved to (from `pickGround`). */
  readonly worldX: number;
  readonly worldY: number;
  /** Second corner, for a box select. */
  readonly worldX2?: number;
  readonly worldY2?: number;
  /** Engine id under the cursor, if the entity picker found one. */
  readonly entityId?: string | null;
  /** Resource-node engine id under the cursor, if any. */
  readonly nodeId?: string | null;
  readonly shift: boolean;
  readonly ctrl: boolean;
}

/**
 * A pending mode the next click resolves: attack-move waiting for its target point, or a build
 * placement waiting for its spot. Modal input is how an RTS keeps its hotkey count human.
 */
export type PendingMode =
  | { kind: "none" }
  | { kind: "attackMove" }
  | { kind: "patrol" }
  | { kind: "build"; buildingType: string }
  // Phase 3. A formation move needs a destination and an escort needs a target, so both are modes
  // for the same reason attack-move is: the order is not complete until the next click.
  //
  // The formation's shape rides ON the mode rather than in the caller's state, which is what keeps
  // this module pure. Pressing the key again while the mode is up advances the shape, so cycling and
  // arming are the same gesture and the player sees what they are about to get before committing.
  | { kind: "formation"; shape: string; leaderPos: string }
  | { kind: "escort" }
  // Phase 5's parity close-out (P5-T13). Six more of the same thing: an order that is not complete
  // until the next click has named its target. Five want an ENTITY (`escort`'s shape exactly) and
  // `rally` wants a POINT — and, if the point happens to be a resource node, that node's id too,
  // which is upstream's rally-to-node and the reason row 31 could not just be wired as it stood.
  //
  // None of them carries anything else. The actor is the selection, which lives in the simulation
  // and is resolved at the bridge; this module has never been able to see it and must not start.
  | { kind: "rally" }
  | { kind: "repair" }
  | { kind: "service" }
  | { kind: "assist" }
  | { kind: "ferry" }
  | { kind: "homeBase" };

export interface GestureResult {
  readonly intent: Intent | null;
  /** What the mode should become. The caller owns the mode; this only says what it becomes. */
  readonly mode: PendingMode;
}

const NO_INTENT: GestureResult = { intent: null, mode: { kind: "none" } };

/**
 * Translate one pointer gesture.
 *
 * @param snap  used only to decide *what* is under the cursor — never mutated, never stored.
 */
export function translatePointer(
  gesture: PointerGesture,
  mode: PendingMode,
  snap: Snapshot,
): GestureResult {
  if (gesture.button === "left") {
    // A pending mode consumes the next left click. Modal state is the one place an RTS is allowed
    // to surprise the player, so it always resolves on the very next click and never persists.
    switch (mode.kind) {
      case "attackMove":
        return { intent: { kind: "attackMove", x: gesture.worldX, y: gesture.worldY, queue: gesture.shift }, mode: { kind: "none" } };
      case "patrol":
        return { intent: { kind: "patrol", x: gesture.worldX, y: gesture.worldY }, mode: { kind: "none" } };
      case "build":
        return {
          intent: { kind: "build", buildingType: mode.buildingType, x: gesture.worldX, y: gesture.worldY },
          // Shift keeps the build mode alive so a player can lay a turret line without re-clicking
          // the button five times — the one place upstream's own UI is sticky, and it matters.
          mode: gesture.shift ? mode : { kind: "none" },
        };
      case "formation":
        return {
          intent: {
            kind: "moveInFormation", x: gesture.worldX, y: gesture.worldY,
            shape: mode.shape, leaderPos: mode.leaderPos, queue: gesture.shift,
          },
          mode: { kind: "none" },
        };
      case "escort":
        // An escort needs a SHIP, not a point. Clicking empty ground cancels rather than issuing
        // anything: the alternative is a silently swallowed click, and the player would try again.
        return gesture.entityId
          ? { intent: { kind: "escort", targetId: gesture.entityId, queue: gesture.shift }, mode: { kind: "none" } }
          : NO_INTENT;
      // --- Phase 5's parity close-out (P5-T13) ------------------------------------------------
      case "rally":
        // The only one of the six that resolves on a POINT, so it never misses. `nodeId` rides
        // along when the click landed on a deposit: that is upstream's rally-to-node, and it is
        // the difference between a worker that spawns already mining and one that walks to a spot
        // beside the ore and stops. `null` rather than absent, so the recorded intent says which
        // of the two it was rather than leaving it to be inferred.
        return {
          intent: {
            kind: "setRally", x: gesture.worldX, y: gesture.worldY,
            nodeId: gesture.nodeId ?? null,
          },
          mode: { kind: "none" },
        };
      case "repair":
        return targetOrCancel(gesture, (id) => ({ kind: "repair", targetId: id, queue: gesture.shift }));
      case "service":
        return targetOrCancel(gesture, (id) => ({ kind: "serviceBuilding", buildingId: id, queue: gesture.shift }));
      case "assist":
        return targetOrCancel(gesture, (id) => ({ kind: "assistBuild", buildingId: id, queue: gesture.shift }));
      case "ferry":
        return targetOrCancel(gesture, (id) => ({ kind: "ferryFreighter", freighterId: id, queue: gesture.shift }));
      case "homeBase":
        // No `queue`: `issueSetHomeBase` takes none. It is passive — the engine's own comment says
        // it "never touches whatever order the unit is already running" — so there is nothing for a
        // waypoint to sit behind.
        return targetOrCancel(gesture, (id) => ({ kind: "setHomeBase", ccId: id }));
      case "none":
        break;
    }

    switch (gesture.type) {
      case "click":
        return {
          intent: { kind: "select", ids: gesture.entityId ? [gesture.entityId] : [], additive: gesture.shift },
          mode: { kind: "none" },
        };
      case "doubleClick": {
        // Select every visible entity of the clicked type. "On screen" is the snapshot, which is
        // already fog-filtered, so this can never select something the player cannot see.
        if (!gesture.entityId) return NO_INTENT;
        const ids = sameTypeAs(snap, gesture.entityId);
        return { intent: { kind: "select", ids, additive: gesture.shift }, mode: { kind: "none" } };
      }
      case "boxSelect": {
        const ids = idsInBox(snap, gesture.worldX, gesture.worldY, gesture.worldX2 ?? gesture.worldX, gesture.worldY2 ?? gesture.worldY);
        return { intent: { kind: "select", ids, additive: gesture.shift }, mode: { kind: "none" } };
      }
      case "contextClick":
        break;
    }
    return NO_INTENT;
  }

  if (gesture.button === "right") {
    // Right-click cancels a pending mode rather than issuing an order — the universal "no, not
    // that" that stops a mis-clicked build mode becoming a mis-placed building.
    if (mode.kind !== "none") return NO_INTENT;
    if (gesture.entityId && isEnemy(snap, gesture.entityId)) {
      return { intent: { kind: "attack", targetId: gesture.entityId, queue: gesture.shift }, mode: { kind: "none" } };
    }
    if (gesture.nodeId) {
      return { intent: { kind: "gather", nodeId: gesture.nodeId, queue: gesture.shift }, mode: { kind: "none" } };
    }
    return { intent: { kind: "move", x: gesture.worldX, y: gesture.worldY, queue: gesture.shift }, mode: { kind: "none" } };
  }

  return NO_INTENT;
}

/**
 * The five entity-target modes, resolved: the intent the click makes, or a cancelled mode.
 *
 * Cancelling on a miss is `escort`'s rule and it is the right one for all five — swallowing the
 * click AND staying armed means the player clicks again and the second click lands the order on
 * whatever they happened to hit. Whether the entity is a LEGAL target for the order is not asked
 * here at all: that is the engine's question and the bridge is where it can be asked (ADR-0012 §5).
 */
function targetOrCancel(
  gesture: PointerGesture,
  make: (entityId: string) => Intent,
): GestureResult {
  return gesture.entityId
    ? { intent: make(gesture.entityId), mode: { kind: "none" } }
    : NO_INTENT;
}

export interface KeyGesture {
  readonly key: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
}

export interface KeyResult {
  readonly intent: Intent | null;
  readonly mode: PendingMode | null;
  /**
   * Camera actions the caller performs; the camera is not sim state, so it is not an intent.
   *
   * `focusAlert` is PRD §4's second named camera command and it needs the alert board to resolve,
   * which lives in the application — so, like `group` below, this only says WHICH action, never
   * where. It also dismisses what it jumps to: an alert a player has looked at is handled, and
   * making them press a second key to clear it is how an alert board fills up and stops being read.
   */
  readonly camera: "focusBase" | "focusAlert" | "rotateLeft" | "rotateRight" | null;
  readonly cancel: boolean;
  /** Flip the power-grid overlay. A view concern, so it is not an intent (nothing in the sim moves). */
  readonly togglePower?: boolean;
  /**
   * A control-group press (P3-T13), for the caller to resolve against its own `ControlGroups`.
   *
   * NOT an intent, and that is the whole point of the task: a control group is client state, and
   * `state.selection` is sim state that `hashState` hashes. A recall becomes an ordinary `select`
   * intent up in the caller, where the group and the snapshot both live. This module has neither
   * and must not grow either.
   */
  readonly group?: { readonly n: number; readonly op: "assign" | "append" | "recall" };
  /**
   * A Helium Bomb command (P3-T10) for the caller to aim at the selection.
   *
   * Same shape of problem as `group`: `armBomb`/`detonate` address ONE unit by id, deliberately —
   * "arm everything selected" is not a thing anyone should be able to do to a doomsday device by
   * accident — and this module cannot see the selection. So the caller resolves it.
   */
  readonly bomb?: "toggleArm" | "detonate";
  /**
   * A POSITIONAL action press (P4-T01) — fire the Nth button the HUD is showing.
   *
   * Z/C/V/B/N are upstream's own action keys and this module has described them that way since the
   * MVP while having no button list to point at: the HUD offered three ad-hoc rows and the letters
   * were left unbound rather than nailed to fixed orders. `HudModel.actions` is that list now, so
   * the convention is finally implementable — and it is what gives the economy panels a keyboard,
   * without inventing five more letters on a board that has none left.
   *
   * An INDEX, not an intent, for exactly the reason `group` and `bomb` are: this layer cannot see
   * the HUD. The caller resolves it against the buttons it is actually drawing.
   */
  readonly action?: { readonly index: number };
  /**
   * Open or close one of the base-wide economy boards (P4-T01).
   *
   * Not an intent — nothing in the simulation knows a panel is open, the same reason `togglePower`
   * is not one. The two boards that need a key are the two that are NOT about the selection: the
   * market and the haulage/repair board. Everything else follows what the player has clicked.
   */
  readonly board?: "market" | "logistics";
  /**
   * Show or hide the GALAXY SCREEN — the starmap (P4-T13).
   *
   * Not an intent, for `board`'s reason: nothing in the simulation knows which screen is up, and a
   * determinism replay must not depend on one. It is a request rather than a state because this
   * module cannot see which screen the shell is showing, exactly as it cannot see the selection.
   *
   * **The letter is `Y`, the last free letter of *galaxy***, and that is not whimsy — it is what is
   * left. The free-letter arithmetic in this function's own doc comment is the whole story: G is the
   * power grid, A attack-moves, L is logistics and X is stop, so every other letter of the word the
   * screen is named after is already spent, and of I/K/U/Y none has a better claim.
   *
   * (`J` for "jump" would read best of all and is deliberately not taken: `test/input/intents.test.ts`
   * uses J as its example of a key this module does NOT own, and that test is the guard that would
   * catch a letter quietly acquiring a binding. A binding worth having is worth not weakening a
   * check for.)
   *
   * The approach view needs no letter of its own — it is reached by picking a destination, which is
   * a click on a world or a button on this screen. And a screen you can only leave by remembering a
   * key is a screen you can get stuck on: Escape backs out one level (`cancel`) and Y closes the
   * whole thing.
   */
  readonly screen?: "starmap";
  /**
   * A SELECTION CYCLE press (P6-T11) — the keyboard's answer to *which thing*.
   *
   * A DIRECTION and nothing more, for the reason `group`, `bomb` and `action` are: this module
   * cannot see the roster, and `state.selection` is simulation state that only `applyIntent` may
   * write (ADR-0012 §5). The caller resolves the step against the snapshot — which is fog-filtered,
   * so a cycle can never reach something the player cannot see — and enqueues an ordinary `select`,
   * the same intent through the same queue a mouse drag produces.
   *
   *   `"type"`    (bare Q)      every visible entity of the NEXT type the player owns. One press is
   *                             a whole army, or the Command Center, or every worker — which is
   *                             upstream's select-army generalised to the things a keyboard also
   *                             has to reach.
   *   `"member"`  (Shift+Q)     ONE entity of the type that is selected now, stepping through them
   *                             on repeat. The answer to "the right one of several", and the only
   *                             way a keyboard addresses the second Command Center.
   *
   * It leaves `mode` null — a cycle does not disarm a pending order. Arming a build, then picking
   * which worker puts it up, then placing it is a real sequence, and cancelling is Escape's job.
   */
  readonly select?: { readonly scope: "type" | "member" };
  /**
   * A CROSSHAIR press (P6-T11) — the keyboard's answer to *where*.
   *
   * The caller turns this into one `PointerGesture` at the camera centre and puts it back through
   * `translatePointer`, so a keyboard order is the same gesture a mouse order is, resolved by the
   * same code: the twelve pending modes, the context order's move/attack/gather branch, and the
   * entity or node under the point all come along rather than being re-derived for the keyboard.
   *
   * **The button is decided here** because this is the one layer that can: `translateKey` is handed
   * the pending mode, and a mode is a click already promised. Armed → the LEFT click it is waiting
   * for. Nothing armed → the RIGHT click, which is the context order. One key, so a player never
   * has to remember which of two completes a build placement.
   *
   * `shift` rides through with the meaning it has under the mouse, because it IS the same gesture:
   * queue this order behind the last one, or keep a build mode alive to lay a second turret.
   */
  readonly crosshair?: { readonly button: "left" | "right"; readonly shift: boolean };
}

const NO_KEY: KeyResult = { intent: null, mode: null, camera: null, cancel: false };

/**
 * The positional action keys, in order. Upstream's letters and upstream's order.
 *
 * Five, because that is what upstream binds; a HUD row longer than five is reachable by mouse and
 * by nothing else, which is a real limit rather than a bug to paper over with more letters.
 */
export const POSITIONAL_KEYS: readonly string[] = ["z", "c", "v", "b", "n"];

/**
 * Hotkeys. Upstream's letters, so muscle memory carries over (persona P1).
 *
 * `mode` is passed in because Phase 3's formation key CYCLES: pressing it again while the mode is up
 * advances the shape rather than re-arming the same one. The parameter is optional so every existing
 * call site keeps working, and the function stays pure — it reads the mode, it does not own it.
 *
 * **The free letters are scarcer than they look**, which is what decided these bindings. W/A/S/D pan
 * (PRD §5), upstream spends Q and E on select-army and scout, and Z/C/V/B/N are upstream's
 * POSITIONAL action keys — they fire the Nth button the HUD is showing, so binding a fixed order to
 * one would break that rule the moment the HUD has buttons. That left F, T and P, which is why a
 * doomsday device ended up on O rather than on B for "bomb".
 *
 * **P4-T01 made the positional rule real rather than a reservation.** The HUD now has an ordered
 * button list (`HudModel.actions`), so Z/C/V/B/N return an INDEX into it and Phase 2's economy
 * controls get a keyboard without spending five more letters this board does not have. M and L open
 * the two boards that are not about the selection. That left I, J, K, U and Y genuinely free, and
 * **P4-T13 has spent Y on the starmap** — the whole galaxy, every panel Phase 4 built and the
 * approach view behind it, for one letter, because the positional row carries the rest.
 *
 * **P5-T13 spent E, I and U, and left K.** Ten orders arrived at once (PARITY.md §5.2) against
 * four free letters, so only the ones with a claim took one: E because this file reserved it for
 * upstream's scout in the MVP, I because it carries two orders the engine itself keeps exclusive,
 * U because a rally point had nothing left to be named after. The other six went onto **Shift +
 * the letter they are named for** — R, F, H, P, L — and one onto Delete, which is not a letter at
 * all. The full table and the reasoning are in this module's header.
 *
 * **P6-T11 spent the last two, Q and K, on being able to play at all.** Every letter above orders
 * something a player has already selected, and until this row nothing on the keyboard could select
 * it or say where — so Q cycles the selection and K acts on the camera centre. `J` is still
 * deliberately unbound. The board is now full, and the next order that needs a key needs a mode, a
 * modifier or a positional slot; there is no bare letter left to argue over.
 */
export function translateKey(gesture: KeyGesture, mode: PendingMode = { kind: "none" }): KeyResult {
  // Control groups: the digit row, as every RTS since the nineties. Ctrl assigns, Shift appends, a
  // bare press recalls. Checked before the letter switch because a digit is never a letter.
  const digit = /^[0-9]$/.test(gesture.key) ? Number(gesture.key) : -1;
  if (digit >= 0) {
    const op = gesture.ctrl ? "assign" : gesture.shift ? "append" : "recall";
    return { ...NO_KEY, group: { n: digit, op } };
  }

  // The positional row, before the letter switch — Z used to return a hard-coded `deploy` intent,
  // and it still deploys, because Deploy is the first button the HUD shows a selected colony ship.
  // That was always the stated reason for the binding; it is now the actual mechanism.
  const positional = POSITIONAL_KEYS.indexOf(gesture.key.toLowerCase());
  if (positional >= 0) return { ...NO_KEY, action: { index: positional } };

  switch (gesture.key.toLowerCase()) {
    case "a": return { intent: null, mode: { kind: "attackMove" }, camera: null, cancel: false };
    // R patrols; Shift+R is **R**epair (P5-T13, row 33) — the explicit "go fix that" a player gives
    // when the auto-repair picks wrong. The pair keeps both orders on the letter each is named for.
    case "r": return {
      intent: null,
      mode: gesture.shift ? { kind: "repair" } : { kind: "patrol" },
      camera: null, cancel: false,
    };
    case "x": return { intent: { kind: "stop" }, mode: { kind: "none" }, camera: null, cancel: false };
    // H holds; Shift+H sets the **H**ome base (row 38) — see the header for why this is not
    // upstream's own right-click-a-Command-Center.
    case "h": return gesture.shift
      ? { intent: null, mode: { kind: "homeBase" }, camera: null, cancel: false }
      : { intent: { kind: "hold" }, mode: { kind: "none" }, camera: null, cancel: false };
    // The power grid overlay. `G` for grid — upstream has not spent it, and the alternatives
    // (`P` for power) collide with nothing today but read as "pause" to anyone coming from another
    // RTS. It is a toggle rather than a mode because the grid answers "where can I build this
    // efficiently?", which a player asks while doing something else.
    case "g": return { ...NO_KEY, togglePower: true };
    // --- Phase 3 ------------------------------------------------------------------------------
    // F arms a formation move and cycles its shape on repeat. The shape lives in the mode, so the
    // player can see what they are arming before they commit the click (see `PendingMode`).
    //
    // Shift+F is **F**erry (P5-T13, row 37): send workers to load a landed freighter's hold. It
    // must not cycle, so it is checked before `nextShape` rather than after.
    case "f": return {
      intent: null,
      mode: gesture.shift
        ? { kind: "ferry" }
        : { kind: "formation", shape: nextShape(mode), leaderPos: DEFAULT_LEADER_POS },
      camera: null, cancel: false,
    };
    // T holds the formation where the group already stands — no click, because there is no
    // destination. It reuses whatever shape F last armed, so the two keys are one control.
    case "t": return {
      intent: {
        kind: "holdFormation",
        shape: mode.kind === "formation" ? mode.shape : FORMATION_KEY_SHAPES[0]!,
        leaderPos: DEFAULT_LEADER_POS,
      },
      mode: { kind: "none" }, camera: null, cancel: false,
    };
    // P for protect. Not G (the power grid), not E (upstream's scout), not C or V (positional).
    //
    // Shift+P is the collection **P**oint (P5-T13, row 39): park a freighter where it stands and
    // let it empty itself into the treasury whenever it fills. A toggle with no `on` — only the
    // simulation knows which way the flag is pointing, so the bridge flips it.
    case "p": return gesture.shift
      ? { intent: { kind: "collectPoint" }, mode: { kind: "none" }, camera: null, cancel: false }
      : { intent: null, mode: { kind: "escort" }, camera: null, cancel: false };
    // The Helium Bomb. O rather than B because B is one of upstream's positional action keys.
    // Arming and detonating are separate presses on purpose — `applyIntent` refuses to detonate an
    // unarmed bomb, so those two presses ARE the confirmation dialog this build does not have.
    case "o": return { ...NO_KEY, bomb: gesture.shift ? "detonate" : "toggleArm" };
    // --- Phase 2's economy, finally reachable (P4-T01) -------------------------------------------
    // Two boards, two letters, and they are the only two economy panels that need one: the market
    // and the haulage/repair board are the panels that are NOT about the current selection. The
    // rest — pause, electrify, scrap, research, doctrine, haul priority — follow what the player has
    // clicked, so they cost no key at all and reach the keyboard through the positional row above.
    case "m": return { ...NO_KEY, board: "market" };
    // L opens the haulage board; Shift+L hands the selected freighters to the **L**ogistics AI
    // (P5-T13, row 40) — the same subject one level down, which is why they share the letter. The
    // engine refuses this silently without `FREIGHTER_AI_TECH`, so the bridge asks before ordering.
    case "l": return gesture.shift
      ? { intent: { kind: "aiLogistics" }, mode: { kind: "none" }, camera: null, cancel: false }
      : { ...NO_KEY, board: "logistics" };
    // --- Phase 5's parity close-out (P5-T13, PARITY.md §5.2) -------------------------------------
    //
    // E is upstream's own scout letter and this file's header has held it since the MVP: "upstream
    // has already spent Q and E on select-army and scout". Row 35 is that order, and this is the
    // reservation being spent rather than a new letter being invented. A stance, not a
    // destination — `scout.js` picks the ground itself — so it needs no click.
    case "e": return { intent: { kind: "scout" }, mode: { kind: "none" }, camera: null, cancel: false };
    // I services a FINISHED building (row 34); Shift+I helps finish an UNFINISHED one (row 36).
    // One letter, because the engine makes the two exclusive rather than merely similar: a service
    // job on a `constructing` target is dropped by `updateService` on the next tick, and a build
    // order is the only thing that helps one along.
    case "i": return {
      intent: null,
      mode: gesture.shift ? { kind: "assist" } : { kind: "service" },
      camera: null, cancel: false,
    };
    // U arms the rally point (row 31) — an arbitrary letter, and the header says why.
    case "u": return { intent: null, mode: { kind: "rally" }, camera: null, cancel: false };
    // Delete cancels the newest queued unit (row 32). A production queue a player could fill and
    // could not empty was the row; the bridge picks the last job and reports what `cancelProduction`
    // — the one order in this group that answers at all — said about it.
    case "delete": return { intent: { kind: "cancelTrain" }, mode: { kind: "none" }, camera: null, cancel: false };
    // --- P6-T11's two keys: keyboard-only PLAY (PRD §5, Phase 6) ----------------------------------
    //
    // Q is the reservation this file has held since the MVP, spent rather than replaced — see the
    // header. Bare Q takes the next TYPE (select-army, when the army is one type); Shift+Q steps
    // through the members of the type already selected, which is how a keyboard reaches the second
    // Command Center. `NO_KEY` leaves `mode` null on purpose: picking who does a job must not
    // disarm the job.
    case "q": return { ...NO_KEY, select: { scope: gesture.shift ? "member" : "type" } };
    // K is the last bare letter, and the crosshair is what a bare letter is for: without it a
    // keyboard can arm every one of the twelve modes above and complete none of them, and can never
    // say where. The BUTTON is read off the pending mode — armed is a click already promised, so it
    // is that mode's left click; nothing armed is the context order's right click.
    case "k": return {
      ...NO_KEY,
      crosshair: { button: mode.kind === "none" ? "right" : "left", shift: gesture.shift },
    };
    // --- Phase 4's galaxy, finally reachable (P4-T13) ---------------------------------------------
    // The starmap. One of the five letters this board still had (see `screen` above), and the only
    // Phase 4 control that needs a key at all: everything else on that screen is a button, and the
    // approach view is opened by picking the destination it is about.
    case "y": return { ...NO_KEY, screen: "starmap" };
    case "escape": return { intent: null, mode: { kind: "none" }, camera: null, cancel: true };
    // Space jumps to the newest live alert and Home goes to the base — the two were one binding
    // until P3-T14 gave the first one something to jump to. Space is the alert key in most of the
    // genre, and a player who presses it with nothing raised gets their base, which is the older
    // behaviour and the reasonable fallback rather than a dead key.
    case " ": return { ...NO_KEY, camera: "focusAlert" };
    case "home": return { ...NO_KEY, camera: "focusBase" };
    case ",": return { ...NO_KEY, camera: "rotateLeft" };
    case ".": return { ...NO_KEY, camera: "rotateRight" };
    default: return NO_KEY;
  }
}

/**
 * The shapes F cycles through, and the leader position it uses.
 *
 * **A copy of the engine's `FORMATION_SHAPES`, and it must not drift** — `applyIntent` validates
 * against the engine's own list and returns "Unknown formation …" for anything else, so a shape
 * added here that the engine does not know is a key press that is silently refused. It is copied
 * rather than imported because `input/` may not import the engine (ADR-0008), and
 * `test/input/phase3-input.test.ts` asserts the two lists are equal so the copy cannot rot.
 */
export const FORMATION_KEY_SHAPES: readonly string[] = ["grid", "line", "wedge", "circle"];
/** `front` because a formation move is an advance; the leader arrives first, which is legible. */
export const DEFAULT_LEADER_POS = "front";

function nextShape(mode: PendingMode): string {
  if (mode.kind !== "formation") return FORMATION_KEY_SHAPES[0]!;
  const i = FORMATION_KEY_SHAPES.indexOf(mode.shape);
  return FORMATION_KEY_SHAPES[(i + 1) % FORMATION_KEY_SHAPES.length]!;
}

/** Entity ids inside a world-space rectangle, player-owned only — box-select never grabs the enemy. */
export function idsInBox(snap: Snapshot, x0: number, y0: number, x1: number, y1: number): string[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const out: string[] = [];
  const e = snap.entities;
  for (let i = 0; i < e.count; i++) {
    if (e.owner[i] !== 0) continue;
    // Buildings are excluded: dragging a box across your base to grab an army and getting the
    // Command Center too is the single most-complained-about selection bug in the genre.
    if ((e.flags[i]! & FLAG_BUILDING_KIND) !== 0) continue;
    const x = e.x[i]!;
    const y = e.y[i]!;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    out.push(engineId(e.ids[i]!));
  }
  return out;
}

function sameTypeAs(snap: Snapshot, entityId: string): string[] {
  const e = snap.entities;
  const numeric = numericId(entityId);
  let typeIndex = -1;
  for (let i = 0; i < e.count; i++) if (e.ids[i] === numeric) { typeIndex = e.typeIndex[i]!; break; }
  if (typeIndex < 0) return [entityId];
  const out: string[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.owner[i] !== 0 || e.typeIndex[i] !== typeIndex) continue;
    out.push(engineId(e.ids[i]!));
  }
  return out;
}

function isEnemy(snap: Snapshot, entityId: string): boolean {
  const numeric = numericId(entityId);
  const e = snap.entities;
  for (let i = 0; i < e.count; i++) if (e.ids[i] === numeric) return e.owner[i] === 1;
  return false;
}

