-- Better VBTV — drop `user_id` from watch_history.
--
-- This is a private, single-account extension: `getClient()` signs in with one
-- hard-coded set of credentials and there is no sign-in UI, so `user_id` was
-- always the same uuid on every row. It bought nothing but a join key to
-- `auth.users` and an extra `.eq()` on every query.
--
-- What replaces it as the privacy boundary: RLS stays ON, and every policy is
-- granted `to authenticated` with a `true` predicate. The anon key ships inside
-- the extension bundle, so the anon role must still see nothing; what changes is
-- only that "the signed-in account" is now implicit rather than matched per row.
--
-- The moments tables (`moment_types`, `moment_tags`, `moments`) still carry
-- `user_id` and are untouched here.

-- Policies reference the column, so they have to go before it does.
drop policy if exists "own rows readable"   on public.watch_history;
drop policy if exists "own rows insertable" on public.watch_history;
drop policy if exists "own rows updatable"  on public.watch_history;
drop policy if exists "own rows deletable"  on public.watch_history;

-- Both of these lead with user_id and are superseded below.
drop index if exists public.watch_history_user_updated_idx;
alter table public.watch_history drop constraint if exists watch_history_pkey;

alter table public.watch_history drop column if exists user_id;

-- media_id — the JW media id — is the stable per-video key on its own now, and
-- the upsert in historyRemote.ts needs it to be a real conflict target.
--
-- Deliberately not de-duplicating first: with one account there is nothing to
-- de-duplicate, and if a second account's rows ever did exist, failing loudly
-- here beats silently deleting half of them.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.watch_history'::regclass and contype = 'p'
  ) then
    alter table public.watch_history add primary key (media_id);
  end if;
end $$;

-- Pulls read the newest live rows.
create index if not exists watch_history_updated_idx
  on public.watch_history (updated_at desc);

drop policy if exists "authenticated rows readable"   on public.watch_history;
drop policy if exists "authenticated rows insertable" on public.watch_history;
drop policy if exists "authenticated rows updatable"  on public.watch_history;
drop policy if exists "authenticated rows deletable"  on public.watch_history;

-- RLS is still what keeps the table private — the bundled anon key gets nothing.
-- `to authenticated` is the whole scope now: one account, every row is its own.
create policy "authenticated rows readable" on public.watch_history
  for select to authenticated using (true);

create policy "authenticated rows insertable" on public.watch_history
  for insert to authenticated with check (true);

create policy "authenticated rows updatable" on public.watch_history
  for update to authenticated using (true) with check (true);

create policy "authenticated rows deletable" on public.watch_history
  for delete to authenticated using (true);
