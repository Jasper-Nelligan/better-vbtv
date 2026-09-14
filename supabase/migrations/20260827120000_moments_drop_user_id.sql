-- Better VBTV — drop `user_id` from the three moment tables.
--
-- The same change 20260824120000 made to `watch_history`, for the same reason:
-- this is a private, single-account extension. `getClient()` signs in with one
-- hard-coded set of credentials and there is no sign-in UI, so `user_id` was
-- always the same uuid on every row — a join key to `auth.users` and an extra
-- `.eq()` on every query, buying nothing.
--
-- What replaces it as the privacy boundary: RLS stays ON, and every policy is
-- granted `to authenticated` with a `true` predicate. The anon key ships inside
-- the extension bundle, so the anon role must still see nothing; what changes is
-- only that "the signed-in account" is now implicit rather than matched per row.
--
-- Every uniqueness rule the moment feature leans on survives this, minus its
-- leading column — see the index section below, which is the part that matters.

-- Policies reference the column, so they have to go before it does.
drop policy if exists "own moment types readable"   on public.moment_types;
drop policy if exists "own moment types insertable" on public.moment_types;
drop policy if exists "own moment types updatable"  on public.moment_types;
drop policy if exists "own moment types deletable"  on public.moment_types;

drop policy if exists "own moment tags readable"   on public.moment_tags;
drop policy if exists "own moment tags insertable" on public.moment_tags;
drop policy if exists "own moment tags updatable"  on public.moment_tags;
drop policy if exists "own moment tags deletable"  on public.moment_tags;

drop policy if exists "own moments readable"   on public.moments;
drop policy if exists "own moments insertable" on public.moments;
drop policy if exists "own moments updatable"  on public.moments;
drop policy if exists "own moments deletable"  on public.moments;

-- Everything below leads with user_id and is superseded further down. Dropping
-- the column would take these with it anyway (Postgres drops any index or
-- constraint involving a dropped column), but naming them keeps the intent
-- visible: they are being *replaced*, not merely lost.
alter table public.moment_types drop constraint if exists moment_types_user_id_moment_type_key;
alter table public.moment_tags  drop constraint if exists moment_tags_user_id_tag_key;
drop index if exists public.moments_user_created_idx;
drop index if exists public.moments_user_video_time_key;

alter table public.moment_types drop column if exists user_id;
alter table public.moment_tags  drop column if exists user_id;
alter table public.moments      drop column if exists user_id;

-- The taxonomy names are unique on their own now. Still an exact-string index
-- rather than `lower(...)`: PostgREST's conflict target can only name plain
-- columns, and `createTaxonomyItem` does the case-insensitive check itself
-- before inserting. `upsert(..., { onConflict: 'moment_type' })` needs these to
-- exist to have anything to infer from.
--
-- A unique INDEX rather than a table constraint, as elsewhere in this schema,
-- because `create unique index if not exists` is idempotent and
-- `alter table ... add constraint` is not.
create unique index if not exists moment_types_name_key on public.moment_types (moment_type);
create unique index if not exists moment_tags_name_key  on public.moment_tags  (tag);

-- Reads are "the newest marks" and "the marks on one video".
create index if not exists moments_created_idx
  on public.moments (created_at desc);

-- One mark per position, unchanged in meaning — it was never really per-user,
-- there is only ever one user. This is still the insert's idempotency key: a
-- retry after a lost reply is refused (23505, which `saveMoment` translates)
-- rather than duplicating the mark.
--
-- Two things still follow from it, as before:
--   * It also serves "the marks on one video" — that column is the index's
--     leading prefix now — which is why there is no separate index for that.
--   * NULL video_id never conflicts; Postgres treats NULLs as distinct. An
--     unparseable player URL degrades to "allow" rather than blocking on a guess.
create unique index if not exists moments_video_time_key
  on public.moments (video_id, timestamp_sec);

drop policy if exists "authenticated moment types readable"   on public.moment_types;
drop policy if exists "authenticated moment types insertable" on public.moment_types;
drop policy if exists "authenticated moment types updatable"  on public.moment_types;
drop policy if exists "authenticated moment types deletable"  on public.moment_types;

-- RLS is still what keeps these tables private — the bundled anon key gets
-- nothing. `to authenticated` is the whole scope now: one account, every row is
-- its own.
create policy "authenticated moment types readable" on public.moment_types
  for select to authenticated using (true);
create policy "authenticated moment types insertable" on public.moment_types
  for insert to authenticated with check (true);
-- Needed even though names are never edited: an upsert is INSERT ... ON CONFLICT
-- DO UPDATE, and the UPDATE arm is checked against this policy.
create policy "authenticated moment types updatable" on public.moment_types
  for update to authenticated using (true) with check (true);
create policy "authenticated moment types deletable" on public.moment_types
  for delete to authenticated using (true);

drop policy if exists "authenticated moment tags readable"   on public.moment_tags;
drop policy if exists "authenticated moment tags insertable" on public.moment_tags;
drop policy if exists "authenticated moment tags updatable"  on public.moment_tags;
drop policy if exists "authenticated moment tags deletable"  on public.moment_tags;

create policy "authenticated moment tags readable" on public.moment_tags
  for select to authenticated using (true);
create policy "authenticated moment tags insertable" on public.moment_tags
  for insert to authenticated with check (true);
create policy "authenticated moment tags updatable" on public.moment_tags
  for update to authenticated using (true) with check (true);
create policy "authenticated moment tags deletable" on public.moment_tags
  for delete to authenticated using (true);

drop policy if exists "authenticated moments readable"   on public.moments;
drop policy if exists "authenticated moments insertable" on public.moments;
drop policy if exists "authenticated moments updatable"  on public.moments;
drop policy if exists "authenticated moments deletable"  on public.moments;

create policy "authenticated moments readable" on public.moments
  for select to authenticated using (true);
create policy "authenticated moments insertable" on public.moments
  for insert to authenticated with check (true);
create policy "authenticated moments updatable" on public.moments
  for update to authenticated using (true) with check (true);
create policy "authenticated moments deletable" on public.moments
  for delete to authenticated using (true);
