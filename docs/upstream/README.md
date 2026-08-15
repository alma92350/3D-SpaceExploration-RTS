# Fixes owed upstream

Three defects this client found in the simulation, with verified patches. **They are not applied
here and must not be**: ADR-0003 vendors `engine/` byte-for-byte and says changes to simulation
behaviour go upstream first, then arrive through a sync that bumps the pinned ref. A local edit
breaks the drift check, which is the whole point of the drift check.

So this directory is a staging post, not a fork. It holds what a maintainer needs to apply the
fixes to `alma92350/SpaceExploration-RTS` and nothing else.

| File | |
|---|---|
| `0001-three-defects-found-from-the-3d-client.patch` | The patch. Three hunks, 63 lines, against `93f607ae46fb` — the commit `src/engine/VENDOR.json` pins, verified identical to upstream `main` at the time of writing |
| `verify-defects.mjs` | Runs each defect and its fix side by side and prints the numbers below. `node docs/upstream/verify-defects.mjs <path-to-patched-engine>` |

A branch exists upstream — `claude/three-defects-found-from-the-3d-client` — created from that same
commit and **currently empty**: this session could not push the file contents to it. See "How to
land these" below.

---

## 1. A world that has been fought over does not round-trip its market prices

**`engine/market.js`, `createMarket`.** Found by P4-T09 (the galaxy save round-trip).

A world's price book is computed **exactly twice**: once at creation (`galaxy.js` `buildPlanetState`)
and once on load (`persist.js`). `createMarket` derives every raw commodity's `base` from
`share = total[com] / sum` over **every map node's `max`** — and `wreckage.js` and `bomb.js` push new
nodes onto `state.map.nodes` **during play**. The payload never carries `base`, so on load the engine
re-derives it from a strictly larger node set than the live book was built from.

**Measured:** radioactives base **27 → 34** with two wreck nodes present. It is not confined to the
wreckage's own commodity — `sum` moves, so every raw commodity's share moves with it, and the drift
grows with accumulated wreckage. A player saves after a battle, reloads, and every price on that
world is quoted off a different book. The wreck nodes themselves round-trip perfectly, which is
exactly why this is easy to miss.

**The fix skips wreck and crater nodes**, and the reason to prefer it over persisting `base` is that
it **changes no live behaviour at all**: at creation there are no such nodes to skip, so the only
call it affects is the one on load — which it makes reproduce creation. No save-format change, no
version bump.

## 2. A conquered colony reports zero income while earning

**`engine/galaxy.js`, `galaxyStatus`.** Found by P4-T06 (colonies and passive income).

`else if (pacified) status = "pacified"` short-circuits **before** the branch that computes `income`,
so a pacified world always reports `income: 0`. `sweepColonies` pays that same world both the
per-building income *and* `PACIFIED_INCOME`, additively.

There are **two** bugs here, not one: pacified worlds never reach the income branch, and
`PACIFIED_INCOME` is never reported for **any** world.

**Measured:** a pacified colony with three player buildings reports **0** and earns **60
credits/min**. After the fix, both read 60.

The fix reorders the chain so the label and the income are decided independently — `pacified` still
outranks `colony`/`contested` as a *label* — and mirrors `sweepColonies` exactly, including its
`background`-only rule.

## 3. `snapLandingPoint` is not idempotent

**`engine/galaxy.js`, `snapLandingPoint`.** Found by P4-T05 (the landing picker).

`Math.min(Math.max(Math.round(v / GRID) * GRID, MARGIN), span - MARGIN)` **rounds and then clamps**,
so the whole edge band lands on `LANDING_PICK_MARGIN` (100) — which is not a multiple of
`LANDING_PICK_GRID` (160). Feeding the answer back in moves it again.

**Measured:** **161 of 1601** x-values on a 1600-wide map. A click at x=0 displays at **100** and
re-snaps to **160**.

That bites any caller that shows a player where they are about to land and then sends that same
point back — which is the obvious way to write a landing picker, and this client had to be built
around it. The fix clamps to the **lattice** inside the margin rather than to the margin itself.

**This one has a behaviour cost and should not be waved through:** the reachable landing band on a
1600-wide map becomes `[160, 1440]` where it was `[100, 1500]`. Nothing else in the engine depends
on the old bound as far as this client can see, but that is a judgement for someone who owns the
game's balance, not for the client that found it.

---

## How to land these

Applying the patch needs a clone, which this session was not permitted to make. Either:

```
git clone https://github.com/alma92350/SpaceExploration-RTS
cd SpaceExploration-RTS
git checkout claude/three-defects-found-from-the-3d-client
git apply /path/to/0001-three-defects-found-from-the-3d-client.patch
npm test          # upstream's own ~41k lines — NOT run by this session
```

**Nothing here has been run against upstream's test suite.** Each fix was verified against the
vendored copy of the same commit, which is byte-identical to upstream, by the script beside this
file — but that proves the defect and the fix, not the absence of a regression elsewhere. Fixes 1
and 2 are inert outside the paths described. Fix 3 is not, and its blast radius is the reason it is
called out separately above.

Once merged upstream, `npm run sync:engine` brings them here and the pinned ref moves.
