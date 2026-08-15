// P1-T07 — tier detection, measured correction, and the budgets themselves (ADR-0006, PRD §6.2).

import { describe, expect, it } from "vitest";
import {
  CORRECTION_WINDOW_MS, TIERS, TIER_ORDER, TierMonitor, type DetectionInputs, detectTier, percentile,
} from "../../src/view/renderer/tiers.js";

const CAPABLE: DetectionInputs = {
  rendererString: "ANGLE (NVIDIA GeForce RTX 3060)",
  hardwareConcurrency: 16,
  deviceMemory: 16,
  hasWebGL2: true,
};

describe("tier table", () => {
  it("matches PRD §6.2's budgets", () => {
    expect(TIERS.T0.frameBudgetMs).toBe(33);
    for (const tier of ["T1", "T2", "T3"] as const) expect(TIERS[tier].frameBudgetMs).toBe(16.6);
  });

  it("spends T0's budget on fragments, not on triangles", () => {
    // The CPU-only cost model inverts the usual one (ADR-0006): fill rate is the enemy. So T0 must
    // render fewer pixels and must not draw a terrain silhouette against the sky.
    expect(TIERS.T0.renderScale).toBeLessThan(1);
    expect(TIERS.T0.terrain).toBe("flat");
    expect(TIERS.T0.shadows).toBe("none");
    expect(TIERS.T0.antialias).toBe(false);
  });

  it("gives every tier an apron past the map edge", () => {
    // The map has to stop somewhere, and where it stops must not read as a rendering failure. Every
    // tier gets a border; richer tiers get a wider one because they can see further.
    for (const tier of TIER_ORDER) {
      expect(TIERS[tier].apron, `${tier} has no apron`).toBeGreaterThan(0);
    }
    for (let i = 1; i < TIER_ORDER.length; i++) {
      expect(TIERS[TIER_ORDER[i]!].apron).toBeGreaterThanOrEqual(TIERS[TIER_ORDER[i - 1]!].apron);
    }
    // Wide enough to fill the view at the tier's own draw distance.
    for (const tier of TIER_ORDER) {
      expect(TIERS[tier].apron).toBeGreaterThan(TIERS[tier].lodDistance * 0.5);
    }
  });

  it("keeps LOD and cull distances monotonic across tiers", () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const lower = TIERS[TIER_ORDER[i - 1]!];
      const higher = TIERS[TIER_ORDER[i]!];
      expect(higher.lodDistance).toBeGreaterThanOrEqual(lower.lodDistance);
      expect(higher.cullDistance).toBeGreaterThanOrEqual(lower.cullDistance);
    }
  });

  it("only draws shadow maps at T3", () => {
    expect(TIERS.T3.shadows).toBe("map");
    for (const tier of ["T0", "T1", "T2"] as const) expect(TIERS[tier].shadows).not.toBe("map");
  });
});

describe("detectTier", () => {
  it("picks T0 for every software rasteriser we know by name", () => {
    for (const name of [
      "SwiftShader", "Google SwiftShader", "llvmpipe (LLVM 15.0.7, 256 bits)",
      "Mesa OffScreen", "Microsoft Basic Render Driver", "Software Renderer",
    ]) {
      expect(detectTier({ ...CAPABLE, rendererString: name }), `${name} should select T0`).toBe("T0");
    }
  });

  it("picks T0 when WebGL2 is missing entirely", () => {
    expect(detectTier({ ...CAPABLE, hasWebGL2: false })).toBe("T0");
  });

  it("picks T0 on a machine too small to carry anything else", () => {
    expect(detectTier({ ...CAPABLE, hardwareConcurrency: 2, rendererString: null })).toBe("T0");
    expect(detectTier({ ...CAPABLE, deviceMemory: 2, rendererString: null })).toBe("T0");
  });

  it("is conservative about an unknown machine", () => {
    // Being pleasantly surprised by a tier bump beats a first impression at 8 fps.
    const unknown = detectTier({ rendererString: null, hardwareConcurrency: 4, deviceMemory: null, hasWebGL2: true });
    expect(TIER_ORDER.indexOf(unknown)).toBeLessThanOrEqual(TIER_ORDER.indexOf("T2"));
  });

  it("gives a real discrete GPU the top tier", () => {
    expect(detectTier(CAPABLE)).toBe("T3");
  });

  it("does not give integrated graphics the top tier however many cores it has", () => {
    expect(detectTier({ ...CAPABLE, rendererString: "ANGLE (Intel(R) Iris(R) Xe Graphics)" })).toBe("T2");
  });
});

describe("TierMonitor", () => {
  function feed(monitor: TierMonitor, frameMs: number, ms: number) {
    let dropped = null;
    for (let t = 0; t < ms; t += frameMs) {
      const result = monitor.sample(frameMs);
      if (result.dropped) dropped = result;
    }
    return dropped;
  }

  it("drops one tier after three consecutive seconds over budget, and says so", () => {
    const monitor = new TierMonitor("T2");
    const dropped = feed(monitor, 40, CORRECTION_WINDOW_MS + 500);   // 40 ms frames against a 16.6 ms budget
    expect(dropped, "a machine missing the budget for 3 s should drop a tier").not.toBeNull();
    expect(monitor.tier).toBe("T1");
    expect(dropped!.notice).toContain(TIERS.T1.label);
  });

  it("does not drop on a brief hitch", () => {
    // A load hitch or one long GC must not permanently downgrade the player's graphics.
    const monitor = new TierMonitor("T2");
    expect(feed(monitor, 40, 800)).toBeNull();
    expect(feed(monitor, 12, 4000)).toBeNull();
    expect(monitor.tier).toBe("T2");
  });

  it("drops only one tier at a time", () => {
    const monitor = new TierMonitor("T3");
    feed(monitor, 90, CORRECTION_WINDOW_MS + 500);
    expect(monitor.tier).toBe("T2");
  });

  it("never up-tiers on its own, however fast the frames get", () => {
    // Raising a tier behind the player's back turns a stable 30 fps into an oscillation.
    const monitor = new TierMonitor("T0");
    feed(monitor, 2, 20_000);
    expect(monitor.tier).toBe("T0");
  });

  it("stops trying once it is already at T0", () => {
    const monitor = new TierMonitor("T0");
    const dropped = feed(monitor, 200, 20_000);
    expect(dropped, "there is no tier below T0; firing a notice the player cannot act on is noise").toBeNull();
    expect(monitor.tier).toBe("T0");
  });

  it("a manual override wins and switches the monitor off", () => {
    const monitor = new TierMonitor("T2");
    monitor.setManual("T3");
    expect(monitor.tier).toBe("T3");
    expect(feed(monitor, 200, 20_000)).toBeNull();
    expect(monitor.tier, "a player's explicit choice must not be overridden by measurement").toBe("T3");
  });

  it("judges on the 95th percentile, not the mean", () => {
    // A mean that looks fine while one frame in twenty takes 60 ms is exactly the "feels choppy but
    // the counter says 60" complaint. p95 sees it.
    const monitor = new TierMonitor("T2");
    let dropped = null;
    for (let i = 0; i < 400; i++) {
      const frame = i % 4 === 0 ? 60 : 8;    // mean ≈ 21 ms, p95 = 60 ms
      const result = monitor.sample(frame);
      if (result.dropped) dropped = result;
    }
    expect(dropped).not.toBeNull();
  });
});

describe("percentile", () => {
  it("returns the value at or above the requested fraction", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 1)).toBe(100);
  });

  it("handles an empty sample without throwing", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe("detectTier disagrees with itself across browsers (N-04, P7-T01)", () => {
  // **A measured cross-browser defect, pinned here rather than fixed, and the reason is in the
  // source it measures.**
  //
  // `navigator.deviceMemory` is a Chromium-only API. `src/app/renderer-factory.ts` reads it and
  // passes `null` where it does not exist, and `DetectionInputs` already says so in a comment —
  // "or null where it is not exposed (Firefox, Safari)". What nothing said, and nothing tested, is
  // what that `null` then DOES: `detectTier` substitutes `?? 4`, so on two of the four browsers
  // N-04 promises, the same physical machine is described differently and gets a different tier.
  //
  // It cuts both ways and only one half self-heals:
  //
  //   • **T3 is unreachable in Firefox and Safari.** Its gate is `cores >= 12 && memory >= 8`, and
  //     `memory` is a hard-coded 4 there, so no machine can pass it. `TierMonitor` never up-tiers
  //     by design ("raising one behind their back turns a stable 30 fps into an oscillation"), so
  //     nothing ever corrects this. A player on a 16-core discrete-GPU machine gets Standard in
  //     Firefox and High in Chrome, permanently, unless they find the Settings picker.
  //
  //   • **The low-memory downgrade never fires there either**, and that is the dangerous half: a
  //     2 GB machine is sent to T0 in Chrome and to T2 in Firefox. This one IS eventually corrected,
  //     because `TierMonitor` drops a tier after three seconds over budget — but the player pays
  //     those seconds at the worst possible moment, the first impression the guess exists to protect.
  //
  // **Not fixed here on purpose.** Every available fix raises a tier on a browser that cannot say
  // how much memory it has, and this file's own header forbids exactly that: "We never silently
  // up-tier." Choosing to guess higher for two of four browsers is a perf decision with an owner
  // and an ADR-0006 shape, not a test-row decision. So it is measured, stated, and made red if it
  // moves.
  //
  // Mutation: 12 fired at `detectTier`, 10 caught by this block. The two survivors are recorded
  // rather than counted, because one of them is a finding about the source:
  //
  //   • Removing the `hasWebGL2` guard survives HERE and is caught by "picks T0 when WebGL2 is
  //     missing entirely" above. Every case in this block sets `hasWebGL2: true`, so it makes no
  //     claim about that branch and should not.
  //   • Deleting `memory >= 8` from `if (cores >= 8 && memory >= 8) return "T2"` survives the whole
  //     file, and no test can catch it: **that condition cannot change an answer.** The next line
  //     is `if (cores >= 4) return "T2"`, so everything the stricter line would have returned T2
  //     for is returned T2 one line later regardless of memory. It is an equivalent mutant, which
  //     means the line reads as a memory rule and is not one. (A side effect worth knowing: T1 is
  //     reachable only at exactly 3 cores.)

  const CAPABLE_GPU = "ANGLE (NVIDIA GeForce RTX 4070)";

  it("cannot reach T3 at all without deviceMemory, however capable the machine", () => {
    const machine = { rendererString: CAPABLE_GPU, hardwareConcurrency: 16, hasWebGL2: true };
    expect(detectTier({ ...machine, deviceMemory: 8 }), "Chrome/Edge on this machine").toBe("T3");
    expect(
      detectTier({ ...machine, deviceMemory: null }),
      "the same machine in Firefox/Safari — T3's gate needs `memory >= 8` and `null` becomes 4",
    ).toBe("T2");
  });

  it("loses the low-memory downgrade, which is the half that costs a first impression", () => {
    const small = { rendererString: CAPABLE_GPU, hardwareConcurrency: 8, hasWebGL2: true };
    expect(detectTier({ ...small, deviceMemory: 2 }), "Chrome/Edge sees 2 GB and picks T0").toBe("T0");
    expect(
      detectTier({ ...small, deviceMemory: null }),
      "Firefox/Safari cannot see the 2 GB, so the `memory <= 2` guard never fires",
    ).toBe("T2");
  });

  it("disagrees on 22 of 60 plausible machines, and every disagreement has this one cause", () => {
    // Derived, not pasted: the sweep is here so the number can be re-checked, and so that changing
    // the heuristic makes this red instead of quietly changing what two of four browsers get.
    // `deviceMemory` is quantised by its spec and capped at 8, so these are the values that occur.
    const GPUS = ["NVIDIA GeForce RTX 4070", "AMD Radeon RX 7800", "Apple M2", "Intel Iris Xe"];
    const CORES = [2, 4, 8, 12, 16];
    const MEMORY = [2, 4, 8];

    const disagreements: string[] = [];
    let total = 0;
    for (const rendererString of GPUS) {
      for (const hardwareConcurrency of CORES) {
        for (const deviceMemory of MEMORY) {
          total++;
          const base = { rendererString, hardwareConcurrency, hasWebGL2: true };
          const chromium = detectTier({ ...base, deviceMemory });
          const elsewhere = detectTier({ ...base, deviceMemory: null });
          if (chromium !== elsewhere) {
            disagreements.push(`${rendererString} ${hardwareConcurrency}c/${deviceMemory}GB: chromium=${chromium} firefox+safari=${elsewhere}`);
          }
        }
      }
    }

    expect(total).toBe(60);
    expect(
      disagreements.length,
      `the browser-dependent tier split moved. It was 22 of 60; it is now ${disagreements.length}:\n`
      + disagreements.map((d) => `  • ${d}`).join("\n")
      + `\nIf this changed because detectTier changed, say what Firefox and Safari now get and why.`,
    ).toBe(22);

    // The shape matters as much as the count: no machine in the sweep reaches T3 without
    // deviceMemory, so the top tier is Chromium-only by construction rather than by chance.
    const reachableElsewhere = new Set(
      GPUS.flatMap((rendererString) =>
        CORES.map((hardwareConcurrency) =>
          detectTier({ rendererString, hardwareConcurrency, deviceMemory: null, hasWebGL2: true }),
        ),
      ),
    );
    expect([...reachableElsewhere].sort(), "T3 must stay unreachable-without-deviceMemory, or this row is stale").toEqual(["T0", "T2"]);
  });
});
