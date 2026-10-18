import {describe, expect, it} from 'vitest';
import {MAX_FORM_AGE_MS, MIN_FILL_MS, RateLimiter, botVerdict, buildIdempotencyKey, clientIp, intakeSchema} from '@/lib/lead-intake';

const valid = {slug: 'acme-leads', name: 'Olivia Rhye', email: 'o@x.io', phone: '', message: 'Hi', website: '', startedAt: 1_000, clientKey: '3f2b8f6e-8c1d-4f6a-9d63-0a1c1c6b2f10'};

describe('intake validation', () => {
  it('accepts a valid submission and normalises empty optionals', () => {
    const r = intakeSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBeUndefined();
  });
  it('requires a name and one contact method', () => {
    expect(intakeSchema.safeParse({...valid, name: '  '}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, email: '', phone: ''}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, email: '', phone: '+92 300 1234567'}).success).toBe(true);
  });
  it('rejects malformed email, phone, slug, key and oversize text', () => {
    expect(intakeSchema.safeParse({...valid, email: 'nope'}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, email: '', phone: 'abc'}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, slug: 'A B'}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, slug: '../etc'}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, clientKey: 'not-a-uuid'}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, message: 'x'.repeat(2001)}).success).toBe(false);
    expect(intakeSchema.safeParse({...valid, name: 'x'.repeat(201)}).success).toBe(false);
  });
  it('ignores any client-supplied workspace id', () => {
    const r = intakeSchema.safeParse({...valid, workspaceId: '00000000-0000-4000-8000-000000000001'});
    expect(r.success && 'workspaceId' in r.data).toBe(false);
  });
});

describe('bot heuristics', () => {
  const now = 1_000_000;
  it('flags a filled honeypot, too-fast and stale submissions', () => {
    expect(botVerdict({website: 'http://spam', startedAt: now - 60_000}, now)).toBe('honeypot');
    expect(botVerdict({startedAt: now - (MIN_FILL_MS - 1)}, now)).toBe('too_fast');
    expect(botVerdict({startedAt: now - MAX_FORM_AGE_MS - 1}, now)).toBe('stale');
    expect(botVerdict({website: '', startedAt: now - 10_000}, now)).toBe('ok');
  });
});

describe('rate limiter', () => {
  it('allows up to the limit per window, then blocks, then resets', () => {
    const rl = new RateLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => rl.allow('a', 0))).toEqual([true, true, true, false]);
    expect(rl.allow('b', 0)).toBe(true);
    expect(rl.allow('a', 999)).toBe(false);
    expect(rl.allow('a', 1000)).toBe(true);
  });
  it('stays bounded when flooded with distinct keys', () => {
    const rl = new RateLimiter(1, 1000, 10);
    for (let i = 0; i < 100; i++) rl.allow(`k${i}`, 0);
    expect(rl.allow('fresh', 5000)).toBe(true);
  });
});

describe('helpers', () => {
  it('derives the idempotency key from the slug and per-form key', () => {
    expect(buildIdempotencyKey('acme-leads', valid.clientKey)).toBe(`web:acme-leads:${valid.clientKey}`);
    expect(buildIdempotencyKey('acme-leads', valid.clientKey).length).toBeGreaterThanOrEqual(8);
  });
  it('takes the first forwarded address', () => {
    expect(clientIp('1.2.3.4, 10.0.0.1', null)).toBe('1.2.3.4');
    expect(clientIp(null, '5.6.7.8')).toBe('5.6.7.8');
    expect(clientIp(undefined, undefined)).toBe('unknown');
  });
});
