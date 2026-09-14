-- Better VBTV — watch history schema.
--
-- Run once in the Supabase SQL editor, then create the single account under
-- Authentication -> Users -> Add user (mark it confirmed) and put its email and
-- password in `.env` as VITE_SUPABASE_EMAIL / VITE_SUPABASE_PASSWORD.
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
