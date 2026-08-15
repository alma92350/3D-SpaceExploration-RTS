const OLD = "/home/user/3D-SpaceExploration-RTS/src/engine";
const NEW = process.argv[2];
async function load(base) {
  return {
    market: await import(`${base}/engine/market.js`),
    galaxy: await import(`${base}/engine/galaxy.js`),
  };
}
const o = await load(OLD), n = await load(NEW);

// ---- Fix 3: snapLandingPoint idempotency -------------------------------------------------
const map = { width: 1600, height: 1200 };
function nonIdempotent(snap) {
  let bad = 0;
  for (let x = 0; x <= 1600; x++) {
    const a = snap(map, x, 600), b = snap(map, a.x, a.y);
    if (a.x !== b.x || a.y !== b.y) bad++;
  }
  return bad;
}
console.log("FIX 3  snapLandingPoint non-idempotent x-values:");
console.log("        before:", nonIdempotent(o.galaxy.snapLandingPoint), "of 1601");
console.log("        after :", nonIdempotent(n.galaxy.snapLandingPoint), "of 1601");
console.log("        x=0 before ->", o.galaxy.snapLandingPoint(map,0,600).x,
            "| after ->", n.galaxy.snapLandingPoint(map,0,600).x);

// ---- Fix 1: createMarket ignores debris ---------------------------------------------------
function bookFor(mk, extraNodes) {
  const state = {
    planetId: "helix",
    map: { nodes: [
      { com:"ore", max:600 }, { com:"crystals", max:400 }, { com:"radioactives", max:300 },
      ...extraNodes,
    ] },
  };
  return mk(state).base;
}
const wrecks = [{ com:"metals", max:220, wreck:true }, { com:"ore", max:180, crater:true }];
for (const [label, mk] of [["before", o.market.createMarket], ["after", n.market.createMarket]]) {
  const clean = bookFor(mk, []), dirty = bookFor(mk, wrecks);
  const moved = Object.keys(clean).filter(c => Math.abs(clean[c]-dirty[c]) > 1e-9);
  console.log(`FIX 1  ${label}: commodities whose base moved when wreckage was added: ${moved.length}`
    + (moved.length ? `  e.g. radioactives ${clean.radioactives?.toFixed(2)} -> ${dirty.radioactives?.toFixed(2)}` : ""));
}
const bases = { before: "/home/user/3D-SpaceExploration-RTS/src/engine", after: process.argv[2] };
for (const [label, base] of Object.entries(bases)) {
  const g = await import(`${base}/engine/galaxy.js`);
  const st = await import(`${base}/engine/state.js`);
  const gal = g.createGalaxy({ seed: 20260814, startId: "helix" });
  // A background world with player buildings on it, then conquered.
  const other = [...gal.planets.keys()].find(id => id !== gal.activeId);
  const s = gal.planets.get(other);
  for (let i = 0; i < 3; i++) {
    const b = st.makeBuilding("habitat", "player", 400 + i * 60, 400);
    b.constructing = false;
    s.buildings.set(b.id, b);
  }
  (gal.pacified ||= new Set()).add(other);
  // A world you have conquered is necessarily one you have been to.
  (gal.discovered ||= new Set()).add(other);

  const before = gal.credits;
  g.sweepColonies(gal, 60);                       // one sim minute
  const earned = Math.round(gal.credits - before);
  const row = g.galaxyStatus(gal).worlds.find(w => w.id === other);
  console.log(`${label.padEnd(7)} world=${other} status=${row.status}`
    + `  REPORTED income=${row.income}/min   ACTUALLY earned=${earned}/min`
    + (row.income === earned ? "   ✓ agree" : "   ✗ DISAGREE"));
}
