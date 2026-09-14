-- Better VBTV — watch history schema.
--
-- Applied with the Supabase CLI: `pnpm db:push` (remote, after `pnpm db:link`)
-- or `pnpm db:reset` (local stack). Pasting it into the dashboard SQL editor
-- still works — every statement here is idempotent — but the CLI is the path
-- that records it in `supabase_migrations`.
--
-- Then create the single account under Authentication -> Users -> Add user
-- (mark it confirmed) and put its email and password in `.env` as
-- VITE_SUPABASE_EMAIL / VITE_SUPABASE_PASSWORD.
--
-- Mirrors the `HistoryEntry` shape in src/utils/history.ts, in snake_case, with
-- two additions:
--   * user_id    — scopes rows to the account and drives the RLS policies.
--   * deleted_at — tombstone rather than a hard delete. The extension caps its
--                  local cache at HISTORY_MAX_ENTRIES while this table keeps
--                  everything, so a pruned row and a deleted row are
--                  indistinguishable locally; without the tombstone the next
--                  pull would resurrect anything removed from the popup.

create table if not exists public.watch_history (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  media_id     text        not null,                          -- JW media id, the stable per-video key
  title        text        not null default 'VBTV replay',
  thumbnail    text,
  url          text        not null,                          -- full player URL, to reopen the video
  position_sec double precision not null default 0,           -- resume point
  duration_sec double precision not null default 0,
  updated_at   timestamptz not null default now(),            -- last viewed; drives recency sort + conflict resolution
  deleted_at   timestamptz,
  primary key (user_id, media_id)
);

-- Pulls read the newest live rows for one user.
create index if not exists watch_history_user_updated_idx
  on public.watch_history (user_id, updated_at desc);

alter table public.watch_history enable row level security;

-- The anon key ships inside the extension bundle, so RLS is what actually keeps
-- the table private: every statement is scoped to the signed-in account.
drop policy if exists "own rows readable"   on public.watch_history;
drop policy if exists "own rows insertable" on public.watch_history;
drop policy if exists "own rows updatable"  on public.watch_history;
drop policy if exists "own rows deletable"  on public.watch_history;

create policy "own rows readable" on public.watch_history
  for select using (auth.uid() = user_id);

create policy "own rows insertable" on public.watch_history
  for insert with check (auth.uid() = user_id);

create policy "own rows updatable" on public.watch_history
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows deletable" on public.watch_history
  for delete using (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Moments — the "mark a moment" feature (press `m` on /player).
--
-- Three tables, mirroring src/utils/moments.ts:
--   * moment_types — the required taxonomy ("Exciting rally", …)
--   * moment_tags  — the optional taxonomy ("Ace", "Match point", …)
--   * moments      — one mark: a video, a playback position, a type, some tags
--
-- These behave differently from watch_history above, and the difference is the
-- whole design:
--
--   * Ids are generated HERE, by Postgres, not by the extension. watch_history
--     is offline-first — it writes a local cache and queues the push — so its
--     rows need their final key before they ever reach the database. Moments are
--     written synchronously instead: the modal waits on the insert and reads the
--     id back. One source of truth, no id reconciliation.
--
--   * The taxonomy names are UNIQUE per user. That constraint would be unsafe
--     behind a retry queue (a violation would fail the same op forever and wedge
--     everything behind it), but with a synchronous write there is no queue to
--     wedge: a conflict is resolved in the same round trip by upserting on the
--     name, so two tabs adding "Ace" at once end up with one row.
--
--   * Nothing is tombstoned. These tables are create-only — no surface in the
--     extension deletes a mark or a taxonomy value — so there is no delete for a
--     later read to resurrect.
--
-- user_id and RLS carry over from watch_history unchanged: the anon key ships
-- inside the extension bundle, so RLS is the only thing keeping rows private.

create table if not exists public.moment_types (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  moment_type text        not null,
  created_at  timestamptz not null default now(),
  -- The conflict target the extension upserts on. Exact-string, because
  -- PostgREST can only name plain columns here; the worker does the
  -- case-insensitive check itself before inserting.
  unique (user_id, moment_type)
);

create table if not exists public.moment_tags (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  tag        text        not null,
  created_at timestamptz not null default now(),
  unique (user_id, tag)
);

create table if not exists public.moments (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users (id) on delete cascade,
  -- JW media id, the same key watch_history.media_id uses. Nullable because the
  -- id is parsed out of the player URL and a layout change could break that; a
  -- mark with an unknown video still beats losing the mark.
  video_id      text,
  -- Playback position of the mark, in seconds. Frozen when the modal opened, so
  -- it does not drift while the form is being filled.
  timestamp_sec double precision not null default 0,
  -- `restrict` rather than `cascade`: deleting a type that marks still reference
  -- should fail loudly, not silently take the marks with it.
  type_id       uuid        not null references public.moment_types (id) on delete restrict,
  -- Tag ids. An array rather than a join table: Postgres cannot enforce a
  -- foreign key per element, but the extension always fetches the whole (small)
  -- moment_tags list to resolve them, and it keeps a mark one row and one insert.
  tag_ids       uuid[]      not null default '{}',
  created_at    timestamptz not null default now()
);

-- Reads are "this user's newest marks" and "this user's marks on one video".
create index if not exists moments_user_created_idx
  on public.moments (user_id, created_at desc);

-- One mark per position: re-opening the modal without moving the playhead and
-- saving again is a double-submit, not a second mark, so the database refuses it
-- rather than trusting the client to notice. A unique INDEX rather than a table
-- constraint because this is idempotent — it applies to an existing `moments`
-- table too, where `create table if not exists` above would have done nothing.
--
-- Two things follow from it:
--   * It also serves "this user's marks on one video" (that pair is the index's
--     leading prefix), which is why there is no separate index for that.
--   * NULL video_id never conflicts — Postgres treats NULLs as distinct. That is
--     the right call: an unparseable player URL means we don't know these are the
--     same video, and blocking a mark on a guess is worse than allowing two.
create unique index if not exists moments_user_video_time_key
  on public.moments (user_id, video_id, timestamp_sec);
drop index if exists moments_user_video_idx;

alter table public.moment_types enable row level security;
alter table public.moment_tags  enable row level security;
alter table public.moments      enable row level security;

drop policy if exists "own moment types readable"   on public.moment_types;
drop policy if exists "own moment types insertable" on public.moment_types;
drop policy if exists "own moment types updatable"  on public.moment_types;
drop policy if exists "own moment types deletable"  on public.moment_types;

create policy "own moment types readable" on public.moment_types
  for select using (auth.uid() = user_id);
create policy "own moment types insertable" on public.moment_types
  for insert with check (auth.uid() = user_id);
-- Needed even though names are never edited: an upsert is INSERT ... ON CONFLICT
-- DO UPDATE, and the UPDATE arm is checked against this policy.
create policy "own moment types updatable" on public.moment_types
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own moment types deletable" on public.moment_types
  for delete using (auth.uid() = user_id);

drop policy if exists "own moment tags readable"   on public.moment_tags;
drop policy if exists "own moment tags insertable" on public.moment_tags;
drop policy if exists "own moment tags updatable"  on public.moment_tags;
drop policy if exists "own moment tags deletable"  on public.moment_tags;

create policy "own moment tags readable" on public.moment_tags
  for select using (auth.uid() = user_id);
create policy "own moment tags insertable" on public.moment_tags
  for insert with check (auth.uid() = user_id);
create policy "own moment tags updatable" on public.moment_tags
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own moment tags deletable" on public.moment_tags
  for delete using (auth.uid() = user_id);

drop policy if exists "own moments readable"   on public.moments;
drop policy if exists "own moments insertable" on public.moments;
drop policy if exists "own moments updatable"  on public.moments;
drop policy if exists "own moments deletable"  on public.moments;

create policy "own moments readable" on public.moments
  for select using (auth.uid() = user_id);
create policy "own moments insertable" on public.moments
  for insert with check (auth.uid() = user_id);
create policy "own moments updatable" on public.moments
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own moments deletable" on public.moments
  for delete using (auth.uid() = user_id);
