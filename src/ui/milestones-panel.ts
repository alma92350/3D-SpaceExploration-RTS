// Milestones, domination, and the fireworks (P5-T06).
//
// The Odyssey has no victory to show, so this is what it has instead: `reachMilestone` fires a
// one-time firework for each thing the galaxy has watched you do, `checkDomination` counts the
// worlds you have taken, and neither ever ends the run.
//
// **Every row here is the engine's own answer to its own question.** `checkGalaxyProgress` decides
// what a settled world is, what a fortified Capital is, and when a Gate is online;
// `checkDomination` decides what "pacified" means and stamps `DOMINATION_TARGET` when it is met.
// Their answers live in exactly two places — `galaxy.reached` (latched, persisted, so a reload does
// not replay a firework) and `galaxy.pacified` — and this file reads those and nothing else. The
// tempting alternative is to re-derive the list: walk the worlds, count the Command Centers, and
// decide for yourself that the Capital milestone is earned. That agrees today, and it stops
// agreeing the first time either function changes its mind — the exact failure `Building.lastTier`'s
// own declaration warns about ("report it; never re-derive it").
//
// **The count and the milestone are two different facts, and this model refuses to merge them.**
// `pacified >= DOMINATION_TARGET` is not the same claim as `reached.has("domination")`: the galaxy's
// progress scans run once a second, not once a tick, so there is a real window in which the count
// has arrived and the firework has not. `milestoneReached` is the engine's answer; `pendingScan`
// names the gap rather than hiding it. A panel that computed the milestone from the count would be
// right most of the time and would be a lie during the window — and would keep being a lie if the
// engine ever put another condition in front of the target.
//
// **`MILESTONE_IDS` is a vocabulary, and vocabularies grow.** The named rows are built by mapping
// `MILESTONE_IDS` itself, so an id added upstream gets a row without this file being touched;
// `milestoneLabel` falls back to a readable form of the id rather than dropping what it does not
// recognise. And what `isMilestoneId` rejects is kept in `unknown` as evidence, on the same
// reasoning `bridge/galaxy-snapshot.ts` keeps `unknownStatuses`: a milestone silently swallowed is
// indistinguishable from one never earned.
//
// **Nothing here runs a scan.** `checkGalaxyProgress` and `checkDomination` are mutators — they add
// to `reached`, push to `milestones`, and stamp diplomacy flags. Calling either from a panel would
// mean opening the panel raised fireworks, so this file calls neither.

import { DOMINATION_TARGET, MILESTONE_IDS, isMilestoneId } from "../engine/index.js";

/** A `world:N` milestone — `isMilestoneId`'s own second family, matched by its own pattern. */
const WORLD_MILESTONE = /^world:(\d+)$/;

/**
 * Labels for the named milestones the engine mints today.
 *
 * `domination`'s label carries `DOMINATION_TARGET` rather than the number 4, so a re-tuned target
 * moves the copy with it. Deliberately NOT the source of the row list — see `milestoneLabel`.
 */
const NAMED_LABELS: Readonly<Record<string, string>> = {
  capital: "Capital fortified",
  gate: "Antimatter Gate online",
  domination: `${DOMINATION_TARGET} worlds pacified`,
  "domination:all": "Every world pacified",
  "rival-gate": "A rival Gate ascended",
};

/**
 * A readable name for any milestone id, including ones this file has never heard of.
 *
 * The fallback is what makes the vocabulary safe to grow: a sixth entry in `MILESTONE_IDS` shows up
 * as a row with its own id for a name, rather than as a blank or as nothing at all.
 */
export function milestoneLabel(id: string): string {
  const named = NAMED_LABELS[id];
  if (named) return named;
  const world = WORLD_MILESTONE.exec(id);
  if (world) return `${world[1]} worlds settled`;
  return id;
}

export interface MilestoneRow {
  readonly id: string;
  readonly label: string;
  /** `named` for a `MILESTONE_IDS` entry, `world` for the `world:N` family. */
  readonly kind: "named" | "world";
  /** `galaxy.reached.has(id)` — latched by `reachMilestone`, never inferred from world state. */
  readonly reached: boolean;
}

export interface DominationModel {
  /** `galaxy.pacified.size` — the set `checkDomination` writes, not a re-count of the roster. */
  readonly pacified: number;
  /** `DOMINATION_TARGET`. */
  readonly target: number;
  readonly remaining: number;
  /** The pacified world ids, in the galaxy's own roster order. */
  readonly worlds: readonly string[];
  readonly totalWorlds: number;
  /**
   * `reached.has("domination")` — the ENGINE's answer, and never `pacified >= target`.
   *
   * The two are the same number today and are not the same claim.
   */
  readonly milestoneReached: boolean;
  /** `reached.has("domination:all")` — the grander one, for pacifying the whole roster. */
  readonly allMilestoneReached: boolean;
  /**
   * The count has reached the target but the engine has not raised the milestone.
   *
   * Normal and brief: the galaxy's progress scans are throttled to roughly once a second. Reported
   * rather than smoothed over, because the alternative is a panel that answers a question the
   * engine has not answered yet.
   */
  readonly pendingScan: boolean;
}

export interface MilestonesPanelModel {
  /** One row per `MILESTONE_IDS` entry, in the engine's own order. Never filtered. */
  readonly named: readonly MilestoneRow[];
  /** The `world:N` milestones actually in `reached`, ascending by N. Never invented from the roster. */
  readonly worlds: readonly MilestoneRow[];
  /** Named milestones reached, of the whole vocabulary. */
  readonly reachedCount: number;
  readonly namedTotal: number;
  /**
   * `galaxy.milestones` — the undrained firework queue, in the order `reachMilestone` raised them.
   *
   * Transient and cumulative: nothing in this app drains it, so this is every firework since the
   * galaxy was created or loaded, oldest first.
   */
  readonly fireworks: readonly MilestoneRow[];
  /**
   * Ids in `reached` or `milestones` that `isMilestoneId` rejects, in the order found.
   *
   * Empty in the steady state — `deserializeGalaxy` filters a loaded set through the same predicate.
   * Kept rather than dropped so a junk id reads as junk instead of as an absence.
   */
  readonly unknown: readonly string[];
  readonly domination: DominationModel;
}

/**
 * What the galaxy has celebrated, and how far the conquest has got.
 *
 * Pure. It calls no scan, raises no milestone, and drains no queue: running it twice on the same
 * galaxy produces the same model and leaves the galaxy exactly as it was.
 */
export function milestonesPanelModel(galaxy: Galaxy): MilestonesPanelModel {
  const reached: ReadonlySet<string> = galaxy.reached ?? new Set<string>();
  const unknown: string[] = [];
  const note = (id: string): void => { if (!isMilestoneId(id) && !unknown.includes(id)) unknown.push(id); };

  // The named vocabulary, mapped from the ENGINE's list — so a sixth id upstream becomes a sixth
  // row here with no edit, and a row can never survive an id being retired.
  const named: MilestoneRow[] = MILESTONE_IDS.map((id) => ({
    id, label: milestoneLabel(id), kind: "named" as const, reached: reached.has(id),
  }));

  // The `world:N` family, read OUT of `reached` rather than counted off the worlds the player holds.
  // Contiguity is not assumed: `checkGalaxyProgress` fills 1..N, but a hand-edited save that
  // survived `isMilestoneId` need not, and a panel that reported "5 worlds" off a lone `world:5`
  // would be inventing four milestones the engine never raised.
  const worlds: MilestoneRow[] = [];
  for (const id of reached) {
    note(id);
    const m = WORLD_MILESTONE.exec(id);
    if (m) worlds.push({ id, label: milestoneLabel(id), kind: "world", reached: true });
  }
  worlds.sort((a, b) => worldIndex(a.id) - worldIndex(b.id));

  const fireworks: MilestoneRow[] = [];
  for (const raw of galaxy.milestones) {
    if (typeof raw !== "string") continue;
    note(raw);
    fireworks.push({
      id: raw,
      label: milestoneLabel(raw),
      kind: WORLD_MILESTONE.test(raw) ? "world" : "named",
      // A queued firework is reached by construction — `reachMilestone` latches before it pushes.
      reached: true,
    });
  }

  const pacifiedSet: ReadonlySet<string> = galaxy.pacified ?? new Set<string>();
  const pacified = pacifiedSet.size;
  const milestoneReached = reached.has("domination");

  return {
    named,
    worlds,
    reachedCount: named.filter((r) => r.reached).length,
    namedTotal: named.length,
    fireworks,
    unknown,
    domination: {
      pacified,
      target: DOMINATION_TARGET,
      remaining: Math.max(0, DOMINATION_TARGET - pacified),
      worlds: galaxy.worlds.filter((id) => pacifiedSet.has(id)),
      totalWorlds: galaxy.worlds.length,
      milestoneReached,
      allMilestoneReached: reached.has("domination:all"),
      pendingScan: pacified >= DOMINATION_TARGET && !milestoneReached,
    },
  };
}

function worldIndex(id: string): number {
  const m = WORLD_MILESTONE.exec(id);
  return m ? Number(m[1]) : 0;
}
