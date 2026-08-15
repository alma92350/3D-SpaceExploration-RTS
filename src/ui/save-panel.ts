// The save/load panel's model (P5-T09, ADR-0012 §4).
//
// **Nothing here serialises or deserialises a galaxy.** `serializeGalaxy`/`deserializeGalaxy` are
// upstream's, `bridge/world.ts` already wraps them as `save()`/`load()`, and P4-T09 proved the
// round trip field by field. This file is the drawer over that: it keeps saves, describes them, and
// says which one the loader will accept. A second reader of the save format would disagree with the
// first one the day upstream adds a field — so the payload is passed through untouched and only
// ever *read*, never rebuilt.
//
// Four rules follow from that, and each is a trap this row could have fallen into:
//
// **1. Describing a save must not LOAD it.** The obvious implementation of "what is in this file?"
// is `deserializeGalaxy(raw)` followed by a few questions of the result. It cannot be used, because
// `deserializeGalaxy` ends in `restoreEntityId(…)` (engine/persist.js) — it rewinds the engine's ONE
// module-global entity-id counter. Listing three saves would wind the live session's counter back
// three times and the next unit trained would be minted on top of a unit already standing. So every
// number below is read off the payload's own top-level fields, and the list costs the running game
// nothing.
//
// **2. A save is untrusted input (N-08), and this file reads it BEFORE the engine's sanitiser
// does.** `sanitizeSave` runs inside `deserializeGalaxy`, which is the LOAD path; listing happens
// first, on whatever is in storage — a hand-edited entry, a half-written one, another script's key.
// So `describeSave` is total: it returns a description of what it could not read rather than
// throwing, and it claims nothing about validity. `deserializeGalaxy` remains the only authority on
// whether a save is real.
//
// **3. The version gate is read from the payload's own `v`, never from our envelope.** The envelope
// (name, timestamp) is ours and could say anything; `v` is what the loader compares. A save from
// another version is LISTED and marked unloadable with both numbers named — the failure a player
// must never get is the silent one, where the button is live, the click is swallowed by
// `bridge.load()` returning false, and the game looks broken rather than out of date.
//
// **4. There is no index.** The list is storage's own keys under `SAVE_PREFIX`. An index is a
// second copy of the truth, and the bug it produces — a row that exists in the index and not in
// storage, or the reverse — is exactly the sort of thing that only shows up on someone else's
// machine.
//
// One thing this file deliberately does NOT carry: a warning about post-battle market prices. That
// defect was real (P4-T09 found it, a world that had grown wreck nodes re-derived a different price
// book on load), was reported as issue #92 and was FIXED upstream in 50ceb88 — the engine here is
// synced to it and `test/bridge/galaxy-save.test.ts` now pins the price book as surviving. A panel
// that warned about it would be teaching players to distrust a save that is correct.

import { GALAXY_SAVE_VERSION, PLANETS } from "../engine/index.js";

/**
 * The engine's own type id for a Command Center, and the definition of "settled".
 *
 * `hudModel` tests the same string to decide whether the player has a base. A world with a player
 * Command Center standing on it is one they hold; a world merely *reached* is a world they flew
 * over, which is why `reachedWorlds` below is a separate number rather than the same one.
 */
const COMMAND_CENTER = "command";

/** The key prefix every slot lives under. Distinct from `odyssey3d.settings.v1`, which is not one. */
export const SAVE_PREFIX = "odyssey3d.save.";

/** Slot names are shown in a list, so a long one is a broken list rather than a rich label. */
export const MAX_SAVE_NAME = 80;

/**
 * What one save is, to a human.
 *
 * Every field is read from the payload rather than remembered by us, so the row describes the bytes
 * that will actually load. `readable` is the reason: absent, unparsable and not-a-save must all be
 * *listed* — a slot the player can see is a slot they can delete, and one that silently vanishes
 * from the list is storage they can never reclaim.
 */
export interface SaveDescription {
  /** False when the payload is not an object at all — no fields below mean anything. */
  readonly readable: boolean;
  /** The version the payload stamps itself with, or null when it carries none. */
  readonly version: number | null;
  /** What this build's loader accepts — `GALAXY_SAVE_VERSION`, carried so a row can name both. */
  readonly currentVersion: number;
  /** Whether the panel will OFFER this save. Never a claim that the load will succeed. */
  readonly loadable: boolean;
  /** Why it is not offered, phrased for the player. Null when it is. */
  readonly problem: string | null;
  readonly seatId: string | null;
  /** The seat's name from the engine's own `PLANETS` table, or the raw id if it is not one. */
  readonly seatName: string;
  /** Worlds with a player Command Center standing on them. */
  readonly settledWorlds: number;
  /** Worlds the expedition has reached — `discovered`, which is larger and means less. */
  readonly reachedWorlds: number;
  readonly lanes: number;
  readonly credits: number;
  /** The galaxy clock, in sim seconds (`galaxyTime`). */
  readonly simSeconds: number;
  /** The one line the list is read by. */
  readonly summary: string;
}

/** A slot as it sits in storage. `payload` is upstream's save, untouched and unvalidated. */
export interface StoredSave {
  /** The storage key minus `SAVE_PREFIX`. */
  readonly id: string;
  readonly name: string;
  /** Wall-clock ms when it was written, or null for a payload that arrived without an envelope. */
  readonly savedAt: number | null;
  readonly payload: unknown;
}

export interface SaveCatalog {
  /**
   * Whether storage could be READ. Not a promise that it can be written: Safari's private mode
   * reads happily and throws on the first `setItem`, so `writeSave` reports its own failure and
   * this stays what it says — "the list you are looking at is the real list".
   */
  readonly available: boolean;
  /** Newest first. Slots with no timestamp sort last, by id, so the order is stable. */
  readonly saves: readonly StoredSave[];
}

/** The slice of `Storage` this module uses. Narrow so a test can pass a fake without a DOM. */
export type SaveStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

export interface SaveRow {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number | null;
  /** "just now", "12 minutes ago" — relative to the `now` the model was given, never to a clock. */
  readonly ageText: string;
  readonly description: SaveDescription;
  readonly canLoad: boolean;
  /** The summary, or the reason this row cannot be loaded. One line either way. */
  readonly detail: string;
}

export interface SavePanelModel {
  readonly rows: readonly SaveRow[];
  readonly canSave: boolean;
  /** Why saving is impossible here, or null. Shown rather than swallowed — see `writeSave`. */
  readonly storageProblem: string | null;
  /** What the Save button would call a new slot. */
  readonly suggestedName: string;
  /** Sim seconds played since the newest LOADABLE save — what loading another one would discard. */
  readonly unsavedSeconds: number;
  /** The one thing that cannot be undone, said before it happens (P2-T12). Null when nothing is. */
  readonly warning: string | null;
}

export interface SavePanelInput {
  readonly catalog: SaveCatalog;
  /** The live galaxy, for the "what you are about to save" half. */
  readonly galaxy: Galaxy;
  /** Wall-clock ms. Taken rather than read, so every string this model produces is a pure function. */
  readonly now: number;
}

/* =================================================================================================
   DESCRIBING A SAVE
   ================================================================================================= */

/**
 * One save, described from its own payload. Never throws, whatever it is handed.
 *
 * The fields read here are the ones `galaxyPayload` writes at the TOP level — `v`, `activeId`,
 * `credits`, `galaxyTime`, `discovered`, `lanes`, `planets` — plus one shallow walk of each
 * planet's `buildings` for the settled count. That is a read of upstream's format, and the way it
 * is kept honest is `test/ui/save-panel.test.ts`: every number is asserted against the live galaxy
 * the save was taken from, so a renamed field is a red test naming the field rather than a row of
 * zeroes nobody notices.
 */
export function describeSave(raw: unknown): SaveDescription {
  const p = asRecord(raw);
  if (!p) {
    return {
      ...EMPTY,
      problem: raw === null || raw === undefined
        ? "This slot is empty."
        : "This is not a save file — the panel could not read it.",
    };
  }

  const version = typeof p.v === "number" ? p.v : null;
  const planets = Array.isArray(p.planets) ? p.planets : null;
  const seatId = typeof p.activeId === "string" ? p.activeId : null;
  const settledWorlds = planets ? planets.filter(isSettled).length : 0;
  const credits = finite(p.credits);
  const simSeconds = finite(p.galaxyTime);

  // The gate, in the order a player needs it. Version first: it is the only refusal that is about
  // the FILE being fine and this build being wrong, and saying "not a save file" to a save from
  // last month's build would send someone hunting for a corrupted disk.
  const problem = version === null
    ? "This file carries no save version, so it cannot be loaded."
    : version !== GALAXY_SAVE_VERSION
      ? `Saved by a different version of the game (save v${version}, this build reads v${GALAXY_SAVE_VERSION}). It cannot be loaded.`
      : !planets || planets.length === 0
        ? "This save carries no worlds, so there would be nothing to load."
        : null;

  return {
    readable: true,
    version,
    currentVersion: GALAXY_SAVE_VERSION,
    loadable: problem === null,
    problem,
    seatId,
    seatName: planetName(seatId),
    settledWorlds,
    reachedWorlds: Array.isArray(p.discovered) ? p.discovered.length : 0,
    lanes: Array.isArray(p.lanes) ? p.lanes.length : 0,
    credits,
    simSeconds,
    summary: summaryLine(planetName(seatId), settledWorlds, credits, simSeconds),
  };
}

/**
 * The live galaxy in the same words a saved one is described in.
 *
 * Deliberately a second walk rather than `describeSave(serializeGalaxy(galaxy))`: serialising a
 * galaxy to label a button costs tens of kilobytes of JSON per rebuild, for four numbers. The two
 * paths are held together by a test that asserts they agree on a real save — which is also what
 * catches the payload field names drifting.
 */
export function liveSummary(galaxy: Galaxy): string {
  return summaryLine(
    planetName(galaxy.activeId),
    [...galaxy.planets.values()].filter(hasPlayerCommandCenter).length,
    galaxy.credits,
    galaxy.time,
  );
}

/**
 * "Helix Belt · 2 worlds · 1,340 cr · 12m".
 *
 * A slot id is useless in a list — every save of one campaign has the same one — so this is the
 * four things that actually separate two saves of the same game: where the player is standing, how
 * far the expansion has got, what the treasury looks like, and how long it has been running.
 */
function summaryLine(seat: string, settled: number, credits: number, simSeconds: number): string {
  return [
    seat,
    `${settled} ${settled === 1 ? "world" : "worlds"}`,
    `${thousands(Math.floor(credits))} cr`,
    formatDuration(simSeconds),
  ].join(" · ");
}

/** A planet payload with a player Command Center on it. Total: every level may be the wrong shape. */
function isSettled(planet: unknown): boolean {
  const p = asRecord(planet);
  if (!p || !Array.isArray(p.buildings)) return false;
  return p.buildings.some((b) => {
    const rec = asRecord(b);
    return rec?.owner === "player" && rec.type === COMMAND_CENTER;
  });
}

const hasPlayerCommandCenter = (state: State): boolean =>
  [...state.buildings.values()].some((b) => b.owner === "player" && b.type === COMMAND_CENTER);

/** A world's name from the engine's own table — `hud.ts` and `jump-panel.ts` read it the same way. */
function planetName(id: string | null): string {
  if (!id) return "Unknown world";
  return PLANETS.find((p) => p.id === id)?.name ?? id;
}

const EMPTY: SaveDescription = {
  readable: false,
  version: null,
  currentVersion: GALAXY_SAVE_VERSION,
  loadable: false,
  problem: null,
  seatId: null,
  seatName: "Unknown world",
  settledWorlds: 0,
  reachedWorlds: 0,
  lanes: 0,
  credits: 0,
  simSeconds: 0,
  summary: "Unreadable",
};

/* =================================================================================================
   THE STORE

   `localStorage`, with the same defensiveness `app/settings.ts` explains and one deliberate
   difference: **a failed write is REPORTED here, not swallowed.** Losing a graphics tier to blocked
   storage costs a player one click; losing a save costs them the session, and a Save button that
   quietly does nothing is the worst outcome this panel could produce.
   ================================================================================================= */

/**
 * `globalThis.localStorage`, or null.
 *
 * The property ACCESS is inside the try, not just the call: a browser with site data blocked throws
 * on reaching for it at all, which is the case `app/settings.ts` was written around and the reason
 * this is not simply `globalThis.localStorage ?? null`.
 */
function defaultStorage(): SaveStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Every slot in storage, newest first.
 *
 * A key that will not parse still produces a row — `payload: null`, which `describeSave` reports as
 * unreadable. Hiding it would leave the player with storage they cannot see and cannot free.
 */
export function readCatalog(storage: SaveStorage | null = defaultStorage()): SaveCatalog {
  if (!storage) return { available: false, saves: [] };
  const saves: StoredSave[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !key.startsWith(SAVE_PREFIX)) continue;
      saves.push(readSlot(key.slice(SAVE_PREFIX.length), storage.getItem(key)));
    }
  } catch {
    // Enumeration itself failed — a storage that exists and refuses to be read. Report what was
    // gathered before it gave up rather than an empty list that looks like "no saves yet".
    return { available: false, saves: sortSaves(saves) };
  }
  return { available: true, saves: sortSaves(saves) };
}

/**
 * One stored string as a slot.
 *
 * Two shapes are accepted. Ours is an envelope — `{ name, savedAt, save }` — because a save carries
 * no name of its own and `galaxyPayload` is upstream's shape to widen, not ours. A bare payload (a
 * save written by another client, or pasted in by hand) is taken as-is and listed without a name,
 * which is what makes an imported file a listing problem rather than a format problem.
 */
function readSlot(id: string, raw: string | null): StoredSave {
  if (raw === null) return { id, name: id, savedAt: null, payload: null };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { id, name: id, savedAt: null, payload: null };
  }
  const env = asRecord(parsed);
  if (!env || !("save" in env)) return { id, name: id, savedAt: null, payload: parsed };
  return {
    id,
    name: typeof env.name === "string" && env.name.length > 0 ? env.name : id,
    savedAt: typeof env.savedAt === "number" && Number.isFinite(env.savedAt) ? env.savedAt : null,
    payload: env.save,
  };
}

function sortSaves(saves: StoredSave[]): StoredSave[] {
  return saves.sort((a, b) => (b.savedAt ?? -Infinity) - (a.savedAt ?? -Infinity) || (a.id < b.id ? -1 : 1));
}

export interface WriteResult {
  readonly ok: boolean;
  readonly id: string;
  /** Why it was not stored. Null on success. */
  readonly problem: string | null;
}

/**
 * A slot id minted from the clock, unique against the catalog.
 *
 * Ids are opaque and ours; the NAME is the player's. Keeping them separate is what lets two saves
 * be called "before the raid" without one overwriting the other.
 */
export function newSaveId(now: number, catalog: SaveCatalog): string {
  const base = `s${Math.max(0, Math.floor(now))}`;
  if (!catalog.saves.some((s) => s.id === base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!catalog.saves.some((s) => s.id === candidate)) return candidate;
  }
}

/** Ids reach a storage KEY, so they are constrained rather than trusted — `newSaveId` mints these. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Write one slot, and say so when it fails.
 *
 * `payload` is whatever `bridge.save()` returned — passed straight through. This function does not
 * inspect it, and specifically does not "check it is valid first": the only thing that can answer
 * that is the loader, and a second opinion here would be the second implementation P5-T09 forbids.
 */
export function writeSave(input: {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly now: number;
  readonly storage?: SaveStorage | null;
}): WriteResult {
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  const id = input.id;
  if (!SAFE_ID.test(id)) {
    return { ok: false, id, problem: "That save slot name cannot be used." };
  }
  if (!storage) {
    return { ok: false, id, problem: STORAGE_BLOCKED };
  }
  const name = input.name.trim().slice(0, MAX_SAVE_NAME) || id;
  try {
    storage.setItem(SAVE_PREFIX + id, JSON.stringify({ name, savedAt: input.now, save: input.payload }));
    return { ok: true, id, problem: null };
  } catch (err) {
    // Quota is the failure worth naming separately: it is the one the player can DO something
    // about, by deleting a slot in this very panel.
    const quota = err instanceof Error && /quota|exceed/i.test(`${err.name} ${err.message}`);
    return {
      ok: false,
      id,
      problem: quota
        ? "There was no room left in this browser's storage — delete a save and try again."
        : "This browser refused to store the save, so it was not written.",
    };
  }
}

export function deleteSave(id: string, storage: SaveStorage | null = defaultStorage()): WriteResult {
  if (!storage) return { ok: false, id, problem: STORAGE_BLOCKED };
  try {
    storage.removeItem(SAVE_PREFIX + id);
    return { ok: true, id, problem: null };
  } catch {
    return { ok: false, id, problem: "This browser refused to delete the save." };
  }
}

const STORAGE_BLOCKED =
  "This browser is not storing data for this page, so saves cannot be kept. The game still runs.";

/* =================================================================================================
   THE MODEL
   ================================================================================================= */

export function savePanelModel(input: SavePanelInput): SavePanelModel {
  const rows = input.catalog.saves.map((save): SaveRow => {
    const description = describeSave(save.payload);
    return {
      id: save.id,
      name: save.name,
      savedAt: save.savedAt,
      ageText: formatAge(save.savedAt, input.now),
      description,
      canLoad: description.loadable,
      detail: description.problem ?? description.summary,
    };
  });

  // What a load would cost, measured on the galaxy's own clock against the newest save this build
  // could actually open. An unloadable save is not a fallback, so it does not count as one.
  const newest = rows.filter((r) => r.canLoad)
    .reduce((max, r) => Math.max(max, r.description.simSeconds), -1);
  const unsavedSeconds = newest < 0 ? input.galaxy.time : Math.max(0, input.galaxy.time - newest);

  return {
    rows,
    canSave: input.catalog.available,
    storageProblem: input.catalog.available ? null : STORAGE_BLOCKED,
    suggestedName: liveSummary(input.galaxy),
    unsavedSeconds,
    // Only when there is something to lose AND somewhere to lose it to. A first session with no
    // saves has no load button to press, and a warning nobody can act on is noise that teaches
    // players to ignore the next one.
    warning: rows.some((r) => r.canLoad) && unsavedSeconds > 0
      ? `Loading replaces the game in progress — ${formatDuration(unsavedSeconds)} of play since the last save.`
      : null,
  };
}

/* =================================================================================================
   FORMATTING

   All of it pure, and all of it locale-free. `toLocaleString` would put the panel's output at the
   mercy of the machine's ICU data, which is a strange thing for a test to assert on and a stranger
   thing for two players comparing screenshots.
   ================================================================================================= */

/**
 * Sim time as a player counts it.
 *
 * Not `hud.ts`'s `formatClock`, which is `M:SS` and right for a match clock. An Odyssey runs for
 * hours, and "184:07" is not a duration anybody reads.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(finite(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Wall-clock age, relative to a `now` the caller supplies — never to `Date.now()` inside a model. */
export function formatAge(savedAt: number | null, now: number): string {
  if (savedAt === null) return "unknown";
  const seconds = Math.floor((now - savedAt) / 1000);
  if (seconds < 0) return "just now";              // a clock that moved backwards; not the player's problem
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** 1340 -> "1,340". A credit balance is the number a player compares two saves by. */
function thousands(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(n));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return sign + out;
}

/** A plain object, or null. Arrays are not records: `planets` is an array and `planets[0]` is not. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** A number, or 0. Every field here comes off untrusted JSON, where `"500"` and NaN both happen. */
function finite(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
