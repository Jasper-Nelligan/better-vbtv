import { enqueue } from './syncQueue';

// The `videos` table's client half — the wire type and the one mutator. The
// supabase-js half is `videosRemote.ts`, which only the background worker
// imports, the same split `history.ts` / `historyRemote.ts` uses.
//
// A video row is a property of the video, not of this account's viewing: it is
// created when a card is clicked, before any watch has qualified, and it is the
// parent row `watch_history.media_id` points at.

// One `videos` row, in the shape the click path knows it.
//
// Everything but `mediaId` and `url` is optional, and that is load-bearing: an
// absent field is left OUT of the upsert payload, which makes PostgREST leave the
// column out of its ON CONFLICT SET list, preserving whatever is already stored.
// So the first write of a click can land before the JW metadata fetch resolves,
// and a later watch-history push can top up the same row without having to know
// the upload date it would otherwise blank.
export interface VideoRecord {
  mediaId: string;
  url: string;          // full player URL, to reopen the video
  title?: string;
  thumbnail?: string;
  uploadDate?: string;  // ISO `yyyy-mm-dd`, parsed from the card's `dd/mm/yyyy`
}

// Record (or refresh) a video the user just clicked.
//
// Queued rather than sent, unlike the moment feature's synchronous writes. A
// moment is a deliberate act the user is watching happen, so a failure can be put
// on screen and left to them; a click has no such surface — the page is already
// navigating and there is nowhere to report to — so the write has to be one that
// survives an unreachable network and a stopped worker on its own.
export async function recordVideoClick(video: VideoRecord): Promise<void> {
  await enqueue({ kind: 'video', id: video.mediaId, at: Date.now(), video });
}
