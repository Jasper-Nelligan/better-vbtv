// Background worker. Two jobs, which work in opposite ways on purpose.
//
// 1. Watch-history sync. `ext.storage.local` is a write-through cache and
//    Supabase is the source of truth: every mutation in `utils/history.ts`
//    writes the cache and queues an op, and this worker drains that queue
//    outbound and folds the remote table back inbound.
//
// 2. Moment marks, over a request/response channel (`MOMENTS_MESSAGE`). Those
//    are written synchronously with the modal waiting on the answer, so there is
//    no cache and no queue here — the worker just forwards to `momentsRemote.ts`
//    and returns what Postgres said. It has to live in the worker regardless:
//    that is where the one auth session is, and it keeps supabase-js out of the
//    content-script bundle.
//
// Two things make a service worker the right home for the sync half rather than
// the content script. First, `VideoController.flushPosition()` runs on `beforeunload`, where
// a network request is dropped when the page dies — but a `storage.local.set` is
// fast and reliable, and it wakes this worker after the tab is gone. Second, one
// worker means one auth session and one queue instead of a race between every
// open VBTV tab and the popup.
//
// The sync half is driven entirely by storage changes and alarms — the
// `storage.onChanged` convention every other surface in this codebase uses. The
// moment half cannot be: a caller waiting on a server-minted id needs a reply,
// and storage has no reply channel.
import {
  SYNC_QUEUE_KEY,
  SYNC_REQUEST_KEY,
  SYNC_STATUS_KEY,
  SYNC_PULL_MINUTES,
  SYNC_RETRY_MINUTES,
  SYNC_MIN_INTERVAL_SEC,
  SYNC_WAKE_MESSAGE,
  MOMENTS_MESSAGE,
} from './constants';
import ext from './utils/browser';
import { log } from './utils/logger';
import { isSupabaseConfigured, ensureAuth } from './utils/supabase';
import { getHistory, mergeRemote } from './utils/history';
import { type SyncStatus } from './utils/syncStatus';
import { readQueue, dropOps, enqueue, type SyncOp } from './utils/syncQueue';
import {
  pushUpsert,
  pushTombstone,
  pushClearAll,
  pullRecent,
  pullTombstonedIds,
} from './utils/historyRemote';
import { upsertVideo } from './utils/videosRemote';
import type { MomentsRequest } from './utils/moments';
import {
  createTaxonomyItem,
  deleteMoment,
  listMoments,
  loadTaxonomy,
  saveMoment,
  updateMoment,
} from './utils/momentsRemote';

const PULL_ALARM = 'better-vbtv-sync-pull';
const RETRY_ALARM = 'better-vbtv-sync-retry';

let draining = false;
// Set when a drain is requested while one is already running, so the in-flight
// run loops again rather than dropping the request. Without it an op queued
// during a drain could sit unsent until the next unrelated storage write.
let drainAgain = false;
// Same idea one level up: a full cycle already in flight. `requestSync()` fires
// two triggers on its own (a SYNC_REQUEST_KEY write *and* a wake message), so
// without this every manual sync does each round trip twice.
let syncing = false;

async function readStatus(): Promise<SyncStatus | undefined> {
  const result = await ext.storage.local.get([SYNC_STATUS_KEY]);
  return result[SYNC_STATUS_KEY] as SyncStatus | undefined;
}

async function writeStatus(patch: Partial<SyncStatus>): Promise<void> {
  const prev = (await readStatus()) ?? {
    configured: isSupabaseConfigured(),
    signedIn: false,
    lastSyncAt: null,
    pending: 0,
    lastError: null,
  };
  await ext.storage.local.set({ [SYNC_STATUS_KEY]: { ...prev, ...patch } });
}

function scheduleRetry(): void {
  ext.alarms.create(RETRY_ALARM, { delayInMinutes: SYNC_RETRY_MINUTES });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Push every queued op, oldest first. Ops that succeed are dropped; the first
// failure stops the run and leaves the rest queued for the retry alarm, so
// nothing is lost and ordering is preserved.
async function drain(): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    const queue = await readQueue();
    if (queue.length === 0) {
      await writeStatus({ pending: 0 });
      return;
    }

    await ensureAuth();

    // One read of the cache covers every upsert in this batch.
    const entries = new Map((await getHistory()).map((e) => [e.id, e]));
    const done: SyncOp[] = [];
    let failure: unknown = null;

    for (const op of queue) {
      try {
        if (op.kind === 'clear') {
          await pushClearAll();
        } else if (op.kind === 'delete') {
          await pushTombstone(op.id);
        } else if (op.kind === 'video') {
          // The one op that carries its own payload — `videos.ts` explains why.
          // No cache lookup, and nothing to discard it against: a video row is
          // valid whether or not the video was ever watched.
          await upsertVideo(op.video);
        } else {
          const entry = entries.get(op.id);
          // Dropped from the cache before we got to it (pruned, or deleted by a
          // later op). Nothing to push — discard the op rather than retry forever.
          if (entry) await pushUpsert(entry);
        }
        done.push(op);
      } catch (err) {
        failure = err;
        break;
      }
    }

    await dropOps(done);

    if (failure) throw failure;
    await writeStatus({ signedIn: true, pending: 0, lastSyncAt: Date.now(), lastError: null });
    log('sync: pushed', done.length, 'op(s)');
  } catch (err) {
    log('sync: drain failed', describeError(err));
    await writeStatus({ pending: (await readQueue()).length, lastError: describeError(err) });
    scheduleRetry();
  } finally {
    draining = false;
  }

  if (drainAgain) {
    drainAgain = false;
    await drain();
  }
}

// Reconcile in both directions.
//
// Down: fold the remote table into the local cache, last-write-wins. Ids with a
// push still pending are protected from tombstone eviction — that local intent
// hasn't shipped yet.
//
// Up: queue anything the server is missing or has an older copy of. This is what
// makes the system self-healing, and it replaces the one-shot migration flag that
// used to handle pre-existing history. A flag is the wrong tool: it gets consumed
// by the first successful run even if that run had nothing to upload (a fresh
// profile, or storage that filled in later), after which entries recorded before
// sync worked could never be uploaded at all. Comparing state every cycle has no
// such failure mode.
async function pull(): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    await ensureAuth();
    const [remote, tombstoned] = await Promise.all([pullRecent(), pullTombstonedIds()]);
    const pending = await readQueue();
    // Only watch-history intent protects an entry from tombstone eviction. A
    // pending `video` op says a row exists in another table; it says nothing
    // about whether this device still wants the entry in its history.
    const protectedIds = pending.flatMap((op) =>
      op.kind === 'upsert' || op.kind === 'delete' ? [op.id] : [],
    );
    const changed = await mergeRemote(remote, { tombstoned, protectedIds });

    const remoteById = new Map(remote.map((e) => [e.id, e]));
    const deleted = new Set(tombstoned);
    let queued = 0;
    for (const entry of await getHistory()) {
      // Don't resurrect something deleted on another device.
      if (deleted.has(entry.id)) continue;
      const row = remoteById.get(entry.id);
      if (!row || entry.updatedAt > row.updatedAt) {
        await enqueue({ kind: 'upsert', id: entry.id, at: Date.now() });
        queued++;
      }
    }

    await writeStatus({ signedIn: true, lastSyncAt: Date.now(), lastError: null });
    log('sync: pulled', remote.length, 'row(s), changed =', changed, '| queued up', queued);
    if (queued > 0) await drain();
  } catch (err) {
    log('sync: pull failed', describeError(err));
    await writeStatus({ lastError: describeError(err) });
    scheduleRetry();
  }
}

// One full cycle: authenticate, push what's queued, then reconcile both ways.
//
// `passive` marks the routine page-load nudge rather than an explicit request.
// Those are throttled to SYNC_MIN_INTERVAL_SEC so a handful of open tabs is
// still one pull; the popup's "Sync now" and the alarms are never passive.
async function syncNow(opts: { passive?: boolean } = {}): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (syncing) return;

  if (opts.passive) {
    const lastSyncAt = (await readStatus())?.lastSyncAt;
    if (lastSyncAt && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_SEC * 1000) {
      log('sync: passive request skipped, synced', Date.now() - lastSyncAt, 'ms ago');
      return;
    }
  }

  syncing = true;
  try {
    try {
      await ensureAuth();
      await writeStatus({ signedIn: true, lastError: null });
    } catch (err) {
      log('sync: auth failed', describeError(err));
      await writeStatus({ signedIn: false, lastError: describeError(err) });
      scheduleRetry();
      return;
    }
    await drain();
    await pull();
  } finally {
    syncing = false;
  }
}

async function boot(): Promise<void> {
  await writeStatus({ configured: isSupabaseConfigured() });
  if (!isSupabaseConfigured()) {
    log('sync: no Supabase credentials in this build — local-only mode');
    return;
  }
  ext.alarms.create(PULL_ALARM, { periodInMinutes: SYNC_PULL_MINUTES });
  await syncNow();
}

ext.runtime.onInstalled.addListener(() => void boot());
ext.runtime.onStartup.addListener(() => void boot());

// The primary wake-up. A stopped MV3 worker is not dependably restarted by a
// storage write, but it is by a runtime message, so `enqueue()` sends one.
ext.runtime.onMessage.addListener(
  (message: { type?: string; full?: boolean; passive?: boolean } | undefined) => {
    if (message?.type === SYNC_WAKE_MESSAGE) {
      // `full` means re-auth and pull as well, rather than just flushing whatever
      // happens to be queued — the popup's "Sync now", and every VBTV page load
      // (`passive`, so it is throttled).
      void (message.full ? syncNow({ passive: message.passive === true }) : drain());
    }
    // Nothing here replies; returning false lets the channel close immediately.
    return false;
  },
);

// --- Moments RPC ----------------------------------------------------------

// The moment modal, waiting on a reply. Everything below runs a live Supabase
// call and returns its result; nothing is cached, queued or retried, so an error
// here is an error the user sees on screen.
async function handleMomentsRequest(request: MomentsRequest): Promise<unknown> {
  if (!isSupabaseConfigured()) {
    // Not an internal failure — this build simply has no `.env`. Say so plainly,
    // because the modal shows this string verbatim.
    throw new Error('Supabase is not configured in this build, so moments cannot be saved.');
  }
  switch (request.action) {
    case 'taxonomy':
      return loadTaxonomy();
    case 'createTaxonomyItem':
      return createTaxonomyItem(request.kind, request.name);
    case 'saveMoment':
      return saveMoment(request.moment);
    case 'listMoments':
      return listMoments(request.videoId);
    case 'updateMoment':
      return updateMoment(request.id, request.patch);
    case 'deleteMoment':
      return deleteMoment(request.id);
    default:
      throw new Error('Unknown moments request.');
  }
}

ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if ((message as { type?: string } | undefined)?.type !== MOMENTS_MESSAGE) return false;
  // `return true` plus `sendResponse` rather than returning a promise: Firefox
  // honours either, but Chrome ignores a returned promise and closes the channel
  // before the await resolves, which the caller sees as an undefined reply.
  handleMomentsRequest(message as MomentsRequest).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => {
      log('moments: request failed', describeError(err));
      sendResponse({ ok: false, error: describeError(err) });
    },
  );
  return true;
});

// Secondary path, for when the worker happens to already be running: catches
// writes from contexts that never sent a message, and the popup's "Sync now".
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SYNC_QUEUE_KEY]) void drain();
  if (changes[SYNC_REQUEST_KEY]) void syncNow();
});

// Both alarms run the full cycle so a stuck migration or a stranded queue heals
// itself on the next tick rather than waiting for a browser restart.
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PULL_ALARM || alarm.name === RETRY_ALARM) void syncNow();
});
