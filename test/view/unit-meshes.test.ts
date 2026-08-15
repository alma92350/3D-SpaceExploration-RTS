// P3-T02 — every unit in the game has a silhouette of its own (ADR-0016).
//
// The first test here is the one ADR-0016 named as an obligation, and it is deliberately not the
// obvious one. `meshIdForType` falls back to `worker` for anything it does not recognise, so a test
// that asked "is this mesh registered?" passes while a Dreadnought renders as a Worker — which is
// exactly what happened, undetected, for two whole phases. The assertion has to be that **no type
// arrives at its mesh by fallback**: it resolves either to a mesh named after itself, or to an
// explicit family entry someone wrote down on purpose.
//
// The rest are the honest, weaker stand-ins for the blind readability test PRD §5 asks for and
// ADR-0011 defers. They cannot tell whether a shape *reads*; they can tell whether two shapes are
// the same shape, and whether the shapes track the simulation's own numbers.

import { describe, expect, it } from "vitest";
import {
  MESH_IDS, TRIANGLE_BUDGET, UNIT_FAMILY, buildMeshes, meshIdForType,
} from "../../src/view/meshes/generators.js";
import { UNITS } from "../../src/engine/index.js";
import { profileDistance, profileOf } from "./silhouette.js";

const meshes = buildMeshes();
const byId = new Map(meshes.map((m) => [m.id, m]));
const unitTypes = Object.keys(UNITS);

/** The nine ADR-0016 is about. Named explicitly so this file fails loudly if one is dropped. */
const NEWLY_MESHED = [
  "ranger", "breacher", "dreadnought", "mender", "wraith", "aegis", "colossus", "leviathan",
  "heliumbomb",
] as const;

describe("the unit mesh set", () => {
  it("gives every unit type a mesh chosen for it, never one reached by fallback", () => {
    // ADR-0016's stated obligation, and the reason this file exists. `meshIdForType`'s default is
    // `worker`; a type is only legitimately drawn as a Worker if it IS the Worker.
    const byFallback = unitTypes.filter((type) => {
      const id = meshIdForType(type);
      const deliberate = UNIT_FAMILY[type] ?? (MESH_IDS as readonly string[]).includes(type);
      return !deliberate || (id === "worker" && type !== "worker");
    });

    expect(
      byFallback,
      `these unit types reach their mesh by FALLBACK and render as a Worker:\n  ${byFallback.join(", ")}\n` +
      `Give each its own generator, or an explicit UNIT_FAMILY entry (ADR-0016).`,
    ).toEqual([]);
  });

  it("routes every unit type to a mesh that was actually built", () => {
    for (const type of unitTypes) {
      const id = meshIdForType(type);
      expect(byId.has(id), `${type} → ${id}, which is not in the built mesh set`).toBe(true);
    }
  });

  it("covers all nine ADR-0016 named, by name", () => {
    // Belt and braces against the sweep above quietly passing on an empty roster.
    for (const type of NEWLY_MESHED) {
      expect(UNITS[type], `${type} left the engine — ADR-0016's premise changed`).toBeDefined();
      expect(meshIdForType(type), `${type} should draw with its own mesh`).toBe(type);
    }
  });

  it("keeps every new mesh inside a declared triangle budget", () => {
    // Budgets are declared, not discovered. The precedent: the volatile deposit went five-sided
    // after six put it at 36 triangles against a 30 budget — the proportion separated it, not the
    // facet count.
    for (const type of NEWLY_MESHED) {
      const budget = TRIANGLE_BUDGET[type];
      expect(budget, `${type} has no declared triangle budget`).toBeDefined();
      expect(byId.get(type)!.triangles, `${type} is over its budget`).toBeLessThanOrEqual(budget!);
    }
  });

  it("gives every unit silhouette a profile of its own", () => {
    // The same proxy the buildings use, over every mesh any unit type resolves to — so the nine new
    // ones are compared against each other AND against the five that already existed.
    const ids = [...new Set(unitTypes.map(meshIdForType))];
    expect(ids.length, "the unit roster should span more than a handful of meshes").toBeGreaterThan(10);
    const profiles = new Map(ids.map((id) => [id, profileOf(byId.get(id)!)]));

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = profileDistance(profiles.get(ids[i]!)!, profiles.get(ids[j]!)!);
        expect(
          d,
          `${ids[i]} and ${ids[j]} have the same profile (${d.toFixed(3)}) — they would look ` +
          `identical on the field, which is the whole thing ADR-0016 spent 18 draw calls to avoid`,
        ).toBeGreaterThan(0.1);
      }
    }
  });

  it("makes the two unarmed units the most distinctive things in the roster", () => {
    // ADR-0016 bought this specifically. The Mender has no attack — a healer that reads as a
    // fighter gets focused by an enemy and abandoned by its own player. The Helium Bomb has no
    // attack either and detonates for up to 3 000 damage in a radius, which makes mistaking it the
    // most expensive misread in the game, in both directions: failing to shoot one, or walking a
    // army into one.
    //
    // So they are held to a wider margin than the 0.1 everything else gets.
    const armed = unitTypes.filter((t) => (UNITS[t] as { attack?: number }).attack);
    const armedIds = [...new Set(armed.map(meshIdForType))];

    for (const unarmed of ["mender", "heliumbomb"]) {
      const mine = profileOf(byId.get(unarmed)!);
      for (const id of armedIds) {
        const d = profileDistance(mine, profileOf(byId.get(id)!));
        expect(
          d,
          `${unarmed} and the armed ${id} differ by only ${d.toFixed(3)} — an unarmed unit that ` +
          `reads as a fighter is the misread ADR-0016 was written to prevent`,
        ).toBeGreaterThan(0.25);
      }
    }
  });

  it("keeps the three siege units apart, since they are the named fallback family", () => {
    // ADR-0016 names breacher/colossus/leviathan as the first thing to collapse if P3-T16 measures
    // a frame-time problem. If they are already indistinguishable, that fallback is free and this
    // ADR bought nothing for them — so it is worth knowing now rather than then.
    const siege = ["breacher", "colossus", "leviathan"];
    for (let i = 0; i < siege.length; i++) {
      for (let j = i + 1; j < siege.length; j++) {
        const d = profileDistance(profileOf(byId.get(siege[i]!)!), profileOf(byId.get(siege[j]!)!));
        expect(d, `${siege[i]} and ${siege[j]} differ by only ${d.toFixed(3)}`).toBeGreaterThan(0.15);
      }
    }
  });

  it("keeps every unit inside the selection ring the engine draws for it", () => {
    // The first draft of this test asserted that mesh radius ordered the same way as
    // `UNITS[t].radius`, and it was measuring the wrong thing. A mesh's radius is a BOUNDING
    // radius, so for the Lancer it is mostly barrel — 9.42 of which 5.4 is gun — while the engine's
    // is a collision radius. The two disagree by design: the Lancer's own comment says the barrel
    // IS the silhouette, and satisfying the ordering would have meant shrinking it to fit a metric
    // that never meant what it looked like it meant.
    //
    // This is the claim that is actually true and actually matters. `SceneComposer` draws the
    // selection ring at `UNITS[t].radius * 1.35` (scene.ts), so a mesh wider than that sticks out
    // of its own ring — visible on every selected unit, and nothing else here would catch it.
    const SELECTION_RING = 1.35;
    // The Colony Ship already overflows, 22.11 against a 17.55 ring, and it is Phase 1 art with a
    // deliberate reason to be enormous. Named rather than silently tolerated: a Phase 3 commit is
    // not the place to reshape it, and an unlisted exception is how a contract stops being one.
    const KNOWN_OVERFLOW = new Set(["colonyship"]);

    for (const type of unitTypes) {
      if (meshIdForType(type) !== type || KNOWN_OVERFLOW.has(type)) continue;
      const ring = UNITS[type]!.radius * SELECTION_RING;
      expect(
        byId.get(type)!.radius,
        `${type}'s mesh reaches ${byId.get(type)!.radius.toFixed(2)} but its selection ring is ` +
        `only ${ring.toFixed(2)} (engine radius ${UNITS[type]!.radius} x ${SELECTION_RING}) — ` +
        `the model sticks out of its own ring`,
      ).toBeLessThanOrEqual(ring);
    }
  });

  it("scales the nine with the simulation's own radii, coarsely", () => {
    // The surviving half of the idea above, in the form that is true: a Leviathan (engine radius
    // 14) must not read as smaller than a Ranger (6). Only pairs the engine separates by 2x are
    // compared, because that is where the claim is unambiguous — below it, a long dart and a squat
    // drum legitimately bound the same box.
    //
    // Bulk rather than radius: radius alone calls the Skiff (a 6.2-long dart, 2.4 tall) bigger than
    // the Bastion, which is a fact about barrels rather than about size.
    const bulk = (id: string): number => byId.get(id)!.radius * byId.get(id)!.height;
    const own = unitTypes.filter((t) => meshIdForType(t) === t);
    let compared = 0;
    for (const a of own) {
      for (const b of own) {
        if (UNITS[a]!.radius <= UNITS[b]!.radius * 2) continue;
        compared++;
        expect(
          bulk(a),
          `the engine says ${a} (r=${UNITS[a]!.radius}) is more than twice ${b} ` +
          `(r=${UNITS[b]!.radius}), but its mesh has less bulk`,
        ).toBeGreaterThan(bulk(b));
      }
    }
    expect(compared, "no pair was far enough apart to compare — this test proves nothing").toBeGreaterThan(2);
  });

  it("still builds identical geometry every time", () => {
    const again = buildMeshes();
    for (const type of NEWLY_MESHED) {
      const first = byId.get(type)!;
      const twin = again.find((m) => m.id === type)!;
      expect(Array.from(twin.positions)).toEqual(Array.from(first.positions));
    }
  });
});
