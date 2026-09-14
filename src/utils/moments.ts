import { MOMENTS_MESSAGE } from '../constants';
import ext from './browser';

// Moment marks and their three taxonomies — the content-script half.
//
// Deliberately NOT arranged like `history.ts`. Watch history is offline-first: a
// write-through cache over `storage.local` plus a queue the worker drains, because
// position saves fire constantly and one of them runs on `beforeunload`, where a
// network request is dropped but a storage write is not.
//
// Moments are the opposite kind of write — a handful per match, each one a
// deliberate act with the user watching it happen — so they go straight to
// Supabase and Postgres mints the ids. That buys a single source of truth, no
// local/remote id reconciliation, and no seed-determinism trick. It costs a live
// connection: with Supabase unreachable, marking a moment fails and says so
// instead of queueing.
//
// Nothing here imports supabase-js. The client lives in the background worker —
// one auth session for the whole browser — so every call below is a runtime
// message and `momentsRemote.ts` is the other end.

export interface TaxonomyItem {
  id: string;        // server-generated UUID
  name: string;
  createdAt: number; // also the display order
}

export interface Moment {
  id: string;
  videoId: string | null; // JW media id; null when the player URL can't be parsed
  timeSec: number;        // playback position of the mark
  typeId: string;
  tagIds: string[];
  playerIds: string[];
  createdAt: number;
}

// Which taxonomy a call is about. All three are identical in shape and differ
// only in their table and name column, so the worker is generic over this.
// `player` is a separate kind rather than a flag on `tag` because the two lists
// are searched separately — a tag names what happened, a player names who did
// it, and one merged dropdown is unusable once a roster is in it.
export type TaxonomyKind = 'type' | 'tag' | 'player';

export interface Taxonomy {
  types: TaxonomyItem[];
  tags: TaxonomyItem[];
  players: TaxonomyItem[];
}

export interface NewMoment {
  videoId: string | null;
  timeSec: number;
  typeId: string;
  tagIds: string[];
  playerIds: string[];
}

// What an edit can change. Not the timestamp: the mark's position is the one
// thing the unique index keys on, and "move this mark" is a different gesture
// from "fix what I labelled it" — re-marking at the new spot is the honest way.
export interface MomentPatch {
  typeId: string;
  tagIds: string[];
  playerIds: string[];
}

// The wire format. `momentsRemote.ts` imports these so the two ends can't drift.
export type MomentsRequest =
  | { action: 'taxonomy' }
  | { action: 'createTaxonomyItem'; kind: TaxonomyKind; name: string }
  | { action: 'saveMoment'; moment: NewMoment }
  | { action: 'listMoments'; videoId: string }
  | { action: 'updateMoment'; id: string; patch: MomentPatch }
  | { action: 'deleteMoment'; id: string };

export type MomentsResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

// Every message failure has to end up as something the modal can show a human,
// so the two silent ones are named here rather than surfacing as `undefined`.
async function call<T>(request: MomentsRequest): Promise<T> {
  let response: MomentsResponse | undefined;
  try {
    response = (await ext.runtime.sendMessage({ type: MOMENTS_MESSAGE, ...request })) as
      | MomentsResponse
      | undefined;
  } catch (err) {
    // `sendMessage` itself rejected, which means the request never reached a
    // listener. This is therefore never a Supabase, schema or RLS failure —
    // those are caught in the worker, come back as `ok: false`, and are rendered
    // verbatim by the branch below. Keep the browser's own reason: the three
    // causes are indistinguishable on screen but have different fixes.
    //
    //   "Extension context invalidated"  — this content script outlived an
    //       extension reload. It still runs (the modal is pure DOM, so `m` still
    //       opens it) but every `runtime` call is dead. Reload the tab.
    //   "Receiving end does not exist"   — the worker failed to start. A rebuild
    //       under a loaded unpacked extension does exactly this: `emptyOutDir`
    //       plus content-hashed chunk names means the installed
    //       `service-worker-loader.js` imports a file that no longer exists, and
    //       Chrome does not reload an unpacked extension on its own. Reload the
    //       extension, then the tab.
    //   "message port closed"            — the worker died mid-request.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the extension (${reason}). Reload the extension at chrome://extensions, then reload this page.`);
  }
  if (!response) throw new Error('The extension gave no response.');
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}

// All three lists in one round trip — the modal always needs all of them, and
// this is on the open path where latency is visible.
export function loadTaxonomy(): Promise<Taxonomy> {
  return call<Taxonomy>({ action: 'taxonomy' });
}

// Returns the existing item when the name is already taken (case-insensitively),
// so this doubles as a resolver and confirming a duplicate can't fork the list.
export function createTaxonomyItem(kind: TaxonomyKind, name: string): Promise<TaxonomyItem> {
  return call<TaxonomyItem>({ action: 'createTaxonomyItem', kind, name });
}

export const createMomentType = (name: string) => createTaxonomyItem('type', name);
export const createMomentTag = (name: string) => createTaxonomyItem('tag', name);
export const createPlayer = (name: string) => createTaxonomyItem('player', name);

// Resolves once the row is committed, so a resolved promise means saved — there
// is no queue behind this and nothing lands later.
export function saveMoment(moment: NewMoment): Promise<Moment> {
  return call<Moment>({ action: 'saveMoment', moment });
}

// Every mark on one video, oldest position first — what the timeline pins are
// drawn from. Marks whose `videoId` is null are unreachable here by design:
// they were saved from a URL we could not parse, so there is no timeline to
// pin them to.
export function listMoments(videoId: string): Promise<Moment[]> {
  return call<Moment[]>({ action: 'listMoments', videoId });
}

export function updateMoment(id: string, patch: MomentPatch): Promise<Moment> {
  return call<Moment>({ action: 'updateMoment', id, patch });
}

export function deleteMoment(id: string): Promise<void> {
  return call<void>({ action: 'deleteMoment', id });
}
