import type { AuthContext } from '@/types/domain';

export const AUTH_PAGES = ['/login', '/signup'];
export const ONBOARDING_PAGE = '/onboarding';
// '/lead-capture/' is the public lead form (Member 2): visitors have no account or workspace.
const ALWAYS_PUBLIC = ['/auth/confirm', '/lead-capture/'];

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeRedirectPath(value: unknown, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : fallback;
}

/**
 * Decides where a navigation must go. Returns null to allow it.
 * - Signed out: allowed in demo mode; otherwise sent to /login (except public pages).
 * - Signed in without a workspace: sent to onboarding instead of a broken dashboard.
 * - Signed in with a workspace: auth and onboarding pages bounce to the dashboard.
 */
export function resolveAuthRedirect(auth: AuthContext, pathname: string, href = pathname): { to: string; search?: Record<string, string> } | null {
  if (ALWAYS_PUBLIC.some((p) => pathname.startsWith(p))) return null;
  const onAuthPage = AUTH_PAGES.includes(pathname);
  if (!auth.user) {
    if (!auth.enforced || onAuthPage) return null;
    return pathname === '/' ? { to: '/login' } : { to: '/login', search: { redirect: href } };
  }
  // A failed workspace lookup is surfaced on the onboarding page rather than looping.
  if (!auth.activeWorkspace) return pathname === ONBOARDING_PAGE ? null : { to: ONBOARDING_PAGE };
  if (onAuthPage || pathname === ONBOARDING_PAGE) return { to: '/' };
  return null;
}
