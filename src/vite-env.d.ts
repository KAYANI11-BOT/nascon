/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** Preferred public key (sb_publishable_...). */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy public anon JWT, used only when the publishable key is absent. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Defaults to demo mode; set to "false" to enforce real authentication. */
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
