import { getSupabaseConfiguration } from '@/lib/supabase';
import { getSupabaseBrowserClient } from '@/lib/supabase-browser';
import type { ServiceResult } from '@/types/domain';

const notConfigured = <T>(): ServiceResult<T> => ({ data: null, error: `Authentication is not configured. Set ${getSupabaseConfiguration().missing.join(' and ')} in .env.local.` });

function friendly(message: string, code?: string) {
  if (code === 'email_not_confirmed') return 'Confirm your email address first. Check your inbox for the confirmation link.';
  if (code === 'invalid_credentials') return 'Incorrect email or password.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return 'Too many attempts. Please wait a minute and try again.';
  if (code === 'weak_password') return 'Choose a stronger password.';
  return message || 'Something went wrong. Please try again.';
}

function confirmUrl(next: string) {
  return `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`;
}

export const authService = {
  /** With email confirmation enabled, no session is returned until the link is opened. */
  async signUp(email: string, password: string, fullName: string): Promise<ServiceResult<{ needsConfirmation: boolean }>> {
    if (!getSupabaseConfiguration().configured) return notConfigured();
    const { data, error } = await getSupabaseBrowserClient().auth.signUp({
      email, password, options: { data: { full_name: fullName.trim() }, emailRedirectTo: confirmUrl('/onboarding') },
    });
    if (error) return { data: null, error: friendly(error.message, error.code) };
    return { data: { needsConfirmation: !data.session }, error: null };
  },
  async signIn(email: string, password: string): Promise<ServiceResult<{ userId: string }>> {
    if (!getSupabaseConfiguration().configured) return notConfigured();
    const { data, error } = await getSupabaseBrowserClient().auth.signInWithPassword({ email, password });
    if (error) return { data: null, error: friendly(error.message, error.code) };
    return { data: { userId: data.user.id }, error: null };
  },
  async resendConfirmation(email: string): Promise<ServiceResult<null>> {
    if (!getSupabaseConfiguration().configured) return notConfigured();
    const { error } = await getSupabaseBrowserClient().auth.resend({ type: 'signup', email, options: { emailRedirectTo: confirmUrl('/onboarding') } });
    return error ? { data: null, error: friendly(error.message, error.code) } : { data: null, error: null };
  },
  async signOut(): Promise<ServiceResult<null>> {
    if (!getSupabaseConfiguration().configured) return { data: null, error: null };
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    return error ? { data: null, error: friendly(error.message, error.code) } : { data: null, error: null };
  },
};
