import { SYNC_QUEUE_KEY, SYNC_QUEUE_MAX_OPS, SYNC_WAKE_MESSAGE } from '../constants';
import ext from './browser';
import { createMutex } from './mutex';
import type { VideoRecord } from './videos';

// An outbound mutation waiting to reach Supabase.
//
// `upsert` deliberately carries only the media id, not a snapshot of the entry:
// the worker reads the current entry from the local cache when it drains. That
// means a video saving its position every POSITION_SAVE_SEC collapses into a
// single queued op and a single round trip, however long playback runs.
//
// `video` is the exception, and has to be: it carries its payload because there
// is no cache behind it to re-read. The upload date is scraped out of a browse
// page the worker cannot see and the user has already navigated away from, so if
// the op does not hold it, nothing does.
export type SyncOp =
  | { kind: 'upsert'; id: string; at: number }
  | { kind: 'delete'; id: string; at: number }
  | { kind: 'clear'; at: number }
  | { kind: 'video'; id: string; at: number; video: VideoRecord };

const lock = createMutex();

export async function readQueue(): Promise<SyncOp[]> {
  const result = await ext.storage.local.get([SYNC_QUEUE_KEY]);
  return (result[SYNC_QUEUE_KEY] as SyncOp[] | undefined) ?? [];
}

async function writeQueue(ops: SyncOp[]): Promise<void> {
  await ext.storage.local.set({ [SYNC_QUEUE_KEY]: ops });
}

// Nudge the background worker to drain.
//
// `storage.onChanged` fires in the worker, but only reliably while it is already
// running — a terminated MV3 worker is not dependably restarted by a storage
// write, which would leave queued ops sitting until the next alarm. A runtime
// message IS a documented wake-up event, so send one after every enqueue.
//
// The worker imports this module too; skip the self-message there. A service
// worker has no `window`, which is the cheapest way to tell the contexts apart.
function wakeWorker(): void {
  if (typeof window === 'undefined') return;
  try {
    // Nothing replies, and the worker may still be starting up, so swallow both
    // "could not establish connection" and the invalidated-context error a stale
    // content script throws after the extension is reloaded.
    void Promise.resolve(ext.runtime.sendMessage({ type: SYNC_WAKE_MESSAGE })).catch(
      () => undefined,
    );
  } catch {
    /* extension context invalidated */
  }
}

// Which table an op writes to. Ops only supersede each other within a family:
// `video` and the watch-history kinds address different rows in different tables,
// and collapsing across them would mean qualifying a watch silently discarding
// the queued row that carries the upload date.
function isVideoOp(op: SyncOp): boolean {
  return op.kind === 'video';
}

// Append an op, collapsing anything it supersedes.
export async function enqueue(op: SyncOp): Promise<void> {
  await lock(async () => {
    const queue = await readQueue();

    // A clear supersedes every pending watch-history op; ops queued after it are
    // later edits and must survive, so order is preserved from here on. It does
    // not touch `video` ops — clearing the history does not unmake the videos.
    let next = op.kind === 'clear'
      ? queue.filter(isVideoOp)
      : queue.filter(
          (q) => q.kind === 'clear' || isVideoOp(q) !== isVideoOp(op) || q.id !== op.id,
        );
    next.push(op);

    // Guard against unbounded growth while sync is broken or unconfigured.
    if (next.length > SYNC_QUEUE_MAX_OPS) next = next.slice(next.length - SYNC_QUEUE_MAX_OPS);

    await writeQueue(next);
  });
  wakeWorker();
}

// Remove ops that were successfully pushed. Matches on identity by (kind, id, at)
// so ops re-queued while the drain was in flight are left alone.
export async function dropOps(done: SyncOp[]): Promise<void> {
  if (done.length === 0) return;
  await lock(async () => {
    const doneKeys = new Set(done.map(opKey));
    const remaining = (await readQueue()).filter((op) => !doneKeys.has(opKey(op)));
    await writeQueue(remaining);
  });
}

export async function queueLength(): Promise<number> {
  return (await readQueue()).length;
}

function opKey(op: SyncOp): string {
  return op.kind === 'clear' ? `clear:${op.at}` : `${op.kind}:${op.id}:${op.at}`;
}
