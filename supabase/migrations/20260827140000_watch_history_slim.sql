-- Better VBTV — finish the videos/watch_history split.
--
-- 20260827130000 created `videos` and backfilled it from `watch_history`, which
-- left `title`, `thumbnail` and `url` duplicated in both tables. This drops the
-- copies, so a video's identity lives in exactly one place and `watch_history` is
-- reduced to what it is actually about: where this account got to in a video, and
-- when. It also gives `videos` the two timestamps.
--
-- Ordering: this must run after the backfill in 20260827130000, because that is
-- the last thing that reads the columns being dropped here. It does, by version.
--
-- One deployment note: after this, an extension build from before 20260827130000
-- pushes `title`/`url` at a table that no longer has them, which PostgREST
-- rejects outright. There is one account and one install, so the fix is to load
-- the new build — but don't push this to a database an old build is still using.

alter table public.videos
  add column if not exists created_at timestamptz not null default now();
alter table public.videos
  add column if not exists updated_at timestamptz not null default now();

-- `created_at` and `updated_at` are both maintained server-side, and neither is
-- ever sent by the extension.
--
-- `created_at` needs nothing beyond its default: the writers upsert, and an
-- omitted column stays out of the ON CONFLICT SET list, so the insert stamps it
-- and every later update leaves it alone.
--
-- `updated_at` cannot work that way — the same omission that protects it from
-- being clobbered also stops it advancing — so a trigger does it. Server time
-- rather than a client-supplied value on purpose: two devices with skewed clocks
-- would otherwise be able to write a row "in the past".
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists videos_set_updated_at on public.videos;

-- The `when` clause is what keeps the column honest. A watch-history push calls
-- `ensureVideo`, which re-upserts the parent row with values that have usually
-- not changed; without this guard every one of those would bump `updated_at` and
-- the column would record "last written" rather than "last changed".
create trigger videos_set_updated_at
  before update on public.videos
  for each row
  when (old.* is distinct from new.*)
  execute function public.set_updated_at();

-- Now redundant with `videos`. Safe because the backfill in 20260827130000 copied
-- every row — including tombstoned ones — and the foreign key added there has
-- guaranteed a parent for every row written since.
alter table public.watch_history drop column if exists title;
alter table public.watch_history drop column if exists thumbnail;
alter table public.watch_history drop column if exists url;
