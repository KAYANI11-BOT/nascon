// Pure public-intake rules (no I/O) so they can be unit tested. Used by the server function in
// src/services/lead-intake.functions.ts. Browser input is never trusted: everything is re-validated there.
import {z} from 'zod';

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const MIN_FILL_MS = 3_000;
export const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const intakeSchema = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, 'Invalid form address.'),
    name: z.string().trim().min(1, 'Please enter your name.').max(200, 'Name is too long.'),
    email: optionalText(320).refine((v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Please enter a valid email address.'),
    phone: optionalText(40).refine((v) => v === undefined || /^[0-9+()\-.\s]{5,40}$/.test(v), 'Please enter a valid phone number.'),
    message: optionalText(2000),
    /** Honeypot: real visitors never see or fill this field. */
    website: z.string().max(200).optional(),
    /** Epoch ms when the form was rendered (client clock); used only as a bot heuristic. */
    startedAt: z.number().int().nonnegative(),
    /** Per-form-instance id: makes double submits and retries idempotent. */
    clientKey: z.string().uuid('Invalid submission.'),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {message: 'Please provide an email address or phone number.', path: ['email']});

export type IntakeInput = z.infer<typeof intakeSchema>;

export type BotVerdict = 'ok' | 'honeypot' | 'too_fast' | 'stale';

/** Heuristic bot checks. Client timestamps can be forged, so this is a speed bump, not a guarantee. */
export function botVerdict(input: Pick<IntakeInput, 'website' | 'startedAt'>, now: number): BotVerdict {
  if (input.website && input.website.trim() !== '') return 'honeypot';
  const age = now - input.startedAt;
  if (age < MIN_FILL_MS) return 'too_fast';
  if (age > MAX_FORM_AGE_MS) return 'stale';
  return 'ok';
}

export function buildIdempotencyKey(slug: string, clientKey: string): string {
  return `web:${slug}:${clientKey}`;
}

/**
 * Fixed-window in-memory rate limiter. Per server instance only: on multi-instance or serverless
 * hosting the effective limit is per instance. The database adds a coarse per-workspace backstop.
 */
export class RateLimiter {
  private hits = new Map<string, {count: number; resetAt: number}>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 5_000) {}

  /** Returns true when the request is allowed (and counts it). */
  allow(key: string, now: number): boolean {
    if (this.hits.size > this.maxKeys) this.prune(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, {count: 1, resetAt: now + this.windowMs});
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    if (this.hits.size > this.maxKeys) this.hits.clear();
  }
}

/** First hop of x-forwarded-for, else a constant bucket. Proxy headers are only as trustworthy as the host. */
export function clientIp(forwardedFor: string | null | undefined, realIp: string | null | undefined): string {
  const first = (forwardedFor ?? '').split(',')[0]?.trim();
  return first || realIp?.trim() || 'unknown';
}

export const GENERIC_SUCCESS = 'Thank you. Your details have been received and the team will be in touch.';
export const GENERIC_UNAVAILABLE = 'This form is temporarily unavailable. Please try again later.';
export const GENERIC_RATE_LIMITED = 'Too many submissions. Please wait a few minutes and try again.';

export type IntakeResult =
  | {ok: true; message: string}
  | {ok: false; message: string; fieldErrors?: Record<string, string>};
