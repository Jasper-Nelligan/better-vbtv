import { render } from 'solid-js/web';
import { createSignal, Show } from 'solid-js';
import styles from './MomentModal.module.css';
import { Combobox } from '../Combobox';
import { VIDEO_SELECTOR } from '../../constants';
import {
  createMomentTag,
  createMomentType,
  createPlayer,
  deleteMoment,
  loadTaxonomy,
  saveMoment,
  updateMoment,
  type Moment,
  type TaxonomyItem,
  type TaxonomyKind,
} from '../../utils/moments';
import { formatTime, parseJwMediaId } from '../../utils/videoMeta';
import { setModalOpen } from '../../utils/modalState';
import { log } from '../../utils/logger';
import { toast } from '../../utils/toast';

export interface MomentModalHandle {
  // Mark a new moment at the current playhead.
  show: () => void;
  // Edit an existing mark, opened from its pin on the seek bar.
  edit: (moment: Moment) => void;
  hide: () => void;
  toggle: () => void;
}

export interface MomentModalOptions {
  // Fired after a mark is created, edited or removed — never on cancel — so the
  // seek-bar pins can re-read. The modal itself knows nothing about them.
  onChanged?: () => void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Mounted as its own island (like the toast host and the shortcuts overlay),
// not through `Renderer` — the modal has to survive the player-page teardown
// order and is opened from the content script's own keyboard listener.
//
// Every data path here is a live round trip to Supabase via the background
// worker (see utils/moments.ts for why moments are synchronous where watch
// history is not), so all of them — load, create, save, delete — need a visible
// pending state and a visible failure state. Nothing is queued behind the
// scenes: if the network is down, the user has to know the mark wasn't taken.
export function mountMomentModal(
  rootId: string,
  options: MomentModalOptions = {},
): MomentModalHandle {
  let host = document.getElementById(rootId);
  if (!host) {
    host = document.createElement('div');
    host.id = rootId;
    document.body.appendChild(host);
  }

  const [visible, setVisible] = createSignal(false);
  // Frozen at open time so the mark doesn't drift while the user fills the form
  // (we deliberately don't pause the video).
  const [mediaId, setMediaId] = createSignal<string | null>(null);
  const [timeSec, setTimeSec] = createSignal(0);
  // Non-null when editing an existing mark rather than creating one. Drives the
  // title, the Delete button, and which request Save makes.
  const [editing, setEditing] = createSignal<Moment | null>(null);

  const [types, setTypes] = createSignal<TaxonomyItem[]>([]);
  const [tagOptions, setTagOptions] = createSignal<TaxonomyItem[]>([]);
  // Players are their own taxonomy, not tags with a naming convention — see
  // `TaxonomyKind`. Empty until the user creates some: unlike types and tags,
  // this list ships no seeds, so a fresh install shows "no matches, add one".
  const [playerOptions, setPlayerOptions] = createSignal<TaxonomyItem[]>([]);
  // The Combobox is name-based; ids are resolved on save against the lists
  // fetched here, which the server keeps unique per name.
  const [type, setType] = createSignal<string[]>([]);
  const [tags, setTags] = createSignal<string[]>([]);
  const [players, setPlayers] = createSignal<string[]>([]);

  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  // Removing is two steps, like creating a taxonomy value: the Delete button
  // swaps into a confirm pair rather than acting on the first click.
  const [confirming, setConfirming] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  // Any in-flight write. Dismissal and every other control is frozen while this
  // is true — see the comment on `hide()`.
  const busy = () => saving() || deleting();

  let firstInput: HTMLInputElement | undefined;
  // Bumped on every open, close and retry, so a slow reply belonging to an
  // earlier open can't land on the current form — including replacing a fresh
  // success with a stale error.
  let loadToken = 0;

  const load = async () => {
    const token = ++loadToken;
    setLoading(true);
    setLoadError(null);
    try {
      const taxonomy = await loadTaxonomy();
      if (token !== loadToken) return;
      setTypes(taxonomy.types);
      setTagOptions(taxonomy.tags);
      setPlayerOptions(taxonomy.players);

      // Prefill from the mark being edited. This has to happen before `loading`
      // flips: the Comboboxes are inside a <Show> on it, so they are created
      // fresh here and read these values as their initial state.
      const target = editing();
      if (target) {
        const typeName = taxonomy.types.find((t) => t.id === target.typeId)?.name;
        setType(typeName ? [typeName] : []);
        // A tag id with no matching row is dropped. The taxonomy is create-only
        // — nothing in the extension deletes a value — so this is the "written
        // by a version we don't understand" case, not an everyday one.
        setTags(
          target.tagIds
            .map((id) => taxonomy.tags.find((t) => t.id === id)?.name)
            .filter((name): name is string => !!name),
        );
        setPlayers(
          target.playerIds
            .map((id) => taxonomy.players.find((p) => p.id === id)?.name)
            .filter((name): name is string => !!name),
        );
      }

      setLoading(false);
      queueMicrotask(() => firstInput?.focus());
    } catch (err) {
      if (token !== loadToken) return;
      log('moments: taxonomy load failed', err);
      setLoadError(describe(err));
      setLoading(false);
    }
  };

  // When the player is fullscreen, only the fullscreen element's subtree is
  // painted — re-parent the modal into it so it stays visible on /player.
  const ensureParent = () => {
    if (!host) return;
    const parent = (document.fullscreenElement as HTMLElement | null) ?? document.body;
    if (host.parentElement !== parent) parent.appendChild(host);
  };

  const open = () => {
    setType([]);
    setTags([]);
    setPlayers([]);
    setSaving(false);
    setSaveError(null);
    setConfirming(false);
    setDeleting(false);
    ensureParent();
    setVisible(true);
    setModalOpen(true);
    // Refetched on every open rather than cached: it is one small request, and
    // a value added on another device should appear without a page reload.
    void load();
  };

  const show = () => {
    const video = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
    setEditing(null);
    setMediaId(parseJwMediaId(window.location.href));
    setTimeSec(video?.currentTime ?? 0);
    open();
  };

  const edit = (moment: Moment) => {
    setEditing(moment);
    setMediaId(moment.videoId);
    setTimeSec(moment.timeSec);
    open();
  };

  // Dismissal is blocked while a write is in flight. The request cannot be
  // called back, so closing here would either report success for a form the
  // user just cancelled, or swallow the failure and leave them thinking nothing
  // happened. The load request has no such problem — it is abandonable, hence
  // the token.
  const hide = () => {
    if (busy()) return;
    loadToken++;
    setVisible(false);
    setModalOpen(false);
  };

  const toggle = () => (visible() ? hide() : show());

  document.addEventListener('fullscreenchange', () => {
    if (visible()) ensureParent();
  });

  // Confirmed in the Combobox's "Add … as new?" strip. Deliberately not caught:
  // the strip is awaiting this promise and renders the failure itself, keeping
  // the typed text so Retry costs one click.
  const addType = async (name: string) => {
    const item = await createMomentType(name);
    setTypes((prev) => (prev.some((t) => t.id === item.id) ? prev : [...prev, item]));
  };

  const addTag = async (name: string) => {
    const item = await createMomentTag(name);
    setTagOptions((prev) => (prev.some((t) => t.id === item.id) ? prev : [...prev, item]));
  };

  const addPlayer = async (name: string) => {
    const item = await createPlayer(name);
    setPlayerOptions((prev) => (prev.some((p) => p.id === item.id) ? prev : [...prev, item]));
  };

  // Name -> id. The lists are refreshed on open and extended in place by the two
  // functions above, so this normally hits locally. The fallback covers the gap
  // where it doesn't: create is idempotent on the server and returns the
  // existing row for a known name, so it resolves rather than duplicating.
  const LISTS: Record<TaxonomyKind, () => TaxonomyItem[]> = {
    type: types,
    tag: tagOptions,
    player: playerOptions,
  };
  const CREATE: Record<TaxonomyKind, (name: string) => Promise<TaxonomyItem>> = {
    type: createMomentType,
    tag: createMomentTag,
    player: createPlayer,
  };

  const resolve = async (kind: TaxonomyKind, name: string): Promise<TaxonomyItem> => {
    const hit = LISTS[kind]().find(
      (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (hit) return hit;
    return CREATE[kind](name);
  };

  const save = async () => {
    const chosen = type()[0];
    if (!chosen || busy()) return;
    setSaving(true);
    setSaveError(null);
    const target = editing();
    try {
      const typeItem = await resolve('type', chosen);
      const tagIds: string[] = [];
      for (const name of tags()) tagIds.push((await resolve('tag', name)).id);
      const playerIds: string[] = [];
      for (const name of players()) playerIds.push((await resolve('player', name)).id);

      if (target) {
        await updateMoment(target.id, { typeId: typeItem.id, tagIds, playerIds });
      } else {
        await saveMoment({
          videoId: mediaId(),
          timeSec: timeSec(),
          typeId: typeItem.id,
          tagIds,
          playerIds,
        });
      }
    } catch (err) {
      // Nothing is queued behind this, so the modal stays open with the form
      // intact: the change does not exist until this succeeds.
      log('moments: save failed', err);
      setSaveError(describe(err));
      setSaving(false);
      return;
    }

    // Order matters: `hide()` refuses to close while a write is in flight, so
    // the flag has to be cleared before it is called, not in a `finally` after.
    setSaving(false);
    toast(
      target
        ? `✏️ ${chosen} @ ${formatTime(timeSec())}`
        : `🔖 ${chosen} @ ${formatTime(timeSec())}`,
    );
    hide();
    options.onChanged?.();
  };

  const remove = async () => {
    const target = editing();
    if (!target || busy()) return;
    setDeleting(true);
    setSaveError(null);
    try {
      await deleteMoment(target.id);
    } catch (err) {
      log('moments: delete failed', err);
      setSaveError(describe(err));
      setDeleting(false);
      return;
    }
    setDeleting(false);
    toast(`🗑️ Moment removed`);
    hide();
    options.onChanged?.();
  };

  // Escape unwinds one layer at a time: the Combobox swallows it while its
  // dropdown or confirm strip is open, so it only reaches here afterwards. The
  // delete confirmation is a layer too, and unwinds before the modal does.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (confirming() && !busy()) {
      setConfirming(false);
      return;
    }
    hide();
  };

  render(
    () => (
      <Show when={visible()}>
        <div class={styles.backdrop} onClick={hide} onKeyDown={onKeyDown}>
          <div
            class={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-label={editing() ? 'Edit moment' : 'Mark a moment'}
            onClick={(e) => e.stopPropagation()}
          >
            <div class={styles.header}>
              <span class={styles.title}>{editing() ? 'Edit moment' : 'Mark a moment'}</span>
              <span class={styles.time}>{formatTime(timeSec())}</span>
              <button
                class={styles.close}
                onClick={hide}
                disabled={busy()}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div class={styles.body}>
              <Show when={loading()}>
                <p class={styles.status}>Loading types and tags…</p>
              </Show>

              <Show when={loadError()}>
                <div class={styles.errorBox} role="alert">
                  <span>{loadError()}</span>
                  <button class={styles.retry} onClick={() => void load()}>
                    Retry
                  </button>
                </div>
              </Show>

              <Show when={!loading() && !loadError()}>
                <Combobox
                  label="Moment type"
                  placeholder="Search or add a type…"
                  required
                  options={types().map((t) => t.name)}
                  value={type()}
                  onChange={setType}
                  onCreate={addType}
                  ref={(el) => (firstInput = el)}
                />
                <Combobox
                  label="Tags"
                  placeholder="Add tags…"
                  multiple
                  options={tagOptions().map((t) => t.name)}
                  value={tags()}
                  onChange={setTags}
                  onCreate={addTag}
                />
                <Combobox
                  label="Players"
                  placeholder="Add players…"
                  multiple
                  options={playerOptions().map((p) => p.name)}
                  value={players()}
                  onChange={setPlayers}
                  onCreate={addPlayer}
                />
              </Show>
            </div>

            <Show when={saveError()}>
              <div class={`${styles.errorBox} ${styles.errorBoxStandalone}`} role="alert">
                <span>{saveError()}</span>
              </div>
            </Show>

            <div class={styles.footer}>
              <Show when={editing()}>
                <span class={styles.footerStart}>
                  <Show
                    when={confirming()}
                    fallback={
                      <button
                        class={styles.delete}
                        onClick={() => setConfirming(true)}
                        disabled={busy()}
                      >
                        Delete
                      </button>
                    }
                  >
                    <span class={styles.confirmText}>Remove this mark?</span>
                    <button
                      class={styles.deleteConfirm}
                      onClick={() => void remove()}
                      disabled={busy()}
                    >
                      {deleting() ? 'Removing…' : 'Remove'}
                    </button>
                    <button
                      class={styles.cancel}
                      onClick={() => setConfirming(false)}
                      disabled={busy()}
                    >
                      Keep
                    </button>
                  </Show>
                </span>
              </Show>
              <button class={styles.cancel} onClick={hide} disabled={busy()}>
                Cancel
              </button>
              <button
                class={styles.save}
                disabled={!type().length || busy() || loading() || !!loadError()}
                onClick={() => void save()}
              >
                {saving() ? 'Saving…' : editing() ? 'Save changes' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </Show>
    ),
    host,
  );

  return { show, edit, hide, toggle };
}
