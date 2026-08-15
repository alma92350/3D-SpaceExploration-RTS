// P5-T15, the drawn half — PARITY rows 66, 67 and 68 as a player actually sees them.
//
// `test/bridge/impacts.test.ts` proves the three facts cross the bridge. Nothing there looks at what
// is stroked, and for these three cues that is where most of the risk lives, because PRD N-05 is a
// claim about GEOMETRY: a heavy hit and a bonus hit arrive at the same moment, in the same place, in
// the same owner colour, and tinting one red and one yellow is both the obvious implementation and
// the one a player who cannot separate those hues has no way to read.
//
// So this file asserts, in order: the pool and the layer, the filter that keeps a plain hit silent,
// the glyph vocabulary as pure geometry (no renderer, no pixels, no colour), and finally the actual
// path commands the shared Canvas2D drawing path issues.

import { describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import { CombatEffects, IMPACT_SECONDS, impactReads } from "../../src/view/effects.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { drawOverlayLayer } from "../../src/view/renderer/overlays2d.js";
import {
  GLYPHS, IDLE_GLYPH, IMPACT_BONUS, IMPACT_HEAVY, type Glyph,
} from "../../src/view/renderer/glyphs.js";
import { OVERLAY_STRIDE, type CameraState, type OverlayLayer } from "../../src/view/renderer/port.js";
import { SNAP_AI, SNAP_PLAYER } from "../../src/bridge/snapshot.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import { UNITS, makeBuilding, makeUnit } from "../../src/engine/index.js";

const SEED = 20260814;
const STRIDE = OVERLAY_STRIDE.impact;

/** An impacts table shaped like the snapshot's, for driving the pool without a simulation. */
function fakeImpacts(rows: ReadonlyArray<{ x?: number; y?: number; owner?: number; heavy?: number; bonus?: number; splash?: number }>) {
  const n = rows.length;
  const t = {
    count: n,
    x: new Float32Array(n), y: new Float32Array(n),
    owner: new Uint8Array(n), heavy: new Uint8Array(n), bonus: new Uint8Array(n),
    splashRadius: new Float32Array(n),
  };
  rows.forEach((r, i) => {
    t.x[i] = r.x ?? 0;
    t.y[i] = r.y ?? 0;
    t.owner[i] = r.owner ?? 0;
    t.heavy[i] = r.heavy ?? 0;
    t.bonus[i] = r.bonus ?? 0;
    t.splashRadius[i] = r.splash ?? 0;
  });
  return {
    shots: { count: 0, dropped: 0, fromX: new Float32Array(0), fromY: new Float32Array(0), toX: new Float32Array(0), toY: new Float32Array(0), owner: new Uint8Array(0) },
    deaths: { count: 0, x: new Float32Array(0), y: new Float32Array(0), owner: new Uint8Array(0), isBuilding: new Uint8Array(0) },
    impacts: t,
  } as unknown as Parameters<CombatEffects["ingestTick"]>[0];
}

describe("the impact pool", () => {
  it("takes only the hits that say something a plain hit does not", () => {
    // The filter is the reason this cue reads at all: 203 hits crossed in a measured 400-tick
    // brawl and 47 of them carried a flag. A mark on all 203 would be one more flash per tracer.
    const fx = new CombatEffects();
    fx.ingestTick(fakeImpacts([
      {},                                   // a plain hit — silent
      { heavy: 1 },
      { bonus: 1 },
      { splash: 26 },
      { heavy: 1, splash: 26 },             // the Colossus on a building: two facts, one hit
      {},                                   // and another plain one, after the interesting rows
    ]));
    expect(fx.impactCount, "the plain hits were drawn, or an interesting one was dropped").toBe(4);
    // …and the survivors kept their own flags rather than the previous row's.
    expect([...fx.iHeavy.slice(0, 4)]).toEqual([1, 0, 0, 1]);
    expect([...fx.iBonus.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    expect([...fx.iSplash.slice(0, 4)]).toEqual([0, 0, 26, 26]);
  });

  it("agrees with the predicate it is written against", () => {
    expect(impactReads(0, 0, 0), "a plain hit").toBe(false);
    expect(impactReads(1, 0, 0), "a siege hit").toBe(true);
    expect(impactReads(0, 1, 0), "a counter hit").toBe(true);
    expect(impactReads(0, 0, 26), "a splash hit").toBe(true);
    expect(impactReads(0, 0, 0.0), "a zero radius is no splash").toBe(false);
  });

  it("keeps a hit up across the frames between two ticks, then retires it exactly once", () => {
    const fx = new CombatEffects();
    expect(IMPACT_SECONDS, "a hit mark must outlive the gap between two sim ticks")
      .toBeGreaterThan(STEP_SECONDS);
    // …and never outlive the weapon cycle, or two shots read as one long mark.
    const fastest = Math.min(...Object.values(UNITS)
      .map((u) => (u as { cooldown?: number }).cooldown)
      .filter((c): c is number => typeof c === "number"));
    expect(IMPACT_SECONDS, `the fastest weapon cycles in ${fastest}s and the mark outlives it`)
      .toBeLessThan(fastest);

    fx.ingestTick(fakeImpacts([{ heavy: 1 }]));
    fx.age(IMPACT_SECONDS - 1e-4);
    expect(fx.impactCount, "retired early").toBe(1);
    expect(fx.impactProgress(0), "the mark is not ageing").toBeGreaterThan(0.9);
    fx.age(2e-4);
    expect(fx.impactCount, "outlived its own lifetime").toBe(0);
  });

  it("compacts without losing the survivors, their positions or their flags", () => {
    // Swap-remove copies the last live entry down over a dead one. Every parallel array has to move
    // together: one forgotten line and a survivor comes back wearing another hit's position, which
    // draws a ring somewhere nothing happened.
    const fx = new CombatEffects();
    fx.ingestTick(fakeImpacts(Array.from({ length: 5 }, (_, i) => ({ x: 100 + i, y: 900 + i, heavy: 1 }))));
    fx.age(IMPACT_SECONDS * 0.5);
    fx.ingestTick(fakeImpacts(Array.from({ length: 3 }, (_, i) => ({
      x: 700 + i, y: 300 + i, bonus: 1, splash: 26, owner: 1,
    }))));
    expect(fx.impactCount).toBe(8);
    fx.age(IMPACT_SECONDS * 0.6);
    expect(fx.impactCount, "compaction lost or kept the wrong entries").toBe(3);

    const survivors = new Set<number>();
    for (let i = 0; i < fx.impactCount; i++) {
      expect(fx.iBonus[i], "a survivor came back wearing a dead entry's flags").toBe(1);
      expect(fx.iHeavy[i], "a survivor picked up a dead entry's `heavy`").toBe(0);
      expect(fx.iSplash[i]).toBe(26);
      expect(fx.iOwner[i], "a survivor came back under the wrong owner").toBe(1);
      expect(fx.impactProgress(i), "a survivor came back with a dead entry's clock").toBeLessThan(1);
      expect(fx.ix[i], "a survivor came back at a dead entry's position").toBeGreaterThanOrEqual(700);
      expect(fx.iy[i]! - fx.ix[i]!, "x and y were compacted out of step with each other").toBe(-400);
      survivors.add(fx.ix[i]!);
    }
    expect(survivors.size, "compaction duplicated a survivor over another").toBe(3);
  });

  it("keeps hits in flight when the pool has to grow", () => {
    // Every value the batch before the growth carried has to come through it. Set on the FIRST
    // batch as well as the second: a version that reallocated instead of copying would still look
    // perfect if the pre-growth entries all happened to be zero.
    const fx = new CombatEffects(4);
    fx.ingestTick(fakeImpacts(Array.from({ length: 3 }, (_, i) => ({
      x: 10 + i, y: 20 + i, heavy: 1, bonus: 1, splash: 100 + i, owner: 1,
    }))));
    fx.ingestTick(fakeImpacts(Array.from({ length: 20 }, (_, i) => ({
      x: 500 + i, y: 600 + i, heavy: 1, splash: i + 1,
    }))));
    expect(fx.impactCount).toBe(23);
    for (let i = 0; i < 3; i++) {
      expect(fx.iSplash[i], "growth discarded a radius that was still in flight").toBe(100 + i);
      expect(fx.ix[i], "growth discarded a position that was still in flight").toBe(10 + i);
      expect(fx.iy[i]).toBe(20 + i);
      expect(fx.iBonus[i], "growth discarded a flag that was still in flight").toBe(1);
      expect(fx.iOwner[i]).toBe(1);
    }
    for (let i = 3; i < 23; i++) {
      expect(fx.iSplash[i], "the batch that caused the growth landed wrong").toBe(i - 2);
      expect(fx.ix[i]).toBe(500 + i - 3);
    }
  });

  it("clears with the rest of the pool on a scene change", () => {
    const fx = new CombatEffects();
    fx.ingestTick(fakeImpacts([{ heavy: 1 }]));
    fx.clear();
    expect(fx.impactCount, "impacts survived a scene change and would draw on the next world").toBe(0);
  });
});

describe("the impact layer in a composed frame", () => {
  function scene() {
    const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
    const base = bridge.state.map.bases.player;
    const cc = makeBuilding("command", "player", base.x, base.y);
    bridge.state.buildings.set(cc.id, cc);
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
    const draw = () => {
      renderer.setFog(bridge.snapshot.fog);
      composer.compose(renderer, bridge.snapshot, rig.update(1280, 720), TIERS.T2, terrain, 0, null);
    };
    return { bridge, base, composer, renderer, draw };
  }

  const layer = (r: RecordingRenderer) => r.lastFrame.overlays.find((o) => o.kind === "impact") ?? null;

  it("draws a real Colossus shell as one row carrying heavy, splash and the shooter's colour", () => {
    // End to end: the engine's own event, through the bridge, through the pool, into a layer.
    const { bridge, base, composer, renderer, draw } = scene();
    const gun = makeUnit("colossus", "player", base.x + 30, base.y);
    const target = makeBuilding("habitat", "ai", base.x + 150, base.y);
    target.hp = 1e6;
    target.maxHp = 1e6;
    bridge.state.units.set(gun.id, gun);
    bridge.state.buildings.set(target.id, target);

    const splash = (UNITS.colossus as { splash?: { radius: number } }).splash!.radius;
    for (let t = 0; t < 200; t++) {
      bridge.step(STEP_SECONDS);
      composer.ingestTick(bridge.snapshot);
      draw();
      const l = layer(renderer);
      if (!l || l.count === 0) { composer.ageEffects(1 / 60); continue; }
      expect(l.stride).toBe(STRIDE);
      expect(l.count, "one shell, one row").toBe(1);
      expect(l.data[STRIDE - 1], "the mark is not in the shooter's colour").toBe(SNAP_PLAYER);
      expect(l.data[4], "a Colossus shell on a building did not read as heavy").toBe(1);
      expect(l.data[6], "the ring is not the weapon's own radius").toBe(splash);
      expect(l.data[3], "a fresh mark is already spent").toBeLessThan(0.2);
      // Lifted off the terrain, like every other ground overlay, so it does not z-fight a slope.
      expect(l.data[1], "the mark sits at the zero plane rather than on the ground").toBeGreaterThan(0);
      return;
    }
    throw new Error("the Colossus never landed a shell in 200 ticks");
  });

  it("costs one layer for the whole frame, not one per hit", () => {
    const { composer, renderer, draw } = scene();
    composer.ingestTick(fakeImpacts(Array.from({ length: 40 }, (_, i) => ({
      x: 600 + i, y: 500, heavy: i % 2, bonus: (i + 1) % 2, splash: 26, owner: i % 2,
    }))) as never);
    draw();
    expect(renderer.lastFrame.overlays.filter((o) => o.kind === "impact").length).toBe(1);
    expect(layer(renderer)!.count).toBe(40);
  });

  it("fades between frames without a new tick", () => {
    const { composer, renderer, draw } = scene();
    composer.ingestTick(fakeImpacts([{ x: 600, y: 500, bonus: 1 }]) as never);
    draw();
    const first = layer(renderer)!.data[3]!;
    for (let f = 0; f < 4; f++) { composer.ageEffects(1 / 60); draw(); }
    const later = layer(renderer)!.data[3]!;
    expect(later, "the mark is not ageing between frames").toBeGreaterThan(first);
    expect(later).toBeLessThanOrEqual(1);
  });

  it("widens its cull by the splash radius, so a blast reaching onto the screen is drawn", () => {
    // The same rule the aura and the bomb use. A Colossus shell landing just past the cull edge
    // still rattles units the player IS looking at, and clipping the impact point would leave half
    // an army losing health with nothing on screen to explain it.
    const { bridge, composer, renderer } = scene();
    const field = elevationFieldFrom(bridge.state.map.terrain, bridge.state.map.width, bridge.state.map.height);
    const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
    const terrain = buildTerrainMesh(field, { relief: false, apron: TIERS.T0.apron });
    rig.focusOn(200, 200);
    const camera = rig.update(1280, 720);

    // Just outside T0's plain cull radius, and inside it once the splash radius is added on.
    const splash = 60;
    const angle = Math.atan2(1, 1);
    const d = TIERS.T0.cullDistance + splash * 0.5;
    const x = camera.eyeX + Math.cos(angle) * d;
    const y = camera.eyeZ + Math.sin(angle) * d;
    expect(Math.hypot(x - camera.eyeX, y - camera.eyeZ)).toBeGreaterThan(TIERS.T0.cullDistance);

    composer.ingestTick(fakeImpacts([{ x, y, heavy: 1, splash }]) as never);
    composer.compose(renderer, bridge.snapshot, camera, TIERS.T0, terrain, 0, null);
    expect(
      layer(renderer),
      "a splash blast whose ring reaches inside the cull radius was thrown away with its centre",
    ).not.toBeNull();

    // …and the same hit with no splash to reach in with really is culled, or the widening is doing
    // nothing and the assertion above passes because nothing is culled at all.
    composer.effects.clear();
    composer.ingestTick(fakeImpacts([{ x, y, heavy: 1 }]) as never);
    composer.compose(renderer, bridge.snapshot, camera, TIERS.T0, terrain, 0, null);
    expect(layer(renderer), "a splashless hit past the cull radius was drawn anyway").toBeNull();
  });

  it("adds no instance batch — a hit mark is not geometry", () => {
    const { composer, renderer, draw } = scene();
    draw();
    const quiet = new Set(renderer.lastFrame.batches.map((b) => `${b.mesh}|${b.owner}|${b.lod}`));
    composer.ingestTick(fakeImpacts([{ x: 600, y: 500, heavy: 1, splash: 26 }]) as never);
    draw();
    for (const b of renderer.lastFrame.batches) {
      const key = `${b.mesh}|${b.owner}|${b.lod}`;
      expect(quiet.has(key), `an impact introduced the batch ${key}`).toBe(true);
    }
  });
});

describe("N-05: the two hit marks differ by more than hue", () => {
  /** A glyph's geometry, canonicalised so two shapes can be compared without a renderer. */
  const shape = (g: Glyph): string =>
    JSON.stringify([g.closed, g.strokes.map((s) => s.map((v) => Math.round(v * 1000)))]);

  it("no two glyphs in the whole vocabulary share a shape", () => {
    // The badges and the hit marks share one glyph space and one stroke colour each, so shape is
    // the only channel any of them has. Two that collided would be two states a player cannot tell
    // apart at all — and the pair most at risk is `starved` (a closed down-triangle) against the
    // siege wedge, which is why they are an open figure with a plate under it.
    const all: Glyph[] = [...Object.values(GLYPHS), IDLE_GLYPH, IMPACT_BONUS, IMPACT_HEAVY];
    expect(all.length, "the vocabulary shrank").toBeGreaterThanOrEqual(9);
    const byShape = new Map<string, string>();
    for (const g of all) {
      const key = shape(g);
      expect(byShape.get(key), `${g.id} and ${byShape.get(key)} are the same figure`).toBeUndefined();
      byShape.set(key, g.id);
    }
  });

  it("the siege mark and the counter mark are unlike each other on every axis", () => {
    expect(IMPACT_HEAVY.closed, "the wedge closed into a triangle, which is `starved`").toBe(false);
    expect(IMPACT_BONUS.closed, "the spark opened up and stopped reading as a star").toBe(true);
    expect(IMPACT_HEAVY.strokes.length, "the plate under the wedge is gone").toBe(2);
    expect(IMPACT_BONUS.strokes.length, "the spark is one closed figure").toBe(1);
    // Radial versus directional, measured rather than asserted by eye. The strongest statement of
    // it a machine can check: the spark maps onto ITSELF under a quarter turn — that symmetry is
    // what makes it read as a burst with no direction — and the wedge does not, which is what makes
    // it read as force arriving from somewhere.
    const points = (g: Glyph) => {
      const out: Array<[number, number]> = [];
      for (const s of g.strokes) for (let i = 0; i < s.length; i += 2) out.push([s[i]!, s[i + 1]!]);
      return out;
    };
    const symmetricUnderQuarterTurn = (g: Glyph): boolean => {
      const pts = points(g);
      return pts.every(([x, y]) => pts.some(([px, py]) => Math.hypot(px + y, py - x) < 1e-6));
    };
    expect(symmetricUnderQuarterTurn(IMPACT_BONUS), "the spark lost its radial symmetry").toBe(true);
    expect(symmetricUnderQuarterTurn(IMPACT_HEAVY), "the siege mark became radial, like the spark")
      .toBe(false);
    // And it is centred, so the burst sits ON the impact rather than beside it.
    const centre = points(IMPACT_BONUS).reduce((a, [x, y]) => ({ x: a.x + x, y: a.y + y }), { x: 0, y: 0 });
    expect(Math.hypot(centre.x, centre.y) / 8, "the spark is lopsided rather than radial")
      .toBeLessThan(0.02);

    // Concave, and by a wide margin. Radial symmetry alone is satisfied by a REGULAR polygon, and a
    // regular octagon at this size is the `idle` badge — a small round figure — which is the one
    // shape in the vocabulary the counter cue must not be mistaken for. The notches are what make
    // it read as a burst.
    const radii = points(IMPACT_BONUS).map(([x, y]) => Math.hypot(x, y));
    expect(
      Math.max(...radii) / Math.min(...radii),
      "the spark's points and notches are the same length, so it is a regular polygon — at nine " +
      "pixels that is the `idle` ring with corners",
    ).toBeGreaterThan(2);
  });
});

describe("the impact overlay as drawn", () => {
  it("strokes a ring at the splash radius, and nothing else, for a splash-only hit", () => {
    const cam = camera();
    const { ctx, paths } = recordingCtx();
    drawOverlayLayer(ctx, cam, impactLayer(cam, [{ splash: 26 }]), 1);
    expect(paths.length, "a splash-only hit should stroke exactly one ring").toBe(1);
    expect(paths[0]!.dashed, "the ring is solid, so it reads as a hard edge the falloff does not have")
      .toBe(true);
  });

  it("draws the ring at the weapon's OWN radius, not a fixed one", () => {
    const cam = camera();
    const small = ringSpan(cam, 26);
    const large = ringSpan(cam, 78);
    expect(large, "three times the radius drew the same ring — the number is not reaching the drawing")
      .toBeGreaterThan(small * 2);
  });

  it("holds the ring at that radius for the whole of its life", () => {
    // The glyphs swell as they fade; the ring must not, because its size is the fact being stated.
    // A ring that grew into its radius would be true only on the frame it expires.
    const cam = camera();
    const fresh = ringSpan(cam, 26, 0);
    const spent = ringSpan(cam, 26, 0.95);
    expect(spent, "the splash ring changed size as it aged — its radius is a measurement")
      .toBeCloseTo(fresh, 6);
  });

  it("gives a siege hit and a counter hit different figures at the same position and colour", () => {
    // N-05, at the drawing. Same owner slot, so the stroke colour is identical in both calls and
    // the ONLY difference available to the player is what these assertions look at.
    const cam = camera();
    const heavy = draws(cam, [{ heavy: 1, owner: 0 }]);
    const bonus = draws(cam, [{ bonus: 1, owner: 0 }]);

    expect(heavy.paths.length, "the siege mark is a wedge and the plate it lands on").toBe(2);
    expect(bonus.paths.length, "the counter mark is one closed spark").toBe(1);
    expect(heavy.paths[0]!.width, "the two marks are stroked at the same weight")
      .toBeGreaterThan(bonus.paths[0]!.width);
    expect(span(heavy.paths[0]!), "the siege mark is not the larger of the two")
      .toBeGreaterThan(span(bonus.paths[0]!));
    // …and they do not sit on top of each other, so the one hit that carries both stays readable.
    expect(Math.abs(mid(heavy.paths[0]!).y - mid(bonus.paths[0]!).y), "the two marks overlap")
      .toBeGreaterThan(4);
  });

  it("draws every mark a single hit carries, rather than picking one", () => {
    const cam = camera();
    const both = draws(cam, [{ heavy: 1, bonus: 1, splash: 26 }]);
    expect(
      both.paths.length,
      "a hit that is heavy AND a counter AND splashing drew fewer than three figures — one of the " +
      "three facts the engine stated was thrown away by a precedence rule nobody asked for",
    ).toBe(4);   // ring + wedge + plate + spark
  });

  it("draws nothing at all for a hit with nothing to say", () => {
    const cam = camera();
    expect(draws(cam, [{}]).paths.length, "a plain hit drew a mark").toBe(0);
  });

  it("fades with the mark's own clock", () => {
    const cam = camera();
    const fresh = draws(cam, [{ heavy: 1 }], 0).alphas;
    const spent = draws(cam, [{ heavy: 1 }], 0.9).alphas;
    expect(fresh[0], "a fresh mark is already transparent").toBeCloseTo(1, 2);
    expect(spent[0], "the mark is not fading").toBeLessThan(0.2);
  });

  it("leaves the context clean for the next layer", () => {
    // Every overlay shares one canvas. A case that returned with a dash pattern or a reduced alpha
    // still set would silently restyle whatever is drawn after it — and the impact layer sets both.
    const cam = camera();
    const { ctx, paths } = recordingCtx();
    drawOverlayLayer(ctx, cam, impactLayer(cam, [{ heavy: 1, splash: 26 }], 0.5), 1);
    expect(paths.length).toBeGreaterThan(0);
    expect((ctx as unknown as { globalAlpha: number }).globalAlpha, "left the canvas faded").toBe(1);
    const after = recordingCtx();
    drawOverlayLayer(after.ctx, cam, impactLayer(cam, [{ splash: 26 }], 0), 1);
    expect(after.paths[0]!.dashed, "the dash state did not survive into the next layer as expected")
      .toBe(true);
  });

  it("puts the AI's hits in the AI's colour and the player's in the player's", () => {
    const cam = camera();
    expect(draws(cam, [{ heavy: 1, owner: SNAP_PLAYER }]).colors[0])
      .not.toBe(draws(cam, [{ heavy: 1, owner: SNAP_AI }]).colors[0]);
  });
});

// --- the recording context, as `bomb-drawing.test.ts` established -------------------------------

interface Path { points: Array<{ x: number; y: number }>; width: number; dashed: boolean; alpha: number; color: string }

function recordingCtx() {
  const paths: Path[] = [];
  let current: Path | null = null;
  const state = { dashed: false };
  const ctx = {
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    save() {},
    restore() {},
    scale() {},
    setLineDash(pattern: number[]) { state.dashed = pattern.length > 0; },
    beginPath() { current = { points: [], width: ctx.lineWidth, dashed: state.dashed, alpha: ctx.globalAlpha, color: ctx.strokeStyle }; },
    closePath() {},
    moveTo(x: number, y: number) { current?.points.push({ x, y }); },
    lineTo(x: number, y: number) { current?.points.push({ x, y }); },
    arc() {},
    fill() {},
    fillRect() {},
    stroke() {
      if (!current || current.points.length < 2) return;
      current.width = ctx.lineWidth;
      current.dashed = state.dashed;
      current.alpha = ctx.globalAlpha;
      current.color = ctx.strokeStyle;
      paths.push(current);
      current = null;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, paths };
}

function camera(): CameraState {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const state = bridge.state;
  const field = elevationFieldFrom(state.map.terrain, state.map.width, state.map.height);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(state.map.bases.player.x, state.map.bases.player.y);
  return rig.update(1280, 720);
}

/** Impact rows at the camera's focus, so nothing lands behind the near plane. */
function impactLayer(
  cam: CameraState,
  rows: ReadonlyArray<{ heavy?: number; bonus?: number; splash?: number; owner?: number }>,
  progress = 0,
): OverlayLayer {
  const data = new Float32Array(rows.length * STRIDE);
  rows.forEach((r, i) => {
    const off = i * STRIDE;
    data[off] = cam.targetX;
    data[off + 1] = 1;
    data[off + 2] = cam.targetY;
    data[off + 3] = progress;
    data[off + 4] = r.heavy ?? 0;
    data[off + 5] = r.bonus ?? 0;
    data[off + 6] = r.splash ?? 0;
    data[off + 7] = r.owner ?? 0;
  });
  return { kind: "impact", count: rows.length, stride: STRIDE, data };
}

function draws(
  cam: CameraState,
  rows: ReadonlyArray<{ heavy?: number; bonus?: number; splash?: number; owner?: number }>,
  progress = 0,
) {
  const { ctx, paths } = recordingCtx();
  drawOverlayLayer(ctx, cam, impactLayer(cam, rows, progress), 1);
  return { paths, alphas: paths.map((p) => p.alpha), colors: paths.map((p) => p.color) };
}

function ringSpan(cam: CameraState, splash: number, progress = 0): number {
  return span(draws(cam, [{ splash }], progress).paths[0]!);
}

/** Longest chord of a path — for a projected ring, its screen diameter. */
function span(p: Path): number {
  let max = 0;
  for (const a of p.points) for (const b of p.points) max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y));
  return max;
}

function mid(p: Path): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const q of p.points) { sx += q.x; sy += q.y; }
  return { x: sx / p.points.length, y: sy / p.points.length };
}
