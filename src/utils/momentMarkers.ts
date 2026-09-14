import { PROGRESS_CONTROL_SELECTOR, PROGRESS_HOLDER_SELECTOR, VIDEO_SELECTOR } from '../constants';
import { listMoments, loadTaxonomy, type Moment } from './moments';
import { formatTime, parseJwMediaId } from './videoMeta';
import { toast } from './toast';
import { log } from './logger';

// Pins on the player's seek bar, one per saved mark.
//
// This is the `ThumbnailProgress` kind of component rather than the Solid-island
// kind: it decorates DOM the *page* owns (video.js's control bar) instead of
// mounting a self-contained panel on <body>, so it lives here and its CSS lives
// in styles.css alongside the thumbnail bars.
//
// Two consequences of attaching to video.js's control bar, both wanted:
//
//   * Spoiler-free mode hides `.vjs-control-bar` outright (styles.css), so the
//     pins vanish with it. That is the correct default — a pin two thirds along
//     the bar labelled "Monster block" is exactly what spoiler-free mode exists
//     to withhold — and it needs no logic of its own.
//   * The control bar is inside the element that goes fullscreen, so the pins
//     follow the player into fullscreen without the re-parenting dance the
//     toast and the modals need.

const RAIL_CLASS = 'better-vbtv-marker-rail';
const MARKER_CLASS = 'better-vbtv-marker';
const STEM_CLASS = 'better-vbtv-marker-stem';
// Remembers a progress control we had to make `position: relative`, so stop()
// can put it back exactly as we found it.
const HOST_ATTR = 'data-bvbtv-marker-host';

export interface MomentMarkersOptions {
  // A pin was shift-clicked. The caller opens the edit modal; this class
  // deliberately knows nothing about modals. A plain click is *not* routed
  // here — it seeks, which the class does itself since it already holds the
  // video element it measures durations from.
  onEdit: (moment: Moment) => void;
}

export class MomentMarkers {
  private readonly onEdit: (moment: Moment) => void;

  private video: HTMLVideoElement | null = null;
  private rail: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private moments: Moment[] = [];
  private typeNames = new Map<string, string>();
  private mediaId: string | null = null;

  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rafId: number | null = null;
  private videoListener: (() => void) | null = null;
  // Discards a reply that belongs to a video the user has already left.
  private loadToken = 0;

  constructor(options: MomentMarkersOptions) {
    this.onEdit = options.onEdit;
  }

  public start(): void {
    // Re-entering /player builds a fresh ElementObserver, whose callback fires
    // again — so this runs more than once per page. Starting twice would leak a
    // second MutationObserver, and the first would never be disconnected.
    if (this.observer) {
      this.scheduleSync();
      return;
    }
    log('MomentMarkers.start()');
    // video.js rebuilds its control bar (source changes, fullscreen, skin
    // swaps), so finding the progress bar is a standing job, not a one-off.
    // rAF coalesces bursts; we only observe childList, so the player's
    // per-frame inline-style writes on the progress bar don't wake us.
    this.observer = new MutationObserver(() => this.scheduleSync());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.sync();
  }

  public stop(): void {
    log('MomentMarkers.stop()');
    this.loadToken++;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.detachVideo();
    this.detachRail();
    this.moments = [];
    this.mediaId = null;
  }

  // Re-read the marks from the server. Called after the modal saves, edits or
  // deletes one.
  public refresh(): void {
    void this.reload();
  }

  private scheduleSync(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.sync();
    });
  }

  private sync(): void {
    this.ensureVideo();
    this.ensureRail();
    this.layoutRail();

    // Switching videos changes only the query string, so nothing above would
    // notice on its own — the same reason VideoController re-checks the id
    // rather than trusting the route.
    const id = parseJwMediaId(window.location.href);
    if (id !== this.mediaId) {
      this.mediaId = id;
      this.moments = [];
      this.renderPins();
      void this.reload();
      return;
    }

    this.renderPins();
  }

  private ensureVideo(): void {
    const video = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
    if (video === this.video) return;
    this.detachVideo();
    this.video = video;
    if (!video) return;
    // `loadstart` fires on every new source; the other two are when a duration
    // first becomes known, which is what the pin positions are a fraction of.
    this.videoListener = () => this.scheduleSync();
    video.addEventListener('loadstart', this.videoListener);
    video.addEventListener('loadedmetadata', this.videoListener);
    video.addEventListener('durationchange', this.videoListener);
  }

  private detachVideo(): void {
    if (this.video && this.videoListener) {
      this.video.removeEventListener('loadstart', this.videoListener);
      this.video.removeEventListener('loadedmetadata', this.videoListener);
      this.video.removeEventListener('durationchange', this.videoListener);
    }
    this.videoListener = null;
    this.video = null;
  }

  private ensureRail(): void {
    const control = document.querySelector<HTMLElement>(PROGRESS_CONTROL_SELECTOR);
    if (!control) {
      this.detachRail();
      return;
    }
    if (this.host === control && this.rail?.isConnected) return;

    this.detachRail();
    if (getComputedStyle(control).position === 'static') {
      control.style.position = 'relative';
      control.setAttribute(HOST_ATTR, '');
    }
    const rail = document.createElement('div');
    rail.className = RAIL_CLASS;
    control.appendChild(rail);
    this.rail = rail;
    this.host = control;

    // The seek bar is narrower than its control (video.js insets it), and it
    // resizes with the player. Mirror it rather than assume the inset.
    const holder = control.querySelector<HTMLElement>(PROGRESS_HOLDER_SELECTOR);
    if (holder && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.layoutRail());
      this.resizeObserver.observe(holder);
    }
  }

  private detachRail(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.rail?.remove();
    this.rail = null;
    if (this.host?.hasAttribute(HOST_ATTR)) {
      this.host.style.position = '';
      this.host.removeAttribute(HOST_ATTR);
    }
    this.host = null;
  }

  private layoutRail(): void {
    const rail = this.rail;
    const holder = this.host?.querySelector<HTMLElement>(PROGRESS_HOLDER_SELECTOR);
    if (!rail || !holder) return;
    rail.style.left = holder.offsetLeft + 'px';
    rail.style.top = holder.offsetTop + 'px';
    rail.style.width = holder.offsetWidth + 'px';
    rail.style.height = holder.offsetHeight + 'px';
  }

  private async reload(): Promise<void> {
    const id = this.mediaId;
    const token = ++this.loadToken;
    if (!id) {
      this.moments = [];
      this.renderPins();
      return;
    }
    try {
      // The type name is what the pin's tooltip says, and `listMoments` returns
      // ids, so both lists are needed. One round trip each, on video load only.
      const [moments, taxonomy] = await Promise.all([listMoments(id), loadTaxonomy()]);
      if (token !== this.loadToken) return;
      this.moments = moments;
      this.typeNames = new Map(taxonomy.types.map((t) => [t.id, t.name]));
    } catch (err) {
      if (token !== this.loadToken) return;
      // Deliberately silent, unlike every path in the modal. Those are actions
      // the user just took and is waiting on; this is ambient decoration on a
      // video they are watching, and a toast over the player would be worse
      // than a missing pin. The marks themselves are safe on the server.
      log('moments: could not load marks for the timeline', err);
      this.moments = [];
    }
    this.renderPins();
  }

  private renderPins(): void {
    const rail = this.rail;
    if (!rail) return;

    const duration = this.video?.duration ?? NaN;
    if (!Number.isFinite(duration) || duration <= 0) {
      rail.replaceChildren();
      rail.dataset.sig = '';
      return;
    }

    const placeable = this.moments.filter((m) => m.timeSec >= 0 && m.timeSec <= duration);
    // Our own writes into the control bar wake the MutationObserver that calls
    // this. Comparing a signature first is what stops that being a loop.
    const sig = duration + '|' + placeable.map((m) => m.id + '@' + m.timeSec).join(',');
    if (rail.dataset.sig === sig) return;
    rail.dataset.sig = sig;
    rail.replaceChildren(...placeable.map((m) => this.buildPin(m, duration)));
  }

  private buildPin(moment: Moment, duration: number): HTMLElement {
    const name = this.typeNames.get(moment.typeId) ?? 'Moment';
    const label = name + ' @ ' + formatTime(moment.timeSec);

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = MARKER_CLASS;
    pin.style.left = (moment.timeSec / duration) * 100 + '%';
    pin.title = label + ' — click to jump here, shift-click to edit';
    pin.setAttribute('aria-label', 'Jump to moment: ' + label + ' (shift-click to edit)');

    const stem = document.createElement('span');
    stem.className = STEM_CLASS;
    pin.appendChild(stem);

    // The pin sits on top of the seek bar. Without stopping the event here the
    // click would also reach video.js and scrub to wherever the *pin head* is —
    // which is not the mark's position, since the head is a fixed-width square
    // centred on it.
    //
    // Plain click jumps to the mark (the common case, several times a match);
    // shift-click opens the editor (rare, and destructive-ish — Delete lives
    // there). Enter/Space on the focused pin arrive here as a click too, so
    // both actions are reachable from the keyboard.
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        this.onEdit(moment);
        return;
      }
      this.seekTo(moment, label);
    });
    // video.js starts a scrub on mousedown, which beats click to it, so the pin
    // has to swallow that too or opening the editor also seeks.
    pin.addEventListener('mousedown', (e) => e.stopPropagation());

    return pin;
  }

  private seekTo(moment: Moment, label: string): void {
    const video = this.video;
    // A currentTime write before the player reports metadata is dropped, the
    // same trap the resume seek in VideoController works around. Here there is
    // nothing to wait for: no duration means no pins were drawn, so a click can
    // only arrive once the player is ready.
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = moment.timeSec;
    toast('📍 ' + label);
  }
}
