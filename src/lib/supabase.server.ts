import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCookies, setCookie } from '@tanstack/react-start/server';
import type { Database } from '@/types/database';
import { requireSupabaseConfiguration } from './supabase';

/**
 * Request-scoped server client: create one per server-function call or server-route request,
 * never cache it in module scope. It reads the caller's session from request cookies and writes
 * refreshed tokens to the response, so every query runs with the caller's RLS identity.
 * It uses only the public key; no privileged credential is involved.
 */
export function createSupabaseServerClient(): SupabaseClient<Database> {
  const { url, publishableKey } = requireSupabaseConfiguration();
  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => Object.entries(getCookies()).map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value, options } of cookies) setCookie(name, value, options);
      },
    },
  });
}
