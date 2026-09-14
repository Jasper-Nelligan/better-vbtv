import { WATCH_HISTORY_KEY } from '../constants';
import { getHistory, type HistoryEntry } from './history';
import { parseJwMediaId } from './videoMeta';
import ext from './browser';
import { log } from './logger';

// YouTube-style watch-progress bar for VBTV thumbnails.
//
// Every thumbnail card on a VBTV browse/list page is an anchor to the player URL
// (`/player?self-link=<encoded jw url>&…`), the same URL scheme the player page
// uses. `parseJwMediaId` pulls the stable JW media id out of that link — exactly
// the key watch history is stored under — so we can look each thumbnail up in
// history and draw a bar showing how much of it the user has watched.

// Thumbnail cards link to the player; this is the same param the player page uses.
const LINK_SELECTOR = 'a[href*="self-link"]';

const BAR_CLASS = 'better-vbtv-progress';
const FILL_CLASS = 'better-vbtv-progress-fill';
// Marks (and remembers we touched) a host whose position we made relative.
const HOST_ATTR = 'data-bvbtv-host';
// Current rendered percentage, so we skip redundant DOM writes.
const PCT_ATTR = 'data-bvbtv-pct';

function progressPct(entry: HistoryEntry): number {
  if (!entry.durationSec || entry.durationSec <= 0) return 0;
  return Math.min(100, Math.round((entry.positionSec / entry.durationSec) * 100));
}

// The bar should sit on the thumbnail image, not below the card's title. Prefer
// the image's wrapper; fall back to the anchor itself if there's no <img>.
function resolveHost(anchor: HTMLAnchorElement): HTMLElement {
  const img = anchor.querySelector('img');
  return (img?.parentElement as HTMLElement | null) ?? anchor;
}

export class ThumbnailProgress {
  private historyMap = new Map<string, HistoryEntry>();
  private observer: MutationObserver | null = null;
  private storageListener:
    | Parameters<typeof chrome.storage.onChanged.addListener>[0]
    | null = null;
  private rafId: number | null = null;

  public async start(): Promise<void> {
    log('ThumbnailProgress.start()');
    await this.refreshHistory();
    this.apply();

    // VBTV is a SPA with lazily-loaded / infinitely-scrolled cards, so re-scan
    // whenever the DOM changes. rAF coalesces bursts to at most once per frame.
    this.observer = new MutationObserver(() => this.scheduleApply());
    this.observer.observe(document.body, { childList: true, subtree: true });

    // Redraw as videos are watched (position saved) elsewhere on the page.
    this.storageListener = (changes, area) => {
      if (area !== 'local') return;
      if (changes[WATCH_HISTORY_KEY]) {
        void this.refreshHistory().then(() => this.apply());
      }
    };
    ext.storage.onChanged.addListener(this.storageListener);
  }

  public stop(): void {
    log('ThumbnailProgress.stop()');
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.storageListener) {
      ext.storage.onChanged.removeListener(this.storageListener);
      this.storageListener = null;
    }
    document.querySelectorAll(`.${BAR_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll<HTMLElement>(`[${HOST_ATTR}]`).forEach((host) => {
      host.style.position = '';
      host.removeAttribute(HOST_ATTR);
    });
  }

  private async refreshHistory(): Promise<void> {
    const list = await getHistory();
    this.historyMap = new Map(list.map((e) => [e.id, e]));
  }

  private scheduleApply(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.apply();
    });
  }

  private apply(): void {
    document
      .querySelectorAll<HTMLAnchorElement>(LINK_SELECTOR)
      .forEach((anchor) => this.applyToAnchor(anchor));
  }

  private applyToAnchor(anchor: HTMLAnchorElement): void {
    // anchor.href is the resolved absolute URL, which parseJwMediaId can parse.
    const id = parseJwMediaId(anchor.href);
    if (!id) return;

    const entry = this.historyMap.get(id);
    const pct = entry ? progressPct(entry) : 0;
    const host = resolveHost(anchor);
    const existing = host.querySelector<HTMLElement>(`:scope > .${BAR_CLASS}`);

    // Nothing watched yet — no bar (and clear a stale one, e.g. history removed).
    if (pct <= 0) {
      existing?.remove();
      return;
    }

    if (existing) {
      // Only touch the DOM when the value actually changed.
      if (existing.getAttribute(PCT_ATTR) !== String(pct)) {
        existing.setAttribute(PCT_ATTR, String(pct));
        const fill = existing.firstElementChild as HTMLElement | null;
        if (fill) fill.style.width = `${pct}%`;
      }
      return;
    }

    this.ensurePositioned(host);
    host.appendChild(this.buildBar(pct));
  }

  // The bar is absolutely positioned, so its host needs a positioning context.
  // Only override when the host is statically positioned, and remember it so
  // stop() can restore the original layout.
  private ensurePositioned(host: HTMLElement): void {
    if (host.hasAttribute(HOST_ATTR)) return;
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
      host.setAttribute(HOST_ATTR, '');
    }
  }

  private buildBar(pct: number): HTMLElement {
    const bar = document.createElement('div');
    bar.className = BAR_CLASS;
    bar.setAttribute(PCT_ATTR, String(pct));
    const fill = document.createElement('div');
    fill.className = FILL_CLASS;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    return bar;
  }
}
