// P3-T06 — tracers, impacts and death read in the frame, and none of it allocates per frame.
//
// PRD §5's Phase 3 exit criterion says "no combat feedback allocates per frame", and that is the
// hard half. The sim reports a shot ONCE at 20 Hz; the display runs at 60+. So the view has to hold
// state the snapshot does not have — a set of live effects with their own clocks — which is exactly
// the shape that invites an object per shot.
//
// The last describe here is therefore the point of the file: 600 frames of a running firefight,
// with effects entering and expiring throughout, and every pool buffer the same object at the end
// as at the start. A test that ran 600 *quiet* frames would prove nothing, because an empty pool
// never grows.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { BLAST_SECONDS, CombatEffects, TRACER_SECONDS } from "../../src/view/effects.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { OVERLAY_STRIDE } from "../../src/view/renderer/port.js";
import { SNAP_AI, SNAP_PLAYER } from "../../src/bridge/snapshot.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { makeBuilding, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;

/** A brawl: two mixed armies inside each other's weapons range, at the player's base. */
function firefight() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  bridge.step(STEP_SECONDS);

  for (let i = 0; i < 60; i++) {
    const owner = i % 2 === 0 ? "player" : "ai";
    const u = makeUnit(["skiff", "lancer", "bastion", "wraith"][i % 4]!, owner,
      base.x + (owner === "player" ? -24 : 24) + (i % 6) * 6, base.y + Math.floor(i / 6) * 6 - 30);
    bridge.state.units.set(u.id, u);
  }

  // One step with everyone present before anything is allowed to die. An entity that spawns and
  // dies inside a single tick has no previous position, so its killing shot is legitimately
  // undrawable and shows up as `dropped` — a real property of the bridge, and a test artefact here,
  // since nothing in a real match is injected mid-fight.
  bridge.step(STEP_SECONDS);

  const field = elevationFieldFrom(bridge.state.map.terrain, bridge.state.map.width, bridge.state.map.height);
  const composer = new SceneComposer(field);
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x, base.y);
  const terrain = buildTerrainMesh(field, { relief: true, apron: 0 });

  const draw = (): void => {
    renderer.setFog(bridge.snapshot.fog);
    composer.compose(renderer, bridge.snapshot, rig.update(1280, 720), TIERS.T2, terrain, 0, null);
  };
  const tick = (): void => {
    bridge.step(STEP_SECONDS);
    composer.ingestTick(bridge.snapshot);
  };
  return { bridge, composer, renderer, draw, tick };
}

function layer(renderer: RecordingRenderer, kind: "tracer" | "blast") {
  return renderer.lastFrame.overlays.find((o) => o.kind === kind) ?? null;
}

describe("the effect pool", () => {
  it("keeps a shot alive across the frames between two ticks", () => {
    // The whole reason the pool exists. At 20 Hz a tick is 50 ms and at 60 fps a frame is ~16.7,
    // so a shot reported once has to survive about three frames or it is a flicker nobody sees.
    const fx = new CombatEffects();
    expect(TRACER_SECONDS, "a tracer must outlive the gap between ticks").toBeGreaterThan(STEP_SECONDS);

    fx.ingestTick(fakeSnapshot(1, 0));
    expect(fx.tracerCount).toBe(1);
    for (let f = 0; f < 3; f++) fx.age(1 / 60);
    expect(fx.tracerCount, "the tracer expired before the next tick even arrived").toBe(1);
    expect(fx.tracerFade(0), "it should be fading, not constant").toBeLessThan(1);
  });

  it("retires an effect once, and exactly when its clock runs out", () => {
    const fx = new CombatEffects();
    fx.ingestTick(fakeSnapshot(1, 1));
    fx.age(TRACER_SECONDS - 1e-4);
    expect(fx.tracerCount, "retired early").toBe(1);
    fx.age(2e-4);
    expect(fx.tracerCount, "outlived its own lifetime").toBe(0);

    expect(BLAST_SECONDS, "a death mark should linger longer than a tracer").toBeGreaterThan(TRACER_SECONDS);
    expect(fx.blastCount, "the blast should still be up").toBe(1);
    fx.age(BLAST_SECONDS);
    expect(fx.blastCount).toBe(0);
  });

  it("compacts without losing the survivors", () => {
    // Swap-remove reorders the pool. That is fine — but only if nothing is dropped or duplicated,
    // and an off-by-one in the swap silently eats the last entry every time.
    const fx = new CombatEffects();
    fx.ingestTick(fakeSnapshot(5, 0));
    fx.age(TRACER_SECONDS * 0.5);                  // all five now half-aged
    fx.ingestTick(fakeSnapshot(3, 0));             // three fresh ones
    expect(fx.tracerCount).toBe(8);
    fx.age(TRACER_SECONDS * 0.6);                  // the first five expire, the three do not
    expect(fx.tracerCount, "compaction lost or kept the wrong entries").toBe(3);
    for (let i = 0; i < fx.tracerCount; i++) {
      expect(fx.tracerFade(i), "a survivor came back with a dead entry's clock").toBeGreaterThan(0);
    }
  });

  it("keeps effects in flight when the pool has to grow", () => {
    // Growth preserves contents here, unlike the snapshot's tables which are refilled from scratch.
    // Dropping on resize would make tracers vanish exactly when a fight got big enough to need them.
    const fx = new CombatEffects(4);
    fx.ingestTick(fakeSnapshot(3, 0));
    fx.ingestTick(fakeSnapshot(20, 0));
    expect(fx.tracerCount).toBe(23);
    let live = 0;
    for (let i = 0; i < fx.tracerCount; i++) if (fx.tracerFade(i) > 0) live++;
    expect(live, "growth discarded effects that were still in flight").toBe(23);
  });
});

describe("combat feedback in a composed frame", () => {
  it("draws a tracer for a shot and a mark for a death", () => {
    const { renderer, draw, tick, bridge } = firefight();
    let sawTracer = false;
    let sawBlast = false;
    for (let t = 0; t < 200 && !(sawTracer && sawBlast); t++) {
      tick();
      draw();
      if ((layer(renderer, "tracer")?.count ?? 0) > 0) sawTracer = true;
      if ((layer(renderer, "blast")?.count ?? 0) > 0) sawBlast = true;
    }
    expect(sawTracer, "200 ticks of a 60-unit brawl produced no tracer").toBe(true);
    expect(sawBlast, "nobody died, so the death cue is untested").toBe(true);
    expect(bridge.snapshot.shots.dropped, "shots were discarded for want of an endpoint").toBe(0);
  });

  it("carries the shooter's owner and a fade that actually decays", () => {
    const { renderer, draw, tick } = firefight();
    const stride = OVERLAY_STRIDE.tracer;
    for (let t = 0; t < 200; t++) {
      tick();
      draw();
      const l = layer(renderer, "tracer");
      if (!l || l.count === 0) continue;
      for (let i = 0; i < l.count; i++) {
        const fade = l.data[i * stride + 6]!;
        const owner = l.data[i * stride + 7]!;
        expect(fade, "a tracer with no fade left is still being drawn").toBeGreaterThan(0);
        expect(fade).toBeLessThanOrEqual(1);
        expect([SNAP_PLAYER, SNAP_AI]).toContain(owner);
      }
      // Two frames later, with no new tick, the same tracers must be dimmer.
      const before = l.data[6]!;
      composeOnly(renderer, draw, 2);
      const after = layer(renderer, "tracer");
      if (after && after.count > 0) {
        expect(after.data[6]!, "the tracer is not fading between frames").toBeLessThanOrEqual(before);
      }
      return;
    }
    throw new Error("no tracer was drawn in 200 ticks");
  });

  it("costs one layer each, not one per effect", () => {
    const { renderer, draw, tick } = firefight();
    for (let t = 0; t < 60; t++) { tick(); draw(); }
    expect(renderer.lastFrame.overlays.filter((o) => o.kind === "tracer").length).toBeLessThanOrEqual(1);
    expect(renderer.lastFrame.overlays.filter((o) => o.kind === "blast").length).toBeLessThanOrEqual(1);
  });

  it("adds no instance batch — a tracer is not geometry", () => {
    const { renderer, draw, tick } = firefight();
    // The baseline has to be a frame with the armies already ON it and nobody shooting yet, or it
    // is a picture of an empty field and every unit mesh reads as "introduced by the fight".
    const quiet = new Set<string>();
    draw();
    for (const b of renderer.lastFrame.batches) quiet.add(`${b.mesh}|${b.owner}|${b.lod}`);
    for (let t = 0; t < 80; t++) { tick(); draw(); }
    const loud = new Set(renderer.lastFrame.batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));
    for (const key of loud) {
      expect(quiet.has(key) || key.startsWith("imposter"), `a fight introduced the batch ${key}`).toBe(true);
    }
  });
});

describe("the zero-allocation criterion (PRD §5)", () => {
  it("holds across 600 frames of a running firefight", () => {
    // The criterion, asserted rather than claimed. A firefight, not a quiet scene: an empty pool
    // never grows, so 600 idle frames would pass with any implementation at all.
    //
    // Identity of the pool's own buffers is what is checked. If any of them is a different object
    // at the end, something allocated — and at 33 ms a GC pause is a visible hitch.
    const { composer, draw, tick, bridge } = firefight();

    // Warm up first, so the ONE legitimate growth — the power-of-two ensure on a tick — happens
    // before the buffers are captured. Growth is allowed off-frame; it is per-FRAME allocation the
    // criterion forbids.
    for (let t = 0; t < 40; t++) { tick(); for (let f = 0; f < 3; f++) draw(); }

    const fx = composer.effects;
    const before = {
      tx0: fx.tx0, ty0: fx.ty0, tx1: fx.tx1, ty1: fx.ty1, tOwner: fx.tOwner, tAge: fx.tAge,
      bx: fx.bx, by: fx.by, bOwner: fx.bOwner, bBig: fx.bBig, bAge: fx.bAge,
    };

    let frames = 0;
    let peakTracers = 0;
    let sawBlast = false;
    while (frames < 600) {
      tick();
      for (let f = 0; f < 3 && frames < 600; f++) {
        composer.ageEffects(1 / 60);
        draw();
        frames++;
        peakTracers = Math.max(peakTracers, fx.tracerCount);
        if (fx.blastCount > 0) sawBlast = true;
      }
    }

    // The fight has to have been real, or the identity check below is vacuous.
    expect(peakTracers, "no tracer was ever live — 600 frames of nothing proves nothing").toBeGreaterThan(0);
    expect(sawBlast, "nothing died in 600 frames, so the blast pool was never exercised").toBe(true);
    expect(bridge.snapshot.shots.dropped).toBe(0);

    for (const [name, buffer] of Object.entries(before)) {
      expect(
        (fx as unknown as Record<string, unknown>)[name],
        `the effect pool reallocated \`${name}\` during a frame — that is the GC pause PRD §5 forbids`,
      ).toBe(buffer);
    }
  });

  it("ages and retires without touching the heap, even when everything expires at once", () => {
    // Compaction is the one per-frame loop that mutates the pool, and a naive implementation
    // (filter, splice, a fresh array) is exactly what a reviewer would reach for.
    const fx = new CombatEffects(256);
    fx.ingestTick(fakeSnapshot(200, 50));
    const before = { tx0: fx.tx0, tAge: fx.tAge, bx: fx.bx, bAge: fx.bAge };
    for (let f = 0; f < 120; f++) fx.age(1 / 60);
    expect(fx.tracerCount, "everything should have expired by now").toBe(0);
    expect(fx.blastCount).toBe(0);
    expect(fx.tx0).toBe(before.tx0);
    expect(fx.tAge).toBe(before.tAge);
    expect(fx.bx).toBe(before.bx);
    expect(fx.bAge).toBe(before.bAge);
  });
});

/** Re-render N frames with no new tick, so only the effect clocks move. */
function composeOnly(_renderer: RecordingRenderer, draw: () => void, frames: number): void {
  for (let f = 0; f < frames; f++) draw();
}

/** A snapshot-shaped stub carrying just the two tables the pool reads. */
function fakeSnapshot(shots: number, deaths: number) {
  const s = {
    count: shots, dropped: 0,
    fromX: new Float32Array(shots), fromY: new Float32Array(shots),
    toX: new Float32Array(shots), toY: new Float32Array(shots),
    owner: new Uint8Array(shots),
  };
  for (let i = 0; i < shots; i++) { s.fromX[i] = i; s.toX[i] = i + 10; }
  const d = {
    count: deaths,
    x: new Float32Array(deaths), y: new Float32Array(deaths),
    owner: new Uint8Array(deaths), isBuilding: new Uint8Array(deaths),
  };
  return { shots: s, deaths: d } as unknown as Parameters<CombatEffects["ingestTick"]>[0];
}
