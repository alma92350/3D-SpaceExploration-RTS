# ADR-0002: Scope — the Odyssey, single-player, in the browser

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** @alma92350
**Relates to:** PRD §3

## Context

The source game ships several distinct products under one shell: a 1v1 **skirmish** with a match
clock and a score victory, the open-world **Odyssey**, a **Competition** system (quick duels,
tournaments, an ELO ladder, a roster, an AI genome editor), and three scripted **scenarios**. Each
carries its own UI surface — the skirmish's match timer and score bar, the competition's six-tab
screen, the scenario objectives panel.

Rebuilding all of that in 3D multiplies the work with no 3D payoff: a tournament bracket does not
get better in perspective. The stakeholder request is explicit — **only the Odyssey**.

The Odyssey is also the mode where a 3D view earns the most: a galaxy of worlds you travel between,
each with terrain relief that currently reads as a flat wash, and a scale (a settled industrial
world) that a top-down view flattens.

## Decision

We will build **only the Odyssey**, single-player, for desktop browsers.

Out: skirmish mode and its victory/score/clock UI; competitions, ELO, tournaments, the genome
editor; scenarios; multiplayer; mobile/touch; VR.

The vendored engine will still *contain* the code for those modes — it is vendored unmodified
(ADR-0003) — but no route, UI, or asset in this project will reach them, and no test here will
cover them beyond what the upstream suite already does.

## Consequences

**This makes easy:**
- One game loop, one HUD, one set of camera rules to get right.
- A believable MVP: the Phase 1 scope is one world, which is a subset of a mode we are keeping,
  not a mode we would later throw away.

**This makes hard / gives up:**
- No quick "play a match" entry point for testing combat in isolation. Mitigated by starting the
  MVP on a single pre-settled world (PRD Q-02), which is functionally a skirmish for test purposes.
- Anyone wanting skirmish in 3D later inherits a UI shell shaped entirely around the galaxy layer.

**Obligations it creates:**
- Dead upstream modes must not silently bloat the bundle: the build's size budget (ADR-0007) is
  measured on the shipped bundle, and tree-shaking is verified in Phase 0 (`P0-T07`).

## Alternatives considered

### Port skirmish first, then Odyssey
Tempting — skirmish is smaller and self-contained, and would reach a playable 3D build sooner. But
it optimises for the wrong milestone: it delivers a demo of a mode we were asked not to build, and
its UI (clock, score bar, victory screen) is throwaway. The Odyssey's single-world slice gives the
same "feel it" milestone with nothing discarded.

### Everything, in parity with the 2D client
Rejected on cost and on request. Parity is a Phase 5 goal *within the Odyssey*, not across modes.
