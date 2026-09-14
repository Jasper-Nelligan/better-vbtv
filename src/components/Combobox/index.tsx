import { createMemo, createSignal, For, Show } from 'solid-js';
import styles from './Combobox.module.css';
import { nearMatches } from '../../utils/fuzzy';

export interface ComboboxProps {
  label: string;
  placeholder?: string;
  required?: boolean;
  // Tags-style multi-select: selections become removable chips and the input
  // clears after each pick. Single mode keeps the value as the input's text.
  multiple?: boolean;
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  // Fired only after the user confirms the inline "Add … as new?" strip. May be
  // async — creating a value is a server round trip — in which case the strip
  // stays up and busy until it settles, and shows the reason if it rejects.
  onCreate: (value: string) => void | Promise<void>;
  ref?: (el: HTMLInputElement) => void;
}

// A navigable dropdown row. "near" rows are typo suggestions the substring
// filter missed; "create" is always last.
type Row =
  | { kind: 'option'; value: string }
  | { kind: 'near'; value: string }
  | { kind: 'create'; value: string };

let uid = 0;

export const Combobox = (props: ComboboxProps) => {
  const id = `bvtv-combobox-${++uid}`;
  let inputEl: HTMLInputElement | undefined;
  let wrapperEl: HTMLDivElement | undefined;
  let addBtn: HTMLButtonElement | undefined;

  // Seeded from the initial value so a single-select field opens showing what
  // is already chosen — the edit-a-mark case, where the modal sets `value`
  // before this component is created. Read once, not tracked: from here on the
  // text belongs to the user.
  const [query, setQuery] = createSignal(props.multiple ? '' : (props.value[0] ?? ''));
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  // Non-null while the "Add <x> as new?" confirm strip is showing.
  const [pendingCreate, setPendingCreate] = createSignal<string | null>(null);
  // The strip's in-flight and failed states. On failure it deliberately stays
  // open with the text intact, so retrying is one click and nothing is retyped.
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal<string | null>(null);
  // Only filter once the user has actually typed, so re-opening a single-select
  // field shows the whole list rather than just the value already in the box.
  const [typed, setTyped] = createSignal(false);

  const needle = () => (typed() ? query().trim() : '');

  // In multi mode a chosen tag leaves the list; in single mode the current
  // value stays visible so it reads as the selected row.
  const available = createMemo(() =>
    props.multiple ? props.options.filter((o) => !props.value.includes(o)) : props.options,
  );

  const matches = createMemo(() => {
    const q = needle().toLowerCase();
    if (!q) return available();
    return available().filter((o) => o.toLowerCase().includes(q));
  });

  const near = createMemo(() => {
    if (!needle()) return [];
    const shown = new Set(matches().map((m) => m.toLowerCase()));
    return nearMatches(needle(), available()).filter((o) => !shown.has(o.toLowerCase()));
  });

  // Compared against every known option, not just the available ones — typing a
  // tag that is already a chip must not offer to create a duplicate.
  const isExisting = createMemo(() => {
    const q = needle().toLowerCase();
    return !!q && props.options.some((o) => o.toLowerCase() === q);
  });

  const rows = createMemo<Row[]>(() => [
    ...matches().map((value): Row => ({ kind: 'option', value })),
    ...near().map((value): Row => ({ kind: 'near', value })),
    ...(needle() && !isExisting() ? [{ kind: 'create', value: needle() } as Row] : []),
  ]);

  const select = (value: string) => {
    setTyped(false);
    setPendingCreate(null);
    setCreateError(null);
    setActiveIndex(0);
    // Focus first: returning from the confirm strip's button fires `onFocus`,
    // which re-opens the dropdown — so the single-select close below has to
    // come after it, not before.
    inputEl?.focus();
    if (props.multiple) {
      // Stay open; picking several tags in a row is the common case.
      if (!props.value.includes(value)) props.onChange([...props.value, value]);
      setQuery('');
    } else {
      props.onChange([value]);
      setQuery(value);
      setOpen(false);
    }
  };

  const remove = (value: string) => {
    props.onChange(props.value.filter((v) => v !== value));
    inputEl?.focus();
  };

  // Picking "Create …" never commits — it opens the confirm strip instead. This
  // is the typo guard: a misspelling costs one more deliberate keystroke, and
  // the near-matches stay listed above so backing out is one click.
  const activate = (row: Row) => {
    if (row.kind === 'create') {
      setPendingCreate(row.value);
      queueMicrotask(() => addBtn?.focus());
      return;
    }
    select(row.value);
  };

  const confirmCreate = () => {
    const value = pendingCreate();
    if (!value || creating()) return;
    setCreating(true);
    setCreateError(null);
    // Wrapped rather than awaited so a synchronous `onCreate` still works: the
    // Combobox is generic and shouldn't require its parent to be async.
    void Promise.resolve(props.onCreate(value)).then(
      () => {
        setCreating(false);
        select(value);
      },
      (err: unknown) => {
        setCreating(false);
        setCreateError(err instanceof Error ? err.message : String(err));
        queueMicrotask(() => addBtn?.focus());
      },
    );
  };

  const cancelCreate = () => {
    if (creating()) return;
    setPendingCreate(null);
    setCreateError(null);
    inputEl?.focus();
  };

  const move = (delta: number) => {
    const count = rows().length;
    if (!count) return;
    setActiveIndex((i) => (i + delta + count) % count);
  };

  const onInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    setQuery(e.currentTarget.value);
    setTyped(true);
    setOpen(true);
    setActiveIndex(0);
    // Editing the text of a single-select field un-picks whatever was chosen,
    // so a half-typed value can never be mistaken for a committed one.
    if (!props.multiple) props.onChange([]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // While the strip is up focus sits on its buttons, so this only fires if
    // the user tabbed back into the input.
    if (pendingCreate()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelCreate();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (open()) move(1);
        else setOpen(true);
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (open()) move(-1);
        else setOpen(true);
        break;
      case 'Enter': {
        const row = rows()[activeIndex()];
        if (!open() || !row) return;
        e.preventDefault();
        e.stopPropagation();
        activate(row);
        break;
      }
      case 'Escape':
        // Swallow it only when there is something of our own to close, so a
        // second Escape reaches the modal.
        if (open()) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        break;
      case 'Backspace':
        if (props.multiple && !query() && props.value.length) {
          e.preventDefault();
          props.onChange(props.value.slice(0, -1));
        }
        break;
    }
  };

  const onStripKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelCreate();
  };

  const onFocusOut = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && wrapperEl?.contains(next)) return;
    // Never tear the strip down mid-request: the reply is about to land, and
    // `select()` needs somewhere to put it.
    if (creating()) return;
    setOpen(false);
    setPendingCreate(null);
    setCreateError(null);
  };

  return (
    <div class={styles.wrapper} ref={wrapperEl} onFocusOut={onFocusOut}>
      <label class={styles.label} for={`${id}-input`}>
        <span>{props.label}</span>
        <span class={props.required ? styles.required : styles.optional}>
          {props.required ? 'required' : 'optional'}
        </span>
      </label>

      <div class={styles.field} onClick={() => inputEl?.focus()}>
        <Show when={props.multiple}>
          <For each={props.value}>
            {(tag) => (
              <span class={styles.chip}>
                {tag}
                <button
                  type="button"
                  class={styles.chipRemove}
                  aria-label={`Remove ${tag}`}
                  onClick={() => remove(tag)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </Show>
        <input
          id={`${id}-input`}
          ref={(el) => {
            inputEl = el;
            props.ref?.(el);
          }}
          class={styles.input}
          type="text"
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={open()}
          aria-controls={`${id}-list`}
          aria-activedescendant={open() && !pendingCreate() ? `${id}-row-${activeIndex()}` : undefined}
          placeholder={props.multiple && props.value.length ? '' : props.placeholder}
          value={query()}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
        />
      </div>

      <Show when={open()}>
        <div class={styles.dropdown}>
          <Show when={rows().length || pendingCreate()} fallback={<div class={styles.empty}>No options</div>}>
            <ul class={styles.list} id={`${id}-list`} role="listbox">
              <For each={rows()}>
                {(row, i) => (
                  <Show when={!(pendingCreate() && row.kind === 'create')} fallback={
                    <li class={styles.confirm} role="presentation" onKeyDown={onStripKeyDown}>
                      <span class={styles.confirmText}>
                        <Show
                          when={createError()}
                          fallback={<>Add <strong>{`"${row.value}"`}</strong> as new?</>}
                        >
                          <span class={styles.confirmError}>{createError()}</span>
                        </Show>
                      </span>
                      <span class={styles.confirmActions}>
                        <button
                          type="button"
                          class={styles.confirmAdd}
                          ref={addBtn}
                          disabled={creating()}
                          onClick={confirmCreate}
                        >
                          {creating() ? 'Adding…' : createError() ? 'Retry' : 'Add'}
                        </button>
                        <button
                          type="button"
                          class={styles.confirmCancel}
                          disabled={creating()}
                          onClick={cancelCreate}
                        >
                          Cancel
                        </button>
                      </span>
                    </li>
                  }>
                    <Show when={row.kind === 'near' && rows()[i() - 1]?.kind !== 'near'}>
                      <li class={styles.groupTitle} role="presentation">
                        Did you mean
                      </li>
                    </Show>
                    <li
                      id={`${id}-row-${i()}`}
                      role="option"
                      aria-selected={activeIndex() === i()}
                      classList={{
                        [styles.row]: true,
                        [styles.active]: activeIndex() === i() && !pendingCreate(),
                        [styles.createRow]: row.kind === 'create',
                      }}
                      // preventDefault keeps focus in the field so the click
                      // isn't eaten by the focusout that would otherwise close
                      // the dropdown first.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(i())}
                      onClick={() => activate(row)}
                    >
                      <Show when={row.kind === 'create'} fallback={row.value}>
                        {`Create "${row.value}"`}
                      </Show>
                    </li>
                  </Show>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  );
};
