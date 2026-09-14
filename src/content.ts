/* @refresh reload */
import "./styles.css";

import { Renderer } from './components/renderer';
import { log } from './utils/logger';
import { ElementObserver } from './utils/elementObserver';
import { PAGE_PATHS, ROOT_ID,
  MOMENT_MODAL_ID,
  SHORTCUTS_OVERLAY_ID,
  TOAST_ID,
  WITH_SPOILER_CLASS,
  VIDEO_SELECTOR } from './constants'
import { observeRouteChange } from './utils/routeChangeObserver';
import { mountShortcutsOverlay } from './components/ShortcutsOverlay';
import { mountMomentModal } from './components/MomentModal';
import { MomentMarkers } from './utils/momentMarkers';
import { mountToast } from './components/Toast';
import { toast } from './utils/toast';
import { isModalOpen } from './utils/modalState';
import { getNoSpoiler, setNoSpoiler } from './utils/settings';
import { ThumbnailProgress } from './utils/thumbnailProgress';
import { VideoClicks } from './utils/videoClicks';
import { requestPassiveSync } from './utils/syncStatus';
import ext from './utils/browser';

log("🏐🏐🏐")

mountToast(TOAST_ID);
const shortcutsOverlay = mountShortcutsOverlay(SHORTCUTS_OVERLAY_ID);

// Pins on the seek bar and the modal are two halves of one feature, wired to
// each other here rather than to each other's internals: a shift-click on a pin
// opens the editor, and any write the editor completes re-reads the pins. A
// plain click just seeks, and never reaches this file.
const momentMarkers = new MomentMarkers({
  onEdit: (moment) => {
    shortcutsOverlay.hide(); // it sits on a higher layer; don't bury the modal
    momentModal.edit(moment);
  },
});
const momentModal = mountMomentModal(MOMENT_MODAL_ID, {
  onChanged: () => momentMarkers.refresh(),
});
let onPlayerPage = false;

// Draw watch-progress bars on thumbnails across every VBTV page. This is
// route-agnostic (its own MutationObserver tracks SPA navigation and lazy-loaded
// cards), so it lives outside the player-only route handling below.
const thumbnailProgress = new ThumbnailProgress();
void thumbnailProgress.start();

// Record a `videos` row whenever a card is clicked. Route-agnostic for the same
// reason — cards are everywhere but the player page — and it has to run on the
// browse page specifically: the upload date is only on the card, and only until
// the SPA navigates away from it.
const videoClicks = new VideoClicks();
videoClicks.start();

// Pull the remote watch history into this device's cache now. Nothing else in
// the content script ever asks for one — `enqueue()`'s wake message only drains
// the *outbound* queue — so without this a cache that is empty or stale (a
// second browser, a fresh profile, anything watched elsewhere) stays that way
// until the worker's 15-minute alarm fires: no thumbnail progress bars, and no
// resume prompt. The worker throttles these, so reloading in a loop is cheap.
// Both surfaces pick the result up through `storage.onChanged`.
requestPassiveSync();

setupSpoilerFreeToggleListener();
setupGlobalKeyboard();
await initializeSpoilerFreeState();

// Keyboard shortcuts:
// - "s"  toggles spoiler-free mode (any VBTV page)
// - "?"  (Shift+/) toggles the shortcuts overlay (player page only)
// - "m"  opens the mark-a-moment modal (player page only); saved marks also
//        appear as clickable pins above the seek bar (utils/momentMarkers.ts)
// - Esc  closes the overlay
//
// Listen on `window` in the CAPTURE phase so we receive the key before the
// video.js player (or the page's "/"-to-search handler) can swallow it. This
// is why arrow-seek worked but "?" did not — video.js intercepts focused keys.
function setupGlobalKeyboard() {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    // An open modal owns the keyboard outright — Escape included, so it can
    // close its own dropdown before the modal itself.
    if (isModalOpen()) return;

    const isQuestionMark = e.key === '?' || (e.code === 'Slash' && e.shiftKey);
    if (isQuestionMark) {
      if (!onPlayerPage) return; // overlay is player-only
      e.preventDefault();
      e.stopPropagation();
      shortcutsOverlay.toggle();
      return;
    }

    if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (!onPlayerPage) return; // the modal marks a moment in a video
      e.preventDefault();
      e.stopPropagation();
      shortcutsOverlay.hide(); // it sits on a higher layer; don't bury the modal
      momentModal.show();
      return;
    }

    if (e.key === 'Escape') {
      shortcutsOverlay.hide();
      return;
    }

    if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleSpoilerFree();
    }
  }, true);
}

async function toggleSpoilerFree() {
  const next = !(await getNoSpoiler());
  await setNoSpoiler(next);
  handleNoSpoilerChange(next);
  toast(next ? '🙈 Spoilers hidden' : '👀 Spoilers shown');
  log('toggleSpoilerFree ->', next);
}

function setupSpoilerFreeToggleListener() {
  ext.runtime.onMessage.addListener((message) => {
    if (message.type === 'NO_SPOILER_TOGGLE_STATE_CHANGED') {
      log('NO_SPOILER_TOGGLE_STATE_CHANGED', message.enabled)
      handleNoSpoilerChange(message.enabled);
      toast(message.enabled ? '🙈 Spoilers hidden' : '👀 Spoilers shown');
    }
  });
};

function handleNoSpoilerChange(noSpoiler: boolean) {
  if (!noSpoiler) {
    // add with spoiler class to enable spoiler styles
    document.body.classList.add(WITH_SPOILER_CLASS);
  } else {
    // remove with spoiler class to enable NO spoiler styles
    document.body.classList.remove(WITH_SPOILER_CLASS);
  }
};

// src/content/feature.ts
async function initializeSpoilerFreeState() {
  // Check initial state when content script loads
  const noSpoiler = await getNoSpoiler()
  log("initializeSpoilerFreeState noSpoiler", noSpoiler)
  setTimeout(
    () => handleNoSpoilerChange(noSpoiler),
    noSpoiler === false
      ? 400 // delay applying spoiler styles on initialization to wait for source rendering
      : 0
  )
};

let observer: ElementObserver | null;
let renderer: Renderer | null;

let cleanupRouteChangeObserver: ReturnType<typeof observeRouteChange>

handleRouteChange(window.location.pathname)

if (window.navigation) {
  window.navigation.addEventListener("navigate", (event) => {
    const url = new URL(event.destination.url)
    log('[navigate] location changed!', url.pathname);
    handleRouteChange(url.pathname)
  })
} else {
  cleanupRouteChangeObserver = observeRouteChange((pathname) => {
    log('[routeChangeObserver] route change:', pathname);
    handleRouteChange(pathname)
  });
}

function handleRouteChange(pathname: string) {
  onPlayerPage = pathname === PAGE_PATHS.PLAYER
  if (onPlayerPage) {
    observer = new ElementObserver({ selector: VIDEO_SELECTOR })
    observer.observe(() => {
      renderer = createRenderer()
      renderer.render()
      // Started here rather than on the route change: it needs the <video> the
      // observer just waited for, to read a duration to place pins against.
      momentMarkers.start()
    })
  } else {
    log("Not on player page")
    shortcutsOverlay.hide()
    momentModal.hide()
    momentMarkers.stop()
    cleanupObserver()
    cleanupRenderer()
  }
}

function cleanupObserver() {
  log("cleanupObserver()")
  if (observer) {
    observer.cleanup()
    observer = null
  }
}

function cleanupRenderer() {
  log("cleanupRenderer()")
  if (renderer) {
    renderer.destroy()
    renderer = null
  }
}

function createRenderer() {
  log("createRenderer")
  if (renderer) {
    return renderer
  }
  log("create new renderer")
  renderer = new Renderer({
    rootId: ROOT_ID,
  })
  return renderer
}

window.addEventListener('beforeunload', () => {
  log("beforeunload")
  if (cleanupRouteChangeObserver) {
    log("cleanupRouteChangeObserver()")
    cleanupRouteChangeObserver()
  }
  cleanupObserver()
  cleanupRenderer()
  momentMarkers.stop()
  thumbnailProgress.stop()
  videoClicks.stop()
});
