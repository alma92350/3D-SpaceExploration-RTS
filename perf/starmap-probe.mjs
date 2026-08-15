#!/usr/bin/env node
// P4-T02 / Q-03 — the starmap probe. NOT part of the perf gate; `perf/run.mjs` never loads it.
//
// The question is "true 3D scene or 2.5D diagram", and TASKS.md demands it be answered with a
// measurement rather than a preference. This script takes the four measurements the answer turns
// on, against the real engine data, the real Renderer port and the real camera rig:
//
//   1. CONTENT — what actually has to be on screen: the roster, the per-world channels
//      `galaxyStatus` reports, and the coordinate fields the engine gives each world.
//   2. BATCHES — what each option costs in draw calls, submitted to the RecordingRenderer and
//      counted by `FrameStats`, against ADR-0014's derived ceiling recomputed from today's roster.
//   3. FIDELITY — how well each layout's on-screen distances agree with the ONE spatial quantity
//      the engine actually computes (`jumpCost`, a function of |Δx|). Kendall discordance over
//      every seat × every world pair, at each of the camera's 8 snapped yaws.
//   4. COLLISION — how often two worlds land within one marker radius of each other on screen.
//      Overlays go to a flat 2D canvas over the scene in BOTH renderers with no depth test, so a
//      collision is a marker a player cannot attribute to a world.
//
// Usage: node perf/starmap-probe.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;
/** A stance ring / alert marker is drawn at roughly this pixel radius by `overlays2d.ts`. */
const MARKER_PX = 28;

const server = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "warn" });
try {
  const engine = await server.ssrLoadModule("/src/engine/index.ts");
  const galaxyMod = await server.ssrLoadModule("/src/engine/engine/galaxy.js");
  const gen = await server.ssrLoadModule("/src/view/meshes/generators.ts");
  const port = await server.ssrLoadModule("/src/view/renderer/port.ts");
  const { RecordingRenderer } = await server.ssrLoadModule("/src/view/renderer/recording.ts");
  const { CameraRig, YAW_SNAP_COUNT } = await server.ssrLoadModule("/src/input/camera.ts");
  const { projectToScreen } = await server.ssrLoadModule("/src/input/picking.ts");

  const { PLANETS, UNITS } = engine;
  const { ODYSSEY_WORLDS, BACKGROUND_WORLDS, createGalaxy, galaxyStatus, jumpCost } = galaxyMod;

  const worlds = ODYSSEY_WORLDS.map((id) => PLANETS.find((p) => p.id === id));

  /* ---------- 1. CONTENT ---------- */

  console.log("\n=== 1. CONTENT — what has to be on screen ===\n");
  console.log(`ODYSSEY_WORLDS            ${ODYSSEY_WORLDS.length}   (${ODYSSEY_WORLDS.join(", ")})`);
  console.log(`BACKGROUND_WORLDS         ${BACKGROUND_WORLDS}   (live from turn one; the rest are dormant but still on the map)`);

  // Which coordinate fields does a world actually carry? This is the measurement the whole ADR
  // turns on, so it is read off the data rather than asserted.
  const coordKeys = ["x", "y", "z"];
  const present = coordKeys.filter((k) => worlds.every((w) => typeof w?.[k] === "number"));
  const partial = coordKeys.filter((k) => !present.includes(k) && worlds.some((w) => typeof w?.[k] === "number"));
  console.log(`coordinate fields on every world   [${present.join(", ") || "none"}]`);
  console.log(`coordinate fields on some worlds   [${partial.join(", ") || "none"}]`);
  const xs = worlds.map((w) => w.x);
  console.log(`x values                  ${xs.join(", ")}  (min ${Math.min(...xs)}, max ${Math.max(...xs)}, all distinct: ${new Set(xs).size === xs.length})`);

  const galaxy = createGalaxy({ seed: 20260815, startId: "helix" });
  const status = galaxyStatus(galaxy);
  const perWorld = Object.keys(status.worlds[0]);
  console.log(`galaxyStatus per-world channels    ${perWorld.length}: ${perWorld.join(", ")}`);
  console.log(`galaxyStatus galaxy-wide channels  ${Object.keys(status).filter((k) => k !== "worlds").join(", ")}`);
  const statuses = new Set(["seat", "colony", "contested", "pacified", "unexplored"]);
  console.log(`distinct world statuses   ${statuses.size} (${[...statuses].join(", ")})`);
  const factions = new Set(worlds.map((w) => w.faction));
  console.log(`distinct world factions   ${factions.size} (${[...factions].join(", ")})`);
  console.log(`lanes worst case          ${(ODYSSEY_WORLDS.length * (ODYSSEY_WORLDS.length - 1)) / 2} unordered pairs; a lane is {from,to,commodities,shipIds} — NO geometry, NO length, NO travel time`);

  /* ---------- 2. BATCHES ---------- */

  console.log("\n=== 2. BATCHES — draw calls per option ===\n");

  const meshes = gen.buildMeshes();
  const derivedCeiling = (() => {
    const buildingMeshes = new Set(Object.values(gen.BUILDING_FAMILY)).size;
    const unitMeshes = new Set(Object.keys(UNITS).map(gen.meshIdForType)).size;
    const depositMeshes = new Set(Object.values(gen.DEPOSIT_FAMILY)).size;
    return (buildingMeshes + unitMeshes) * 2 * 2 + depositMeshes + 1;
  })();
  console.log(`ADR-0014 derived ceiling, recomputed from today's roster: ${derivedCeiling}`);

  const { OWNER_PLAYER, OWNER_AI, OWNER_NEUTRAL, LOD_MESH, OVERLAY_STRIDE } = port;

  // Stand-in meshes. A batch key is (mesh, owner, LOD) — the geometry behind the id changes the
  // triangle count and nothing else — so borrowing registered ids measures the batch arithmetic
  // exactly while inventing no art. `command` stands in for a world body, `node` for a moon/marker.
  function frame(build) {
    const r = new RecordingRenderer();
    r.registerMeshes(meshes);
    r.resize(VIEWPORT_W, VIEWPORT_H, 1);
    const rig = new CameraRig({ mapWidth: 1200, mapHeight: 1200 });
    r.beginFrame(rig.update(VIEWPORT_W, VIEWPORT_H));
    build(r);
    return r.endFrame();
  }

  function instances(mesh, owner, n) {
    return {
      mesh, owner, lod: LOD_MESH, count: n,
      xyz: new Float32Array(n * 3), yaw: new Float32Array(n),
      scale: new Float32Array(n).fill(1), shade: new Float32Array(n).fill(1),
    };
  }
  function overlay(kind, n) {
    const stride = OVERLAY_STRIDE[kind];
    return { kind, count: n, stride, data: new Float32Array(n * stride) };
  }

  // Owner slots a world can take: the seat and colonies are the player's, AI-claimed and pacified
  // worlds are the AI's, unexplored/unclaimed are neutral. Three, and the port has exactly three.
  const OWNERS = [OWNER_PLAYER, OWNER_AI, OWNER_NEUTRAL];

  // Option A — a true 3D scene: worlds are bodies in a volume, one shared body mesh per owner.
  const a = frame((r) => {
    for (const o of OWNERS) r.drawInstances(instances("command", o, 4));      // world bodies
    r.drawOverlay(overlay("rally", 6));      // lanes: two endpoints each, the only line overlay
    r.drawOverlay(overlay("aura", 11));      // stance rings
    r.drawOverlay(overlay("status", 11));    // claim / faction glyph
    r.drawOverlay(overlay("waypoint", 3));   // alerts (rival gate, colony under attack)
    r.drawOverlay(overlay("selection", 1));  // the world under the cursor
  });

  // Option A' — the same scene with a per-status silhouette, the house rule ADR-0013/0015/0016
  // would otherwise apply: five statuses × three owners, minus the pairs that cannot co-occur.
  const aPrime = frame((r) => {
    const meshIds = ["command", "habitat", "civic", "fortress", "node"];   // stand-ins for 5 statuses
    let i = 0;
    for (const m of meshIds) {
      for (const o of OWNERS) { r.drawInstances(instances(m, o, 1)); i++; }
    }
    r.drawOverlay(overlay("rally", 6));
    r.drawOverlay(overlay("aura", 11));
    r.drawOverlay(overlay("status", 11));
    r.drawOverlay(overlay("waypoint", 3));
    r.drawOverlay(overlay("selection", 1));
  });

  // Option B — a 2.5D diagram: worlds are discs and glyphs on a flat plate. Same information, and
  // the bodies are still instanced meshes on a plane (a disc IS a mesh), so this is not "2D".
  const b = frame((r) => {
    for (const o of OWNERS) r.drawInstances(instances("node", o, 4));       // world discs on the plate
    r.drawOverlay(overlay("rally", 6));
    r.drawOverlay(overlay("aura", 11));
    r.drawOverlay(overlay("status", 11));
    r.drawOverlay(overlay("waypoint", 3));
    r.drawOverlay(overlay("selection", 1));
  });

  // The battlefield's own measured T0 frame, from `npm run perf` on this checkout. Quoted rather
  // than recomputed so the "starmap over the battlefield" sum is against the real gated number.
  const T0_DRAW_CALLS = 22, T0_TRIANGLES = 13086;

  const row = (name, s) => console.log(
    `${name.padEnd(34)} ${String(s.drawCalls).padStart(3)} draw calls   `
    + `${String(s.instances).padStart(3)} instances   ${String(s.overlayItems).padStart(3)} overlay items   `
    + `${String(s.triangles).padStart(5)} tris   headroom ${derivedCeiling - s.drawCalls}   `
    + `over the battlefield ${T0_DRAW_CALLS + s.drawCalls}/${derivedCeiling}`,
  );
  row("A  true 3D scene (1 body mesh)", a);
  row("A' true 3D + per-status meshes", aPrime);
  row("B  2.5D diagram (1 disc mesh)", b);
  console.log(`\nBattlefield T0 today (npm run perf): ${T0_DRAW_CALLS} draw calls, ${T0_TRIANGLES} triangles.`);
  console.log(`Canvas2D's cost is its painter sort, O(F log F) over every submitted face, so the`);
  console.log(`starmap's face count is what decides whether the fallback can draw it: ${a.triangles} vs ${T0_TRIANGLES}`);
  console.log(`= ${(a.triangles / T0_TRIANGLES * 100).toFixed(1)}% of a battlefield frame it already draws at T0.`);
  console.log(`\nNOTE: the port's InstanceBatch.scale is a single UNIFORM scale per instance, so a lane of`);
  console.log(`      arbitrary length cannot be an instanced mesh at all. Either one batch per lane`);
  console.log(`      (${(ODYSSEY_WORLDS.length * (ODYSSEY_WORLDS.length - 1)) / 2} worst case) or one 'rally'-shaped overlay layer for all of them. Both options above`);
  console.log(`      take the overlay, so the lane cost is identical and does not separate them.`);

  /* ---------- 3 & 4. FIDELITY and COLLISION ---------- */

  console.log("\n=== 3/4. FIDELITY and COLLISION — layouts under the project's own camera ===\n");

  const SPREAD = 60;   // world units per unit of planet x — sized so the roster fills the plate
  const n = worlds.length;
  const CENTRE = 1200;   // where the camera looks; every layout is centred here so no layout is
                         // handicapped by sitting off-axis in a perspective frustum.

  // Ground truth check: is |Δx| really the quantity a player ranks? `jumpCost` says so, but the
  // proxy is worth verifying against the function rather than against the comment above it.
  {
    const g = createGalaxy({ seed: 20260815, startId: "helix" });
    const from = g.activeId;
    const byCost = ODYSSEY_WORLDS.filter((id) => id !== from)
      .map((id) => ({ id, c: jumpCost(g, id), dx: Math.abs(planetXOf(id) - planetXOf(from)) }))
      .sort((p, q) => p.c - q.c);
    const monotone = byCost.every((e, i) => i === 0 || byCost[i - 1].dx <= e.dx);
    console.log(`jumpCost from ${from} is monotone in |Δx|: ${monotone}`);
    console.log(`  ${byCost.map((e) => `${e.id} ${e.c}cr@Δx${e.dx}`).join("  ")}\n`);
  }
  function planetXOf(id) { return PLANETS.find((pl) => pl.id === id)?.x ?? 0; }

  // A deterministic hash, so "a plausible 3D layout" is reproducible rather than a lucky draw.
  const h = (s) => { let v = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) v = Math.imul(v ^ s.charCodeAt(i), 16777619) >>> 0; return v / 4294967296; };

  /** Translate a layout so its bounding-box centre sits under the camera target. */
  function centre(pts) {
    const mid = (k) => (Math.min(...pts.map((q) => q[k])) + Math.max(...pts.map((q) => q[k]))) / 2;
    const cx = mid("x"), cy = mid("y"), cz = mid("z");
    return pts.map((q) => ({ id: q.id, x: q.x - cx + CENTRE, y: q.y - cy, z: q.z - cz + CENTRE }));
  }

  const layouts = {
    // The 2.5D diagram: x along one screen axis, a stagger on the other so markers do not stack,
    // everything on the plane. Authored for ONE orientation — a diagram does not orbit, the same
    // reason `ui/minimap.ts` stays north-up "regardless of camera yaw".
    diagram: centre(worlds.map((w, i) => ({ id: w.id, x: w.x * SPREAD, y: 0, z: (i % 3) * 130 - 130 }))),
    // The same plate with no stagger at all — the maximally faithful diagram, to price the stagger.
    "diagram-flat": centre(worlds.map((w) => ({ id: w.id, x: w.x * SPREAD, y: 0, z: 0 }))),
    // A "true 3D" galactic shell — the layout a 3D starmap is usually asked for. Ignores x.
    shell3d: centre(worlds.map((w) => {
      const t = h(w.id) * Math.PI * 2, u = h(w.id + ":u") * 2 - 1, rad = 380 + h(w.id + ":r") * 260;
      const s = Math.sqrt(1 - u * u);
      return { id: w.id, x: rad * s * Math.cos(t), y: rad * u, z: rad * s * Math.sin(t) };
    })),
    // The most faithful 3D option available: x IS one axis, y and z are decoration. If a 3D
    // starmap can be honest about jump cost at all, this is the layout that manages it.
    x3d: centre(worlds.map((w) => ({
      id: w.id, x: w.x * SPREAD,
      y: h(w.id + ":y") * 260, z: (h(w.id + ":z") * 2 - 1) * 260,
    }))),
  };

  const cost = (a, b) => Math.abs(a.x - b.x);
  const planetById = Object.fromEntries(worlds.map((w) => [w.id, w]));

  const rig = new CameraRig({ mapWidth: 2400, mapHeight: 2400 });
  rig.targetX = CENTRE; rig.targetY = CENTRE; rig.distance = 900;   // fully zoomed out, near top-down
  const p = { x: 0, y: 0, behind: false };

  function measure(layout, yawIndex) {
    rig.yawIndex = yawIndex;
    const cam = rig.update(VIEWPORT_W, VIEWPORT_H);
    const screen = layout.map((w) => {
      projectToScreen(cam, w.x, w.y, w.z, p);
      return { id: w.id, sx: p.x, sy: p.y, behind: p.behind };
    });
    const vis = screen.filter((s) => !s.behind);

    // Kendall discordance: over every seat, and every pair of destinations from it, how often does
    // the screen say "that one is nearer" while the engine charges more to jump there?
    let pairs = 0, discordant = 0;
    for (let s = 0; s < n; s++) {
      if (screen[s].behind) continue;
      for (let i = 0; i < n; i++) {
        if (i === s || screen[i].behind) continue;
        for (let j = i + 1; j < n; j++) {
          if (j === s || screen[j].behind) continue;
          const dc = cost(planetById[layout[i].id], planetById[layout[s].id])
                   - cost(planetById[layout[j].id], planetById[layout[s].id]);
          if (dc === 0) continue;
          const ds = Math.hypot(screen[i].sx - screen[s].sx, screen[i].sy - screen[s].sy)
                   - Math.hypot(screen[j].sx - screen[s].sx, screen[j].sy - screen[s].sy);
          pairs++;
          if (Math.sign(dc) !== Math.sign(ds)) discordant++;
        }
      }
    }

    const sxs = vis.map((s) => s.sx), sys = vis.map((s) => s.sy);
    const spread = vis.length < 2 ? 0
      : Math.min(Math.max(...sxs) - Math.min(...sxs), Math.max(...sys) - Math.min(...sys));

    let collide = 0;
    for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
      if (Math.hypot(vis[i].sx - vis[j].sx, vis[i].sy - vis[j].sy) < MARKER_PX * 2) collide++;
    }
    return { discord: pairs ? discordant / pairs : 0, spread, collide, offscreen: n - vis.length };
  }

  console.log("layout        yaw  discordant  narrow-axis px  marker collisions  behind camera");
  const summary = {};
  for (const [name, layout] of Object.entries(layouts)) {
    let worstDiscord = 0, bestDiscord = 1, worstCollide = 0, minSpread = Infinity, worstOff = 0;
    for (let yawIndex = 0; yawIndex < YAW_SNAP_COUNT; yawIndex++) {
      const m = measure(layout, yawIndex);
      console.log(
        `${name.padEnd(13)} ${String(yawIndex).padStart(3)}  ${(m.discord * 100).toFixed(1).padStart(9)}%  `
        + `${m.spread.toFixed(0).padStart(14)}  ${String(m.collide).padStart(17)}  ${String(m.offscreen).padStart(13)}`,
      );
      worstDiscord = Math.max(worstDiscord, m.discord);
      bestDiscord = Math.min(bestDiscord, m.discord);
      worstCollide = Math.max(worstCollide, m.collide);
      minSpread = Math.min(minSpread, m.spread);
      worstOff = Math.max(worstOff, m.offscreen);
    }
    summary[name] = { worstDiscord, bestDiscord, worstCollide, minSpread, worstOff };
    console.log("");
  }

  console.log("layout        authored-view  worst-view  narrowest px  worst collisions  worst behind");
  for (const [name, s] of Object.entries(summary)) {
    console.log(
      `${name.padEnd(13)} ${(s.bestDiscord * 100).toFixed(1).padStart(12)}%  ${(s.worstDiscord * 100).toFixed(1).padStart(9)}%  `
      + `${s.minSpread.toFixed(0).padStart(12)}  ${String(s.worstCollide).padStart(16)}  ${String(s.worstOff).padStart(12)}`,
    );
  }

  console.log("\nA DIAGRAM IS READ AT ITS AUTHORED VIEW ONLY — it does not orbit, exactly as `ui/minimap.ts`");
  console.log("stays north-up regardless of camera yaw. A 3D SCENE has to hold up at every view, so its");
  console.log("honest figure is the worst column and a diagram's is the authored one.\n");
  console.log("discordant = share of (seat, worldA, worldB) triples where the screen ranks the two");
  console.log("  destinations in the opposite order to what the engine charges to jump between them.");
  console.log("narrow-axis px = the shorter screen axis the roster occupies, of 1280x720.");
  console.log("collisions = world pairs whose markers overlap, which overlays CANNOT disambiguate:");
  console.log("  both renderers draw every overlay to a flat 2D canvas over the scene, no depth test.");
} finally {
  await server.close();
}
