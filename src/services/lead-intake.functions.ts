import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import {
  GENERIC_RATE_LIMITED, GENERIC_SUCCESS, GENERIC_UNAVAILABLE, RateLimiter, botVerdict, buildIdempotencyKey, clientIp, intakeSchema,
  type IntakeResult,
} from '@/lib/lead-intake';
import { createSupabaseServiceClient } from '@/lib/supabase.service.server';

// Per server instance. 5 submissions / 10 min per visitor+form, 120 / min per form overall.
const perVisitor = new RateLimiter(5, 10 * 60_000);
const perForm = new RateLimiter(120, 60_000);

/**
 * Public (unauthenticated) lead capture for the web form. The workspace is resolved by the
 * database from the public slug; the browser never supplies a workspace id. The only privileged
 * operation is public.capture_external_lead (service role), which validates again and is idempotent.
 */
export const submitPublicLead = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<IntakeResult> => {
    const parsed = intakeSchema.safeParse(data);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
      return { ok: false, message: 'Please check the highlighted details.', fieldErrors };
    }
    const input = parsed.data;
    const now = Date.now();

    // Bots get the same friendly answer as people, and nothing is stored.
    if (botVerdict(input, now) !== 'ok') return { ok: true, message: GENERIC_SUCCESS };

    const ip = clientIp(getRequestHeader('x-forwarded-for'), getRequestHeader('x-real-ip'));
    if (!perForm.allow(input.slug, now) || !perVisitor.allow(`${ip}|${input.slug}`, now)) {
      return { ok: false, message: GENERIC_RATE_LIMITED };
    }

    const service = createSupabaseServiceClient();
    if (!service) return { ok: false, message: GENERIC_UNAVAILABLE };
    const { error } = await service.rpc('capture_external_lead', {
      p_slug: input.slug,
      p_full_name: input.name,
      p_email: input.email ?? null,
      p_phone: input.phone ?? null,
      p_message: input.message ?? null,
      p_source: 'web_form',
      p_idempotency_key: buildIdempotencyKey(input.slug, input.clientKey),
    });
    if (error) {
      // Details stay in the server log; visitors only ever see a generic message.
      console.error('Public lead capture failed', error.code, error.message);
      return { ok: false, message: GENERIC_UNAVAILABLE };
    }
    return { ok: true, message: GENERIC_SUCCESS };
  });
