# ADR-0023: A shot is the engine's own `attackHit` event — the tracer set is what LANDED, not what fired

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** @alma92350
**Supersedes:** ADR-0017
**Answers:** Q-12 (re-answered; ADR-0017's answer rested on a false premise)
**Relates to:** ADR-0003, ADR-0006, ADR-0008, ADR-0012 §5, PARITY §7.1, P3-T05, P3-T06, P3-T07,
P5-T15, P6-T01

## Context

ADR-0017 decided that "the bridge synthesises a shot by diffing `attackTimer`", and allowed that
derivation — which ADR-0012 §5 normally forbids — *"for the stated reason that there is nothing to
ask instead"*. PARITY §7.1 checked the premise against the vendored source and it is false:
`combat.js:187` pushes an `attackHit` inside `performAttack`, and has since `4a5c169`, the Phase 1
MVP, which is before Phase 3 was scoped. P5-T15 then read that event for the impact cues.

So the question is no longer "is there something to ask" but **what the derivation costs**. P6-T01
measured it. Everything below is a number from a run, not an argument.

### 1. The defect the row was filed for: an ordered attack draws nothing

`extractShots` resolved a tracer's endpoint from `unit.autoTarget`. `combat.js:46` takes an
explicitly ordered attack's target straight off `unit.order`, and the `if (!targetId)` block at
`combat.js:55–67` — the only place in the whole engine that writes `autoTarget` — is therefore
unreachable for that unit. A Skiff right-clicked onto a Worker, 200 ticks, `helix`, seed 20260814:

| | fired | tracers | `dropped` | impacts |
|---|---|---|---|---|
| ADR-0017's diff | 10 | **0** | **10** | 10 |
| this decision | 10 | **10** | **0** | 10 |

Right-click-to-attack is the most common combat order in an RTS and it produced no tracer from
Phase 3 to Phase 6, against a counter ADR-0017 says must stay at zero. The stopgap
(`order.targetId ?? autoTarget`) was rejected before it was written and is argued below.

### 2. Two more losses ADR-0017 did not know it had

Both were found by instrumenting the engine's event stream and comparing it against what the bridge
emitted, on a 120-unit fight over 400 ticks — the same shape of scene ADR-0017's points 1–3 were
measured on. **ADR-0017's own recipe was never committed to this repo**, so it is not reproducible;
this one is, as `packedFight()` in `test/bridge/shots.test.ts`: world `helix`, seed 20260814, one
player Command Center on the player base, 120 units drawn round-robin from every type in `UNITS`
with owner decorrelated from type, in two blocks `gap` units either side of the base, jittered
`(i*13) % 60 − 30` in x and `(i*29) % 180 − 90` in y, stepped 400 times at `STEP_SECONDS`.

| | gap 60 | gap 30 |
|---|---|---|
| `attackHit` the engine pushed | 622 | 713 |
| shots per tick, p50 / p95 / max | 1 / 6 / 21 | 1 / 7 / 46 |
| target already removed at extraction | 8.4 % | 5.9 % |
| shots with no target id at all | 0 % | 0 % |
| **tracers ADR-0017's diff drew** | **620** | **711** |
| … of which counted on `dropped` | 1 | 2 |
| … of which lost with no counter at all | 1 | 0 |
| **tracers this decision draws** | **622** | **713** |
| … `dropped` | **0** | **0** |

The two leaks behind those numbers:

- **`dropped` is not zero in a real fight, and the test that said so could not have seen it.**
  `shots.dropped` is reset per extraction, and `shots.test.ts` read it *once, after the loop* — so it
  only ever observed the final tick. Summed over the run it is 1–4 depending on density. Every one of
  those drops is the same cause, confirmed by instrumenting the two branches separately: a target
  that died this tick **and was never in the previous tick's entity table**, because that table is
  fog-gated and `prevPos` is built from it. ADR-0017's point 2 assumed the previous position is
  always there; it is there only for something the player could already see.
- **A shot whose SHOOTER dies inside the same tick is lost, and was never counted at all.** A
  per-entity diff reads `attackTimer` off entities that still exist; an entity removed later in the
  same tick has no timer left to read. Measured at 1–3 shots per 600 in a packed fight. It could not
  reach `dropped`, because the loop that would have counted it never visits the shooter.

### 3. What the event covers, measured rather than assumed

Four questions had to be answered with numbers before a tracer could be hung off `attackHit`.

- **Does one shot push one `attackHit`, or several?** One, always. `applySplash` sits directly below
  the push and emits only `entityKilled` for whatever it finishes off. Verified on the roster's only
  splash weapon (`colossus`, `splash: {radius: 26, frac: 0.5}`) firing into a pack of ten: **10
  enemies took damage from one shot and the tick carried exactly 1 `attackHit`.** The cue that
  should grow with the splash is the impact ring, and it already does, off the same event's
  `splashRadius` (P5-T15).
- **Does it fire for buildings?** Yes. `performAttack` is called from three places — `updateCombat`
  (mobile units), `updateWorkerCombat` (a worker's ordered attack) and `updateBuildingCombat`
  (turrets) — and the file's own comment says it is *"Shared by mobile units and turrets"*. A
  Sentinel Turret fired 6 times in 200 ticks and pushed 6 `attackHit`s.
- **Is there a hit with no shot?** No. Each of the three call sites resets the shooter's cooldown
  immediately afterwards, so a hit always costs a weapon cycle. This is what stops "a tracer per
  hit" being "a tracer per arbitrary event".
- **Is there a shot with no hit?** **Yes — exactly one, and it is the reason this ADR is not a free
  win.** `performAttack` has a single early return before the push, `detonateIfAttacked`, so a hit on
  an **ARMED Helium Bomb** sets it off, resets the shooter's cooldown, and announces nothing.
  Measured on a Lancer shelling an armed bomb in plain sight: **the diff drew 1 tracer, this decision
  draws 0.** There is no miss chance, no out-of-range fire (the engine chases instead) and no flight
  time in this simulation, so that is the whole list.

### 4. What the ordering constraint was for

`extractShots` had to run before `rememberPreviousPositions` refilled `prevPos`, because a killing
shot's endpoint came out of it. That was ADR-0017's point 2 and it is the only reason the constraint
existed. The event stamps `x`/`y` from the target **before** `removeEntity` runs, so the endpoint
arrives with the shot. The constraint is gone, and the comment claiming it is gone with it — a stale
comment asserting a requirement that no longer exists would be worse than the defect this row fixed.

## Decision

**1. A shot is `attackHit`, read and copied. The bridge derives nothing.** `extractShots` walks
`state.events`, takes `fromX`/`fromY` as the tracer's origin and `x`/`y` as its endpoint, and copies
`owner`. This returns the shot path to ADR-0012 §5's ordinary rule — ask the engine, do not infer —
and it is the same event `extractImpacts` has read since P5-T15, so the two cues can no longer
disagree about whether a shot happened.

**2. Both endpoints come off the payload. Nothing is looked up, and `prevPos` is not consulted.**
`extractShots` therefore has no ordering constraint; `prevPos` reverts to being interpolation's
alone. The only remaining requirement is the one shots, impacts and deaths already share:
`WorldBridge.step` must drain `state.events` *after* extraction, which P3-T07 established.

**3. ADR-0017 §4's fog rule is carried forward unchanged, applied to the event's own origin.** A
shot crosses only if its shooter is the viewer's, or stands on ground the viewer can see —
`isVisibleAt(fog, ev.fromX, ev.fromY)`. A tracer from an unseen enemy is a line pointing straight at
it. **The tracer and the impact gate on different halves of the same event on purpose**: the tracer
on where the shot came from, the impact on where it landed. That is what lets a player shot from the
dark see the hit on their own unit while the line that would give away the artillery stays
suppressed.

**4. The tracer set is "shots that landed", and the one shot it gives up is the armed Helium
Bomb's.** Named here rather than discovered later, and pinned two ways: a source sweep asserting
that `performAttack` has exactly one early return before the push and that it is
`detonateIfAttacked`, and a behavioural test asserting that this shot draws nothing while the blast's
deaths still do. A miss chance added upstream would fail the sweep on the commit that added it.

**5. `dropped` survives with a narrower job: an `attackHit` whose four coordinates are not all
finite numbers.** ADR-0017's obligation was "a shot whose endpoint cannot be resolved must be
counted, not silently dropped". There is no resolution step left, so the counter moves to the one
assumption that replaced it — that the event carries both endpoints. It is checked **before** the fog
gate, so a malformed payload on unseen ground is counted rather than swallowed, and it is reset per
extraction like every other field of the table.

**6. The table is sized off `events.length`, exactly as `ImpactTable` and `DeathTable` are.** One
pass, no counting pass, and the over-estimate is bounded by one tick's events. It is also strictly
smaller than ADR-0017's `units + buildings`, which cut a table for "every shooter fires at once,
every tick" — 120 rows for a fight whose busiest tick carried 46.

## Consequences

**This makes easy:**
- Every shot the engine announces, from every path that can announce one: ordered attacks, AI
  focus-fire, worker attacks and turrets, with no per-case branch and nothing to keep in sync with
  upstream's targeting code.
- The killing shot, without a fallback: 8.4 % of shots in the measured fight had a target that was
  already removed, and the event carries where it was standing.
- Deleting a per-entity `Map` (`prevAttack`), an unbounded `Set` (`livingIds` — added to on every
  entity, every tick, and never cleared, which also made its own pruning pass a no-op) and a
  `numericId` call per shooter per tick, from a method that ran over every unit and building.

**This makes hard / gives up:**
- **A shot at an armed Helium Bomb draws no tracer.** Measured at 1 tracer before, 0 after. What the
  player still gets is every `entityKilled` the blast produces across a 190-unit radius, which is a
  louder cue than a 150 ms line — but this is a real regression against the diff and it is filed as
  one, not argued away.
- **The tracer set now depends on upstream's event payload rather than on upstream's field
  semantics.** A trade, not an improvement: ADR-0017 depended on `attackTimer` having exactly two
  writers, this depends on `attackHit` carrying four coordinates. The second is the cheaper
  dependency — it is one line of the engine, it is what the engine's own comment says the field is
  *for* ("so `render.js` can draw a tracer from shooter to target"), and `dropped` catches it moving.
- **A shot is still known only at tick resolution** (ADR-0017's cost, unchanged). The view renders at
  60 Hz and the sim ticks at 20, so a tracer's start quantises to 50 ms.
- **Being shot from the dark still shows no tracer** (ADR-0017's cost, unchanged, and half bought
  back by P5-T15's impact).

**Obligations it creates:**
- A source sweep asserting the premise against `combat.js`: the push carries both endpoints, it runs
  before `removeEntity`, `performAttack` has exactly one early return before it, there are exactly
  three call sites and each resets a cooldown. ADR-0017's premise about this same file was checkably
  false for two phases because nothing read the file; these tests read it.
- `dropped` must stay 0, **summed over every tick of a run** — not read once at the end, which is
  how the old obligation was discharged and why it reported zero while shots were being lost.
- The shot table's growth path needs a test that reads the rows back, not one that counts them: a
  write past a typed array's end is silently discarded, so a table that failed to grow would keep
  incrementing `count` and hand the view `undefined` while every total still added up.

## Alternatives considered

### `order.targetId ?? autoTarget` — the one-line stopgap
Rejected before it was written, and the reason is the measurement. `combat.js:93` nulls the order on
the kill (`if (died && unit.order && unit.order.targetId === target.id) unit.order = null`), so the
*killing* shot of an ordered attack still has neither field. It would take the Skiff's `dropped` from
10 to about 1 and make ordered attacks look like the ordinary dead-target case — hiding the fact that
they are special, which is worse than the visible bug. It also fixes nothing for AI focus-fire
(`unit.focusId` at `combat.js:52` is a third targeting path that never writes `autoTarget` either),
nothing for a shooter that dies mid-tick, and nothing for a target that was never visible.

### Keep the diff and read the event only for the endpoint
The conservative option: keep `attackTimer` as the trigger, use `attackHit` to place the far end. It
keeps every loss in §2 — the diff is what cannot see a dead shooter — while adding a second source of
truth that has to be matched up with the first, per entity, per tick. Two mechanisms, one of the two
defects fixed.

### Keep the diff as an auditor: count `fired − landed` into `dropped`
Genuinely attractive, and rejected on cost and on honesty. It would keep a live number on the
armed-bomb divergence instead of a source sweep — but it keeps the whole per-entity map and the
per-tick loop over every unit and building that this decision deletes, and the count it produces is
wrong in exactly the case that matters: a shooter that dies mid-tick is invisible to the audit too,
so the counter would run negative and need clamping. A structural property of the engine is better
pinned by a sweep over the engine than by a runtime counter that cannot see all of it.

### Draw a tracer for `attackHit` and a second one for the armed-bomb shot, synthesised
Restores the one lost shot by keeping a diff alive solely for entities that vanished this tick.
Rejected: it reintroduces the entire mechanism — the previous-timer map, the invariant, the
source-sweep test that guards it — to recover one tracer per doomsday device, in a moment that
already fills the screen with deaths.

### Ask upstream to emit a "shot fired" event
The clean answer to the armed-bomb gap, and not available: ADR-0003 vendors the engine unmodified.
Worth stating because it is what a reader will ask, and because it is the same sentence ADR-0017 used
about an event that already existed — so this time it is a claim about a payload that demonstrably is
not there, checked in `test/bridge/shots.test.ts` rather than remembered.
