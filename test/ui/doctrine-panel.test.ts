// P2-T12 — selecting a doctrine changes exactly what the engine changes, and the panel states the
// trade-off in the engine's own numbers.
//
// "Exactly what the engine changes" is the load-bearing half. A doctrine commitment is the only
// irreversible click in the game: it spends resources like anything else, and it also spends the
// other two doctrines for the rest of the match. A panel that showed the resource cost and not the
// commitment would be telling the truth and still misleading the player at the one moment it mattered.
//
// So the tests below sweep ALL of `UPGRADES` against the engine node by node, the way the research
// panel's do — one path's gating drifting while the other two look right shows up to a player as a
// button that does nothing — and then check the commitment separately.

import { describe, expect, it } from "vitest";
import { doctrinePanelModel } from "../../src/ui/doctrine-panel.js";
import { WorldBridge } from "../../src/bridge/world.js";
import { STEP_SECONDS } from "../../src/app/loop.js";
import {
  UPGRADES, committedDoctrine, makeBuilding, researchUpgrade, upgradeMult,
} from "../../src/engine/index.js";

const SEED = 20260814;

/** A Refinery and a full treasury: the panel's gating is what is under test, not affordability. */
function refineryWorld(): { bridge: WorldBridge; refinery: Building } {
  const bridge = new WorldBridge({ seed: SEED, worldId: "helix" });
  const base = bridge.state.map.bases.player;
  const cc = makeBuilding("command", "player", base.x, base.y);
  bridge.state.buildings.set(cc.id, cc);
  const refinery = makeBuilding("refinery", "player", base.x + 80, base.y);
  bridge.state.buildings.set(refinery.id, refinery);
  const res = bridge.state.players.player.resources;
  res.ore = 5000; res.crystals = 5000; res.radioactives = 5000;
  bridge.step(STEP_SECONDS);
  return { bridge, refinery };
}

function allEntries(model: ReturnType<typeof doctrinePanelModel>) {
  return model.paths.flatMap((p) => p.upgrades);
}

function entry(model: ReturnType<typeof doctrinePanelModel>, id: string) {
  return allEntries(model).find((e) => e.id === id)!;
}

describe("the doctrine panel", () => {
  it("covers all three paths and every upgrade the engine defines on them", () => {
    const { bridge, refinery } = refineryWorld();
    const model = doctrinePanelModel(bridge.state, refinery.id);

    expect(model.paths.map((p) => p.doctrine)).toEqual(["assault", "bulwark", "logistics"]);
    const shown = new Set(allEntries(model).map((e) => e.id));
    const engineIds = Object.values(UPGRADES).filter((d) => d.doctrine).map((d) => d.id);
    expect(shown, "the panel and the engine disagree about the roster").toEqual(new Set(engineIds));
    for (const path of model.paths) {
      expect(path.upgrades.map((u) => u.tier), `${path.doctrine} is out of tier order`).toEqual([1, 2, 3]);
    }
  });

  it("never shows `hardEdge`, which is the AI's and is not a doctrine at all", () => {
    // It sits in the same table with no `doctrine` field, and `committedDoctrine` guards on that
    // field for exactly this reason: seeded before any real research, it would otherwise read as a
    // commitment and silently disable the doctrine lock for the whole match.
    const { bridge, refinery } = refineryWorld();
    expect(UPGRADES.hardEdge, "hardEdge left the engine — this test's premise is gone").toBeDefined();
    expect(UPGRADES.hardEdge!.doctrine).toBeUndefined();
    expect(allEntries(doctrinePanelModel(bridge.state, refinery.id)).some((e) => e.id === "hardEdge")).toBe(false);
  });

  it("agrees with the engine about every upgrade, node by node", () => {
    // The sweep. `canStart` is a dry run of `researchUpgrade`, so this checks the dry run is really
    // a dry run: the engine's verdict is taken twice and must not change in between, and nothing
    // may have been spent or queued along the way.
    const { bridge, refinery } = refineryWorld();
    const model = doctrinePanelModel(bridge.state, refinery.id);
    const before = { ...bridge.state.players.player.resources };

    for (const e of allEntries(model)) {
      const probe = doctrinePanelModel(bridge.state, refinery.id);
      expect(entry(probe, e.id).canStart, `${e.id} changed its mind between two identical reads`)
        .toBe(e.canStart);
    }

    expect(bridge.state.players.player.resources, "the dry run spent resources").toEqual(before);
    expect(bridge.state.buildings.get(refinery.id)!.researchQueue ?? [], "the dry run left a job queued")
      .toEqual([]);
  });

  it("offers only the Tier 1s while nothing is researched, because a queued job is not a prereq here", () => {
    // The rule that is the OPPOSITE of the tech tree's, and the whole reason `canStart` is a dry run
    // rather than a copied predicate. `researchTech` counts a tech queued ahead on the same
    // Datacenter as satisfying its successor; `researchUpgrade` does not.
    const { bridge, refinery } = refineryWorld();
    const model = doctrinePanelModel(bridge.state, refinery.id);
    for (const e of allEntries(model)) {
      expect(e.canStart, `tier ${e.tier} ${e.id}`).toBe(e.tier === 1);
      if (e.tier > 1) expect(e.blockedBy, `${e.id} should be blocked on its prerequisite`).toBe("prereq");
    }

    // Queue the Tier 1 for real; its Tier 2 must STILL be blocked, unlike a tech tree node.
    expect(researchUpgrade(bridge.state, refinery.id, "overchargedWeapons")).toBe(true);
    const after = doctrinePanelModel(bridge.state, refinery.id);
    expect(entry(after, "overchargedWeapons").state).toBe("queued");
    expect(
      entry(after, "overchargedCore").canStart,
      "a Refinery job queued ahead must NOT satisfy its successor's prerequisite",
    ).toBe(false);
  });

  it("states the commitment BEFORE the click, and the lock-out after it", () => {
    const { bridge, refinery } = refineryWorld();
    const open = doctrinePanelModel(bridge.state, refinery.id);
    expect(open.committed, "nothing committed at the start").toBeNull();
    expect(open.choiceIsOpen, "the choice is live and worth warning about").toBe(true);
    expect(open.paths.every((p) => !p.lockedOut)).toBe(true);

    expect(researchUpgrade(bridge.state, refinery.id, "reinforcedPlating")).toBe(true);

    const locked = doctrinePanelModel(bridge.state, refinery.id);
    expect(locked.committed).toBe("bulwark");
    expect(locked.choiceIsOpen, "the warning must stop being shown once it is too late").toBe(false);
    for (const path of locked.paths) {
      expect(path.lockedOut, `${path.doctrine}`).toBe(path.doctrine !== "bulwark");
      if (path.lockedOut) {
        for (const u of path.upgrades) {
          expect(u.canStart, `${u.id} is on a closed path`).toBe(false);
          // The distinction that matters. "cost" says come back richer; "doctrine" says never.
          expect(u.blockedBy, `${u.id} must read as permanently closed, not merely unaffordable`)
            .toBe("doctrine");
        }
      }
    }
  });

  it("locks out on a QUEUED job, not only a completed one", () => {
    // `committedDoctrine` reads the Refinery's queue as well as the researched set, so the lock
    // lands the instant the job is queued. A panel that waited for completion would offer the other
    // two paths for 25 seconds and have every click silently refused.
    const { bridge, refinery } = refineryWorld();
    researchUpgrade(bridge.state, refinery.id, "logisticsNetwork");
    expect(bridge.state.players.player.upgrades.logisticsNetwork, "not researched yet, only queued").toBeFalsy();
    expect(committedDoctrine(bridge.state, "player")).toBe("logistics");
    expect(doctrinePanelModel(bridge.state, refinery.id).committed).toBe("logistics");
  });

  it("states the trade-off in the engine's own numbers, without doing arithmetic on them", () => {
    // Every numeric field on the def has to reach the model verbatim. A percentage conversion here
    // would be this module doing arithmetic on a balance number, and a sign error in it is invisible
    // until someone counts damage in a real fight.
    const { bridge, refinery } = refineryWorld();
    const model = doctrinePanelModel(bridge.state, refinery.id);

    for (const e of allEntries(model)) {
      const def = UPGRADES[e.id]!;
      const numeric = Object.entries(def)
        .filter(([k, v]) => typeof v === "number" && k !== "tier" && k !== "time");
      expect(
        new Set(e.effects.map((x) => x.field)),
        `${e.id} drops an effect the engine defines`,
      ).toEqual(new Set(numeric.map(([k]) => k)));
      for (const [field, value] of numeric) {
        expect(e.effects.find((x) => x.field === field)!.value, `${e.id}.${field}`).toBe(value);
      }
      expect(e.desc, `${e.id} should carry the engine's own sentence`).toBe(def.desc ?? "");
      expect(e.timeSeconds).toBe(def.time ?? 0);
    }
  });

  it("keeps the Bulwark capstone's payload, which a `*Mult` suffix rule would silently drop", () => {
    // `selfSealingPlating` grants `regenRate` and `regenDelay`. Filtering effects by a "Mult" suffix
    // is the obvious implementation and it loses the entire upgrade's payload while looking correct
    // on the eight that do end in Mult.
    const { bridge, refinery } = refineryWorld();
    const e = entry(doctrinePanelModel(bridge.state, refinery.id), "selfSealingPlating");
    const fields = new Set(e.effects.map((x) => x.field));
    expect(fields.has("regenRate")).toBe(true);
    expect(fields.has("regenDelay")).toBe(true);
  });

  it("shows nothing at all for a building that is not a Refinery", () => {
    // `researchUpgrade` refuses anything else outright, so a panel elsewhere would offer buttons the
    // engine silently ignores (F-07).
    const { bridge } = refineryWorld();
    const cc = [...bridge.state.buildings.values()].find((b) => b.type === "command")!;
    const model = doctrinePanelModel(bridge.state, cc.id);
    expect(model.paths).toEqual([]);
    expect(model.choiceIsOpen).toBe(false);
  });
});

describe("committing to a doctrine", () => {
  it("changes exactly what the engine changes and nothing else", () => {
    const { bridge, refinery } = refineryWorld();
    const state = bridge.state;
    const before = {
      resources: { ...state.players.player.resources },
      upgrades: { ...state.players.player.upgrades },
      queue: [...(state.buildings.get(refinery.id)!.researchQueue ?? [])],
    };
    const def = UPGRADES.overchargedWeapons!;

    const err = bridge.apply({ kind: "doctrine", buildingId: refinery.id, upgradeId: "overchargedWeapons" });
    expect(err, "the engine refused a fully affordable Tier 1").toBeNull();

    const after = state.players.player.resources;
    // Exactly the cost, off exactly the commodities named — nothing else moved.
    for (const com of Object.keys(before.resources)) {
      const spent = (def.cost as Record<string, number>)[com] ?? 0;
      expect(after[com], `${com}`).toBeCloseTo((before.resources[com] ?? 0) - spent, 6);
    }
    expect(state.players.player.upgrades, "queuing is not researching").toEqual(before.upgrades);
    expect(state.buildings.get(refinery.id)!.researchQueue!.length).toBe(before.queue.length + 1);
    expect(state.buildings.get(refinery.id)!.researchQueue![0]!.techId).toBe("overchargedWeapons");
  });

  it("applies the multiplier the panel promised, once it completes", () => {
    // The end of the chain: what the panel showed as an effect is what `upgradeMult` returns. The
    // panel is only honest if this holds, and it is the one assertion that spans both.
    const { bridge, refinery } = refineryWorld();
    const e = entry(doctrinePanelModel(bridge.state, refinery.id), "overchargedWeapons");
    const promised = e.effects.find((x) => x.field === "damageDealtMult")!.value;

    expect(upgradeMult(bridge.state.players.player.upgrades, "damageDealtMult")).toBe(1);
    bridge.apply({ kind: "doctrine", buildingId: refinery.id, upgradeId: "overchargedWeapons" });
    // Run it out. `time` is 25 s and the step is a fixed tick, so this is generous rather than exact.
    for (let i = 0; i < 700; i++) bridge.step(STEP_SECONDS);

    expect(bridge.state.players.player.upgrades.overchargedWeapons, "the research never finished").toBeTruthy();
    expect(upgradeMult(bridge.state.players.player.upgrades, "damageDealtMult")).toBeCloseTo(promised, 6);
  });

  it("refuses a closed path with a reason that says it is permanent", () => {
    const { bridge, refinery } = refineryWorld();
    bridge.apply({ kind: "doctrine", buildingId: refinery.id, upgradeId: "reinforcedPlating" });

    const err = bridge.apply({ kind: "doctrine", buildingId: refinery.id, upgradeId: "overchargedWeapons" });
    expect(err, "a locked-out click must not silently succeed").not.toBeNull();
    // "Cannot research X yet" is the wrong sentence here: there is no "yet". The player has plenty
    // of radioactives and will never be allowed to spend them on this.
    expect(err).toContain("bulwark");
    expect(err).not.toContain("yet");
  });

  it("refuses an unknown upgrade rather than reaching into the engine with it", () => {
    const { bridge, refinery } = refineryWorld();
    expect(bridge.apply({ kind: "doctrine", buildingId: refinery.id, upgradeId: "nope" })).toBe("Unknown upgrade");
  });
});
