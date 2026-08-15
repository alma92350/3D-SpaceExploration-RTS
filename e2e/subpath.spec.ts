// The built site works when served from a SUBPATH, not just from the root.
//
// GitHub Pages serves a project site at `/<repo>/`, and the failure mode is silent in every other
// test we have: `npm run preview` serves at `/`, so absolute `/assets/...` URLs resolve fine
// locally and 404 only once deployed. The bug would be a blank page on the public URL and a
// perfectly green CI — which is the exact shape of failure this project keeps finding.
//
// So this serves `dist/` from a nested path with a plain static server and asserts the game boots
// there. It uses its own server rather than the shared `webServer` precisely because the point is
// to test a different path prefix than everything else uses.

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const PREFIX = "/3D-SpaceExploration-RTS";

// An EPHEMERAL port, not a fixed one, and the browser matrix is what made that necessary (P7-T01).
// With one project this file bound 4199, released it, and nobody noticed. With three projects the
// same file runs three times in one process, and `server.close()` waits for keep-alive sockets the
// previous browser left open — so the next project's `beforeAll` can land on a port that is still
// bound and fail with EADDRINUSE. That failure would look like a cross-browser bug in the built
// site, which is precisely the wrong conclusion. Asking the OS for a free port removes the class.
let port = 0;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
};

let server: Server;

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (!url.startsWith(PREFIX)) {
      res.writeHead(404).end("outside the site prefix");
      return;
    }
    let rel = url.slice(PREFIX.length) || "/";
    if (rel === "/" || rel === "") rel = "/index.html";
    // Refuse to serve outside dist/, exactly as a real host would.
    const path = join(DIST, normalize(rel));
    if (!path.startsWith(DIST)) {
      res.writeHead(403).end("nope");
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the built site boots when served from a subpath, as GitHub Pages serves it", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
  const failed: string[] = [];
  page.on("requestfailed", (r) => failed.push(`${r.url()} — ${r.failure()?.errorText ?? "failed"}`));
  page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.url()} — HTTP ${r.status()}`); });

  await page.goto(`http://127.0.0.1:${port}${PREFIX}/`);
  await page.waitForFunction(() => (window as unknown as { __odyssey?: unknown }).__odyssey !== undefined, null, { timeout: 30_000 });
  await page.waitForFunction(
    () => (window as unknown as { __odyssey: { bridge: { snapshot: { tick: number } } } }).__odyssey.bridge.snapshot.tick > 3,
    null,
    { timeout: 30_000 },
  );

  expect(failed, `assets failed to load under ${PREFIX}/:\n${failed.join("\n")}`).toEqual([]);
  expect(errors, `console errors under ${PREFIX}/:\n${errors.join("\n")}`).toEqual([]);
});

test("no built asset URL is rooted at /, which would 404 under a subpath", async () => {
  // A cheap belt to the braces above: catch the regression in the HTML itself, with a message that
  // names the cause, rather than only as a mysteriously blank deployed page.
  const html = await readFile(join(DIST, "index.html"), "utf8");
  const rooted = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]!);
  expect(rooted, `these would 404 under a subpath — is vite.config.ts's \`base\` still "./"?`).toEqual([]);
});
