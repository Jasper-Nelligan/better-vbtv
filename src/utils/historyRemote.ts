import { HISTORY_MAX_ENTRIES, WATCH_HISTORY_TABLE } from '../constants';
import type { HistoryEntry } from './history';
import { getClient, getUserId } from './supabase';

// The `watch_history` row shape. Mirrors HistoryEntry, in snake_case, with two
// additions: `user_id` scopes rows to the account (and drives the RLS policies),
// and `deleted_at` is a tombstone rather than a hard delete — without it the next
// pull would resurrect anything removed from the popup.
interface WatchHistoryRow {
  user_id: string;
  media_id: string;
  title: string;
  thumbnail: string | null;
  url: string;
  position_sec: number;
  duration_sec: number;
  updated_at: string;
  deleted_at: string | null;
}

function toRow(entry: HistoryEntry, userId: string): WatchHistoryRow {
  return {
    user_id: userId,
    media_id: entry.id,
    title: entry.title,
    thumbnail: entry.thumbnail ?? null,
    url: entry.url,
    position_sec: entry.positionSec,
    duration_sec: entry.durationSec,
    updated_at: new Date(entry.updatedAt).toISOString(),
    deleted_at: null,
  };
}

function toEntry(row: WatchHistoryRow): HistoryEntry {
  return {
    id: row.media_id,
    title: row.title,
    thumbnail: row.thumbnail ?? undefined,
    url: row.url,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    updatedAt: Date.parse(row.updated_at),
  };
}

async function requireUserId(): Promise<string> {
  const userId = await getUserId();
  if (!userId) throw new Error('supabase: not authenticated');
  return userId;
}

// Insert-or-update by (user_id, media_id). Also clears any tombstone, so
// re-watching a previously removed video brings it back.
export async function pushUpsert(entry: HistoryEntry): Promise<void> {
  const userId = await requireUserId();
  const { error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .upsert(toRow(entry, userId), { onConflict: 'user_id,media_id' });
  if (error) throw error;
}

export async function pushTombstone(id: string): Promise<void> {
  const userId = await requireUserId();
  const { error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('media_id', id);
  if (error) throw error;
}

export async function pushClearAll(): Promise<void> {
  const userId = await requireUserId();
  const { error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) throw error;
}

// The most recent live rows. The remote table keeps everything; only the local
// cache is capped, so this mirrors that cap rather than the full table.
export async function pullRecent(): Promise<HistoryEntry[]> {
  const userId = await requireUserId();
  const { data, error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(HISTORY_MAX_ENTRIES);
  if (error) throw error;
  return (data as WatchHistoryRow[]).map(toEntry);
}

// Media ids the account has tombstoned. The pull merge uses these to evict rows
// deleted on another device instead of keeping them alive from the local cache.
export async function pullTombstonedIds(): Promise<string[]> {
  const userId = await requireUserId();
  const { data, error } = await getClient()
    .from(WATCH_HISTORY_TABLE)
    .select('media_id')
    .eq('user_id', userId)
    .not('deleted_at', 'is', null);
  if (error) throw error;
  return (data as { media_id: string }[]).map((r) => r.media_id);
}
