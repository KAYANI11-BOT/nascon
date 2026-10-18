import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { requireSupabaseConfiguration } from './supabase';

let browserClient: SupabaseClient<Database> | undefined;

/**
 * Browser-only client. The session lives in cookies so server functions can read it.
 * One instance per browser tab is safe because a tab has a single signed-in user;
 * server code must use createSupabaseServerClient() instead.
 */
export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  if (typeof window === 'undefined') {
    throw new Error('getSupabaseBrowserClient() is browser-only. Use createSupabaseServerClient() in server functions.');
  }
  if (!browserClient) {
    const { url, publishableKey } = requireSupabaseConfiguration();
    browserClient = createBrowserClient<Database>(url, publishableKey);
  }
  return browserClient;
}
