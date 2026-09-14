import {
  MOMENTS_TABLE,
  MOMENT_TAGS_TABLE,
  MOMENT_TYPES_TABLE,
  PLAYERS_TABLE,
} from '../constants';
import type {
  Moment,
  MomentPatch,
  NewMoment,
  Taxonomy,
  TaxonomyItem,
  TaxonomyKind,
} from './moments';
import { ensureAuth, getClient } from './supabase';

// Supabase access for the moment feature — the worker half of `moments.ts`.
// Imported only by src/background.ts, which is what keeps supabase-js out of the
// content-script bundle (same split as `historyRemote.ts` / `history.ts`).
//
// Unlike the history push functions, nothing here is retried by a queue: these
// run inside a request the modal is awaiting, so a failure becomes a message on
// screen and the user decides whether to try again. Two consequences worth
// keeping in mind when editing:
//
//   * Every mutation must be safe to repeat, because "try again" is the recovery
//     path. The taxonomy writes are upserts on the name. The moment insert has no
//     client-minted key to be idempotent on, so the database supplies one for it:
//     `moments_video_time_key` makes (video, position) unique, and a repeat is
//     refused instead of duplicating. That covers the deliberate double-submit
//     the constraint is there for *and* the lost-reply retry, at the cost of a
//     slightly odd message in the second case — the reply vanished, but the mark
//     it was reporting does exist.
//   * Ordering is enforced by `await`, not by a queue. `saveMoment` can only be
//     called with ids that already came back from the server, so the `type_id`
//     foreign key is satisfied by construction.

// Written on the first read that finds a user's taxonomy empty, so the modal is
// never a blank form. `created_at` is set explicitly from a fixed base rather
// than left to `now()`: it is also the display order, and `now()` would give all
// of them the same millisecond and scramble the list.
const SEED_TYPES = ['Exciting rally', 'Spiketown', 'Monster block', 'Great dig'];
const SEED_TAGS = ['Ace', 'Libero dig', 'Tip', 'Set 5', 'Match point', 'Block out'];
const SEED_EPOCH = Date.UTC(2020, 0, 1);

// The three taxonomy tables are identical apart from the column holding the name
// (`moment_type` vs `tag` vs `player`), which is how they were specced. One
// descriptor per kind keeps the read/write paths generic instead of duplicated.
//
// `seed` is what a kind is seeded with on the first read that finds it empty.
// Players have none on purpose: types and tags are a fixed vocabulary the
// extension can guess at, a roster is not, and a list of invented names would be
// worse than an empty one — the modal's Combobox creates values by typing.
const TAXONOMY: Record<
  TaxonomyKind,
  { table: string; nameColumn: string; seed: readonly string[] }
> = {
  type: { table: MOMENT_TYPES_TABLE, nameColumn: 'moment_type', seed: SEED_TYPES },
  tag: { table: MOMENT_TAGS_TABLE, nameColumn: 'tag', seed: SEED_TAGS },
  player: { table: PLAYERS_TABLE, nameColumn: 'player', seed: [] },
};

interface MomentRow {
  id: string;
  video_id: string | null;
  timestamp_sec: number;
  type_id: string;
  tag_ids: string[] | null;
  player_ids: string[] | null;
  created_at: string;
}

// Every entry point starts here: the worker may have been torn down since the
// last message, and `ensureAuth()` is what signs back in. There is no user id to
// carry any more — one account, and RLS scopes these tables to it — so all this
// still guards is a build with no Supabase credentials, where nothing below can
// succeed and the modal has to say so.
async function requireAuth(): Promise<void> {
  if (!(await ensureAuth())) throw new Error('Supabase is not configured.');
}

// --- Taxonomies -----------------------------------------------------------

async function readTaxonomy(kind: TaxonomyKind): Promise<TaxonomyItem[]> {
  const { table, nameColumn } = TAXONOMY[kind];
  const { data, error } = await getClient()
    .from(table)
    // `select('*')` rather than a column list: supabase-js parses the list at
    // the *type* level, and it can't read one built from a template literal.
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: (row[nameColumn] as string) ?? '',
    createdAt: Date.parse(row.created_at as string),
  }));
}

async function seedIfEmpty(kind: TaxonomyKind): Promise<TaxonomyItem[]> {
  const existing = await readTaxonomy(kind);
  if (existing.length > 0) return existing;

  const { table, nameColumn, seed: names } = TAXONOMY[kind];
  // Nothing to seed (players). Return the empty list rather than sending an
  // upsert with no rows, which PostgREST answers with a 400.
  if (names.length === 0) return existing;
  const { error } = await getClient()
    .from(table)
    .upsert(
      names.map((name, i) => ({
        [nameColumn]: name,
        created_at: new Date(SEED_EPOCH + i).toISOString(),
      })),
      // Another device seeding at the same moment is a no-op rather than a
      // duplicate-key error, and it keeps whichever rows landed first.
      { onConflict: nameColumn, ignoreDuplicates: true },
    );
  if (error) throw error;
  return readTaxonomy(kind);
}

// All three lists in one call, seeding whichever is empty and seedable.
export async function loadTaxonomy(): Promise<Taxonomy> {
  await requireAuth();
  const [types, tags, players] = await Promise.all([
    seedIfEmpty('type'),
    seedIfEmpty('tag'),
    seedIfEmpty('player'),
  ]);
  return { types, tags, players };
}

export async function createTaxonomyItem(
  kind: TaxonomyKind,
  name: string,
): Promise<TaxonomyItem> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A name is required.');
  await requireAuth();
  const { table, nameColumn } = TAXONOMY[kind];

  // Case-insensitive check first. The unique constraint is on the exact string —
  // PostgREST's conflict target can only name plain columns, not `lower(...)` —
  // so without this, "ace" alongside "Ace" would be two rows. The whole list is a
  // few dozen rows and creating a value is a deliberate two-step action, so the
  // extra round trip is not on any hot path.
  const existing = (await readTaxonomy(kind)).find(
    (item) => item.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return existing;

  // `upsert` rather than `insert`: two tabs confirming the same new name at the
  // same instant then resolve to one row instead of one of them erroring.
  const { data, error } = await getClient()
    .from(table)
    // A one-element array rather than a bare object: with only a computed key
    // left in the row, `{ [nameColumn]: trimmed }` widens to an index signature,
    // which supabase-js's single-row overload rejects. The array overload — the
    // one `seedIfEmpty` already takes — accepts it, and `.single()` still
    // unwraps the one row that comes back.
    .upsert([{ [nameColumn]: trimmed }], { onConflict: nameColumn })
    .select('*')
    .single();
  if (error) throw error;

  const row = data as unknown as Record<string, unknown>;
  return {
    id: row.id as string,
    name: (row[nameColumn] as string) ?? trimmed,
    createdAt: Date.parse(row.created_at as string),
  };
}

// --- Moments --------------------------------------------------------------

function toMoment(row: MomentRow): Moment {
  return {
    id: row.id,
    videoId: row.video_id,
    timeSec: row.timestamp_sec,
    typeId: row.type_id,
    tagIds: row.tag_ids ?? [],
    // Null only for a row written before the column existed; the default is
    // '{}' and the column is not nullable.
    playerIds: row.player_ids ?? [],
    createdAt: Date.parse(row.created_at),
  };
}

// `insert`, not `upsert`: a conflict here means the user is marking a position
// they have already marked, and the right answer is to tell them so, not to
// quietly overwrite the earlier mark. The id comes back in the same round trip.
export async function saveMoment(input: NewMoment): Promise<Moment> {
  if (!input.typeId) throw new Error('A moment type is required.');
  await requireAuth();
  const { data, error } = await getClient()
    .from(MOMENTS_TABLE)
    .insert({
      video_id: input.videoId,
      timestamp_sec: input.timeSec,
      type_id: input.typeId,
      tag_ids: input.tagIds,
      player_ids: input.playerIds,
    })
    .select('*')
    .single();
  if (error) {
    // 23505 = unique_violation, i.e. moments_video_time_key: same video,
    // same playhead position, already marked. The modal shows this string, so it
    // has to read as a decision rather than a fault.
    if ((error as { code?: string }).code === '23505') {
      throw new Error('You have already marked a moment at this exact timestamp.');
    }
    throw error;
  }
  return toMoment(data as unknown as MomentRow);
}

// Every mark on one video. `video_id` is the leading column of
// `moments_video_time_key`, so this filter is an index scan rather than a
// sequential one.
export async function listMoments(videoId: string): Promise<Moment[]> {
  await requireAuth();
  const { data, error } = await getClient()
    .from(MOMENTS_TABLE)
    .select('*')
    .eq('video_id', videoId)
    .order('timestamp_sec', { ascending: true });
  if (error) throw error;
  return (data as unknown as MomentRow[]).map(toMoment);
}

// Type, tags and players — see `MomentPatch`. Nothing here can collide with the
// uniqueness index, so unlike `saveMoment` there is no 23505 to translate.
export async function updateMoment(id: string, patch: MomentPatch): Promise<Moment> {
  if (!patch.typeId) throw new Error('A moment type is required.');
  await requireAuth();
  const { data, error } = await getClient()
    .from(MOMENTS_TABLE)
    .update({ type_id: patch.typeId, tag_ids: patch.tagIds, player_ids: patch.playerIds })
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    // PGRST116 = "no rows returned" from `.single()`. The mark was deleted on
    // another device between the pins being drawn and Save being pressed.
    if ((error as { code?: string }).code === 'PGRST116') {
      throw new Error('That mark no longer exists — it was removed elsewhere.');
    }
    throw error;
  }
  return toMoment(data as unknown as MomentRow);
}

// Deleting something already gone is success, not an error: the caller wanted
// it absent and it is absent, so a stale pin resolves rather than nagging.
export async function deleteMoment(id: string): Promise<void> {
  await requireAuth();
  const { error } = await getClient()
    .from(MOMENTS_TABLE)
    .delete()
    .eq('id', id);
  if (error) throw error;
}
