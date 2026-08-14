// P0-T11 / P1-T22 — the app boots, draws, takes orders, and survives a browser with no WebGL.
//
// Everything here runs under a software rasteriser (see playwright.config.ts), which is persona
// P2's actual machine. A smoke test on a GPU proves the app works somewhere we were never worried
// about.

import { expect, test } from "@playwright/test";

/** Fail the test on any console error — a clean console is part of the definition of booting. */
function watchConsole(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(`uncaught: ${err.message}`));
  return errors;
}

test("boots to a playable frame with a clean console", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");

  await expect(page.locator("#scene")).toBeVisible();
  await expect(page.locator("#boot")).toHaveCount(0);

  // Not just "a canvas exists" — the loop must actually be advancing the simulation.
  await page.waitForFunction(() => (window as any).__odyssey?.bridge?.snapshot?.tick > 5, null, { timeout: 30_000 });

  const state = await page.evaluate(() => {
    const game = (window as any).__odyssey;
    return {
      renderer: game.bridge ? "ready" : "missing",
      tick: game.bridge.snapshot.tick,
      entities: game.bridge.snapshot.entities.count,
      world: game.bridge.worldId,
    };
  });
  expect(state.tick).toBeGreaterThan(5);
  expect(state.entities, "the opening should have something on screen").toBeGreaterThan(0);
  expect(errors, `console errors during boot:\n${errors.join("\n")}`).toEqual([]);
});

test("shows the Odyssey opening and deploys on click", async ({ page }) => {
  // S1's first step, end to end through the real UI: select the colony ship, press the button the
  // HUD offers, get a Command Center. This is the one path a first-time player MUST find (S6).
  const errors = watchConsole(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__odyssey?.bridge?.snapshot?.tick > 2, null, { timeout: 30_000 });

  await page.evaluate(() => {
    const game = (window as any).__odyssey;
    const ship = [...game.bridge.state.units.values()].find((u: any) => u.owner === "player" && u.type === "colonyship");
    game.bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  });

  const deploy = page.getByRole("button", { name: /deploy/i });
  await expect(deploy, "a selected colony ship must offer Deploy without documentation").toBeVisible({ timeout: 15_000 });
  await deploy.click();

  await page.waitForFunction(() => {
    const game = (window as any).__odyssey;
    return [...game.bridge.state.buildings.values()].some((b: any) => b.owner === "player" && b.type === "command");
  }, null, { timeout: 15_000 });

  expect(errors, `console errors while deploying:\n${errors.join("\n")}`).toEqual([]);
});

test("draws the base in the player's colour, not black", async ({ page }) => {
  // Narrow, deliberately un-golden: this is not a pixel-diff (ADR-0009 rules those out), it is a
  // guard against the scene going dark. It exists because a real bug did exactly that — the
  // per-instance shade attribute was declared as a plain `BufferAttribute`, so WebGL read it per
  // VERTEX, ran off the end of the buffer and shaded every face past index 63 to zero. Every
  // structural test stayed green: the draw calls, the instance counts, the budgets and the whole
  // conformance suite are blind to a model that renders solid black.
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__odyssey?.bridge?.snapshot?.tick > 2, null, { timeout: 30_000 });

  await page.evaluate(() => {
    const game = (window as any).__odyssey;
    const ship = [...game.bridge.state.units.values()].find((u: any) => u.owner === "player" && u.type === "colonyship");
    game.bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
    game.bridge.enqueue({ kind: "deploy" });
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const game = (window as any).__odyssey;
    const cc = [...game.bridge.state.buildings.values()].find((b: any) => b.owner === "player" && b.type === "command");
    game.camera.focusOn(cc.x, cc.y);
    game.camera.distance = 130;
  });
  await page.waitForTimeout(600);

  const shot = await page.locator("#viewport").screenshot();
  const blueish = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    // The player's owner colour is #4fd1ff: blue clearly ahead of red, and bright.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 2]! > 140 && data[i + 2]! - data[i]! > 40) n++;
    }
    return n;
  }, Array.from(shot));

  expect(blueish, "the Command Center filling the view rendered no player-coloured pixels").toBeGreaterThan(3000);
});

test("issues a move order from a right-click on the ground", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__odyssey?.bridge?.snapshot?.tick > 2, null, { timeout: 30_000 });

  await page.evaluate(() => {
    const game = (window as any).__odyssey;
    const ship = [...game.bridge.state.units.values()].find((u: any) => u.owner === "player" && u.type === "colonyship");
    game.bridge.enqueue({ kind: "select", ids: [ship.id], additive: false });
  });

  const before = await page.evaluate(() => {
    const game = (window as any).__odyssey;
    const u = [...game.bridge.state.units.values()].find((x: any) => x.owner === "player" && x.type === "colonyship");
    return { x: u.x, y: u.y };
  });

  await page.locator("#viewport").click({ button: "right", position: { x: 900, y: 300 } });
  await page.waitForFunction((start) => {
    const game = (window as any).__odyssey;
    const u = [...game.bridge.state.units.values()].find((x: any) => x.owner === "player" && x.type === "colonyship");
    return !!u && Math.hypot(u.x - start.x, u.y - start.y) > 10;
  }, before, { timeout: 20_000 });
});

test("falls back to the Canvas2D renderer when WebGL is unavailable (P1-T22)", async ({ page }) => {
  const errors = watchConsole(page);
  // Stub context creation to fail exactly the way a locked-down enterprise build does.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (typeof type === "string" && type.startsWith("webgl")) return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  await page.goto("/");
  await expect(page.locator("#boot")).toHaveCount(0, { timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__odyssey?.bridge?.snapshot?.tick > 5, null, { timeout: 30_000 });

  const notice = page.locator("#fallback-notice");
  await expect(notice, "the player should be told why the view looks plainer").toBeVisible();
  await expect(notice).toContainText(/WebGL/i);

  // A playable frame, not just a boot: the fallback must be drawing the world.
  const drew = await page.evaluate(() => {
    const canvas = document.getElementById("overlay") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! > 60) lit++;
    return lit;
  });
  expect(drew, "the Canvas2D fallback rendered nothing").toBeGreaterThan(1000);
  expect(errors, `console errors on the no-WebGL path:\n${errors.join("\n")}`).toEqual([]);
});
