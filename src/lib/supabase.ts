// Configuration boundary only: reads public build-time settings, never creates clients
// or performs network requests. A present configuration does not prove a working connection.
export const SUPABASE_ENV = {
  url: 'VITE_SUPABASE_URL',
  publishableKey: 'VITE_SUPABASE_PUBLISHABLE_KEY',
  legacyAnonKey: 'VITE_SUPABASE_ANON_KEY',
} as const;

export interface SupabaseConfiguration {
  url: string;
  publishableKey: string;
  configured: boolean;
  missing: string[];
  demoMode: boolean;
}

function looksLikePlaceholder(value: string) {
  return /^(your|replace|changeme|placeholder)/i.test(value) || /^[A-Z_]+$/.test(value);
}

export function getSupabaseConfiguration(): SupabaseConfiguration {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
  const missing: string[] = [];
  if (!/^https:\/\/\S+/.test(url) || looksLikePlaceholder(url)) missing.push(SUPABASE_ENV.url);
  if (!key || looksLikePlaceholder(key)) missing.push(`${SUPABASE_ENV.publishableKey} (or ${SUPABASE_ENV.legacyAnonKey})`);
  if (key.startsWith('sb_secret_')) throw new Error('A Supabase secret key was placed in a public VITE_ variable. Remove it immediately and rotate it in the Supabase Dashboard.');
  return { url, publishableKey: key, configured: missing.length === 0, missing, demoMode: import.meta.env.VITE_DEMO_MODE !== 'false' };
}

/** Real authentication is enforced only when Supabase is configured and demo mode is explicitly disabled. */
export function isAuthEnforced() {
  const config = getSupabaseConfiguration();
  return config.configured && !config.demoMode;
}

export class ConfigurationRequiredError extends Error {
  constructor(missing: string[] = getSupabaseConfiguration().missing) {
    super(missing.length ? `Supabase is not configured. Set ${missing.join(' and ')} in the project-root .env.local file, then restart the dev server.` : 'Supabase adapters are not connected.');
    this.name = 'ConfigurationRequiredError';
  }
}

export function requireSupabaseConfiguration() {
  const config = getSupabaseConfiguration();
  if (!config.configured) throw new ConfigurationRequiredError(config.missing);
  return config;
}
