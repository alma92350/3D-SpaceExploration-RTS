// News from worlds you are not standing on (PARITY rows 93 and 94).
//
// Two sources, one board, and the reason they are one board is that they are one question: *what
// happened in the galaxy while I was looking at this battlefield?*
//
//   • **Row 93** — `sweepColonies` returns `{type: "lost" | "hostile" | "attacked", planetId}` and
//     `WorldBridge.takeColonyNotes()` hands them over. They are the only channel that says a colony
//     is being attacked while the player is elsewhere.
//   • **Row 94** — `galaxy.milestones`, `galaxy.pacifyNotes` and `galaxy.expansionNotes` are queues
//     the engine fills for a UI to drain. Upstream's `boot.js` drains them; nothing in this client
//     does. `galaxy.rivalGateNotes` is a fourth queue of exactly the same shape that the board row
//     does not name, and `galaxy.lastReliefTime` is a fifth channel that is not a queue at all.
//
// ================================================================================================
// WHY THIS IS BESIDE `view/alerts.ts` AND NOT IN IT
// ================================================================================================
//
// `AlertFeed` is the client's existing attention board, and the question was asked before this file
// was written rather than assumed. Three things put colony news outside it, and the third is fatal:
//
//   1. **`AlertFeed` cannot see any of this.** Its header's whole fog argument is "the snapshot is
//      the only input" — `view/` may not import the engine (ADR-0008), so the class physically
//      cannot ask the galaxy anything. Every input here comes off the *galaxy*, through the bridge.
//      Feeding it in would delete the constraint that makes `AlertFeed` safe.
//   2. **An alert is a place.** Its pool is keyed on x/y within `ALERT_MERGE_RADIUS`, and "focus
//      last alert" jumps the camera there. A colony note has no position on the seat's map: every
//      one of these would land on the same non-position and coalesce with each other regardless of
//      which world they were about.
//   3. **`Game.adoptSeat()` calls `alerts.clear()` on every jump**, deliberately — alert positions
//      belong to the map the player just left. Colony news is *about the worlds you are not on*, so
//      an alert board would erase it at the exact moment it becomes the only thing worth knowing.
//
// So: beside it. `AlertFeed` is seat-scoped and a jump clears it; `NewsFeed` is galaxy-scoped and a
// jump does not touch it. The two never hold the same event.
//
// ================================================================================================
// NOBODY DRAINS ANYTHING, AND THAT IS THE DESIGN
// ================================================================================================
//
// **The galaxy queues are read through a cursor and never emptied.** Draining one from `ui/` is a
// write to a galaxy field, which is what ADR-0008 §3 forbids ("nothing above the bridge may write a
// sim field") and what `relief-panel.ts` already refuses to do to `galaxy.reliefNote`. It would also
// break a row that has already shipped: `ui/milestones-panel.ts` REPORTS `galaxy.milestones` as the
// cumulative firework list (row 99), so a drainer here would quietly empty that panel. The cursor is
// client state in exactly `view/alerts.ts`' sense — one player's attention, never a fact about the
// world, and nothing the engine can see.
//
// **The colony notes are drained by the SHELL, and this file is handed the result.** `takeColonyNotes`
// is a *take*: whoever calls it consumes the queue. A model that called it could not be called twice
// — which is precisely what `EconomyCache` and `GalaxyCache` rely on, both of them proving "nothing
// was rebuilt" by reference equality — and a second caller in the same frame would silently see an
// empty list. `app/game.ts` already drains it once per frame; `ingest` takes what that drain
// returned.
//
// **Every queue was checked for `reliefNote`'s shape before being trusted.** `galaxy.reliefNote` is
// a LATCH: raised on every dispatch and never lowered by anything in this client, so a toast on it
// would show for the rest of the run. It is not read here at all. The edge relief actually has is
// `lastReliefTime` CHANGING, and that is what this file watches. The four queues are genuinely
// append-only and were checked: `reachMilestone` pushes once per id and `galaxy.reached` latches so
// it can never push twice; `checkDomination` pushes a world id once and `galaxy.pacified` latches;
// `checkExpansion` pushes once per claim and `galaxy.claims` latches; `checkRivalGate`'s `spotted`
// is the one that can repeat, and it repeats for a real reason (a new Gate got tracked).
//
// ================================================================================================
// A QUEUE IS CUMULATIVE, WHICH IS NOT THE SAME AS RECENT
// ================================================================================================
//
// `milestones-panel.ts` says it plainly: the queue is everything since the galaxy was created or
// loaded, because nothing drains it. So "everything in the queue" is emphatically **not** "what just
// happened", and a feed that raised a toast per entry on first sight would open a session by firing
// every firework of the run at once.
//
// The cursor is therefore PRIMED to each queue's current length the first time a galaxy is seen, and
// `NewsModel.since` reports the galaxy clock that happened at. This feed reports what happened while
// it was watching and says when it started. The alternative — replaying the backlog — is the bug
// this paragraph exists to have already refused.

import { FACTIONS, PLANETS } from "../engine/index.js";
import { milestoneLabel } from "./milestones-panel.js";
import type { ColonyNote } from "../bridge/world.js";

/**
 * Which channel an entry came from. The engine's own sub-type rides along in `topic` unnarrowed —
 * `bridge/world.ts` and `bridge/galaxy-snapshot.ts`' reason: a fourth kind added upstream must
 * arrive as itself rather than being folded into one of these by a mapping nobody would check.
 */
export type NewsSource = "colony" | "milestone" | "pacified" | "expansion" | "rivalGate" | "relief";

/**
 * How long one entry keeps absorbing repeats of itself, in **galaxy** seconds.
 *
 * `sweepColonies` raises `attacked` on every sweep that finds a fresh player death, and a background
 * world ticks every `BG_STEP` (4) steps — so a one-minute raid on a colony can push three hundred
 * notes for one thing that is happening. Thirty seconds makes that raid one line carrying a count,
 * and still lets a second raid a minute later announce itself.
 *
 * Measured from the entry's FIRST event and never slid forward, which is `ALERT_WINDOW_SECONDS`'
 * rule and its reasoning: a sliding window gives a twenty-minute siege exactly one line, raised at
 * the start and never repeated.
 */
export const NEWS_MERGE_SECONDS = 30;

/**
 * How long the newest unread entry is offered as a toast, in galaxy seconds.
 *
 * Measured from `lastAt`, not `at`, so an entry that is still absorbing a raid stays up while the
 * raid is on and retires when it stops.
 */
export const NEWS_TOAST_SECONDS = 8;

/**
 * How many entries the board keeps. Newest kept, oldest discarded, and the discards are COUNTED —
 * see `NewsModel.dropped`. A history that silently forgets is a history that cannot be trusted.
 */
export const NEWS_LIMIT = 32;

export interface NewsEntry {
  /**
   * Stable handle for `markSeen`, minted in arrival order. Never an index: the pool is compacted at
   * the front when the cap bites, which is `AlertFeed.latest()`' lesson about ids meaning "later".
   */
  readonly id: number;
  readonly source: NewsSource;
  /**
   * The engine's own word for what this is, unnarrowed and never mapped away: `"lost"`, `"hostile"`,
   * `"attacked"`, a milestone id, `"claim"`, `"expand"`, `"factionEcho"`, `"spotted"`, `"ascended"`.
   * Empty for the two channels that carry no sub-type of their own.
   */
  readonly topic: string;
  /** The world it is about, or null where the channel names none. */
  readonly planetId: string | null;
  /** The faction the engine named on this note, where it named one. */
  readonly faction: string | null;
  /** One line, in the player's words. */
  readonly text: string;
  /** `galaxy.time` when this entry's FIRST event was seen. The merge window is measured from here. */
  readonly at: number;
  /** `galaxy.time` of the most recent event folded in — "still happening". */
  readonly lastAt: number;
  /** How many engine events this one line stands for. 1 for everything that cannot repeat. */
  readonly count: number;
  readonly seen: boolean;
}

export interface NewsInput {
  readonly galaxy: Galaxy;
  /**
   * Whatever `WorldBridge.takeColonyNotes()` just returned. **Already drained by the caller** — see
   * this file's header. Pass an empty array when nothing was drained; never call the bridge here.
   */
  readonly colonyNotes: readonly ColonyNote[];
  /**
   * `galaxy.time`, the one monotonic clock across a run.
   *
   * Passed rather than read for `savePanelModel`'s reason — every string this module produces stays
   * a pure function of its inputs — and it must be the GALAXY clock and not `activeState(galaxy).time`,
   * which is `relief-panel.ts`' argument: each world's clock advances independently, so a jump makes
   * a seat clock read as "elapsed" or "never elapses" depending on which way the two drifted.
   */
  readonly now: number;
}

export interface NewsModel {
  /** Newest first — the order a board is read in. */
  readonly entries: readonly NewsEntry[];
  readonly unseen: number;
  /**
   * The newest unseen entry whose window is still open, or null.
   *
   * This is the toast, and it is a QUERY rather than an event: asking twice gives the same answer
   * and asking never loses anything, so a HUD that skips a frame misses nothing.
   */
  readonly toast: NewsEntry | null;
  /** The newest entry's id, or null on an empty board. A HUD's "jump to newest" handle. */
  readonly latestId: number | null;
  /**
   * Engine events folded in since this board started watching — merges counted, discards counted.
   *
   * Not `entries.length + dropped`: a raid that coalesced into one line contributed one entry and
   * three hundred events, and the difference between those two numbers is the whole point of the
   * merge window.
   */
  readonly total: number;
  /** How many entries the cap discarded. Reported rather than hidden. */
  readonly dropped: number;
  /**
   * How many times a galaxy queue shrank under the cursor — somebody else drained it, or a load
   * emptied it. Entries between the last read and the reset are gone; saying so is cheaper than a
   * silent gap in a news feed.
   */
  readonly resynced: number;
  /**
   * The galaxy clock when this feed started watching the galaxy it is watching, or null before its
   * first `ingest`. Everything older than this happened before the board existed and is not here —
   * see the header on why the backlog is deliberately not replayed.
   */
  readonly since: number | null;
}

/**
 * The board's memory.
 *
 * It holds three things and only three: the entries, a read cursor per galaxy queue, and the
 * `lastReliefTime` it has already seen. All of it is client state in `view/alerts.ts`' sense —
 * nothing in the engine knows it exists, and none of it may ever become simulation state, because a
 * dismissal that reached `hashState` would desync a replay against a player who clicked differently.
 *
 * `version` is bumped whenever anything changes, so a drawer can cache on it exactly as `GalaxyCache`
 * caches on `galaxy.tick`.
 */
export class NewsFeed {
  /** Oldest first. `newsModel` reverses; nothing outside this class should read it directly. */
  private readonly entries: NewsEntry[] = [];
  private nextId = 1;
  private total = 0;
  private dropped = 0;
  private resynced = 0;
  private since: number | null = null;
  /** The galaxy these cursors belong to, so a load is NOTICED rather than assumed. */
  private galaxy: Galaxy | null = null;
  private readonly cursors = new Map<string, number>();
  /** `lastReliefTime` already accounted for. `undefined` means "no drop has ever happened". */
  private reliefAt: number | undefined = undefined;

  /** Changes on every mutation. A cache key, never a count of anything. */
  version = 0;

  /**
   * Fold one observation into the board.
   *
   * **Idempotent with respect to the galaxy**: the queues are read through a cursor and the relief
   * clock through a stored value, so calling this twice on one tick adds nothing twice. The one
   * input that is not idempotent is `colonyNotes`, because the caller already destroyed it by
   * draining — so the contract is simply that a drained note is handed over exactly once.
   *
   * That makes it safe on a frame or on a step. `app/game.ts` drains the bridge on a frame today,
   * which is why this is not `ingestTick`.
   */
  ingest(input: NewsInput): void {
    const galaxy = input.galaxy;
    const now = input.now;
    // A load replaces the galaxy object outright (`WorldBridge.load` reassigns `#galaxy`), and
    // `deserializeGalaxy` rebuilds every one of these queues empty. Adopting by IDENTITY is the
    // same guard `WorldBridge.refresh` puts on its extractor's map: notice the swap rather than
    // hope the numbers happen to line up.
    if (this.galaxy !== galaxy) this.adopt(galaxy, now);

    for (const note of input.colonyNotes) {
      this.raise(now, {
        source: "colony",
        topic: typeof note.type === "string" ? note.type : "",
        planetId: typeof note.planetId === "string" ? note.planetId : null,
        faction: null,
      });
    }

    // Read order is the order a player would want them: what the galaxy celebrated, what fell, how
    // the map is being carved up, then the race. It is not the order the engine pushes in — nothing
    // above the bridge can know that — so entries raised on one tick share a timestamp and are
    // separated only by their arrival id, exactly as two alerts on one tick are.
    for (const raw of this.fresh(galaxy, "milestones")) {
      if (typeof raw !== "string") continue;
      this.raise(now, { source: "milestone", topic: raw, planetId: null, faction: null });
    }
    for (const raw of this.fresh(galaxy, "pacifyNotes")) {
      if (typeof raw !== "string") continue;
      this.raise(now, { source: "pacified", topic: "", planetId: raw, faction: null });
    }
    for (const raw of this.fresh(galaxy, "expansionNotes")) {
      const note = asNote(raw);
      if (!note) continue;
      this.raise(now, {
        source: "expansion",
        topic: note.type,
        planetId: note.planetId,
        faction: note.faction,
        from: note.from,
      });
    }
    for (const raw of this.fresh(galaxy, "rivalGateNotes")) {
      const note = asNote(raw);
      if (!note) continue;
      this.raise(now, { source: "rivalGate", topic: note.type, planetId: note.planetId, faction: null });
    }

    // Relief is an EDGE, not a queue. `galaxy.reliefNote` is upstream's own toast flag and it
    // latches — raised on every dispatch, drained by upstream's `boot.js` and by nothing here — so
    // reading it would put a toast on screen for the rest of the run. `lastReliefTime` is stamped
    // with the galaxy clock of each drop, so a CHANGE in it is the moment a ship actually arrived.
    const relief = galaxy.lastReliefTime;
    if (relief !== undefined && relief !== this.reliefAt) {
      this.reliefAt = relief;
      this.raise(now, { source: "relief", topic: "", planetId: galaxy.activeId, faction: null });
    }
  }

  /** Put one entry away. Idempotent, and false for a stranger — `AlertFeed.dismiss`' contract. */
  markSeen(id: number): boolean {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return false;
    if (!this.entries[i]!.seen) {
      this.entries[i] = { ...this.entries[i]!, seen: true };
      this.version++;
    }
    return true;
  }

  /** The "mark all read" control. */
  markAllSeen(): void {
    let changed = false;
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i]!.seen) continue;
      this.entries[i] = { ...this.entries[i]!, seen: true };
      changed = true;
    }
    if (changed) this.version++;
  }

  /**
   * Drop everything and forget which galaxy was being watched.
   *
   * The id counter is NOT reset, for `AlertFeed.clear`'s reason: a HUD holding a handle across the
   * clear would otherwise mark whatever entry is minted into that number next as read.
   */
  clear(): void {
    this.entries.length = 0;
    this.cursors.clear();
    this.galaxy = null;
    this.since = null;
    this.reliefAt = undefined;
    this.total = 0;
    this.dropped = 0;
    this.resynced = 0;
    this.version++;
  }

  /** Everything `newsModel` reads. Internal; the model is the public shape. */
  read(): {
    entries: readonly NewsEntry[]; total: number; dropped: number; resynced: number; since: number | null;
  } {
    return {
      entries: this.entries, total: this.total, dropped: this.dropped,
      resynced: this.resynced, since: this.since,
    };
  }

  /**
   * Start watching a galaxy: the board emptied, cursors primed to what is already queued, relief
   * primed to whatever drop has already happened.
   *
   * **Primed, not zeroed.** The queues are cumulative since the galaxy was created or loaded (see
   * the header), so starting at zero would replay every firework of a loaded run as a fresh toast.
   *
   * **And the board is emptied, which is not tidiness.** The only thing that swaps the galaxy under
   * this feed is a load, and a load throws the run away: the news on the board is about a galaxy
   * that no longer exists. Keeping it would be merely confusing; what it would actually do is
   * *merge* — a colony lost on the discarded run and the same colony lost on the loaded one share a
   * source, a topic and a world, so the second would fold into the first inside the window and the
   * count would span two universes. `Game.adoptSeat()` clears `AlertFeed` on a jump for the same
   * kind of reason, one layer down.
   */
  private adopt(galaxy: Galaxy, now: number): void {
    this.galaxy = galaxy;
    this.since = now;
    this.reliefAt = galaxy.lastReliefTime;
    this.entries.length = 0;
    // Counted since this galaxy was adopted, so they reset with it. `nextId` deliberately does not
    // — see `clear`.
    this.total = 0;
    this.dropped = 0;
    this.resynced = 0;
    this.cursors.clear();
    for (const name of QUEUES) this.cursors.set(name, queueOf(galaxy, name).length);
    this.version++;
  }

  /**
   * The entries of one queue that have appeared since it was last read, and never a mutation of it.
   *
   * A queue shorter than the cursor means it was emptied under us — a load that did not swap the
   * object, or a future drainer somewhere else. The cursor resyncs to the queue's own length and the
   * event is COUNTED, because the alternative is a news board with a silent hole in it.
   */
  private fresh(galaxy: Galaxy, name: QueueName): readonly unknown[] {
    const queue = queueOf(galaxy, name);
    const cursor = this.cursors.get(name) ?? 0;
    if (queue.length < cursor) {
      this.cursors.set(name, queue.length);
      this.resynced++;
      this.version++;
      return NONE;
    }
    if (queue.length === cursor) return NONE;
    this.cursors.set(name, queue.length);
    return queue.slice(cursor);
  }

  /**
   * Fold one event in, or open a new entry.
   *
   * The coalescing key is **source, topic and world** — never a position, which is what separates
   * this from `AlertFeed` — and the window is measured from the entry's first event. Two different
   * worlds under attack are two lines; one world raided for a minute is one line with a count.
   *
   * **Relief is the exception, and the reason is arithmetic.** Every other source here is keyed by
   * something the engine latches — a milestone id in `galaxy.reached`, a world id in
   * `galaxy.pacified`, a claim in `galaxy.claims` — so a repeat inside the window is the same news
   * said twice and folding it is right. A relief drop is a new ship, and `checkGalaxyRescue` gates
   * drops on `RELIEF_COOLDOWN`, which is **20 seconds — shorter than this window**. So two
   * consecutive rescues would always coalesce, and the line would report one arrival while a second
   * colony ship stood on the map waiting to be deployed.
   */
  private raise(now: number, ev: RaisedEvent): void {
    for (let i = this.entries.length - 1; ev.source !== "relief" && i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.source !== ev.source || e.topic !== ev.topic || e.planetId !== ev.planetId) continue;
      if (now - e.at > NEWS_MERGE_SECONDS) break;
      // Note what is NOT touched: `at`, `seen` and `id`. Keeping `seen` is `AlertFeed`'s
      // no-resurrection rule — a dismissed line must not come back on the next tick of the same
      // raid, or a dismissal during a siege lasts one twentieth of a second.
      this.entries[i] = { ...e, lastAt: now, count: e.count + 1 };
      this.total++;
      this.version++;
      return;
    }

    this.entries.push({
      id: this.nextId++,
      source: ev.source,
      topic: ev.topic,
      planetId: ev.planetId,
      faction: ev.faction,
      text: newsText(ev),
      at: now,
      lastAt: now,
      count: 1,
      seen: false,
    });
    this.total++;
    // Oldest first out. A board that dropped the NEWEST when it filled would be a board that stops
    // working exactly when something is happening.
    while (this.entries.length > NEWS_LIMIT) {
      this.entries.shift();
      this.dropped++;
    }
    this.version++;
  }
}

/**
 * The board, newest first, with the toast picked out.
 *
 * Pure: it reads the feed and writes nothing, so calling it twice on one frame produces two equal
 * models and consumes nothing. `now` is the galaxy clock — the toast window is a countdown, and a
 * model that read the timestamp of the last `ingest` would keep a toast up through a paused game.
 */
export function newsModel(feed: NewsFeed, now: number): NewsModel {
  const state = feed.read();
  const entries = state.entries.slice().reverse();
  let unseen = 0;
  let toast: NewsEntry | null = null;
  for (const e of entries) {
    if (e.seen) continue;
    unseen++;
    // `entries` is newest first and ids only increase, so the first live one found is the newest.
    if (toast === null && now - e.lastAt <= NEWS_TOAST_SECONDS) toast = e;
  }
  return {
    entries,
    unseen,
    toast,
    latestId: entries.length > 0 ? entries[0]!.id : null,
    total: state.total,
    dropped: state.dropped,
    resynced: state.resynced,
    since: state.since,
  };
}

/* =================================================================================================
   WORDS

   Every line names the world by the engine's own `PLANETS` entry and the faction by the engine's own
   `FACTIONS` entry, both with a fall-through to the raw id. That is `milestoneLabel`'s rule applied
   to a second vocabulary: a world or a faction this file has never heard of shows up looking odd
   rather than showing up blank or not at all.
   ================================================================================================= */

interface RaisedEvent {
  readonly source: NewsSource;
  readonly topic: string;
  readonly planetId: string | null;
  readonly faction: string | null;
  /** `expansionNotes`' `expand` carries the world the expansion came FROM. */
  readonly from?: string | null;
}

function newsText(ev: RaisedEvent): string {
  const world = planetName(ev.planetId);
  const faction = factionName(ev.faction);
  switch (ev.source) {
    case "colony":
      switch (ev.topic) {
        // `lost` is the only one that reports a world gone, `hostile` is the declaration the
        // diplomacy layer latches once, `attacked` is a raid in progress. Phrased, never re-decided.
        case "lost": return `${world} is lost — nothing of yours is left standing there`;
        case "hostile": return `${world}'s neighbour has declared war on your colony`;
        case "attacked": return `Your colony on ${world} is under attack`;
        default: return `${world}: ${ev.topic || "news"}`;
      }
    // The engine's own label for the milestone, from `ui/milestones-panel.ts`, so the firework and
    // the Records board cannot end up calling the same milestone two different things.
    case "milestone": return `Milestone — ${milestoneLabel(ev.topic)}`;
    case "pacified": return `${world} is pacified — its neighbour has no base left standing`;
    case "expansion":
      switch (ev.topic) {
        case "claim": return `${faction} has claimed ${world}`;
        case "expand": return `${faction} has expanded from ${planetName(ev.from ?? null)} to ${world}`;
        // The stance penalty `checkDomination` echoes onto a pacified world's remaining
        // faction-mates. The note names the world that was RAZED, not the ones that hardened.
        case "factionEcho": return `Razing ${world} has hardened the rest of ${faction} against you`;
        default: return `${world}: ${ev.topic || "news"}`;
      }
    case "rivalGate":
      switch (ev.topic) {
        case "spotted": return `A rival Antimatter Gate is charging on ${world}`;
        // The moment row 98 exists for: `checkRivalGate` nulls its own tracked record here, so the
        // starmap's mark clears at exactly the moment the race is lost.
        case "ascended": return `A rival Antimatter Gate has completed on ${world}`;
        default: return `${world}: ${ev.topic || "news"}`;
      }
    case "relief": return `A relief colony ship has arrived on ${world}`;
  }
}

/** A world's name from the engine's own table — `hud.ts`, `jump-panel.ts` and `save-panel.ts` agree. */
function planetName(id: string | null): string {
  if (!id) return "an unknown world";
  return PLANETS.find((p) => p.id === id)?.name ?? id;
}

/** A faction's name from the engine's own table, including `neutral`, which is a real entry. */
function factionName(id: string | null): string {
  if (!id) return "an unknown faction";
  const name = FACTIONS[id]?.name;
  return typeof name === "string" ? name : id;
}

/* =================================================================================================
   THE QUEUES

   Three of these are not in the vendored declarations and one is not documented by row 94 at all, so
   they are named here once — `relief-panel.ts`' `flags()` idiom — rather than cast at each use.
   ================================================================================================= */

type QueueName = "milestones" | "pacifyNotes" | "expansionNotes" | "rivalGateNotes";

/**
 * Every append-only queue the engine keeps for a UI, in the order this board reads them.
 *
 * `rivalGateNotes` is here even though row 94 names only three: it is the same mechanism with the
 * same producer cadence, it is created LAZILY (`checkRivalGate` builds it on first use and
 * `deserializeGalaxy` does not rebuild it at all, so it is `undefined` on a fresh galaxy and on a
 * loaded one), and it carries the one event `docs/planning/PARITY.md` row 98 says the starmap stops
 * being able to show at the worst possible moment.
 */
const QUEUES: readonly QueueName[] = ["milestones", "pacifyNotes", "expansionNotes", "rivalGateNotes"];

const NONE: readonly unknown[] = [];

/** One queue, or an empty array for a lazily-created one that does not exist yet. Never created. */
function queueOf(galaxy: Galaxy, name: QueueName): readonly unknown[] {
  const q = (galaxy as unknown as Record<string, unknown>)[name];
  return Array.isArray(q) ? q : NONE;
}

interface EngineNote {
  readonly type: string;
  readonly planetId: string | null;
  readonly faction: string | null;
  readonly from: string | null;
}

/**
 * One object-shaped queue entry, read defensively.
 *
 * Total, for `describeSave`'s reason one layer down: these arrays survive a save round trip in
 * upstream's format and a hand-edited one can hold anything. A note with no readable `type` is
 * dropped rather than raised as a blank line — but a note with a type this file does not recognise
 * is KEPT and shown as itself.
 */
function asNote(raw: unknown): EngineNote | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.type !== "string" || rec.type.length === 0) return null;
  return {
    type: rec.type,
    planetId: typeof rec.planetId === "string" ? rec.planetId : null,
    faction: typeof rec.faction === "string" ? rec.faction : null,
    from: typeof rec.from === "string" ? rec.from : null,
  };
}

// A note on the other half of "reachable" (PARITY §8's first condition):
//
// This module is a model and a memory, and neither is a control. Row 93's colony half is already
// drained in `app/game.ts` and shown through `HudView.notice` — a single transient line, shared with
// command errors, overwritten by the next one, with no memory and no way back to what it said. That
// is what this replaces. Row 94's four queues reach nothing at all today. Both need the shell to
// hold one `NewsFeed`, call `ingest` where the colony drain already happens, and put `newsModel`'s
// `toast` and `entries` somewhere a player can see — which is the integration pass, and is not this
// file's to make.
