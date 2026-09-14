import { WATCH_HISTORY_KEY, HISTORY_MAX_ENTRIES } from '../constants';
import ext from './browser';
import { createMutex } from './mutex';
import { enqueue } from './syncQueue';

export interface HistoryEntry {
  id: string;          // JW media id — stable per-video key
  title: string;
  thumbnail?: string;
  url: string;         // full player URL, to reopen the video
  positionSec: number; // resume point
  durationSec: number; // for the progress bar
  updatedAt: number;   // last viewed — drives recency sort
}

// Stored as a map keyed by id: re-watching updates the same entry (O(1) dedupe)
// instead of appending duplicates. The list view derives order from updatedAt.
type HistoryMap = Record<string, HistoryEntry>;

// `ext.storage.local` is the local cache; Supabase is the source of truth. Reads
// stay synchronous-fast and work offline, and every mutation additionally queues
// an op for the background worker to push. See src/background.ts.
const lock = createMutex();

async function readMap(): Promise<HistoryMap> {
  const result = await ext.storage.local.get([WATCH_HISTORY_KEY]);
  return (result[WATCH_HISTORY_KEY] as HistoryMap | undefined) ?? {};
}

async function writeMap(map: HistoryMap): Promise<void> {
  await ext.storage.local.set({ [WATCH_HISTORY_KEY]: map });
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getEntry(id: string): Promise<HistoryEntry | undefined> {
  const map = await readMap();
  return map[id];
}

// Create on first qualify, or refresh metadata on re-watch. Always bumps recency.
// Existing values win when the new payload omits them (e.g. metadata fetch failed).
export async function recordView(entry: {
  id: string;
  title?: string;
  thumbnail?: string;
  url: string;
  positionSec: number;
  durationSec: number;
}): Promise<void> {
  await lock(async () => {
    const map = await readMap();
    const prev = map[entry.id];
    map[entry.id] = {
      id: entry.id,
      url: entry.url,
      title: entry.title || prev?.title || 'VBTV replay',
      thumbnail: entry.thumbnail ?? prev?.thumbnail,
      positionSec: entry.positionSec,
      durationSec: entry.durationSec || prev?.durationSec || 0,
      updatedAt: Date.now(),
    };
    await writeMap(prune(map));
  });
  await enqueue({ kind: 'upsert', id: entry.id, at: Date.now() });
}

// Lightweight position update for an already-recorded video (the throttled
// resume-time save). No-op if the video was never qualified.
export async function savePosition(
  id: string,
  positionSec: number,
  durationSec?: number,
): Promise<void> {
  const saved = await lock(async () => {
    const map = await readMap();
    const prev = map[id];
    if (!prev) return false;
    map[id] = {
      ...prev,
      positionSec,
      durationSec: durationSec || prev.durationSec,
      updatedAt: Date.now(),
    };
    await writeMap(map);
    return true;
  });
  if (saved) await enqueue({ kind: 'upsert', id, at: Date.now() });
}

export async function removeEntry(id: string): Promise<void> {
  await lock(async () => {
    const map = await readMap();
    if (!(id in map)) return;
    delete map[id];
    await writeMap(map);
  });
  // Queue the tombstone even when the entry was already gone locally: it may
  // still be live remotely (e.g. pruned out of this device's cache).
  await enqueue({ kind: 'delete', id, at: Date.now() });
}

export async function clearHistory(): Promise<void> {
  await lock(() => writeMap({}));
  await enqueue({ kind: 'clear', at: Date.now() });
}

// Fold a pull from Supabase into the local cache. Last-write-wins on `updatedAt`,
// so a position saved locally while offline is not clobbered by a staler row.
// Queues nothing — this is the inbound direction.
//
// Returns whether anything actually changed, so the caller can skip the write:
// every write to WATCH_HISTORY_KEY fans out to `ThumbnailProgress`, which
// re-reads the map and re-scans the document, and a no-op pull should not.
export async function mergeRemote(
  remote: HistoryEntry[],
  opts: { tombstoned?: string[]; protectedIds?: string[] } = {},
): Promise<boolean> {
  return lock(async () => {
    const map = await readMap();
    const keep = new Set(opts.protectedIds ?? []);
    let changed = false;

    for (const entry of remote) {
      const local = map[entry.id];
      if (!local || entry.updatedAt > local.updatedAt) {
        map[entry.id] = entry;
        changed = true;
      }
    }

    // Deleted on another device. Skip ids with a push still pending locally —
    // those are newer local intent that hasn't reached the server yet.
    for (const id of opts.tombstoned ?? []) {
      if (keep.has(id) || !(id in map)) continue;
      delete map[id];
      changed = true;
    }

    if (!changed) return false;
    await writeMap(prune(map));
    return true;
  });
}

// Keep only the most-recent HISTORY_MAX_ENTRIES.
function prune(map: HistoryMap): HistoryMap {
  const entries = Object.values(map);
  if (entries.length <= HISTORY_MAX_ENTRIES) return map;
  const keep = entries
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_MAX_ENTRIES);
  return Object.fromEntries(keep.map((e) => [e.id, e]));
}
