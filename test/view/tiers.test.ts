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
