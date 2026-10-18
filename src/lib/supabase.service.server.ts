import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * SERVER-ONLY service-role client for the few narrow privileged operations that have no user
 * session (public lead capture). The key comes from a non-VITE environment variable so it can
 * never be bundled into browser code. Returns null when not configured: callers must report
 * "unavailable" instead of pretending the operation worked.
 *
 * Only call SECURITY DEFINER functions that are granted to service_role and validate their own
 * input (public.capture_external_lead). Do not use this client for ad-hoc table access.
 */
export function createSupabaseServiceClient(): SupabaseClient | null {
  const url = (process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '').trim();
  const key = (process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '').trim();
  if (!/^https:\/\/\S+/.test(url) || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
