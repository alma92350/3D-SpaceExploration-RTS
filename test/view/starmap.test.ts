// P4-T03 — the starmap: worlds, claims, stances, alerts.
//
// The row's definition of done is two sentences and they pull in different directions: "every world
// in `galaxy.worlds` is placed, owned and legible" is a claim about a picture, and "a stance change
// is visible without opening a panel" is a claim about what happens when the simulation moves while
// nobody is looking. Both are asserted here end to end — real engine, real bridge, real composer,
// real `Renderer` port — because every seam between them is a place the answer can be true on one
// side and false on the other.
//
// **ADR-0019 decided the design and this file is where its premises stop being prose.** The plate
// was chosen over a 3D scene on a measurement — how often a layout ranks jump destinations in the
// opposite order to what the engine charges — and a measurement that lives only in
// `perf/starmap-probe.mjs` is one nobody re-runs. So the two numbers the ADR paid for are asserted
// against the composed frame:
//
//   • **5.2 % discordant** at the authored view. Better than that is a bug in the measurement, not
//     a bonus; worse means the plate has stopped being the honest layout.
//   • **0 marker collisions**, which is what the stagger is bought with — and the test proves the
//     purchase by re-laying the same roster flat and watching six pairs collide.
//
// Five claims, each mutation-tested against the way it could be wrong (see the closing notes):
//
//   1. PLACED     every world in the roster reaches the frame, once, at the position its engine `x`
//                 says — and screen order along the axis IS `jumpCost` order.
//   2. MEANINGLESS  the cross-axis is a function of the roster index and of nothing else, proved by
//                 re-laying the plate under galaxies that disagree about everything else.
//   3. OWNED      each of the five statuses lands on the right owner colour, the seat is
//                 distinguishable without one, and a claim, a loss and a rival Gate each draw.
//   4. STANCE     the neighbour's attitude is on the map, tracks the engine's own number, and moves
//                 when the simulation moves it — with no panel anywhere in the call path.
//   5. REPORTED   every channel is `galaxyStatus`'s own answer, compared field by field, and the
//                 status vocabulary is pinned against the engine's source rather than a comment.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALERT_LOST_COLONY, ALERT_NONE, ALERT_RIVAL_GATE, AUTHORED_VIEW, PLATE_SPREAD, STAGGER_ROWS,
  STARMAP_WORLD_MESH, StarmapComposer, WORLD_DISC_SCALE, alertForWorld, authoredCamera, ownerSlotForWorld,
  plateMidX, plateX, plateZ, stanceFraction, worldScale, worldShade,
} from "../../src/view/starmap.js";
import {
  GalaxySnapshotExtractor, NO_FACTION, NO_WORLD, WORLD_COLONY, WORLD_CONTESTED, WORLD_PACIFIED,
  WORLD_SEAT, WORLD_STATUS_CODES, WORLD_UNEXPLORED, WORLD_UNKNOWN, statusCodeOf,
  type GalaxySnapshot,
} from "../../src/bridge/galaxy-snapshot.js";
import { RecordingRenderer, type RecordedFrame } from "../../src/view/renderer/recording.js";
import { OWNER_AI, OWNER_NEUTRAL, OWNER_PLAYER, OVERLAY_STRIDE } from "../../src/view/renderer/port.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { CameraRig, YAW_SNAP_COUNT } from "../../src/input/camera.js";
import { projectToScreen } from "../../src/input/picking.js";
import {
  ODYSSEY_WORLDS, PLANETS, backgroundWorldIds, canJumpTo, createGalaxy, galaxyStatus, jumpCost,
  makeBuilding, stepGalaxy,
} from "../../src/engine/index.js";
import { STEP_SECONDS } from "../../src/app/loop.js";

const SEED = 20260815;
const HOME = "helix";
const meshes = buildMeshes();

/**
 * A world's diplomacy record.
 *
 * Deliberately NOT on the declared `State` shape: `state.diplomacy` is Odyssey-only — a skirmish
 * has none — so the declarations this project hand-wrote do not carry it. A narrow cast, used only
 * to arrange and to read the stance the engine itself owns, exactly as `ai-fog.test.ts` reaches for
 * the AI's private controller.
 */
function diplomacyOf(state: State): { stance: number } {
  return (state as unknown as { diplomacy: { stance: number } }).diplomacy;
}

/** The one orientation the plate is read at, as a live camera. */
function authoredCameraState() {
  const rig = new CameraRig({ mapWidth: 2400, mapHeight: 2400 });
  authoredCamera(rig);
  return rig.update(1280, 720);
}

/**
 * A galaxy in motion — every status the engine can report, a claim, a stance and a rival Gate.
 *
 * Built by hand rather than by playing forty minutes of Odyssey, and the parts are the engine's own
 * state rather than an imitation of it: `discovered`, `claims` and `pacified` are the sets
 * `galaxyStatus` reads, and the stance is the neighbour's own `diplomacy.stance`. Nothing here
 * fakes the *summary*; it arranges the world the summary describes.
 *
 * The premise this scenario has to satisfy is asserted in the first test: **all five statuses must
 * actually occur**. A starmap test on a fresh galaxy would draw ten identical unexplored discs and
 * one seat, and every claim about legibility would be green and empty.
 */
function galaxyInMotion() {
  const galaxy = createGalaxy({ seed: SEED, startId: HOME });
  const live = backgroundWorldIds(SEED, HOME);
  expect(live.length, "the seeded background draw brought up no worlds to arrange").toBeGreaterThanOrEqual(3);

  const [colonyId, contestedId, pacifiedId] = live as [string, string, string];

  // A COLONY: reached, and still holding a building there.
  galaxy.discovered.add(colonyId);
  const colony = galaxy.planets.get(colonyId)!;
  const spot = colony.map.bases.player;
  const hq = makeBuilding("command", "player", spot.x, spot.y);
  colony.buildings.set(hq.id, hq);

  // CONTESTED: reached, holding nothing. The engine's only status that reports a loss.
  galaxy.discovered.add(contestedId);

  // PACIFIED: their capital razed, and it stays razed.
  galaxy.discovered.add(pacifiedId);
  galaxy.pacified.add(pacifiedId);

  // A CLAIM, on a world the player has never been to — `controlledBy` is sphere-of-influence news
  // and the engine shows it galaxy-wide, so the frontier fills in ahead of the player.
  const claimedId = ODYSSEY_WORLDS.find((id) => !galaxy.discovered.has(id) && id !== HOME)!;
  galaxy.claims.set(claimedId, "syndicate");

  // A RIVAL GATE, charging. `galaxy.rivalGate` is transient galaxy bookkeeping that the hand-written
  // declarations do not describe, so it is set through a narrow cast — the same move a test makes
  // for any transient the hand-written `.d.ts` leaves out. `rivalGateStatus` reads the charge off
  // the building every call.
  const gate = makeBuilding("antimatter_gate", "ai", spot.x + 200, spot.y);
  (gate as unknown as { charge: number }).charge = 0.42;
  colony.buildings.set(gate.id, gate);
  (galaxy as unknown as { rivalGate: { worldId: string; buildingId: string } }).rivalGate =
    { worldId: colonyId, buildingId: gate.id };

  // A STANCE worth reading: the neighbour on the colony world has soured.
  diplomacyOf(colony).stance = -0.4;

  return { galaxy, colonyId, contestedId, pacifiedId, claimedId };
}

function snapshotOf(galaxy: Galaxy): GalaxySnapshot {
  return new GalaxySnapshotExtractor().extract(galaxy);
}

function composeFrame(snap: GalaxySnapshot): { frame: RecordedFrame; composer: StarmapComposer } {
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(meshes);
  renderer.resize(1280, 720, 1);
  const composer = new StarmapComposer();
  composer.compose(renderer, snap, authoredCameraState());
  return { frame: renderer.lastFrame, composer };
}

/** Every instance the frame drew, as (x, z, scale, shade, owner) — the plate, read back. */
function drawnWorlds(frame: RecordedFrame) {
  const out: Array<{ x: number; z: number; scale: number; shade: number; owner: number }> = [];
  for (const batch of frame.batches) {
    for (let i = 0; i < batch.count; i++) {
      out.push({
        x: batch.xyz[i * 3]!, z: batch.xyz[i * 3 + 2]!,
        scale: batch.scale[i]!, shade: batch.shade[i]!, owner: batch.owner,
      });
    }
  }
  return out;
}

function overlayRows(frame: RecordedFrame, kind: string): number[][] {
  const layer = frame.overlays.find((o) => o.kind === kind);
  if (!layer) return [];
  const rows: number[][] = [];
  for (let i = 0; i < layer.count; i++) {
    rows.push([...layer.data.slice(i * layer.stride, (i + 1) * layer.stride)]);
  }
  return rows;
}

/* =================================================================================================
   1. PLACED — every world, once, on the axis the engine actually computes
   ================================================================================================= */

describe("the plate places every world on the galaxy's one coordinate (P4-T03, ADR-0019)", () => {
  it("draws a scenario that exercises every status", () => {
    // The anti-vacuity guard for the whole file. Without it, everything below is a test of ten
    // identical unexplored discs.
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const seen = new Set<number>();
    for (let i = 0; i < snap.worlds.count; i++) seen.add(snap.worlds.status[i]!);
    for (const [name, code] of Object.entries(WORLD_STATUS_CODES)) {
      expect(seen.has(code), `no world in the scenario is "${name}" — that status is never drawn here`)
        .toBe(true);
    }
    expect(seen.has(WORLD_UNKNOWN), "the bridge could not map a status the engine reported").toBe(false);
    expect(snap.unknownStatuses, "unmapped statuses reached the view").toEqual([]);
  });

  it("puts every world in galaxy.worlds on the plate, exactly once", () => {
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);

    expect(snap.worlds.count, "the roster did not cross the bridge").toBe(galaxy.worlds.length);
    expect(snap.worlds.ids, "the table is not in roster order — the stagger keys on that order")
      .toEqual(galaxy.worlds);

    const drawn = drawnWorlds(frame);
    expect(drawn.length, "the frame drew a different number of worlds than the galaxy has")
      .toBe(galaxy.worlds.length);

    const mid = plateMidX(snap.worlds.x, snap.worlds.count);
    for (let i = 0; i < snap.worlds.count; i++) {
      const at = drawn.find((d) =>
        Math.abs(d.x - plateX(snap.worlds.x[i]!, mid)) < 1e-3 && Math.abs(d.z - plateZ(i)) < 1e-3);
      expect(at, `${snap.worlds.ids[i]} is not on the plate — a world in galaxy.worlds is undrawn`)
        .toBeDefined();
    }
    // One mesh for every world, because a starmap marker's identity is WHERE it is (ADR-0019 §6
    // left the choice open and priced it: 8 draw calls against 20, against a ceiling of 119).
    for (const batch of frame.batches) expect(batch.mesh).toBe(STARMAP_WORLD_MESH);
  });

  it("maps x to the axis affinely, so screen order is jumpCost order", () => {
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const mid = plateMidX(snap.worlds.x, snap.worlds.count);

    // Affine and strictly increasing, asserted on the function rather than inferred from a picture.
    expect(plateX(mid, mid)).toBeCloseTo(AUTHORED_VIEW.centreX, 6);
    expect(plateX(mid + 1, mid) - plateX(mid, mid)).toBeCloseTo(PLATE_SPREAD, 6);
    expect(plateX(mid + 2, mid) - plateX(mid + 1, mid)).toBeCloseTo(PLATE_SPREAD, 6);
    expect(plateX(mid - 1, mid)).toBeLessThan(plateX(mid, mid));

    // And the consequence that matters: from the seat, the order of worlds along the plate is the
    // order the engine charges to jump to them. This is ADR-0019's whole case for the layout —
    // "a world that looks twice as far away costs about twice as much to reach".
    const fresh = createGalaxy({ seed: SEED, startId: HOME });
    const seat = snap.worlds.ids.indexOf(HOME);
    expect(seat, "the seat is not in the roster").toBeGreaterThanOrEqual(0);
    const ranked = snap.worlds.ids
      .map((id, i) => ({
        id,
        alongAxis: Math.abs(plateX(snap.worlds.x[i]!, mid) - plateX(snap.worlds.x[seat]!, mid)),
        cost: jumpCost(fresh, id),
      }))
      .filter((r) => r.id !== HOME)
      .sort((a, b) => a.alongAxis - b.alongAxis);

    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1]!;
      const here = ranked[i]!;
      expect(
        here.cost,
        `${here.id} is further along the plate than ${prev.id} but costs ${here.cost} against ` +
        `${prev.cost} — the axis has stopped meaning what it costs to get there`,
      ).toBeGreaterThanOrEqual(prev.cost);
    }
    expect(ranked[ranked.length - 1]!.cost, "every destination costs the same — nothing was ranked")
      .toBeGreaterThan(ranked[0]!.cost);
  });

  it("is 5.2 % discordant and collides nothing, at the authored view", () => {
    // ADR-0019 §3's measurement, re-run against the composed frame instead of against the probe's
    // model of it. The probe measured the LAYOUT; this measures what actually reaches the renderer,
    // which is the only version a player ever sees.
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);
    const measured = measurePlate(frame, snap);

    // Pinned in BOTH directions on purpose. A ceiling alone would be satisfied by a measurement
    // that had quietly stopped measuring — 0.0 % passes `<= 0.053` and means the plate under test
    // is the bare line, not the staggered one. The number is 5.219 %; the band is the ADR's 5.2 %
    // rounded either way.
    expect(
      measured.discordant,
      `${(measured.discordant * 100).toFixed(1)} % of (seat, A, B) triples now read backwards ` +
      "against jumpCost — ADR-0019 priced this layout at 5.2 % and a 3D shell at 37.6-45.9 %",
    ).toBeLessThanOrEqual(0.053);
    expect(measured.discordant, "the plate measured MORE faithful than ADR-0019's 5.2 % — which " +
      "means this is measuring a different layout, not a better one").toBeGreaterThanOrEqual(0.051);
    expect(measured.collisions, "two world markers overlap — and no overlay can disambiguate them, " +
      "because both renderers draw overlays to a flat canvas over the scene with no depth test")
      .toBe(0);
    // The other half of ADR-0019 §3, and the reason the stagger exists at all: the same roster on a
    // bare line is perfectly faithful — 0.0 % — and collides six marker pairs. That is the trade
    // the stagger makes, and it is asserted rather than quoted so it cannot quietly stop being true.
    expect(measured.flatCollisions, "a bare line no longer collides six pairs — the stagger is now unpriced")
      .toBe(6);
    expect(measured.flatDiscordant, "the bare line is not the perfectly faithful layout any more").toBe(0);
    expect(measured.flatDiscordant, "the stagger is no longer the thing costing fidelity")
      .toBeLessThan(measured.discordant);
  });

  it("is authored for one orientation, and does not orbit", () => {
    // `ui/minimap.ts`'s precedent, for its reason: "a minimap that rotated with the camera would be
    // worse at its only job." The layout was priced at yaw 0 and nowhere else.
    const rig = new CameraRig({ mapWidth: 2400, mapHeight: 2400 });
    rig.yawIndex = 3;
    rig.distance = 250;
    authoredCamera(rig);
    expect(rig.yawIndex).toBe(AUTHORED_VIEW.yawIndex);
    expect(rig.distance).toBe(AUTHORED_VIEW.distance);
    expect(rig.targetX).toBe(AUTHORED_VIEW.centreX);
    expect(rig.targetY).toBe(AUTHORED_VIEW.centreZ);

    // Placement cannot depend on the camera because it cannot SEE the camera: `plateX` and `plateZ`
    // take numbers, not a `CameraState`. Asserted the only way a signature can be — by rotating the
    // rig underneath a composed frame and watching the world positions not move.
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const at = (yawIndex: number) => {
      const r = new CameraRig({ mapWidth: 2400, mapHeight: 2400 });
      authoredCamera(r);
      r.yawIndex = yawIndex;
      const renderer = new RecordingRenderer();
      renderer.registerMeshes(meshes);
      renderer.resize(1280, 720, 1);
      new StarmapComposer().compose(renderer, snap, r.update(1280, 720));
      return drawnWorlds(renderer.lastFrame).map((d) => `${d.x.toFixed(3)},${d.z.toFixed(3)}`).sort();
    };
    for (let yaw = 1; yaw < YAW_SNAP_COUNT; yaw++) {
      expect(at(yaw), `the plate re-laid itself at yaw ${yaw} — a diagram that orbits is a scene`)
        .toEqual(at(0));
    }
  });
});

/**
 * The probe's own two measurements, taken from a composed frame.
 *
 * Kendall discordance: over every seat, and every pair of destinations from it, how often does the
 * screen rank the two in the opposite order to what the engine charges to jump between them?
 * Collisions: how often do two markers land within one marker of each other, which is the case
 * neither renderer can disambiguate because neither depth-tests an overlay (ADR-0005 §4).
 */
function measurePlate(frame: RecordedFrame, snap: GalaxySnapshot) {
  /** The pixel radius `perf/starmap-probe.mjs` assumed for a marker, and `WORLD_DISC_SCALE` respects. */
  const MARKER_PX = 28;
  const camera = frame.camera;
  const n = snap.worlds.count;
  const mid = plateMidX(snap.worlds.x, snap.worlds.count);
  const p = { x: 0, y: 0, behind: false };

  const projectAll = (staggered: boolean) => {
    const pts: Array<{ sx: number; sy: number }> = [];
    for (let i = 0; i < n; i++) {
      projectToScreen(camera, plateX(snap.worlds.x[i]!, mid), 0, staggered ? plateZ(i) : AUTHORED_VIEW.centreZ, p);
      expect(p.behind, `${snap.worlds.ids[i]} is behind the camera at the authored view`).toBe(false);
      pts.push({ sx: p.x, sy: p.y });
    }
    return pts;
  };

  const score = (pts: Array<{ sx: number; sy: number }>) => {
    let pairs = 0;
    let discordant = 0;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < n; i++) {
        if (i === s) continue;
        for (let j = i + 1; j < n; j++) {
          if (j === s) continue;
          const dc = Math.abs(snap.worlds.x[i]! - snap.worlds.x[s]!)
                   - Math.abs(snap.worlds.x[j]! - snap.worlds.x[s]!);
          if (dc === 0) continue;
          const ds = Math.hypot(pts[i]!.sx - pts[s]!.sx, pts[i]!.sy - pts[s]!.sy)
                   - Math.hypot(pts[j]!.sx - pts[s]!.sx, pts[j]!.sy - pts[s]!.sy);
          pairs++;
          if (Math.sign(dc) !== Math.sign(ds)) discordant++;
        }
      }
    }
    let collisions = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.hypot(pts[i]!.sx - pts[j]!.sx, pts[i]!.sy - pts[j]!.sy) < MARKER_PX * 2) collisions++;
      }
    }
    expect(pairs, "no ranked pairs — the measurement is empty").toBeGreaterThan(100);
    return { discordant: discordant / pairs, collisions };
  };

  const staggered = score(projectAll(true));
  const flat = score(projectAll(false));
  return {
    discordant: staggered.discordant,
    collisions: staggered.collisions,
    flatDiscordant: flat.discordant,
    flatCollisions: flat.collisions,
  };
}

/* =================================================================================================
   2. MEANINGLESS — the cross-axis carries nothing, and can be shown to carry nothing

   ADR-0019 decision 2: "Nothing may ever be encoded on it — the moment it means something, the
   plate acquires the exact defect this ADR rejected 3D for." The ADR's own consequences list this
   as an obligation: "The stagger's meaninglessness needs pinning too, or it will quietly acquire a
   meaning."
   ================================================================================================= */

describe("the stagger means nothing (P4-T03, ADR-0019 decision 2)", () => {
  it("gives the same cross-axis to galaxies that disagree about everything else", () => {
    // Four galaxies with different seats, different claims, different stances, different statuses
    // and different reachability. Every one of them must lay the plate identically across.
    const variants: Array<() => Galaxy> = [
      () => createGalaxy({ seed: SEED, startId: HOME }),
      () => galaxyInMotion().galaxy,
      () => {
        const g = createGalaxy({ seed: SEED + 7, startId: "ferros" });
        for (const id of g.worlds) g.claims.set(id, "core");
        return g;
      },
      () => {
        const g = createGalaxy({ seed: SEED + 99, startId: "vesper" });
        for (const id of g.worlds) g.discovered.add(id);
        for (const [, state] of g.planets) diplomacyOf(state).stance = 0.95;
        return g;
      },
    ];

    const layouts = variants.map((make) => {
      const snap = snapshotOf(make());
      const { frame } = composeFrame(snap);
      const byId = new Map<string, number>();
      const mid = plateMidX(snap.worlds.x, snap.worlds.count);
      for (let i = 0; i < snap.worlds.count; i++) {
        const drawn = drawnWorlds(frame).find((d) => Math.abs(d.x - plateX(snap.worlds.x[i]!, mid)) < 1e-3
          && Math.abs(d.z - plateZ(i)) < 1e-3);
        expect(drawn, `${snap.worlds.ids[i]} vanished from the plate in one of the variants`).toBeDefined();
        byId.set(snap.worlds.ids[i]!, drawn!.z);
      }
      return byId;
    });

    const first = layouts[0]!;
    for (let v = 1; v < layouts.length; v++) {
      for (const [id, z] of layouts[v]!) {
        expect(
          z,
          `${id} sits at a different cross-axis position in variant ${v} — the stagger has ` +
          "acquired a meaning, and the plate now has the defect ADR-0019 rejected 3D for",
        ).toBe(first.get(id));
      }
    }
  });

  it("is a function of the roster index and takes exactly three values", () => {
    // The structural half. `plateZ` takes ONE argument and it is an integer index: there is no
    // parameter through which a stance or a claim could reach it. Three rows, evenly spaced,
    // symmetric about the plate's own centre — so the cross-axis has no preferred direction either.
    expect(STAGGER_ROWS.length).toBe(3);
    expect(new Set(STAGGER_ROWS).size, "two stagger rows are the same row").toBe(3);
    expect(STAGGER_ROWS[0]! + STAGGER_ROWS[2]!, "the stagger is not symmetric about the plate centre")
      .toBeCloseTo(2 * STAGGER_ROWS[1]!, 6);

    const zs = new Set<number>();
    for (let i = 0; i < 33; i++) {
      zs.add(plateZ(i));
      expect(plateZ(i), "plateZ is not periodic in the roster index").toBe(plateZ(i + STAGGER_ROWS.length));
    }
    expect(zs.size, "the cross-axis has more than three positions").toBe(3);
  });
});

/* =================================================================================================
   3. OWNED AND LEGIBLE — colour, size, ring, dot
   ================================================================================================= */

describe("every world is owned and legible (P4-T03)", () => {
  it("routes each status to the owner colour the rule names", () => {
    // The table, spelled out. Written as data rather than as a re-implementation of the function,
    // so a change to the rule has to be made twice on purpose instead of once by accident.
    const cases: Array<[string, number, number, number]> = [
      ["the seat is yours", WORLD_SEAT, NO_FACTION, OWNER_PLAYER],
      ["a colony is yours", WORLD_COLONY, NO_FACTION, OWNER_PLAYER],
      ["a world you pacified is yours", WORLD_PACIFIED, NO_FACTION, OWNER_PLAYER],
      ["…even if a faction has since claimed it", WORLD_PACIFIED, 2, OWNER_PLAYER],
      ["a contested world is theirs", WORLD_CONTESTED, NO_FACTION, OWNER_AI],
      ["a claimed world is theirs", WORLD_UNEXPLORED, 1, OWNER_AI],
      ["an unexplored, unclaimed world is nobody's", WORLD_UNEXPLORED, NO_FACTION, OWNER_NEUTRAL],
      ["a claim on the seat does not change whose it is", WORLD_SEAT, 3, OWNER_PLAYER],
    ];
    for (const [what, status, claim, expected] of cases) {
      expect(ownerSlotForWorld(status, claim), what).toBe(expected);
    }
  });

  it("draws the seat, the colony and the fringe in three different colours", () => {
    const { galaxy, colonyId, contestedId } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);

    const owners = new Set(frame.batches.map((b) => b.owner));
    expect(owners.size, "the whole galaxy drew in one colour — nothing is owned").toBe(3);
    expect(frame.batches.length, "one batch per owner slot, and the port has exactly three").toBe(3);

    const mid = plateMidX(snap.worlds.x, snap.worlds.count);
    const at = (id: string) => {
      const i = snap.worlds.ids.indexOf(id);
      return drawnWorlds(frame).find((d) => Math.abs(d.x - plateX(snap.worlds.x[i]!, mid)) < 1e-3
        && Math.abs(d.z - plateZ(i)) < 1e-3)!;
    };
    expect(at(HOME).owner, "the seat is not drawn as the player's").toBe(OWNER_PLAYER);
    expect(at(colonyId).owner, "a colony is not drawn as the player's").toBe(OWNER_PLAYER);
    expect(at(contestedId).owner, "a world you have lost is still drawn as yours").toBe(OWNER_AI);

    // Colour is never the only cue (N-05): the seat is also the biggest marker and the only one
    // wearing a highlight ring, so "where am I" survives a colour-blind reading.
    expect(at(HOME).scale, "the seat is no larger than a colony").toBeGreaterThan(at(colonyId).scale);
    expect(worldScale(WORLD_SEAT)).toBeGreaterThan(worldScale(WORLD_COLONY));
    expect(worldScale(WORLD_UNEXPLORED), "an unexplored world is not smaller than a known one")
      .toBeLessThan(worldScale(WORLD_COLONY));
    expect(worldScale(WORLD_COLONY)).toBe(WORLD_DISC_SCALE);

    const here = overlayRows(frame, "selection");
    expect(here.length, "no ring on the seat — the first question a starmap is asked is unanswered").toBe(1);
    expect(here[0]![0], "the ring is not on the seat").toBeCloseTo(at(HOME).x, 6);
    expect(here[0]![2]).toBeCloseTo(at(HOME).z, 6);
  });

  it("dims a world it cannot jump to, and never dims the seat", () => {
    // `canJumpTo` is the engine's own answer, and it is false for the seat because the seat is not
    // a destination. A view that read the flag alone would dim the world the player is standing on.
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const seat = snap.worlds.ids.indexOf(HOME);
    expect(canJumpTo(galaxy, HOME), "the engine now treats the seat as a destination").toBe(false);
    expect(snap.worlds.reachable[seat], "the seat crossed the bridge as reachable").toBe(0);
    expect(worldShade(WORLD_SEAT, snap.worlds.reachable[seat]!), "the seat is dimmed as unreachable").toBe(1);
    expect(worldShade(WORLD_UNEXPLORED, 1)).toBeGreaterThan(worldShade(WORLD_UNEXPLORED, 0));
  });

  it("rings a claimed world, and rings only claimed worlds", () => {
    const { galaxy, claimedId } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);

    const claimed: string[] = [];
    for (let i = 0; i < snap.worlds.count; i++) if (snap.worlds.claim[i] !== NO_FACTION) claimed.push(snap.worlds.ids[i]!);
    expect(claimed, "the scenario has no claim to draw").toContain(claimedId);

    const rings = overlayRows(frame, "aura");
    expect(rings.length, "faction spread is not drawn — claims creeping across the roster is invisible")
      .toBe(claimed.length);
    const mid = plateMidX(snap.worlds.x, snap.worlds.count);
    for (const id of claimed) {
      const i = snap.worlds.ids.indexOf(id);
      const ring = rings.find((r) => Math.abs(r[0]! - plateX(snap.worlds.x[i]!, mid)) < 1e-3);
      expect(ring, `${id} is claimed and wears no ring`).toBeDefined();
      expect(ring![4], "the claim ring is not in the claimant's colour").toBe(OWNER_AI);
      expect(ring![3], "the claim ring has no radius").toBeGreaterThan(0);
    }
  });

  it("marks the rival Gate and a lost colony, and nothing else", () => {
    const { galaxy, colonyId, contestedId } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);

    // The engine raises this one itself — `galaxyStatus.rivalGate` is commented "starmap alert".
    expect(snap.rivalGateIndex, "the rival Gate did not cross the bridge").toBe(snap.worlds.ids.indexOf(colonyId));
    expect(snap.rivalGateCharge, "the Gate's live charge did not cross").toBeCloseTo(0.42, 6);

    const expected = new Map<string, number>([
      [colonyId, ALERT_RIVAL_GATE],
      [contestedId, ALERT_LOST_COLONY],
    ]);
    for (let i = 0; i < snap.worlds.count; i++) {
      const id = snap.worlds.ids[i]!;
      expect(alertForWorld(snap, i), `${id} raises the wrong alert`).toBe(expected.get(id) ?? ALERT_NONE);
    }

    const marks = overlayRows(frame, "waypoint");
    expect(marks.length, "the alerts are not drawn").toBe(expected.size);
    expect(new Set(marks.map((m) => m[3])), "both alerts carry the same code — the kinds have collapsed")
      .toEqual(new Set([ALERT_RIVAL_GATE, ALERT_LOST_COLONY]));
  });
});

/* =================================================================================================
   4. THE STANCE — on the map, without a panel

   "A stance change is visible without opening a panel" is the row's own definition of done, and it
   is the one claim here that is about TIME rather than about a picture: stances move on
   `updateDiplomacy`'s clock and `updateFactionWarmth`'s scan, which run whether or not the player
   is looking at anything.
   ================================================================================================= */

describe("a stance change is visible on the map itself (P4-T03)", () => {
  it("draws the neighbour's own number, monotonically, on every world that has one", () => {
    const { galaxy, colonyId } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);

    const known: string[] = [];
    for (let i = 0; i < snap.worlds.count; i++) if (snap.worlds.stanceKnown[i] === 1) known.push(snap.worlds.ids[i]!);
    expect(known.length, "no world reports a stance — there is nothing to make visible")
      .toBeGreaterThanOrEqual(3);
    expect(known, "the soured neighbour has no stance to draw").toContain(colonyId);

    const bars = overlayRows(frame, "healthbar");
    expect(bars.length, "the stance is not on the map at all").toBe(known.length);

    const i = snap.worlds.ids.indexOf(colonyId);
    const mid = plateMidX(snap.worlds.x, snap.worlds.count);
    const bar = bars.find((b) => Math.abs(b[0]! - plateX(snap.worlds.x[i]!, mid)) < 1e-3)!;
    expect(bar, `${colonyId} has a stance and no bar`).toBeDefined();
    expect(bar[3], "the drawn stance is not the engine's own number")
      .toBeCloseTo(stanceFraction(diplomacyOf(galaxy.planets.get(colonyId)!).stance), 6);
    expect(bar[4], "the stance is not drawn in the neighbour's colour").toBe(OWNER_AI);

    // Monotone, and banded nowhere: `stanceLabel` owns the bands and is not exported past the
    // bridge, so a threshold invented up here would be a second answer to a question the engine
    // already answers.
    expect(stanceFraction(-1)).toBe(0);
    expect(stanceFraction(1)).toBe(1);
    expect(stanceFraction(0)).toBe(0.5);
    for (let s = -1; s < 1; s += 0.05) {
      expect(stanceFraction(s + 0.05), `the bar is not monotone in the stance around ${s.toFixed(2)}`)
        .toBeGreaterThan(stanceFraction(s));
    }
  });

  it("follows the stance when the simulation moves it, with nothing but the map on screen", () => {
    // The DoD, end to end and in that order: the engine moves a stance, the bridge re-extracts, the
    // composer re-composes, and the drawn bar has moved. No panel exists in this call path — the
    // only inputs are a galaxy, an extractor and a renderer.
    const { galaxy, colonyId } = galaxyInMotion();
    const extractor = new GalaxySnapshotExtractor();
    const renderer = new RecordingRenderer();
    renderer.registerMeshes(meshes);
    renderer.resize(1280, 720, 1);
    const composer = new StarmapComposer();
    const camera = authoredCameraState();

    const barFor = (id: string): number => {
      const snap = extractor.extract(galaxy);
      composer.compose(renderer, snap, camera);
      const i = snap.worlds.ids.indexOf(id);
      const mid = plateMidX(snap.worlds.x, snap.worlds.count);
      const row = overlayRows(renderer.lastFrame, "healthbar")
        .find((b) => Math.abs(b[0]! - plateX(snap.worlds.x[i]!, mid)) < 1e-3);
      expect(row, `${id} lost its stance bar`).toBeDefined();
      return row![3]!;
    };

    const before = barFor(colonyId);
    const dip = diplomacyOf(galaxy.planets.get(colonyId)!);
    dip.stance = -0.95;
    const soured = barFor(colonyId);
    expect(soured, "the neighbour turned hostile and the map did not move").toBeLessThan(before);
    expect(soured).toBeCloseTo(stanceFraction(-0.95), 6);

    dip.stance = 0.9;
    const warmed = barFor(colonyId);
    expect(warmed, "the neighbour became an ally and the map did not move").toBeGreaterThan(soured);
    expect(warmed).toBeGreaterThan(before);

    // …and it survives the engine's own clock rather than only a hand-set field: stepping the
    // galaxy runs `updateDiplomacy` and the ~1 Hz `updateFactionWarmth` scan, and the map still
    // draws whatever they leave behind.
    for (let t = 0; t < 60; t++) stepGalaxy(galaxy, STEP_SECONDS);
    expect(barFor(colonyId), "after stepping the galaxy the map no longer matches the engine")
      .toBeCloseTo(stanceFraction(diplomacyOf(galaxy.planets.get(colonyId)!).stance), 6);
  });

  it("draws no stance for a world the player has never reached", () => {
    // The other direction, and the one that stops "the stance is drawn" being satisfied by drawing
    // something for everybody. `galaxyStatus` hides an undiscovered world's stance on purpose, and
    // a bar sitting at the neutral middle would be a confident lie about a neighbour never met.
    const galaxy = createGalaxy({ seed: SEED, startId: HOME });
    const snap = snapshotOf(galaxy);
    const { frame } = composeFrame(snap);
    const seat = snap.worlds.ids.indexOf(HOME);
    for (let i = 0; i < snap.worlds.count; i++) {
      expect(snap.worlds.stanceKnown[i], `${snap.worlds.ids[i]} reports a stance the player has not earned`)
        .toBe(i === seat ? 1 : 0);
    }
    expect(overlayRows(frame, "healthbar").length, "a bar was drawn for an unvisited world").toBe(1);
  });
});

/* =================================================================================================
   5. REPORTED, NEVER RE-DERIVED

   `galaxyStatus` is the engine's own summary. The board row says report it and never re-derive it,
   and the failure mode is not that a copy is wrong today — it is that a re-derivation is right
   today and wrong after the next upstream change to what "colony" means.
   ================================================================================================= */

describe("the bridge reports galaxyStatus rather than re-deriving it (P4-T03)", () => {
  it("matches the engine's own summary, channel for channel", () => {
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const status = galaxyStatus(galaxy) as {
      credits: number; activeId: string; visited: number; total: number; pacified: number;
      dominationTarget: number; rivalGate: { worldId: string; charge: number } | null;
      worlds: Array<Record<string, unknown>>;
    };

    expect(snap.credits).toBe(status.credits);
    expect(snap.visited).toBe(status.visited);
    expect(snap.total).toBe(status.total);
    expect(snap.pacifiedCount).toBe(status.pacified);
    expect(snap.dominationTarget).toBe(status.dominationTarget);
    expect(snap.worlds.ids[snap.activeIndex]).toBe(status.activeId);
    expect(snap.worlds.count).toBe(status.worlds.length);

    for (let i = 0; i < snap.worlds.count; i++) {
      const w = status.worlds[i]!;
      const id = String(w.id);
      expect(snap.worlds.ids[i]).toBe(id);
      expect(WORLD_STATUS_CODES[String(w.status)], `${id}: status "${String(w.status)}" is unmapped`)
        .toBe(snap.worlds.status[i]);
      expect(snap.worlds.income[i], `${id}: income was re-derived`).toBeCloseTo(w.income as number, 5);
      expect(snap.worlds.pacified[i], `${id}: pacified was re-derived`).toBe(w.pacified ? 1 : 0);
      expect(snap.worlds.industry[i], `${id}: industry was re-derived`).toBe(w.industry);
      expect(snap.worlds.tech[i], `${id}: tech was re-derived`).toBe(w.tech);
      const faction = snap.worlds.faction[i]! === NO_FACTION ? null : snap.factionNames[snap.worlds.faction[i]!]!;
      expect(faction, `${id}: faction was re-derived`).toBe(w.faction ?? null);
      const claim = snap.worlds.claim[i]! === NO_FACTION ? null : snap.factionNames[snap.worlds.claim[i]!]!;
      expect(claim, `${id}: controlledBy was re-derived`).toBe(w.controlledBy ?? null);
      if (w.stance === null) {
        expect(snap.worlds.stanceKnown[i], `${id}: a stance appeared that the engine withheld`).toBe(0);
      } else {
        expect(snap.worlds.stanceKnown[i]).toBe(1);
        expect(snap.worlds.stance[i], `${id}: stance was re-derived`).toBeCloseTo(w.stance as number, 6);
      }
      // The two engine queries the table also carries, asked rather than computed. `jumpCost` is not
      // `JUMP_COST`: `FUEL_DISCOUNT_BY_TIER` makes it depend on the origin pad's tier.
      expect(snap.worlds.jumpCost[i], `${id}: the fuel price was re-derived`).toBe(jumpCost(galaxy, id));
      expect(snap.worlds.reachable[i], `${id}: reachability was re-derived`).toBe(canJumpTo(galaxy, id) ? 1 : 0);
      // The one coordinate, straight off `PLANETS` — the same lookup `planetX` makes.
      expect(snap.worlds.x[i], `${id}: the coordinate was re-derived`)
        .toBe(PLANETS.find((p) => p.id === id)?.x ?? 0);
    }
  });

  it("describes galaxyStatus's real shape, not a plausible one", () => {
    // `galaxyStatus` is declared as returning `unknown` — honestly, because nobody has typed the
    // vendored function — so `bridge/galaxy-snapshot.ts` narrows it with a cast. A cast is a claim
    // about a shape, and a wrong one type-checks perfectly and is `undefined` at runtime: that is
    // exactly the fiction ADR-0003's façade exists to prevent, and this project has already been
    // bitten by it once in this same declarations file. So every field the bridge reads is checked
    // for existence and type against the value the engine actually returns.
    const { galaxy } = galaxyInMotion();
    const status = galaxyStatus(galaxy) as Record<string, unknown>;
    const galaxyWide: Array<[string, string]> = [
      ["credits", "number"], ["activeId", "string"], ["visited", "number"], ["total", "number"],
      ["pacified", "number"], ["dominationTarget", "number"], ["worlds", "object"],
    ];
    for (const [field, type] of galaxyWide) {
      expect(typeof status[field], `galaxyStatus no longer returns a ${type} "${field}"`).toBe(type);
    }
    expect(status.rivalGate, "the rival Gate channel is gone").not.toBeUndefined();

    const world = (status.worlds as Array<Record<string, unknown>>)[0]!;
    const perWorld: Array<[string, string]> = [
      ["id", "string"], ["status", "string"], ["income", "number"], ["pacified", "boolean"],
      ["industry", "number"], ["tech", "number"],
    ];
    for (const [field, type] of perWorld) {
      expect(typeof world[field], `galaxyStatus's world rows no longer carry a ${type} "${field}"`).toBe(type);
    }
    // The three nullable ones, asserted as "present and either null or the right type" — an absent
    // key and an explicit null are the same `undefined ?? null` to the bridge and must not be.
    for (const field of ["stance", "faction", "controlledBy"]) {
      expect(Object.prototype.hasOwnProperty.call(world, field), `world rows lost "${field}"`).toBe(true);
    }
    expect(Object.keys(world).length, "galaxyStatus grew a per-world channel the starmap ignores")
      .toBe(perWorld.length + 3);
  });

  it("covers exactly the statuses the engine's own source can produce", () => {
    // The vocabulary, pinned against `galaxy.js` rather than against a comment. A sixth status added
    // upstream lands here as a red test in the same sync that lands it — instead of as worlds
    // silently drawing `WORLD_UNKNOWN` in whatever the fallback colour is.
    const source = readFileSync(new URL("../../src/engine/engine/galaxy.js", import.meta.url), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
    const emitted = new Set<string>();
    for (const assign of code.matchAll(/\bstatus\s*=\s*([^;]+);/g)) {
      for (const literal of assign[1]!.matchAll(/"([a-z]+)"/g)) emitted.add(literal[1]!);
    }
    expect(emitted.size, "no status literals found in galaxy.js — this scan is vacuous")
      .toBeGreaterThanOrEqual(5);
    expect([...emitted].sort(), "the engine's status vocabulary and the bridge's table disagree")
      .toEqual(Object.keys(WORLD_STATUS_CODES).sort());
  });

  it("says so loudly when it cannot map a status", () => {
    // The failure path, taken. `WORLD_UNKNOWN` exists so a sixth status is a visible anomaly rather
    // than a world silently redrawn as "never been there" — and a fallback nobody has ever watched
    // being taken is a fallback nobody can trust, which is why `statusCodeOf` is a function and not
    // an inline `??`.
    expect(statusCodeOf("moonbase"), "an unrecognised status did not reach the sentinel")
      .toBe(WORLD_UNKNOWN);
    expect(statusCodeOf(""), "an empty status did not reach the sentinel").toBe(WORLD_UNKNOWN);
    for (const [name, code] of Object.entries(WORLD_STATUS_CODES)) {
      expect(statusCodeOf(name), `"${name}" no longer maps to its own code`).toBe(code);
      expect(code, `"${name}" collides with the unknown sentinel`).not.toBe(WORLD_UNKNOWN);
    }
    // …and no real galaxy takes it. The engine cannot be made to emit a sixth status without
    // editing it (ADR-0003), so this is the half that stays behavioural: every status a played
    // galaxy actually produces maps, and `unknownStatuses` is empty.
    const { galaxy } = galaxyInMotion();
    expect(snapshotOf(galaxy).unknownStatuses, "a real galaxy reports an unmappable status").toEqual([]);
  });
});

/* =================================================================================================
   6. THE PORT — one vocabulary, three implementations, no allocation
   ================================================================================================= */

describe("the starmap draws through the port and allocates nothing per frame (P4-T03)", () => {
  it("costs the draw calls ADR-0019 measured", () => {
    const { galaxy } = galaxyInMotion();
    const { frame, composer } = composeFrame(snapshotOf(galaxy));
    // ADR-0019 §1: eleven worlds, their stances, claims and alerts come to eight draw calls against
    // a derived ceiling of 119 — three instance batches (one per owner slot) and the overlay
    // layers. Lanes are P4-T07's `rally` layer and are not drawn yet, which is the difference.
    expect(frame.stats.drawCalls, "the starmap frame has grown past what ADR-0019 priced")
      .toBeLessThanOrEqual(8);
    expect(frame.stats.drawCalls).toBe(composer.expectedDrawCalls);
    expect(frame.stats.drawCalls).toBe(frame.batches.length + frame.overlays.length);
    // No terrain: the plate is not a place, and a starmap that replaces the battlefield has no
    // ground to draw (ADR-0019 §1 prices "replaces" at 8 and "overlays" at 30 — neither binds).
    expect(frame.terrainVersion, "the starmap drew terrain — there is no ground on a diagram").toBeNull();
  });

  it("uses only overlay kinds both product renderers actually draw", () => {
    // "Canvas2D must draw it too" — and it does, because the starmap invents no `OverlayKind`.
    // Asserted against `overlays2d.ts`, which is the ONE function `WebGLRenderer.drawOverlay` and
    // `Canvas2DRenderer.drawOverlay` both call: a kind missing from its switch is a kind that draws
    // nothing at all, silently, in both implementations.
    const overlays = readFileSync(new URL("../../src/view/renderer/overlays2d.ts", import.meta.url), "utf8");
    const { galaxy } = galaxyInMotion();
    const { frame } = composeFrame(snapshotOf(galaxy));
    expect(frame.overlays.length, "the starmap drew no overlays — a plate is almost purely overlay")
      .toBeGreaterThanOrEqual(4);
    for (const layer of frame.overlays) {
      expect(overlays.includes(`case "${layer.kind}":`), `overlays2d.ts cannot draw "${layer.kind}"`).toBe(true);
      expect(layer.stride, `"${layer.kind}" is packed at the wrong stride`).toBe(OVERLAY_STRIDE[layer.kind]);
    }
  });

  it("reuses its scratch across frames", () => {
    // ADR-0006: no allocation in a steady-state frame. The RecordingRenderer copies what it is
    // given, so identity has to be captured at the moment of submission — a composer that grew or
    // replaced a buffer between frames would hand over a different array the second time.
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    const composer = new StarmapComposer();
    const camera = authoredCameraState();

    const submitted: Float32Array[][] = [];
    class Spy extends RecordingRenderer {
      readonly seen: Float32Array[] = [];
      override drawInstances(batch: Parameters<RecordingRenderer["drawInstances"]>[0]): void {
        this.seen.push(batch.xyz as Float32Array);
        super.drawInstances(batch);
      }
      override drawOverlay(layer: Parameters<RecordingRenderer["drawOverlay"]>[0]): void {
        this.seen.push(layer.data as Float32Array);
        super.drawOverlay(layer);
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      const spy = new Spy();
      spy.registerMeshes(meshes);
      spy.resize(1280, 720, 1);
      composer.compose(spy, snap, camera);
      submitted.push(spy.seen);
    }
    expect(submitted[0]!.length, "nothing was submitted").toBeGreaterThan(4);
    for (let pass = 1; pass < submitted.length; pass++) {
      expect(submitted[pass]!.length, "the frame changed shape between identical composes")
        .toBe(submitted[0]!.length);
      for (let i = 0; i < submitted[0]!.length; i++) {
        expect(
          submitted[pass]![i] === submitted[0]![i],
          `buffer ${i} was reallocated on pass ${pass} — the frame allocates, which ADR-0006 forbids`,
        ).toBe(true);
      }
    }
  });

  it("keeps every typed-array allocation in a constructor or an ensure* helper", () => {
    // The same scan `test/architecture/layering.test.ts` runs over the battlefield's hot files,
    // applied to the two modules this row adds. It is here rather than there because that file is
    // not this change's to edit — which is worth fixing: the list of hot files should not be a list
    // someone has to remember to append to.
    const files = ["src/view/starmap.ts", "src/bridge/galaxy-snapshot.ts"];
    const METHOD = /^\s{2}(?:private\s+|protected\s+|public\s+|static\s+|override\s+|readonly\s+|get\s+|\*)*([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\(/gm;
    const offenders: string[] = [];
    for (const rel of files) {
      const source = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const methods = [...source.matchAll(METHOD)].map((m) => ({ name: m[1]!, at: m.index! }));
      const allocations = [...source.matchAll(/new (?:Float32Array|Int32Array|Int8Array|Uint8Array|Uint16Array)/g)];
      expect(allocations.length, `${rel} allocates no typed arrays — this scan is looking at nothing`)
        .toBeGreaterThan(0);
      for (const m of allocations) {
        const line = source.slice(source.lastIndexOf("\n", m.index!) + 1, source.indexOf("\n", m.index!));
        if (/^\s{2}(?:private |protected |public |readonly |static )*[A-Za-z_]\w*(?:\s*:[^=]+)?\s*=\s*new /.test(line)) continue;
        const owner = [...methods].reverse().find((x) => x.at < m.index!);
        const name = owner?.name ?? "<module scope>";
        if (name === "constructor" || name.startsWith("ensure") || name === "<module scope>") continue;
        offenders.push(`${rel}: ${name}() allocates ${m[0]}`);
      }
    }
    expect(offenders, `move the allocation into an ensure* helper:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("has no world at NO_WORLD, and knows where the seat is", () => {
    const { galaxy } = galaxyInMotion();
    const snap = snapshotOf(galaxy);
    expect(snap.activeIndex, "the seat is not in the table").not.toBe(NO_WORLD);
    expect(snap.worlds.ids[snap.activeIndex]).toBe(galaxy.activeId);
    const fresh = snapshotOf(createGalaxy({ seed: SEED, startId: HOME }));
    expect(fresh.rivalGateIndex, "a fresh galaxy is already racing a Gate").toBe(NO_WORLD);
    expect(fresh.rivalGateCharge).toBe(0);
  });
});

/* =================================================================================================
   MUTATION LOG — every claim above was watched going red before it was kept.

   PLACED       `plateX` returned the roster index instead of the engine's `x`: the jumpCost-order
                test fails on the first pair, and discordance rises from 5.2 % to 22.6 %.
                Dropping the last world from the compose loop: "puts every world on the plate"
                names the missing world.
   MEANINGLESS  made `plateZ` take the world's stance and offset the row by it: the four-variant
                comparison fails and names the world that moved. Making the stagger two rows instead
                of three: the collision count goes to 2 and the "three values" test fails.
   OWNED        moved `pacified` below the claim test in `ownerSlotForWorld`: the table test fails
                on "…even if a faction has since claimed it". Returning `reachable === 1 ? 0.9 : 0.5`
                without the seat's special case: the seat is dimmed and its test names it.
   STANCE       dropped the `stanceKnown` guard so every world drew a bar: "draws no stance for a
                world the player has never reached" fails with 11 bars against 1. Made
                `stanceFraction` symmetric (`Math.abs`): monotonicity fails at -0.05, and the
                follow-the-engine test fails on the souring step.
   REPORTED     re-derived `income` as `buildings * 0.3 * 60` instead of copying: the channel-for-
                channel comparison fails on the colony (the engine caps at COLONY_INCOME_CAP and
                excludes turrets). Deleting `contested` from `WORLD_STATUS_CODES`: the source-scan
                test fails, and the scenario test reports `WORLD_UNKNOWN`.
   PORT         submitted the claim ring at stride 4 instead of 5: the RecordingRenderer throws on
                the stride contract before any assertion runs. Allocating a fresh `Float32Array` in
                `compose`: the scratch-reuse test fails on pass 1.
   ================================================================================================= */
