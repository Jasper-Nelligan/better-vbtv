import { SYNC_STATUS_KEY, SYNC_REQUEST_KEY, SYNC_WAKE_MESSAGE } from '../constants';
import ext from './browser';

// Written by the background worker, read by the popup. Shared here so the popup
// doesn't have to import from src/background.ts and drag the worker into its bundle.
export interface SyncStatus {
  configured: boolean;  // were Supabase credentials present at build time?
  signedIn: boolean;
  lastSyncAt: number | null;
  pending: number;      // ops still queued for upload
  lastError: string | null;
}

export const DEFAULT_SYNC_STATUS: SyncStatus = {
  configured: false,
  signedIn: false,
  lastSyncAt: null,
  pending: 0,
  lastError: null,
};

export async function getSyncStatus(): Promise<SyncStatus> {
  const result = await ext.storage.local.get([SYNC_STATUS_KEY]);
  return { ...DEFAULT_SYNC_STATUS, ...(result[SYNC_STATUS_KEY] as Partial<SyncStatus> | undefined) };
}

// Ask the worker for a full cycle now: authenticate, migrate, push, pull.
//
// The storage write records the request, but a stopped MV3 worker is not
// dependably restarted by one, so the runtime message is what actually wakes it.
export async function requestSync(): Promise<void> {
  await ext.storage.local.set({ [SYNC_REQUEST_KEY]: Date.now() });
  try {
    void Promise.resolve(
      ext.runtime.sendMessage({ type: SYNC_WAKE_MESSAGE, full: true }),
    ).catch(() => undefined);
  } catch {
    /* extension context invalidated */
  }
}

// The nudge every VBTV page load sends, so a device whose cache is empty or
// stale gets the remote history *now* rather than whenever the 15-minute alarm
// next fires. Without this nothing in the content script ever asks for a pull:
// `enqueue()`'s wake message only drains the outbound queue.
//
// Message-only, deliberately: writing SYNC_REQUEST_KEY would also trip the
// worker's `storage.onChanged` path, which is the explicit-request route and is
// not throttled. `sendMessage` is itself a documented wake-up event, so a
// stopped worker still starts for it — the storage write buys nothing here.
export function requestPassiveSync(): void {
  try {
    void Promise.resolve(
      ext.runtime.sendMessage({ type: SYNC_WAKE_MESSAGE, full: true, passive: true }),
    ).catch(() => undefined);
  } catch {
    /* extension context invalidated */
  }
}
