# ADR-0026 — The GPU decides the graphics tier

**Status:** Accepted
**Date:** 2026-08-16
**Amends:** ADR-0006 (the tier ladder's entry point, not its budgets). **Partly closes:** P7-T07.

## Context

A player reported that distant objects render as flat rectangles and asked whether a real graphics
card could do better. Their machine: **GeForce GTX 1060 6 GB, i7-4790K (4 cores / 8 threads),
16 GB RAM.**

Run against `detectTier` itself, that machine got **T2**, and could not reach T3 on any browser:

```
DeskJockey, Chrome            -> T2  lod  800  cull 2200  shadows blob
DeskJockey, Firefox           -> T2  lod  800  cull 2200  shadows blob
integrated Intel UHD, 16 thr  -> T2  lod  800  cull 2200  shadows blob   <-- same tier
```

T3's gate was `cores >= 12 && memory >= 8 && !renderer.includes("intel")`. An eight-thread CPU
cannot pass it, **whatever card is in the machine** — and a laptop with integrated Intel graphics
and a sixteen-thread CPU landed on the same tier as the discrete GTX.

The renderer string was consulted twice, and both times as a **veto**: `SOFTWARE_RENDERERS` to force
T0, and a bare `!includes("intel")` to block T3. Nothing in the function could ever *promote* on the
strength of the GPU. **A graphics setting was being decided by asking about everything except the
graphics.**

What it cost this player is not subtle. A Small map is 1600 × 1000, diagonal ≈ 1886. T2's
`lodDistance` is 800, so most of the field is past it and drawn as the LOD imposter — one flat quad
(ADR-0024). T3's is **2400**, which exceeds the whole map diagonal: at T3 on a Small map nothing is
ever an imposter. The report — *"when an object is too far the rendering is just a flat square"* —
is that number, seen.

## Decision

**A renderer string that names a GPU built for 3D selects T3, checked before anything CPU-shaped.**
A four-core floor still applies, because ADR-0006 puts the simulation on one thread and the frame on
another and below four the CPU is the bottleneck whatever the card is.

`DEDICATED_GPUS` is a **family** list, not a model list: `nvidia`, `geforce`, `quadro`, `titan`,
`radeon rx`, `radeon pro`, `firepro`, `intel arc`, `arc a`, `apple m`. A model list is a thing
somebody maintains forever and that is wrong the week a card ships; these prefixes have named the
same product lines for over a decade.

**Not bare `radeon`.** Every Ryzen APU reports something like *"AMD Radeon(TM) Vega 8 Graphics"*, and
matching the word alone hands T3 to a laptop with no discrete card. This was a mutation survivor
before it was a rule, and it is pinned now.

**The tier numbers themselves are unchanged.** `lodDistance`, `cullDistance`, `renderScale` and the
shadow styles are exactly what they were. This ADR changes *which machines reach a tier*, not what a
tier does — because ADR-0006 requires the budgets to be measured, P1-T23 is PARKED for want of a GPU
in CI, and inventing better numbers on hardware nobody here can run would be the thing this project
keeps catching other people doing.

## Consequences

**The reporting player goes from `lodDistance` 800 to 2400** — three times the distance before
anything degrades, and past the diagonal of a Small map — plus shadow maps and antialiasing.

**The guess is allowed to be optimistic because it is not the answer.** This module's own header
says the sequence is *"guess from the renderer string, then correct by measurement"*, and
`TierMonitor` drops a tier that misses its budget within `CORRECTION_WINDOW_MS`. It never raises
one — so **a guess that is too low is the permanent one**, which is exactly the failure being fixed
here. "We never silently up-tier" is a rule about the runtime monitor and is untouched.

**It partly closes P7-T07, and the remaining half is now stated exactly.** That row's sharpest
finding was that `navigator.deviceMemory` is Chromium-only, so T3 was unreachable in Firefox and
Safari however capable the machine. The renderer string does not depend on `deviceMemory`, so every
machine whose browser names its card now gets **the same tier in all four browsers**. The sweep's
disagreement count falls from **22 of 60 to 16 of 60**, and every survivor is a **2 GB row** — the
`memory <= 2` downgrade still fires only where memory is visible. P7-T07 stays open for that half.

**What this does not do.** It does not measure anything. No GPU has run this build; the claim is
that the right tier is now *reachable*, not that its budget has been verified on the hardware — and
P1-T23 remains PARKED for exactly that reason. If T3 turns out to be too ambitious for a GTX 1060,
`TierMonitor` will drop it within three seconds and the player will see the notice, which is the
system working rather than a second bug.
