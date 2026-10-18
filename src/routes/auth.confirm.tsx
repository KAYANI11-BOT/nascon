import { createFileRoute } from '@tanstack/react-router';
import type { EmailOtpType } from '@supabase/supabase-js';
import { safeRedirectPath } from '@/lib/auth-guard';
import { getSupabaseConfiguration } from '@/lib/supabase';
import { createSupabaseServerClient } from '@/lib/supabase.server';

const OTP_TYPES: EmailOtpType[] = ['signup', 'email', 'invite', 'magiclink', 'recovery', 'email_change'];

// Email confirmation callback. Supports the recommended token_hash template (works across
// devices) and the default PKCE ?code= redirect (same browser only). Sets session cookies
// server-side, then redirects; the root guard routes users without a workspace to onboarding.
export const Route = createFileRoute('/auth/confirm')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const next = safeRedirectPath(url.searchParams.get('next'), '/onboarding');
        const fail = (reason: string) => new Response(null, { status: 302, headers: { Location: `/login?confirmation=${reason}` } });
        if (!getSupabaseConfiguration().configured) return fail('unavailable');

        const supabase = createSupabaseServerClient();
        const tokenHash = url.searchParams.get('token_hash');
        const type = url.searchParams.get('type') as EmailOtpType | null;
        const code = url.searchParams.get('code');
        let failed = true;
        if (tokenHash && type && OTP_TYPES.includes(type)) {
          failed = Boolean((await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error);
        } else if (code) {
          failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
        }
        // Supabase reports expired or reused links via error params on the redirect.
        if (failed || url.searchParams.get('error')) return fail('failed');
        return new Response(null, { status: 302, headers: { Location: next } });
      },
    },
  },
});
