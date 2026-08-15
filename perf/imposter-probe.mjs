#!/usr/bin/env node
// P7-T02 — the imposter probe. NOT part of the perf gate; `perf/run.mjs` never loads it.
//
// P6-T07 measured the LOD imposter's shape and left it, with numbers: "the quad covers 0.73× to
// 10.35× the mesh's screen area". That measurement was a paragraph in a comment and not a program,
// so the row that had to act on it could not re-run it, could not check a candidate against it, and
// could not report a before and an after in the same units. This is that program.
//
// The method is P6-T07's, stated exactly: project **every vertex of each mesh** and **every corner
// of the imposter quad that replaces it** through the same camera, using the same `place`/`yaw`
// transform both renderers apply, onto the raster the tier actually rasterises (T0 renders at
// 0.75×, so 1280×720 becomes 960×540), and compare screen-space bounding boxes.
//
// Three things it does that a paragraph could not:
//
//   1. **It samples only what the game can draw.** An imposter exists between `lodDistance` and
//      `cullDistance`, and the rig's pitch is a pure function of zoom — so at the closest zooms the
//      LOD distance is off the top of the screen entirely and nothing there is ever an imposter.
//      Every (zoom, yaw, range) sample is projected first and dropped unless it lands inside the
//      viewport, which is what makes the reported extremes real rather than hypothetical.
//   2. **It judges against the mesh's facing-averaged box.** The imposter deliberately does not turn
//      with the entity (`scene.ts`: "imposters that never rotate against each other"), so comparing
//      it against one arbitrary facing would charge it for a difference it is designed to have. The
//      target is the geometric mean over eight facings; the per-facing spread is reported beside it.
//   3. **It prices candidates, not just the status quo.** `--candidates` re-measures the same roster
//      under the shapes that were considered, so the choice in ADR-0024 can be checked rather than
//      believed.
//
// Usage:
//   node perf/imposter-probe.mjs                 -- the roster, per type, worst cases named
//   node perf/imposter-probe.mjs --candidates    -- every shape considered, side by side
//   node perf/imposter-probe.mjs --tier=T2       -- any tier (default T0, the budget's own target)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const TIER_NAME = String(args.get("tier") ?? "T0");
const SHOW_CANDIDATES = args.get("candidates") === true;

/** The CSS viewport the game is measured at. The tier's `renderScale` is applied to it below. */
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

/** Eight facings — the entity can point anywhere, and the imposter's own yaw never moves with it. */
const FACINGS = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);

const server = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "warn" });
try {
  const engine = await server.ssrLoadModule("/src/engine/index.ts");
  const gen = await server.ssrLoadModule("/src/view/meshes/generators.ts");
  const { TIERS } = await server.ssrLoadModule("/src/view/renderer/tiers.ts");
  const { CameraRig, MIN_DISTANCE, MAX_DISTANCE, PITCH_NEAR, PITCH_FAR } =
    await server.ssrLoadModule("/src/input/camera.ts");
  const { projectToScreen } = await server.ssrLoadModule("/src/input/picking.ts");

  const { buildMeshes, meshIdForType, IMPOSTER_SIZE, IMPOSTER_LEAN } = gen;
  const tier = TIERS[TIER_NAME];
  if (!tier) throw new Error(`no such tier: ${TIER_NAME}`);

  const meshes = new Map(buildMeshes().map((m) => [m.id, m]));
  const quadToday = meshes.get("imposter");

  // The roster as the SNAPSHOT reports it: every engine type, with the radius `snapshot.ts` puts on
  // the wire (`UNITS[type].radius` / `BUILDINGS[type].radius`) and the mesh `scene.ts` draws for it.
  const roster = [];
  for (const [type, def] of Object.entries(engine.UNITS)) {
    roster.push({ type, radius: def.radius ?? 6, mesh: meshIdForType(type) });
  }
  for (const [type, def] of Object.entries(engine.BUILDINGS)) {
    roster.push({ type, radius: def.radius ?? 16, mesh: meshIdForType(type) });
  }

  const rasterW = Math.round(VIEWPORT_W * tier.renderScale);
  const rasterH = Math.round(VIEWPORT_H * tier.renderScale);
  // Flat ground: this is a measurement of geometry, and terrain under the sample point would add a
  // height the mesh and the quad share anyway.
  const field = { width: 12000, height: 12000, cols: 300, rows: 300, cell: 40, type: new Uint8Array(300 * 300) };

  const out = { x: 0, y: 0, behind: false };

  /** A model-space point placed into the world, rotated about Y exactly as both renderers do it. */
  function place(px, py, pz, yaw, scale, ox, oz) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const x = px * scale;
    const z = pz * scale;
    return { x: ox + x * c + z * s, y: py * scale, z: oz - x * s + z * c };
  }

  function bbox(positions, yaw, scale, ox, oz, camera) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const p = place(positions[i], positions[i + 1], positions[i + 2], yaw, scale, ox, oz);
      projectToScreen(camera, p.x, p.y, p.z, out);
      if (out.x < x0) x0 = out.x;
      if (out.x > x1) x1 = out.x;
      if (out.y < y0) y0 = out.y;
      if (out.y > y1) y1 = out.y;
    }
    return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  // --- 1. Where an imposter can actually be ------------------------------------------------------

  const samples = [];
  for (let zoom = MIN_DISTANCE; zoom <= MAX_DISTANCE; zoom += 45) {
    for (let yawIndex = 0; yawIndex < 8; yawIndex++) {
      const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
      rig.yawIndex = yawIndex;
      rig.distance = zoom;
      rig.focusOn(field.width / 2, field.height / 2);
      const camera = rig.update(rasterW, rasterH);
      for (let range = tier.lodDistance; range <= tier.cullDistance; range += 60) {
        // Placed along the view direction from the EYE, so `range` is the distance `compose`
        // actually tests against `lodDistance` — rotating the rig around a fixed point would move
        // that distance by hundreds of units and change which side of the switch the sample is on.
        const ox = camera.eyeX + Math.sin(rig.yaw) * range;
        const oz = camera.eyeZ + Math.cos(rig.yaw) * range;
        projectToScreen(camera, ox, 0, oz, out);
        if (out.behind || out.x < 0 || out.x > rasterW || out.y < 0 || out.y > rasterH) continue;
        samples.push({ camera, pitch: rig.pitch, zoom, range, ox, oz });
      }
    }
  }

  const pitches = samples.map((s) => s.pitch);
  console.log(`imposter probe — tier ${TIER_NAME}, raster ${rasterW}x${rasterH}, `
    + `LOD ${tier.lodDistance} → cull ${tier.cullDistance}`);
  console.log(`  ${samples.length} on-screen (zoom, yaw, range) samples x ${roster.length} types `
    + `x ${FACINGS.length} facings`);
  console.log(`  camera pitch over those samples ${deg(Math.min(...pitches))}–${deg(Math.max(...pitches))}°, `
    + `rig ramp ${deg(PITCH_NEAR)}–${deg(PITCH_FAR)}°, lean ${deg(IMPOSTER_LEAN)}°\n`);

  // --- 2. The target: what the mesh itself covers ------------------------------------------------

  // Precomputed once and shared by every candidate, so the comparison cannot drift between them.
  const target = new Map();
  for (const id of new Set(roster.map((r) => r.mesh))) {
    const mesh = meshes.get(id);
    target.set(id, samples.map((s) => {
      const boxes = FACINGS.map((f) => bbox(mesh.positions, f, 1, s.ox, s.oz, s.camera));
      let lw = 0, lh = 0;
      for (const b of boxes) { lw += Math.log(b.w); lh += Math.log(b.h); }
      return {
        w: Math.exp(lw / boxes.length), h: Math.exp(lh / boxes.length),
        cx: boxes[0].cx, cy: boxes[0].cy,
        spread: Math.max(...boxes.map((b) => b.w)) / Math.min(...boxes.map((b) => b.w)),
      };
    }));
  }

  // --- 3. The candidates ------------------------------------------------------------------------

  /** A quad 1 wide and `aspect` tall, standing on the ground, leaning `lean` rad away from the eye. */
  function quad(aspect, lean) {
    const uy = aspect * Math.cos(lean);
    const uz = -aspect * Math.sin(lean);
    const c = [[-0.5, 0, 0], [0.5, 0, 0], [0.5, uy, uz], [-0.5, uy, uz]];
    return new Float32Array([...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]]);
  }

  const candidates = [
    { label: "P6-T07's measurement: engineRadius x 2.2, square, upright",
      positions: quad(1, 0), size: (r) => r.radius * 2.2 },
    { label: "the mesh's widest diameter, square, upright",
      positions: quad(1, 0), size: (r, m) => m.radius * 2 },
    { label: "the mesh's mean footprint width, square, upright",
      positions: quad(1, 0), size: (r, m) => IMPOSTER_SIZE[m.id] },
    { label: "SHIPPED: mean footprint width, square, leaning at the rig's mid-pitch",
      positions: quadToday.positions, size: (r, m) => IMPOSTER_SIZE[m.id] },
    { label: "…leaning all the way to the far pitch (74.5°)",
      positions: quad(1, PITCH_FAR), size: (r, m) => IMPOSTER_SIZE[m.id] },
    { label: "…leaning, but 0.85 as tall as it is wide",
      positions: quad(0.85, IMPOSTER_LEAN), size: (r, m) => IMPOSTER_SIZE[m.id] },
    { label: "…leaning, but 1.15 as tall as it is wide",
      positions: quad(1.15, IMPOSTER_LEAN), size: (r, m) => IMPOSTER_SIZE[m.id] },
  ];

  function measure(candidate) {
    const widths = [], heights = [], areas = [], offsets = [];
    const perType = new Map();
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si];
      for (const r of roster) {
        const mesh = meshes.get(r.mesh);
        const q = bbox(candidate.positions, s.camera.yaw + Math.PI, candidate.size(r, mesh), s.ox, s.oz, s.camera);
        const t = target.get(r.mesh)[si];
        const w = q.w / t.w;
        const h = q.h / t.h;
        widths.push(w); heights.push(h); areas.push(w * h);
        offsets.push(Math.hypot(q.cx - t.cx, q.cy - t.cy) / Math.hypot(t.w, t.h));
        const row = perType.get(r.type) ?? { w: [], h: [], a: [], worst: 0, at: "" };
        row.w.push(w); row.h.push(h); row.a.push(w * h);
        const err = Math.max(Math.abs(Math.log(w)), Math.abs(Math.log(h)));
        if (err > row.worst) { row.worst = err; row.at = `zoom ${s.zoom}, ${s.range} out`; }
        perType.set(r.type, row);
      }
    }
    return { widths, heights, areas, offsets, perType };
  }

  const range = (a) => `${Math.min(...a).toFixed(2)}–${Math.max(...a).toFixed(2)}`;
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.95 * (s.length - 1))]; };

  if (SHOW_CANDIDATES) {
    console.log("every shape considered, against the mesh's own screen box");
    console.log(`  ${"".padEnd(58)}  ${"width".padEnd(14)} ${"height".padEnd(14)} ${"area".padEnd(15)} centre off`);
    for (const c of candidates) {
      const m = measure(c);
      console.log(`  ${c.label.padEnd(58)}  ${range(m.widths).padEnd(14)} ${range(m.heights).padEnd(14)} `
        + `${range(m.areas).padEnd(15)} p95 ${p95(m.offsets).toFixed(2)}`);
    }
    console.log("");
  }

  // P6-T07's own single configuration, printed so the two measurements can be read against each
  // other: the default zoom, yaw snap 0, one facing, entities exactly at the switch distance. It is
  // one point of the sweep above, and it is the point the comment in `tiers.ts` quotes.
  {
    const rig = new CameraRig({ mapWidth: field.width, mapHeight: field.height }, field);
    rig.yawIndex = 0;
    rig.distance = 420;
    rig.focusOn(field.width / 2, field.height / 2);
    const camera = rig.update(rasterW, rasterH);
    const ox = camera.eyeX + Math.sin(rig.yaw) * tier.lodDistance;
    const oz = camera.eyeZ + Math.cos(rig.yaw) * tier.lodDistance;
    const ratios = [];
    let worst = { v: 0, line: "" };
    for (const r of roster) {
      const mesh = meshes.get(r.mesh);
      const m = bbox(mesh.positions, 0, 1, ox, oz, camera);
      const old = bbox(quad(1, 0), camera.yaw + Math.PI, r.radius * 2.2, ox, oz, camera);
      const now = bbox(quadToday.positions, camera.yaw + Math.PI, IMPOSTER_SIZE[r.mesh], ox, oz, camera);
      const a = (old.w * old.h) / (m.w * m.h);
      ratios.push({ type: r.type, before: a, after: (now.w * now.h) / (m.w * m.h) });
      if (a > worst.v) {
        worst = { v: a, line: `${r.type} — mesh ${m.w.toFixed(1)}x${m.h.toFixed(1)} px, `
          + `quad was ${old.w.toFixed(1)}x${old.h.toFixed(1)} px, is now ${now.w.toFixed(1)}x${now.h.toFixed(1)} px` };
      }
    }
    console.log("P6-T07's own configuration (default zoom, yaw 0, one facing, at the switch distance)");
    console.log(`  screen area  ${range(ratios.map((r) => r.before))} (median `
      + `${median(ratios.map((r) => r.before)).toFixed(2)})   →   ${range(ratios.map((r) => r.after))} `
      + `(median ${median(ratios.map((r) => r.after)).toFixed(2)})`);
    console.log(`  worst: ${worst.line}\n`);
  }

  const before = measure(candidates[0]);
  const after = measure(candidates.find((c) => c.label.startsWith("SHIPPED")));

  console.log("before → after, over every sample");
  for (const [name, key] of [["screen width ", "widths"], ["screen height", "heights"], ["screen area  ", "areas"]]) {
    console.log(`  ${name}  ${range(before[key]).padEnd(14)} (median ${median(before[key]).toFixed(2)})`
      + `   →   ${range(after[key]).padEnd(14)} (median ${median(after[key]).toFixed(2)})`);
  }
  console.log(`  box centre     p95 ${p95(before.offsets).toFixed(2)} of the mesh's own diagonal`
    + `   →   p95 ${p95(after.offsets).toFixed(2)}\n`);

  console.log("per type, worst screen-box error at any zoom, range or facing");
  const rows = roster.map((r) => ({
    type: r.type, mesh: r.mesh, radius: r.radius,
    size: IMPOSTER_SIZE[r.mesh],
    b: before.perType.get(r.type), a: after.perType.get(r.type),
  })).sort((x, y) => y.a.worst - x.a.worst);
  console.log(`  ${"type".padEnd(17)} ${"mesh".padEnd(12)} ${"engR".padStart(5)} ${"quad".padStart(6)}   `
    + `${"before w/h".padEnd(24)} ${"after w/h".padEnd(24)} at`);
  for (const r of rows) {
    console.log(`  ${r.type.padEnd(17)} ${r.mesh.padEnd(12)} ${String(r.radius).padStart(5)} `
      + `${r.size.toFixed(1).padStart(6)}   `
      + `${`${range(r.b.w)} / ${range(r.b.h)}`.padEnd(24)} `
      + `${`${range(r.a.w)} / ${range(r.a.h)}`.padEnd(24)} ${r.a.at}`);
  }

  // The residual nobody can fix with a uniform scale: the roster's own aspect spread, and the
  // per-facing spread of the mesh the imposter is standing in for.
  console.log("\nwhat a single square quad cannot follow");
  const aspects = [...new Set(roster.map((r) => r.mesh))]
    .map((id) => ({ id, ratio: meshes.get(id).height / IMPOSTER_SIZE[id] }))
    .sort((a, b) => a.ratio - b.ratio);
  console.log(`  mesh height / mean footprint width: ${aspects[0].id} ${aspects[0].ratio.toFixed(2)} `
    + `… ${aspects[aspects.length - 1].id} ${aspects[aspects.length - 1].ratio.toFixed(2)}`);
  const spreads = [...target.values()].flat().map((t) => t.spread);
  console.log(`  a mesh's own screen width across its 8 facings varies by ${range(spreads)}x, `
    + `and the imposter's does not vary at all`);

  function deg(rad) { return (rad * 180 / Math.PI).toFixed(1); }
} finally {
  await server.close();
}
