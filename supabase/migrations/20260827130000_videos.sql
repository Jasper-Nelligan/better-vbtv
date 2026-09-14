-- Better VBTV — the `videos` table.
--
-- Until now the only per-video record was a `watch_history` row, which conflates
-- two different things: what a video *is* (title, poster, link, upload date) and
-- what this account *did with it* (resume position, last viewed). The first is a
-- property of the video and is known the moment a card is clicked; the second
-- only exists once playback qualifies. Splitting them lets a video be known
-- without having been watched, and gives the upload date — which is scraped off
-- the browse page and is unavailable anywhere else — somewhere to live.
--
-- `watch_history.media_id` becomes a foreign key into this table, so every watch
-- record now hangs off a video row. See the note on ordering at the bottom: the
-- backfill has to happen before the constraint is added, or it fails on the
-- history that already exists.

create table if not exists public.videos (
  -- The JW media id, same key `watch_history` and `moments.video_id` use. Minted
  -- by VBTV, not by us: it is parsed out of the player URL's `self-link`, which
  -- is why nothing here has a surrogate id the way the moment tables do.
  media_id   text primary key,
  -- Defaulted rather than required so a write can omit it. Both writers upsert,
  -- and PostgREST leaves a column out of the ON CONFLICT SET list when it is
  -- absent from the payload — so an omitted title takes this default on insert
  -- and preserves whatever is already there on update. That is what lets the
  -- click path record a row before the JW metadata fetch has come back, and lets
  -- the watch-history push top up a parent row without knowing the upload date.
  title      text not null default 'VBTV replay',
  thumbnail  text,
  url        text not null,
  -- Scraped from the browse-page card, where it sits between the thumbnail and
  -- the title as `dd/mm/yyyy`. Nullable, and null is the normal case for a while:
  -- the backfill below cannot know it, and a layout change would stop the scrape
  -- finding it. A video with an unknown upload date is still worth recording.
  upload_date date
);

alter table public.videos enable row level security;

drop policy if exists "authenticated videos readable"   on public.videos;
drop policy if exists "authenticated videos insertable" on public.videos;
drop policy if exists "authenticated videos updatable"  on public.videos;
drop policy if exists "authenticated videos deletable"  on public.videos;

-- Same shape as every other table here since 20260824120000: one account, so RLS
-- exists to keep the bundled anon key out rather than to separate users.
create policy "authenticated videos readable" on public.videos
  for select to authenticated using (true);
create policy "authenticated videos insertable" on public.videos
  for insert to authenticated with check (true);
-- An upsert is INSERT ... ON CONFLICT DO UPDATE, and the UPDATE arm is checked
-- against this policy — both writers upsert, so this is required, not spare.
create policy "authenticated videos updatable" on public.videos
  for update to authenticated using (true) with check (true);
create policy "authenticated videos deletable" on public.videos
  for delete to authenticated using (true);

-- Backfill from the history that already exists. `upload_date` stays null — it
-- was never captured, and there is nowhere to recover it from.
--
-- Deliberately NOT filtered to `deleted_at is null`: a tombstoned history row is
-- still a row, and the foreign key added below applies to it too. Filtering here
-- would make the constraint fail on exactly the rows that are easiest to forget.
insert into public.videos (media_id, title, thumbnail, url)
select media_id, title, thumbnail, url
from public.watch_history
on conflict (media_id) do nothing;

-- `restrict`, not `cascade`. Deleting a video out from under its watch history
-- should fail loudly: a cascade would hard-delete history rows, and history
-- deletes are tombstones precisely because a hard delete is invisible to the
-- pull merge — the local cache would still hold the entry, `pull()` would see
-- the server missing it, and re-queue it, and the push would then fail the
-- foreign key forever. Nothing in the extension deletes a video row, so this
-- costs nothing and closes that loop.
--
-- Guarded because `alter table ... add constraint` has no `if not exists`.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'watch_history_media_id_fkey'
  ) then
    alter table public.watch_history
      add constraint watch_history_media_id_fkey
      foreign key (media_id) references public.videos (media_id) on delete restrict;
  end if;
end $$;
