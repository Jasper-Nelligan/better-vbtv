export const ROOT_ID = "better-vbtv"
export const SHORTCUTS_OVERLAY_ID = "better-vbtv-shortcuts"
export const TOAST_ID = "better-vbtv-toast"
export const MOMENT_MODAL_ID = "better-vbtv-moment"
export const VIDEO_SELECTOR = 'video'
// Every thumbnail card on a browse/list page is an anchor to the player URL.
// Both surfaces that work off cards — the progress bars and the click recorder —
// find their cards with this.
export const VIDEO_LINK_SELECTOR = 'a[href*="self-link"]'
// video.js seek bar. The *control* is the click target and our positioning
// context; the *holder* is the narrower inner track the pins are a fraction of.
export const PROGRESS_CONTROL_SELECTOR = '.vjs-progress-control'
export const PROGRESS_HOLDER_SELECTOR = '.vjs-progress-holder'
export const PAGE_PATHS = {
  PLAYER: '/player'
}
export const NO_SPOILER_STORAGE_KEY = 'NO_SPOILER'
export const WITH_SPOILER_CLASS = 'with-spoiler'

// Configurable seek intervals (seconds)
export const SEEK_SMALL_KEY = 'SEEK_SMALL'
export const SEEK_LARGE_KEY = 'SEEK_LARGE'
export const DEFAULT_SEEK_SMALL = 5
export const DEFAULT_SEEK_LARGE = 10
// The page runs its own ±10s skip on the arrow keys from a capture-phase
// listener registered before ours, so our seek is re-asserted a tick later.
// Tolerance has to clear normal playback drift between the two writes (a few
// ms, even at 5x rate) while staying well under the smallest contested delta.
export const SEEK_ENFORCE_TOLERANCE_SEC = 0.5

// Toast appearance
export const TOAST_FONT_SIZE_KEY = 'TOAST_FONT_SIZE'
export const DEFAULT_TOAST_FONT_SIZE = 12

// Watch history + resume
export const WATCH_HISTORY_KEY = 'WATCH_HISTORY'
// Min continuous playtime (seconds) before a video is recorded to history.
export const WATCH_QUALIFY_SEC = 5
// A live stream is not eligible for history at all — see VideoController's
// `isLive()`. video.js flags a live playlist with this class on the player root,
// which is the only dependable signal: a DVR stream reports a *finite* duration
// (the seekable end, which grows with wall-clock time), so an isFinite() check
// on its own sees nothing unusual.
export const LIVE_PLAYER_CLASS = 'vjs-live'
// Throttle/debounce for persisting the resume position (seconds).
export const POSITION_SAVE_SEC = 5
// Cap the stored list so storage can't grow unbounded.
export const HISTORY_MAX_ENTRIES = 100
// Public JW Player delivery feed — returns title + poster for a media id, no auth.
export const JW_MEDIA_FEED = 'https://cdn.jwplayer.com/v2/media/'

// --- Supabase sync ---
// Outbound op queue, drained by the background service worker. Persisted (rather
// than held in memory) so it survives both page unload and SW termination.
export const SYNC_QUEUE_KEY = 'SYNC_QUEUE'
// Last-known sync state, surfaced by the popup.
export const SYNC_STATUS_KEY = 'SYNC_STATUS'
// Bumped by the popup's "Sync now" button; the write wakes the SW.
export const SYNC_REQUEST_KEY = 'SYNC_REQUEST'
// Set once the pre-existing local history has been pushed to Supabase.
export const SUPABASE_MIGRATED_KEY = 'SUPABASE_MIGRATED'
// Where supabase-js persists its session (service workers have no localStorage).
export const SUPABASE_SESSION_KEY = 'SUPABASE_SESSION'
// Remote table backing the watch history.
export const WATCH_HISTORY_TABLE = 'watch_history'
// Remote table of videos themselves — what a video *is*, as opposed to what this
// account did with it. `watch_history.media_id` is a foreign key into it.
export const VIDEOS_TABLE = 'videos'
// Alarm cadence: how often to pull the remote table into the local cache.
export const SYNC_PULL_MINUTES = 15
// Alarm cadence: retry a failed drain after this long.
export const SYNC_RETRY_MINUTES = 1
// Stop the queue growing without bound while sync is broken or unconfigured.
export const SYNC_QUEUE_MAX_OPS = 500
// Content script / popup -> background worker: "the queue has work".
export const SYNC_WAKE_MESSAGE = 'SYNC_WAKE'
// Floor between *passive* full cycles (the nudge every VBTV page load sends).
// Opening ten tabs, or reloading in a loop, must not mean ten pulls. The
// popup's "Sync now" is an explicit request and ignores this.
export const SYNC_MIN_INTERVAL_SEC = 30

// --- Moments ---
// Unlike watch history, the moment feature keeps no local cache and queues
// nothing: the modal talks to Supabase synchronously and Postgres mints the ids.
// So there are no storage keys here — only the remote tables and the channel the
// content script reaches the worker on. See src/utils/moments.ts for why.
export const MOMENT_TYPES_TABLE = 'moment_types'
export const MOMENT_TAGS_TABLE = 'moment_tags'
// A third taxonomy, identical in shape to moment_tags and separate from it on
// purpose: tags say what happened, players say who did it, and one merged list
// stops being searchable as soon as a roster is in it.
export const PLAYERS_TABLE = 'players'
export const MOMENTS_TABLE = 'moments'
// Content script -> background worker, request/response. Message passing rather
// than the usual storage convention because these calls need an *answer* (the
// server-minted id), and because supabase-js has to stay out of the content
// bundle, so the worker is the only context that can make the request.
export const MOMENTS_MESSAGE = 'BVTV_MOMENTS'
