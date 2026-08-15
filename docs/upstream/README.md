# Fixes owed upstream — **ALL LANDED**

> **Closed.** All three were reported as upstream issues #92, #93 and #94, fixed in
> `alma92350/SpaceExploration-RTS` PR #95, and arrived here through `npm run sync:engine`:
> the pinned ref moved `93f607ae46fb` → **`50ceb88d36f2`**. Nothing in this directory is
> outstanding; it is kept as the record of the round trip, because it is the first time this
> project exercised ADR-0003's upstream-first path end to end.
>
> **Upstream solved #94 better than the patch below proposed.** Rather than clamping to the lattice,
> it added `landingSites(map)` — the sites a map actually offers, per axis — and made
> `snapLandingPoint` pick the nearest one. That makes the site list the source of truth instead of
> the bare grid, which is the distinction that made "nearest multiple of the grid" wrong by up to 60
> units near an edge. `ApproachBrief` now carries that list beside the bound `snap`, and
> `view/landing.ts`'s probe (`snapStep`) is demoted to a fallback.

Three defects this client found in the simulation, with verified patches. **They were not applied
here and must not be**: ADR-0003 vendors `engine/` byte-for-byte and says changes to simulation
behaviour go upstream first, then arrive through a sync that bumps the pinned ref. A local edit
breaks the drift check, which is the whole point of the drift check.

So this directory was a staging post, not a fork.

| File | |
|---|---|
| `0001-three-defects-found-from-the-3d-client.patch` | The patch. Three hunks, 63 lines, against `93f607ae46fb` — the commit `src/engine/VENDOR.json` pins, verified identical to upstream `main` at the time of writing |
| `verify-defects.mjs` | Runs each defect and its fix side by side and prints the numbers below. `node docs/upstream/verify-defects.mjs <path-to-patched-engine>` |

A branch was created upstream — `claude/three-defects-found-from-the-3d-client` — and left empty,
because this session could not push file contents to it. The fixes landed via PR #95 from a
different branch instead; the empty one can be deleted.

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

## How they landed, and what it cost

Reported as issues rather than a PR, because this session could clone neither repo and could not
push 103 kB of file content through the API. That turned out to be the better shape anyway: the
upstream session ran the real ~41 k-line suite, which this one could not, and it improved fix 3
rather than applying it. **Six CI checks green on node 20 and node 22 before merge.**

The whole round trip, as a record of ADR-0003's path working:

1. Three separate rows of Phase 4 each found one defect **as a side effect of testing something
   else** — the save round-trip, the colony income panel, the landing picker.
2. Each was pinned here as a test asserting the defect **is there**, with a note saying an upstream
   fix should turn it red.
3. Reported upstream with a measurement, a reproduction and a suggested diff.
4. Fixed upstream, merged, synced (`93f607ae46fb` → `50ceb88d36f2`).
5. **All three pinned tests went red on the sync, exactly as designed** — plus one that fired for
   the wrong reason (see below). Each was then *inverted* into a regression guard rather than
   deleted: the scenarios are expensive to build and are precisely what a regression would need.

**One guard cried wolf, and that is worth recording.** `test/engine/galaxy-coordinates.test.ts`
pinned ADR-0019's premise by file, function **and line number** — and the fix added nine lines above
`jumpCost`, moving it from 975 to 984. Nothing about the premise had changed. A guard that fires on
unrelated edits is one the next person deletes, so it now pins file and function only, and prints
the line in the failure message where it helps and cannot cause a false alarm.
