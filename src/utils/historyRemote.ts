import { HISTORY_MAX_ENTRIES, WATCH_HISTORY_TABLE } from '../constants';
import type { HistoryEntry } from './history';
import { log } from './logger';
import { getClient } from './supabase';
import { ensureVideo } from './videosRemote';

// The `watch_history` row shape — narrower than `HistoryEntry`, because the table
// now holds only what this account *did* with a video: where playback got to, and
// when. What the video *is* (title, thumbnail, url) lives in `videos`, and is
// joined back in on read to rebuild the entry the popup expects.
//
// `deleted_at` is a tombstone rather than a hard delete — without it the next
// pull would resurrect anything removed from the popup.
//
// There is no `user_id`. This is a single-account extension, so the account is
// implicit: RLS grants the whole table to the `authenticated` role, and the
// bundled anon key still sees nothing. `media_id` alone is the primary key.
interface WatchHistoryRow {
  media_id: string;
  position_sec: number;
  duration_sec: number;
  updated_at: string;
  deleted_at: string | null;
}

// A row with its parent embedded. There is exactly one foreign key between the
// two tables, so PostgREST resolves `videos(...)` without a disambiguating hint,
// and returns a to-one embed as an object rather than an array.
interface JoinedRow extends WatchHistoryRow {
  videos: { title: string; thumbnail: string | null; url: string } | null;
}

// A joined row that survived the null check in `pullRecent`.
type EntryRow = JoinedRow & { videos: NonNullable<JoinedRow['videos']> };

function toRow(entry: HistoryEntry): WatchHistoryRow {
  return {
    media_id: entry.id,
    position_sec: entry.positionSec,
    duration_sec: entry.durationSec,
    updated_at: new Date(entry.updatedAt).toISOString(),
    deleted_at: null,
  };
}

function toEntry(row: EntryRow): HistoryEntry {
  return {
    id: row.media_id,
    title: row.videos.title,
    thumbnail: row.videos.thumbnail ?? undefined,
    url: row.videos.url,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    updatedAt: Date.parse(row.updated_at),
  };
}

// Insert-or-update by media_id. Also clears any tombstone, so re-watching a
// previously removed video brings it back.
//
// `media_id` is a foreign key into `videos`, so the parent row has to be there
// first. The click that started this video normally created it, but not always —
// see `ensureVideo`, which exists for the cases where it didn't.
//
// Since the title and thumbnail moved out of this table, that call is also the
// only way a watched video's metadata reaches the server at all: if this stopped
// passing them, a video first seen through playback rather than a click would
// keep the placeholder title forever. The upload date is not passed on because
// this side has never known it; leaving the field out preserves whatever the
// click path stored.
export async function pushUpsert(entry: HistoryEntry): Promise<void> {
  await ensureVideo({
    mediaId: entry.id,
    url: entry.url,
    title: entry.title,
    thumbnail: entry.thumbnail,
  });

  const { error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .upsert(toRow(entry), { onConflict: 'media_id' });
  if (error) throw error;
}

export async function pushTombstone(id: string): Promise<void> {
  const { error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('media_id', id);
  if (error) throw error;
}

export async function pushClearAll(): Promise<void> {
  const { error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .is('deleted_at', null);
  if (error) throw error;
}

// The most recent live rows. The remote table keeps everything; only the local
// cache is capped, so this mirrors that cap rather than the full table.
export async function pullRecent(): Promise<HistoryEntry[]> {
  const { data, error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    // The parent row is embedded rather than fetched in a second round trip:
    // `HistoryEntry` — what the popup renders and what the thumbnail bars read —
    // still wants all of it on one object.
    .select('*, videos(title, thumbnail, url)')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(HISTORY_MAX_ENTRIES);
  if (error) throw error;
  return (data as unknown as JoinedRow[])
    .filter((row): row is EntryRow => {
      if (row.videos) return true;
      // The foreign key makes this unreachable. If it ever fires, dropping the
      // row beats inventing a title and a url that opens a blank tab.
      log('pull: watch_history row with no video', row.media_id);
      return false;
    })
    .map(toEntry);
}

// Media ids that have been tombstoned. The pull merge uses these to evict rows
// deleted on another device instead of keeping them alive from the local cache.
export async function pullTombstonedIds(): Promise<string[]> {
  const { data, error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .select('media_id')
    .not('deleted_at', 'is', null);
  if (error) throw error;
  return (data as { media_id: string }[]).map((r) => r.media_id);
}
