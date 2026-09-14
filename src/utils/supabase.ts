import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_SESSION_KEY } from '../constants';
import ext from './browser';
import { log } from './logger';

// Credentials are baked in at build time from `.env` (gitignored). This is a
// private, single-account extension: there is no sign-in UI and no second user.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_EMAIL = import.meta.env.VITE_SUPABASE_EMAIL;
const SUPABASE_PASSWORD = import.meta.env.VITE_SUPABASE_PASSWORD;

// Every Supabase code path is opt-in on this. With no `.env` the extension keeps
// working exactly as it did before: local-only watch history, no network.
export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_EMAIL && SUPABASE_PASSWORD);
}

// supabase-js persists its session to `localStorage` by default, which does not
// exist in a service worker. Back it with `ext.storage.local` instead — same
// shim the rest of the codebase uses, so it works on Chrome and Firefox alike.
const extAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const result = await ext.storage.local.get([key]);
    return (result[key] as string | undefined) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await ext.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await ext.storage.local.remove(key);
  },
};

let client: SupabaseClient | null = null;

// Lazily created and memoized. Only ever called from the background worker.
export function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
      auth: {
        storage: extAuthStorage,
        storageKey: SUPABASE_SESSION_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // No redirect flow here — this is an extension worker, not a web page.
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

// Resolve to a usable session, signing in with the hard-coded account if needed.
// Call this at the top of every drain/pull: `autoRefreshToken` runs on a timer
// that does not survive service-worker termination, whereas `getSession()`
// refreshes an expired token on demand, which is what actually keeps us signed in.
export async function ensureAuth(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  const supabase = getClient();
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) return true;

  const { error } = await supabase.auth.signInWithPassword({
    email: SUPABASE_EMAIL as string,
    password: SUPABASE_PASSWORD as string,
  });
  if (error) {
    log('supabase sign-in failed', error.message);
    throw error;
  }
  log('supabase signed in');
  return true;
}

// The signed-in user id, used to scope every row. Null when not authenticated.
//
// Reads it off the cached session rather than `auth.getUser()`, which makes a
// network round trip on every call — and this is called once per queued op.
export async function getUserId(): Promise<string | null> {
  const { data } = await getClient().auth.getSession();
  return data.session?.user.id ?? null;
}
