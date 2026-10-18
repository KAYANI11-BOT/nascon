import { createServerFn } from '@tanstack/react-start';
import { getCookie, setCookie } from '@tanstack/react-start/server';
import { z } from 'zod';
import { getSupabaseConfiguration, isAuthEnforced } from '@/lib/supabase';
import { createSupabaseServerClient } from '@/lib/supabase.server';
import type { PermissionKey, WorkspaceRoleValue } from '@/types/database';
import type { AuthContext, Role, ServiceResult, WorkspaceMembership } from '@/types/domain';

const ACTIVE_WORKSPACE_COOKIE = 'leadguard-workspace';
const roleLabel: Record<WorkspaceRoleValue, Role> = { owner: 'Owner', admin: 'Admin', user: 'User' };

function signedOut(error: string | null = null): AuthContext {
  return { configured: getSupabaseConfiguration().configured, enforced: isAuthEnforced(), user: null, memberships: [], activeWorkspace: null, permissions: [], error };
}

/**
 * Authenticated user, memberships, active workspace and effective permissions for this request.
 * The user is verified with the Supabase Auth server (getUser), not trusted from the cookie.
 */
export const getAuthContext = createServerFn({ method: 'GET' }).handler(async (): Promise<AuthContext> => {
  if (!getSupabaseConfiguration().configured) return signedOut();
  try {
    return await loadAuthContext();
  } catch (error) {
    console.error('Auth context lookup failed', error);
    return signedOut('Authentication service is unreachable. Check the Supabase URL and your connection.');
  }
});

async function loadAuthContext(): Promise<AuthContext> {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return signedOut(userError && userError.name !== 'AuthSessionMissingError' ? 'Your session could not be verified. Please sign in again.' : null);

  const base: AuthContext = {
    ...signedOut(),
    user: { id: user.id, email: user.email ?? '', fullName: String(user.user_metadata?.['full_name'] ?? '').trim() || (user.email ?? '').split('@')[0] || 'Member' },
  };

  const { data: rows, error } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name, industry, timezone)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  if (error) return { ...base, error: `Workspace data is unavailable (${error.code ?? 'error'}). The database migrations may not be applied yet.` };

  const memberships: WorkspaceMembership[] = (rows ?? []).flatMap((r) => r.workspaces ? [{
    workspaceId: r.workspace_id,
    role: roleLabel[r.role],
    workspace: { id: r.workspaces.id, name: r.workspaces.name, industry: r.workspaces.industry, timezone: r.workspaces.timezone },
  }] : []);
  const preferred = getCookie(ACTIVE_WORKSPACE_COOKIE);
  const activeWorkspace = memberships.find((m) => m.workspaceId === preferred) ?? memberships.find((m) => m.role === 'Owner') ?? memberships[0] ?? null;
  if (!activeWorkspace) return { ...base, memberships };

  let permissions: PermissionKey[];
  if (activeWorkspace.role === 'Owner') {
    const { data } = await supabase.from('permissions').select('key');
    permissions = (data ?? []).map((p) => p.key);
  } else {
    const { data } = await supabase.from('workspace_role_permissions').select('permission_key')
      .eq('workspace_id', activeWorkspace.workspaceId).eq('role', activeWorkspace.role === 'Admin' ? 'admin' : 'user').eq('allowed', true);
    permissions = (data ?? []).map((p) => p.permission_key);
  }
  return { ...base, memberships, activeWorkspace, permissions };
}

const onboardingInput = z.object({
  name: z.string().trim().min(2, 'Enter a workspace name with at least two characters.').max(120),
  industry: z.string().trim().max(80).default('Other'),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
});

/**
 * Creates the caller's workspace and Owner membership atomically. The database function
 * derives the user from the JWT and is idempotent, so retries never create duplicates.
 */
export const createWorkspace = createServerFn({ method: 'POST' })
  .validator((input: unknown) => onboardingInput.parse(input))
  .handler(async ({ data }): Promise<ServiceResult<{ workspaceId: string }>> => {
    if (!getSupabaseConfiguration().configured) return { data: null, error: 'Supabase is not configured.' };
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: 'Your session has expired. Please sign in again.' };
    const { data: workspaceId, error } = await supabase.rpc('create_workspace_with_owner', { p_name: data.name, p_industry: data.industry, p_timezone: data.timezone });
    if (error || !workspaceId) return { data: null, error: error?.message ?? 'Workspace could not be created. Please try again.' };
    setCookie(ACTIVE_WORKSPACE_COOKIE, workspaceId, { path: '/', sameSite: 'lax', secure: true, httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    return { data: { workspaceId }, error: null };
  });

/** Remembers the active workspace; only accepted if the caller is a member (checked under RLS). */
export const setActiveWorkspace = createServerFn({ method: 'POST' })
  .validator((input: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<ServiceResult<null>> => {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null, error: 'Your session has expired. Please sign in again.' };
    const { data: row } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', data.workspaceId).eq('user_id', user.id).maybeSingle();
    if (!row) return { data: null, error: 'You are not a member of that workspace.' };
    setCookie(ACTIVE_WORKSPACE_COOKIE, data.workspaceId, { path: '/', sameSite: 'lax', secure: true, httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    return { data: null, error: null };
  });
