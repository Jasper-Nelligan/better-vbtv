-- Better VBTV — a third moment taxonomy: `players`.
--
-- Shaped exactly like `moment_tags`, and for the same reason: a moment can carry
-- any number of them, they are created by typing a new name into the modal, and
-- the extension resolves names to ids against the whole (small) list it fetches
-- on open. The split from `moment_tags` is semantic, not structural — "Ace" and
-- "Set 5" describe *what happened*, a player name describes *who did it*, and
-- mixing the two into one list makes both unsearchable once the roster grows.
--
-- Consequences of keeping it a separate table rather than a flag on moment_tags:
--   * `players_name_key` is scoped to players, so a tag and a player may share a
--     name without either one shadowing the other in its own Combobox.
--   * `moments.player_ids` is its own column, so an existing mark keeps meaning
--     what it meant — no backfill, and nothing has to guess which of a mark's
--     tag_ids were really people.

create table if not exists public.players (
  id         uuid        primary key default gen_random_uuid(),
  -- `player`, mirroring `moment_tags.tag`: one name column per taxonomy table,
  -- which is the shape `TAXONOMY` in momentsRemote.ts is generic over.
  player     text        not null,
  -- Also the display order, which is why seeds elsewhere set it explicitly. This
  -- table ships no seeds — a roster is not something the extension can guess —
  -- so every row here is user-created and `now()` is the right order.
  created_at timestamptz not null default now()
);

-- The conflict target `createTaxonomyItem` upserts on. Exact-string rather than
-- `lower(...)` for the same reason as the other two: PostgREST's conflict target
-- can only name plain columns, and the worker does the case-insensitive check
-- itself before inserting.
create unique index if not exists players_name_key on public.players (player);

-- Player ids on a mark. An array, like `tag_ids`, with the same trade: Postgres
-- cannot enforce a foreign key per element, but the extension always has the
-- full list in hand to resolve them, and a mark stays one row and one insert.
--
-- `not null default '{}'` means every pre-existing mark reads as "no players
-- recorded" without a backfill, and `toMoment` needs no null branch.
alter table public.moments
  add column if not exists player_ids uuid[] not null default '{}';

alter table public.players enable row level security;

-- Same policy set as the other taxonomies: RLS is what keeps the table private
-- (the anon key ships inside the extension bundle), and `to authenticated` is
-- the whole scope — one account, every row is its own.
drop policy if exists "authenticated players readable"   on public.players;
drop policy if exists "authenticated players insertable" on public.players;
drop policy if exists "authenticated players updatable"  on public.players;
drop policy if exists "authenticated players deletable"  on public.players;

create policy "authenticated players readable" on public.players
  for select to authenticated using (true);
create policy "authenticated players insertable" on public.players
  for insert to authenticated with check (true);
-- Needed even though names are never edited: an upsert is INSERT ... ON CONFLICT
-- DO UPDATE, and the UPDATE arm is checked against this policy.
create policy "authenticated players updatable" on public.players
  for update to authenticated using (true) with check (true);
create policy "authenticated players deletable" on public.players
  for delete to authenticated using (true);
