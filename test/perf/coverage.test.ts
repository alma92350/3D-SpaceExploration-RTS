// P6-T07 — the gate must draw everything the composer can draw, and this is what says so.
//
// `perf/scene.ts` carries a running list of times this harness silently was not measuring what a
// phase had shipped. There are five entries now: an owner assignment that counted every unit mesh
// for one side only; a second extractor that ran after `state.events` had been drained, so no death
// ever reached a perf run; a Helium Bomb on the field but unarmed, so the bomb overlay never fired;
// a rally line whose scene had never selected anything; and a build ghost that `PerfScene.render`
// passed as `null` on every frame this project has ever measured.
//
// Every one was found by a person noticing. That is five for five, and the sixth is already being
// written somewhere — so this file is the check that finds the next one instead.
//
// **Derived, not listed** (ADR-0014's move applied to coverage rather than to a ceiling). A
// hand-written list of "overlays we remembered to measure" has exactly one failure mode, and it is
// the one above: the list does not grow when the code does. So the expectation is computed from two
// facts the compiler and the source already hold —
//
//   1. `OVERLAY_STRIDE` is the port's own roster of kinds. A kind that is not in it cannot be drawn.
//   2. `src/view/scene.ts` reaches its buffers through exactly one expression, `overlays.get("…")`,
//      so the kinds `SceneComposer` can emit are readable out of the file itself.
//
// — and the assertion is that (2) is a subset of what the gated scenes actually draw. Add an overlay
// to the composer and this test names it on the next run, in the same commit as the overlay.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PerfScene, SCENES } from "../../perf/scene.js";
import { runScene } from "../../perf/harness.js";
import { RecordingRenderer } from "../../src/view/renderer/recording.js";
import { OVERLAY_STRIDE, type OverlayKind } from "../../src/view/renderer/port.js";
import { PLAY_HZ } from "../../src/app/loop.js";

const SCENE_SOURCE = fileURLToPath(new URL("../../src/view/scene.ts", import.meta.url));

/**
 * The overlay kinds `SceneComposer` is capable of pushing, read out of its source.
 *
 * Source-scanning rather than reflection because there is nothing to reflect on: a kind that some
 * branch never takes leaves no trace on the object, and "the composer has a buffer for it" is true
 * of all twelve — the constructor makes one per `OVERLAY_STRIDE` entry whether it is ever filled or
 * not. What distinguishes a kind the composer draws from one it merely has room for is a `push`
 * site, and a push site is a line of code. `test/architecture/` already reads source for the same
 * class of question.
 *
 * Cross-checked against `OVERLAY_STRIDE` below, so a rename that this regex stopped matching
 * shows up as a kind that vanished rather than as a test that quietly checks nothing.
 */
function kindsTheComposerCanDraw(): Set<OverlayKind> {
  const src = readFileSync(SCENE_SOURCE, "utf8");
  const found = new Set<OverlayKind>();
  for (const m of src.matchAll(/overlays\.get\("([a-z]+)"\)/g)) found.add(m[1] as OverlayKind);
  return found;
}

/** Every overlay kind drawn at least once across a whole run of `spec`, and the peak batch count. */
function drawnBy(name: keyof typeof SCENES, frames: number): Set<OverlayKind> {
  const spec = SCENES[name]!;
  const renderer = new RecordingRenderer();
  renderer.keepFrames = 1;
  const scene = new PerfScene(spec);
  scene.setup(renderer);
  const kinds = new Set<OverlayKind>();
  const ticksPerFrame = PLAY_HZ / 60;
  let debt = 0;
  for (let f = 0; f < frames; f++) {
    debt += ticksPerFrame;
    while (debt >= 1) { scene.tick(); debt -= 1; }
    scene.render(renderer, debt);
    for (const o of renderer.lastFrame.overlays) kinds.add(o.kind);
  }
  return kinds;
}

// Long enough to cross a yaw snap and let the packed scenes trade shots, short enough that five
// scenes fit in a unit-test suite. The gate itself runs 600.
const FRAMES = 150;

describe("the perf gate draws what the composer can draw (P6-T07)", () => {
  const composerKinds = kindsTheComposerCanDraw();

  it("reads the composer's own push sites, and they are all real overlay kinds", () => {
    // The guard on the derivation. If the regex matched nothing, or matched a string that is not a
    // kind, every assertion below would pass vacuously — which is the exact shape of failure this
    // file exists to catch, so it is checked before it is used.
    expect(composerKinds.size, "no `overlays.get(\"…\")` sites found; the derivation broke").toBeGreaterThan(8);
    for (const kind of composerKinds) {
      expect(Object.keys(OVERLAY_STRIDE), `${kind} is pushed but is not an OverlayKind`).toContain(kind);
    }
  });

  it("leaves no overlay kind that the composer draws and no gated scene measures", () => {
    const gated = new Set<OverlayKind>();
    for (const name of Object.keys(SCENES)) for (const k of drawnBy(name, FRAMES)) gated.add(k);

    const unmeasured = [...composerKinds].filter((k) => !gated.has(k)).sort();
    expect(
      unmeasured,
      `${unmeasured.join(", ")} — SceneComposer draws these and no scene in perf/scene.ts makes them `
      + `fire, so they would ship ungated. That has happened five times in this repo already and `
      + `every one of them was found by a person rather than by a test. Give one scene the knob that `
      + `makes the layer draw, and record the delta in perf/baseline.json with its reason.`,
    ).toEqual([]);
  });

  it("accounts for every kind the port defines, drawn here or drawn somewhere else", () => {
    // The other half of the derivation, and the reason `waypoint` is not a bug. `OVERLAY_STRIDE` is
    // the whole vocabulary; `SceneComposer` is only one of three composers that draw through the
    // port. A kind in neither set would be a stride nothing ever packs — dead weight in a table two
    // renderers switch on, which is how a packing mismatch gets to live for a phase.
    const elsewhere = ["../../src/view/landing.ts", "../../src/view/starmap.ts"]
      .map((p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"))
      .join("\n");
    const orphans = (Object.keys(OVERLAY_STRIDE) as OverlayKind[])
      .filter((k) => !composerKinds.has(k) && !elsewhere.includes(`"${k}"`));
    expect(orphans, `${orphans.join(", ")}: in OVERLAY_STRIDE but no composer packs them`).toEqual([]);
  });
});

describe("the gate's structural maxima cover the warm-up too (P6-T07)", () => {
  // `runScene` drops the warm-up frames because their TIMINGS are a report on JIT rather than on
  // steady state. It used to drop their draw-call counts with them, and a draw-call count has no
  // warm-up: it is the same on the first frame as on the ten-thousandth, on every machine. So the
  // gate's one machine-independent check was blind to the first tenth of the camera path, and P3's
  // busiest batch frame lived there — which is how `perf/baseline.json` came to record 44 for a
  // scene that draws 45.
  //
  // **The peak is INJECTED rather than found on a scene**, and that is the point of doing it this
  // way. Whether some real scene happens to peak inside its own warm-up is a fact about the camera
  // path and the balance table, and it moves: widening the path's yaw sweep in this same row made
  // the measured window revisit the configuration that produced P3's warm-up peak, so no gated
  // scene demonstrates the case today. A test resting on that would have passed while proving
  // nothing the moment either changed. A spike planted on a known frame index proves the contract
  // itself and keeps proving it.
  const SECONDS = 2;                       // 120 measured frames after a 12-frame warm-up
  const SPIKE = 1000;                      // far above anything a real frame draws

  class SpikingRenderer extends RecordingRenderer {
    seen = 0;
    constructor(readonly spikeAt: number) { super(); }
    override endFrame() {
      const stats = super.endFrame();
      if (this.seen++ === this.spikeAt) stats.drawCalls += SPIKE;
      return stats;
    }
  }

  function runWithSpikeOn(frame: number) {
    const renderer = new SpikingRenderer(frame);
    renderer.keepFrames = 1;
    return runScene("T0", SCENES.T0!, renderer, {
      seconds: SECONDS, targetFps: 60, now: () => performance.now(),
    });
  }

  it("counts a peak that lands on a warm-up frame", () => {
    const result = runWithSpikeOn(0);
    expect(
      result.maxDrawCalls,
      `a frame drawing ${SPIKE}+ calls went unreported. A batch count has no warm-up — dropping `
      + `those frames does not remove noise, it removes the start of the camera path from the only `
      + `check in this gate that is identical on every machine.`,
    ).toBeGreaterThan(SPIKE);
  });

  it("counts a peak that lands on a measured frame", () => {
    // The control. Without it, a harness that reported a constant would pass the case above.
    const warmup = Math.min(60, Math.floor((SECONDS * 60) / 10));
    expect(runWithSpikeOn(warmup + 5).maxDrawCalls).toBeGreaterThan(SPIKE);
  });

  it("reports a peak nowhere near the spike when nothing spikes", () => {
    // …and the third leg: a harness that simply always returned a huge number would pass both.
    expect(runWithSpikeOn(-1).maxDrawCalls).toBeLessThan(SPIKE);
  });
});

describe("the held build ghost is the game's ghost (P6-T07)", () => {
  it("re-decides its placement every frame, so both draw paths get measured", () => {
    // `Game.updateGhost` runs `pickGround` and `checkPlacement` on EVERY frame a ghost is up, and
    // the scene does the same. A ghost decided once in the constructor would draw the same shape
    // for 600 frames — and the two shapes are not the same cost: a valid footprint is one ring, an
    // invalid one is a dashed ring plus a cross (`overlays2d.ts`). Measuring only the cheap one is
    // the same flattering-scene mistake as measuring an unarmed bomb.
    const renderer = new RecordingRenderer();
    renderer.keepFrames = 1;
    const scene = new PerfScene(SCENES.P2!);
    scene.setup(renderer);
    const seen = new Set<number>();
    for (let f = 0; f < 300; f++) {
      scene.render(renderer, 0);
      const layer = renderer.lastFrame.overlays.find((o) => o.kind === "ghost");
      expect(layer, `frame ${f} drew no ghost layer`).toBeDefined();
      seen.add(layer!.data[4]!);            // `ghost` packs valid(0|1) at offset 4
    }
    expect(
      [...seen].sort(),
      "the ghost held one validity for the whole run, so only one of its two draw paths is gated",
    ).toEqual([0, 1]);
  });

  it("throws rather than pricing the fallback mesh for a type the engine does not define", () => {
    // Two silent failures in one: `checkPlacement` would answer about a building that does not
    // exist, and `meshIdForType` falls back to the worker block — so the layer the flag exists to
    // price would be priced against the wrong mesh, with every count still looking healthy.
    expect(() => new PerfScene({ ...SCENES.P2!, ghostBuilding: "nosuchbuilding" }))
      .toThrow(/not a building type the engine defines/);
  });
});

describe("the gate's camera path sweeps every yaw snap (P6-T07)", () => {
  // `run.mjs` fixes the gate at 10 s at 60 fps: 60 warm-up frames and 600 measured ones. The path
  // used to hold a yaw for SIX seconds, so a gated measurement looked from snaps 0 and 1 and never
  // from the other six — and the rig snaps yaw to eight compass directions (ADR-0010), so those six
  // are a third of the game's rotations, not an edge case.
  //
  // It hid a real bug for five phases. Neither renderer billboards the imposter quad — the composer
  // has to, and until P6-T07 it did not — so whether the LOD fallback was drawn at all was a function
  // of the active snap; at snaps 2 and 6 it projected to zero width, and at a fixed yaw it was
  // back-facing at five of the eight. Nothing in the gate could see any of that from two viewpoints.
  // The composer turns it in yaw now and it is built already leaning in pitch (ADR-0024), and this
  // path is what keeps both honest at every rotation rather than at two of them.
  const WARMUP = 60;
  const MEASURED = 600;

  it("visits all eight in the frames the gate actually measures", () => {
    const renderer = new RecordingRenderer();
    renderer.keepFrames = 1;
    const scene = new PerfScene(SCENES.T0!);
    scene.setup(renderer);
    // Rendered without ticking: the camera path is a function of the frame counter alone, and this
    // is a test of the path, not of the simulation under it.
    const seen = new Set<number>();
    for (let f = 0; f < WARMUP + MEASURED; f++) {
      scene.render(renderer, 0);
      if (f >= WARMUP) seen.add(scene.rig.yawIndex);
    }
    expect(
      [...seen].sort((a, b) => a - b),
      `a gate-length run looked from ${seen.size} of the rig's 8 yaw snaps. Everything whose cost or `
      + `visibility depends on the camera's rotation is ungated at the ones it missed.`,
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("the power grid is uploaded, and version-gated (P6-T07)", () => {
  // Third of the three version-gated uploads, and the only one no gate ever watched: the fog and
  // the terrain have had `fogUploads`/`terrainUploads` since Phase 1, and `setPower` had never been
  // called from a perf scene at all, because the grid comes up with a build ghost and no scene held
  // one. Both halves are asserted here — that it happens, and that it happens far less than once a
  // frame — because a `powerUploads` wired to a constant satisfies either one alone.
  const renderer = new RecordingRenderer();
  renderer.keepFrames = 1;
  const withGhost = runScene("P2", SCENES.P2!, renderer, {
    seconds: 2, targetFps: 60, now: () => performance.now(),
  });

  it("uploads the field at all on the scene that holds a ghost", () => {
    expect(
      withGhost.powerUploads,
      "P2 holds a build ghost for every frame of its run, so `setPower` is called with a real field "
      + "on every one of them — an upload count of zero means the grid never reached the renderer.",
    ).toBeGreaterThan(0);
  });

  it("uploads it far less often than once per frame", () => {
    expect(withGhost.powerUploads).toBeLessThan(withGhost.frames / 4);
  });

  it("does not upload it at all on a scene with no ghost", () => {
    const bare = new RecordingRenderer();
    bare.keepFrames = 1;
    const noGhost = runScene("T0", SCENES.T0!, bare, {
      seconds: 1, targetFps: 60, now: () => performance.now(),
    });
    expect(noGhost.powerUploads, "the grid is a placement cue; nothing else should raise it").toBe(0);
  });
});
