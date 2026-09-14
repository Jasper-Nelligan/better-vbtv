// Add types for window.navigation for use in this file. See https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-types- for more info.
/// <reference types="navigation-api-types" />

declare const __DEBUG__: boolean;

// Build-time Supabase credentials, injected by Vite from `.env` (gitignored).
// All four are optional: when any is missing the extension degrades to
// local-only watch history and the sync worker no-ops.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_EMAIL?: string;
  readonly VITE_SUPABASE_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
