// P6-T04 — the reduced-motion setting, asserted as an EFFECT rather than as a flag.
//
// A test that set the preference and then checked the preference would prove nothing at all: the
// claim is that the things which moved stop moving, and that everything they were saying is still
// said. So every assertion here goes through the real path — `SceneComposer.compose` into the
// recording renderer, reading the very overlay buffers `overlays2d.ts` and `webgl.ts` draw from.
// What is checked is the numbers a renderer would paint with:
//
//   tracer  data[i·stride + 6]  the fade
//   blast   data[i·stride + 3]  the progress the ring's size AND opacity are both derived from
//   impact  data[i·stride + 3]  the progress the two glyphs swell and fade on
//
// The control half matters as much as the reduced half. Each of these first proves the value MOVES
// with motion on — otherwise "it did not change" would pass against a pool that was simply empty,
// which is the shape of a green test that measures nothing.

import { afterEach, describe, expect, it } from "vitest";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { SceneComposer } from "../../src/view/scene.js";
import {
  BLAST_SECONDS, CombatEffects, IMPACT_SECONDS, STILL_BLAST_PROGRESS, STILL_IMPACT_PROGRESS,
  STILL_TRACER_FADE, TRACER_SECONDS,
} from "../../src/view/effects.js";
import {
  MOTION_PREFERENCES, REDUCED_MOTION_QUERY, isMotionPreference, motionPreference,
  prefersReducedMotion, reducedMotion, setMotionPreference,
} from "../../src/view/motion.js";
import { TIERS } from "../../src/view/renderer/tiers.js";
import { buildMeshes } from "../../src/view/meshes/generators.js";
import { buildTerrainMesh } from "../../src/view/terrain/mesh.js";
import { elevationFieldFrom } from "../../src/view/terrain/elevation.js";
import { CameraRig } from "../../src/input/camera.js";
import { OVERLAY_STRIDE } from "../../src/view/renderer/port.js";
import { WorldBridge } from "../../src/bridge/world.js";

const SEED = 20260814;

/**
 * One shot, one death and one heavy splashing hit, at a known place, composed on demand.
 *
 * Injected rather than fought for: `combat-feedback.test.ts` already proves the pool fills from a
 * real firefight, and what is under test here is what happens to an effect's CLOCK between frames.
 * A hand-built tick makes "the same three effects, aged by exactly one frame" the only variable.
 */
function scene() {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const map = bridge.state.map;
  const base = map.bases.player;
  const field = elevationFieldFrom(map.terrain, map.width, map.height);
  const composer = new SceneComposer(field);
  const renderer = new RecordingRenderer();
  renderer.registerMeshes(buildMeshes());
  renderer.setTier("T2");
  renderer.resize(1280, 720, 1);
  const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
  rig.focusOn(base.x, base.y);
  const terrain = buildTerrainMesh(field, { relief: true, apron: 0 });

  composer.ingestTick({
    shots: {
      count: 1, dropped: 0,
      fromX: new Float32Array([base.x - 20]), fromY: new Float32Array([base.y]),
      toX: new Float32Array([base.x + 20]), toY: new Float32Array([base.y + 10]),
      owner: new Uint8Array([0]),
    },
    deaths: {
      count: 1,
      x: new Float32Array([base.x + 20]), y: new Float32Array([base.y + 10]),
      owner: new Uint8Array([1]), isBuilding: new Uint8Array([1]),
    },
    impacts: {
      count: 1,
      x: new Float32Array([base.x + 20]), y: new Float32Array([base.y + 10]),
      owner: new Uint8Array([0]),
      heavy: new Uint8Array([1]), bonus: new Uint8Array([0]),
      splashRadius: new Float32Array([28]),
    },
  } as unknown as Parameters<SceneComposer["ingestTick"]>[0]);

  const draw = (): void => {
    renderer.setFog(bridge.snapshot.fog);
    composer.compose(renderer, bridge.snapshot, rig.update(1280, 720), TIERS.T2, terrain, 0, null);
  };
  /** Advance one 60 fps frame and redraw — the loop `Game.renderFrame` runs. */
  const frame = (): void => { composer.ageEffects(1 / 60); draw(); };
  return { composer, renderer, draw, frame };
}

type Kind = "tracer" | "blast" | "impact";
const CLOCK_OFFSET: Record<Kind, number> = { tracer: 6, blast: 3, impact: 3 };

/** The animated number the renderer would paint effect 0 with, this frame. */
function clock(renderer: RecordingRenderer, kind: Kind): number {
  const layer = renderer.lastFrame.overlays.find((o) => o.kind === kind);
  expect(layer, `nothing pushed a ${kind} layer, so this proves nothing`).toBeDefined();
  expect(layer!.count, `the ${kind} pool was empty, so a "did not change" check is vacuous`).toBe(1);
  return layer!.data[CLOCK_OFFSET[kind]]!;
}

/** Every number the renderer receives for effect 0 — the FACTS as well as the clock. */
function row(renderer: RecordingRenderer, kind: Kind): number[] {
  const layer = renderer.lastFrame.overlays.find((o) => o.kind === kind)!;
  return [...layer.data.slice(0, OVERLAY_STRIDE[kind])];
}

afterEach(() => {
  // Module-level state, so a leaked preference would quietly reduce motion in every later file.
  setMotionPreference("auto");
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  setMotionPreference("auto");
});

/**
 * Stand in for an OS that answers the reduced-motion query one way or the other.
 *
 * The query is written out here rather than taken from `REDUCED_MOTION_QUERY`, deliberately: a stub
 * that answered whatever the source happened to ask would agree with a source that asked the wrong
 * question, and a browser would not. This is the ONE string the client has to get right to hear the
 * machine at all, so the test spells it.
 */
const OS_QUERY = "(prefers-reduced-motion: reduce)";

function stubMatchMedia(reduce: boolean, queries: string[] = []): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => {
    queries.push(query);
    return { matches: reduce && query === OS_QUERY };
  };
}

describe("motion on: the effects animate (the control)", () => {
  it("moves all three clocks between two frames of the same tick", () => {
    setMotionPreference("full");
    const { draw, frame, renderer } = scene();
    draw();
    const before = { tracer: clock(renderer, "tracer"), blast: clock(renderer, "blast"), impact: clock(renderer, "impact") };
    frame();
    frame();
    expect(clock(renderer, "tracer"), "the tracer's fade never moved with motion ON").toBeLessThan(before.tracer);
    expect(clock(renderer, "blast"), "the death ring never expanded with motion ON").toBeGreaterThan(before.blast);
    expect(clock(renderer, "impact"), "the impact glyph never swelled with motion ON").toBeGreaterThan(before.impact);
  });
});

describe("motion reduced: the decoration stops and the facts stay", () => {
  it("holds every clock still across the whole life of the effect", () => {
    setMotionPreference("reduced");
    const { draw, frame, renderer } = scene();
    draw();
    const first = { tracer: clock(renderer, "tracer"), blast: clock(renderer, "blast"), impact: clock(renderer, "impact") };
    // The three chosen values, written out rather than compared against the constants they came
    // from — a test that reads the source's own number cannot notice the source changing it, and
    // each of these is a legibility decision with a paragraph of reasoning behind it.
    expect(first.tracer, "a still tracer is drawn at anything but full strength").toBe(1);
    expect(STILL_TRACER_FADE).toBe(1);
    // A third of the way in: where the ring's growth (0.35 + p) and its fade (1 − p) cross, so a
    // frozen mark puts the most ink on screen any single frame of the animation ever does. Through
    // a `Float32Array` on the way to the renderer, so a third is a third to seven places.
    expect(first.blast).toBeCloseTo(1 / 3, 6);
    expect(STILL_BLAST_PROGRESS).toBeCloseTo(1 / 3, 12);
    // Zero: full opacity, and the glyphs at the base size the vocabulary was drawn for.
    expect(first.impact).toBe(0);
    expect(STILL_IMPACT_PROGRESS).toBe(0);

    // Eight frames — half the tracer's whole life, and long enough that any per-frame ramp would
    // have moved it visibly.
    for (let f = 0; f < 8; f++) {
      frame();
      expect(clock(renderer, "tracer"), "the tracer is still fading under reduced motion").toBe(first.tracer);
      expect(clock(renderer, "blast"), "the death ring is still expanding under reduced motion").toBe(first.blast);
      expect(clock(renderer, "impact"), "the impact glyph is still swelling under reduced motion").toBe(first.impact);
    }
  });

  it("still draws all three cues, and every fact they carry is unchanged", () => {
    // The half that stops this becoming "turn the effects off". A tracer is how a player knows they
    // are being shot at and from where; deleting it would remove information rather than motion.
    setMotionPreference("full");
    const moving = scene();
    moving.draw();
    const movingRows = { tracer: row(moving.renderer, "tracer"), blast: row(moving.renderer, "blast"), impact: row(moving.renderer, "impact") };

    setMotionPreference("reduced");
    const still = scene();
    still.draw();

    for (const kind of ["tracer", "blast", "impact"] as const) {
      const stillRow = row(still.renderer, kind);
      const movingRow = movingRows[kind];
      expect(stillRow.length, `the ${kind} layer changed shape under reduced motion`).toBe(movingRow.length);
      for (let i = 0; i < stillRow.length; i++) {
        if (i === CLOCK_OFFSET[kind]) continue;               // the clock is the thing that changed
        expect(stillRow[i], `reduced motion altered a ${kind} FACT at slot ${i} — endpoint, owner, size or radius`)
          .toBe(movingRow[i]);
      }
    }
  });

  it("leaves every lifetime exactly where it was", () => {
    // A frozen mark that also lingered would be a different feature, and it would change how much
    // combat a player sees. The clock stops; the calendar does not.
    setMotionPreference("reduced");
    const fx = new CombatEffects();
    fx.ingestTick(fakeTick());
    expect([fx.tracerCount, fx.blastCount, fx.impactCount]).toEqual([1, 1, 1]);

    fx.age(TRACER_SECONDS - 1e-4);
    expect(fx.tracerCount, "a still tracer retired early").toBe(1);
    fx.age(2e-4);
    expect(fx.tracerCount, "a still tracer outlived its own lifetime").toBe(0);

    fx.age(IMPACT_SECONDS - TRACER_SECONDS);
    expect(fx.impactCount, "a still impact mark outlived its own lifetime").toBe(0);
    expect(fx.blastCount, "the death mark should still be up — it is the longest of the three").toBe(1);
    fx.age(BLAST_SECONDS);
    expect(fx.blastCount, "a still death mark outlived its own lifetime").toBe(0);
  });
});

describe("the setting may disagree with the machine, in both directions", () => {
  it("takes the machine's answer under auto, and shows it in the frame", () => {
    const asked: string[] = [];
    stubMatchMedia(true, asked);
    setMotionPreference("auto");
    expect(asked, "auto asked the OS a different question than prefers-reduced-motion: reduce")
      .toContain(OS_QUERY);
    expect(REDUCED_MOTION_QUERY, "the exported query no longer matches the one browsers answer")
      .toBe(OS_QUERY);

    const { draw, frame, renderer } = scene();
    draw();
    const before = clock(renderer, "tracer");
    frame();
    expect(clock(renderer, "tracer"), "a machine asking for reduced motion still got an animated tracer")
      .toBe(before);
  });

  it("gives a player full motion on a machine that asks for less", () => {
    stubMatchMedia(true);
    setMotionPreference("full");
    expect(prefersReducedMotion(), "this test needs an OS that asks for reduced motion").toBe(true);

    const { draw, frame, renderer } = scene();
    draw();
    const before = clock(renderer, "tracer");
    frame();
    expect(
      clock(renderer, "tracer"),
      "the OS overruled the player: a machine that asks for reduced motion should not be able to " +
      "take an animated tracer away from someone who asked for one",
    ).toBeLessThan(before);
  });

  it("gives a player reduced motion on a machine that never asked", () => {
    stubMatchMedia(false);
    setMotionPreference("reduced");
    expect(prefersReducedMotion(), "this test needs an OS with no opinion").toBe(false);

    const { draw, frame, renderer } = scene();
    draw();
    const before = clock(renderer, "tracer");
    frame();
    expect(clock(renderer, "tracer"), "the player's own choice was overruled by a silent OS").toBe(before);
  });

  it("goes back to the machine's answer when auto is chosen again", () => {
    stubMatchMedia(true);
    setMotionPreference("full");
    expect(reducedMotion()).toBe(false);
    setMotionPreference("auto");
    expect(reducedMotion(), "auto kept the last explicit answer instead of asking the machine again")
      .toBe(true);
    expect(motionPreference()).toBe("auto");
  });
});

describe("the preference itself", () => {
  it("survives an environment with no matchMedia at all, and one that throws", () => {
    // Persona P2's browser: `matchMedia` is absent in jsdom and can be blocked outright. A settings
    // read that throws must not stop the game from starting — `app/settings.ts`'s own rule.
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    expect(() => setMotionPreference("auto")).not.toThrow();

    (globalThis as { matchMedia?: unknown }).matchMedia = () => { throw new Error("blocked"); };
    expect(prefersReducedMotion(), "a blocked matchMedia was allowed to escape").toBe(false);
    expect(() => setMotionPreference("auto")).not.toThrow();
    expect(reducedMotion()).toBe(false);
  });

  it("names three states, and accepts nothing else as one", () => {
    expect([...MOTION_PREFERENCES]).toEqual(["auto", "full", "reduced"]);
    for (const p of MOTION_PREFERENCES) expect(isMotionPreference(p)).toBe(true);
    for (const junk of [true, false, "on", "off", "", null, undefined, 1]) {
      expect(isMotionPreference(junk), `${String(junk)} was accepted as a motion preference`).toBe(false);
    }
  });
});

/** One of each effect, with the flags that make an impact worth drawing at all (`impactReads`). */
function fakeTick() {
  return {
    shots: {
      count: 1, dropped: 0,
      fromX: new Float32Array([0]), fromY: new Float32Array([0]),
      toX: new Float32Array([10]), toY: new Float32Array([10]),
      owner: new Uint8Array([0]),
    },
    deaths: {
      count: 1, x: new Float32Array([10]), y: new Float32Array([10]),
      owner: new Uint8Array([1]), isBuilding: new Uint8Array([0]),
    },
    impacts: {
      count: 1, x: new Float32Array([10]), y: new Float32Array([10]), owner: new Uint8Array([0]),
      heavy: new Uint8Array([1]), bonus: new Uint8Array([0]), splashRadius: new Float32Array([0]),
    },
  } as unknown as Parameters<CombatEffects["ingestTick"]>[0];
}
