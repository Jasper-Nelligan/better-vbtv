import { VIDEOS_TABLE } from '../constants';
import { getClient } from './supabase';
import type { VideoRecord } from './videos';

// Supabase access for the `videos` table — the worker half of `videos.ts`, and
// imported only from the background worker so supabase-js stays out of the
// content-script bundle.

// The payload last written for each id, for this worker's lifetime only.
//
// `pushUpsert` has to guarantee the parent row before every watch-history push,
// and during playback that push happens once per POSITION_SAVE_SEC — so without
// a memo, an hour of watching is an hour of re-upserting a row that has not
// changed since the first save. An MV3 worker is torn down often enough that it
// re-verifies on its own.
//
// It remembers the *payload*, not just that the id was seen, and that distinction
// became load-bearing when the title moved into this table: `qualifyAndRecord`
// records a fallback title first and the real one a moment later, so a memo that
// only asked "have we written this id?" would push the placeholder, skip the
// write that corrects it, and leave `VBTV replay` on the row for good.
const lastWritten = new Map<string, string>();

// Undefined fields are dropped from the payload rather than sent as null, and
// that is the whole contract of this module: PostgREST builds its ON CONFLICT SET
// list from the keys present, so an absent column keeps the value already stored.
// It is what lets a click write a row before the JW metadata arrives, and what
// stops `ensureVideo` — which never knows the upload date — from blanking it on
// every position save.
//
// `created_at` and `updated_at` are never sent: the first defaults on insert and
// is preserved by that same omission, and the second is a trigger's job.
function toRow(video: VideoRecord): Record<string, unknown> {
  const row: Record<string, unknown> = { media_id: video.mediaId, url: video.url };
  if (video.title) row.title = video.title;
  if (video.thumbnail) row.thumbnail = video.thumbnail;
  if (video.uploadDate) row.upload_date = video.uploadDate;
  return row;
}

// Insert-or-update by media_id. Always writes — a click is a deliberate act and
// should refresh the row it names.
export async function upsertVideo(video: VideoRecord): Promise<void> {
  const row = toRow(video);
  const { error } = await getClient()
    .from(VIDEOS_TABLE)
    .upsert([row], { onConflict: 'media_id' });
  if (error) throw error;
  // Only after it lands: a failed write must not be remembered as done.
  lastWritten.set(video.mediaId, JSON.stringify(row));
}

// Make sure a watch-history row has a video to hang off, before it is pushed.
//
// Not just belt-and-braces over the click path: history reaches the server from
// places no click was ever seen. A cache that predates the `videos` table, a
// device that pulled the entry rather than clicking it, `pull()` re-queueing
// something the server is missing — each of those would otherwise hit the
// foreign key, fail, and sit at the head of the queue blocking every op behind
// it until the retry alarm gave up. Writing the parent first makes the constraint
// satisfied by construction instead.
export async function ensureVideo(video: VideoRecord): Promise<void> {
  if (lastWritten.get(video.mediaId) === JSON.stringify(toRow(video))) return;
  await upsertVideo(video);
}
