import {describe, expect, it} from 'vitest';
import {moveInRing, parseRulesDraft, rulesToDraft} from '@/lib/rules-form';
import type {AssignmentRules} from '@/types/leads';

const base: AssignmentRules = {
  active: true, strategy: 'round_robin', maxOpenLeads: 5, ackTimeoutSeconds: 60, escalationTimeoutsSeconds: [30, 20], maxEscalationLevels: 3,
  backupUserId: 'b', managerUserId: 'm', idleThresholdSeconds: 3600, eligibleUserIds: ['a', 'c'], acknowledgedAbsencePolicy: 'keep_and_flag',
};

describe('rules form', () => {
  it('round-trips a rule through the draft', () => {
    const parsed = parseRulesDraft(rulesToDraft(base));
    expect(parsed.error).toBeNull();
    expect(parsed.rules).toEqual(base);
  });
  it('rejects values the database would reject', () => {
    const d = rulesToDraft(base);
    expect(parseRulesDraft({...d, ackSeconds: '4'}).error).toMatch(/5 seconds/);
    expect(parseRulesDraft({...d, ackSeconds: 'abc'}).error).toBeTruthy();
    expect(parseRulesDraft({...d, escalationTimeouts: '30, x'}).error).toMatch(/Escalation timeouts/);
    expect(parseRulesDraft({...d, escalationTimeouts: '3'}).error).toMatch(/Escalation timeouts/);
    expect(parseRulesDraft({...d, maxLevels: '0'}).error).toMatch(/levels/);
    expect(parseRulesDraft({...d, maxOpenLeads: '0'}).error).toMatch(/limit/);
    expect(parseRulesDraft({...d, idleSeconds: '5'}).error).toMatch(/idle/i);
    expect(parseRulesDraft({...d, ring: ['a', 'a']}).error).toMatch(/twice/);
  });
  it('requires somewhere to send leads when automatic assignment is active', () => {
    const d = {...rulesToDraft(base), ring: [], backupUserId: '', managerUserId: ''};
    expect(parseRulesDraft(d).error).toMatch(/at least one/);
    expect(parseRulesDraft({...d, strategy: 'manual' as const}).error).toBeNull();
    expect(parseRulesDraft({...d, active: false}).error).toBeNull();
  });
  it('treats an empty timeout list and empty backup/manager as unset', () => {
    const parsed = parseRulesDraft({...rulesToDraft(base), escalationTimeouts: '', backupUserId: '', managerUserId: ''});
    expect(parsed.rules?.escalationTimeoutsSeconds).toEqual([]);
    expect(parsed.rules?.backupUserId).toBeNull();
  });
  it('reorders the ring without mutating the input and ignores out-of-range moves', () => {
    const ring = ['a', 'b', 'c'];
    expect(moveInRing(ring, 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(ring).toEqual(['a', 'b', 'c']);
    expect(moveInRing(ring, 'a', -1)).toEqual(ring);
    expect(moveInRing(ring, 'c', 1)).toEqual(ring);
    expect(moveInRing(ring, 'zzz', 1)).toEqual(ring);
  });
});
