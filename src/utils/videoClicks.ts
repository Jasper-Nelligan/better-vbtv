import { VIDEO_LINK_SELECTOR } from '../constants';
import { log } from './logger';
import { recordVideoClick } from './videos';
import { fetchJwMeta, parseJwMediaId } from './videoMeta';

// Records a `videos` row every time the user clicks a thumbnail card.
//
// A plain class in `utils/` rather than a Solid island, for the same reason
// `ThumbnailProgress` is one: it reads DOM the *page* owns and mounts nothing.
// It is route-agnostic too — cards appear on every browse and list page — so
// `content.ts` starts it once, outside the player-only route handling.
//
// The interesting part is the upload date. Title, thumbnail and url all come
// from the same places watch history gets them (the JW feed and the player URL),
// but the upload date exists only as text on the card, between the thumbnail and
// the title, and only until the SPA swaps the page out. Clicking is therefore the
// one moment it can be captured, which is why the row is written here rather than
// on the player page where everything else about a video is already known.

// The card's date, rendered as `dd/mm/yyyy`.
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// How far up from the anchor to look for the card's own subtree. Small on
// purpose — see `cardRoot`, which stops earlier than this whenever it can.
const CARD_ANCESTOR_LIMIT = 4;

// `dd/mm/yyyy` -> `yyyy-mm-dd`, or null if it isn't a real date.
//
// The round-trip through `Date` is what rejects `31/02/2026`: the components are
// normalised on the way in, so a day that rolled over into the next month comes
// back different. Worth doing because this runs over every text node on the card
// and the pattern alone is not very selective — a scoreline never looks like
// this, but a stray "10/12/2026" in a description would.
export function toIsoDate(raw: string): string | null {
  const m = DATE_RE.exec(raw.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// First date-shaped text node under `root`, in document order — which is why the
// anchor is searched before the wider card: the closer the root, the less chance
// of picking up something that isn't this video's date.
function scanForDate(root: Element): string | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const iso = toIsoDate(node.nodeValue ?? '');
    if (iso) return iso;
    node = walker.nextNode();
  }
  return null;
}

// The smallest ancestor that still holds only this card.
//
// The anchor sometimes wraps the whole card and sometimes only the thumbnail, so
// the date can sit outside it. Climbing fixes that, but climbing too far reaches
// the grid or carousel that holds every *other* card — and their dates. Stopping
// at the first ancestor containing more than one card link is what keeps the
// scan on the right video; the depth limit is only a backstop for a page where
// that never becomes true.
function cardRoot(anchor: HTMLAnchorElement): Element {
  let node: Element = anchor;
  for (let i = 0; i < CARD_ANCESTOR_LIMIT; i++) {
    const parent = node.parentElement;
    if (!parent) break;
    if (parent.querySelectorAll(VIDEO_LINK_SELECTOR).length > 1) break;
    node = parent;
  }
  return node;
}

export function findUploadDate(anchor: HTMLAnchorElement): string | null {
  return scanForDate(anchor) ?? scanForDate(cardRoot(anchor));
}

export class VideoClicks {
  private listener: ((e: MouseEvent) => void) | null = null;

  public start(): void {
    log('VideoClicks.start()');
    if (this.listener) return;
    // Capture phase, like the keyboard listeners: the SPA router handles this
    // click to navigate, and may well stop it propagating any further.
    this.listener = (e) => this.onClick(e);
    document.addEventListener('click', this.listener, true);
  }

  public stop(): void {
    log('VideoClicks.stop()');
    if (!this.listener) return;
    document.removeEventListener('click', this.listener, true);
    this.listener = null;
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as Element | null;
    const anchor = target?.closest?.(VIDEO_LINK_SELECTOR) as HTMLAnchorElement | null;
    if (!anchor) return;

    // `anchor.href` is the resolved absolute player URL — the same string watch
    // history stores from `window.location.href` once the page has navigated.
    const id = parseJwMediaId(anchor.href);
    if (!id) return;

    void this.record(id, anchor.href, findUploadDate(anchor) ?? undefined);
  }

  // Two writes, for the reason `qualifyAndRecord` makes two: the row should exist
  // even if the metadata fetch is slow or fails, so record what the page already
  // told us first and refine it after. The queue collapses the pair into one
  // round trip whenever the fetch wins the race, and an omitted `title` leaves
  // the column alone rather than overwriting a good one with a placeholder.
  private async record(id: string, url: string, uploadDate?: string): Promise<void> {
    log('VideoClicks: clicked', id, uploadDate ?? '(no date found)');
    await recordVideoClick({ mediaId: id, url, uploadDate });

    const meta = await fetchJwMeta(id);
    if (!meta) return;
    await recordVideoClick({
      mediaId: id,
      url,
      uploadDate,
      title: meta.title,
      thumbnail: meta.thumbnail,
    });
  }
}
