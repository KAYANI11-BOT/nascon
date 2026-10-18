import {describe, expect, it} from 'vitest';
import {
  ackDeadline,
  buildEscalationNotification,
  countdownState,
  firstResponseSeconds,
  isEligible,
  isEscalatable,
  isQualifyingAction,
  nextEscalationTarget,
  pickNextAssignee,
  recoveryReasons,
} from '@/lib/lead-engine';
import type {Assignee, AssignmentRules, Lead} from '@/types/leads';

const rules: AssignmentRules = {
  active: true,
  maxOpenLeads: 2,
  ackTimeoutSeconds: 60,
  escalationTimeoutsSeconds: [30, 20],
  maxEscalationLevels: 3,
  backupUserId: 'backup',
  managerUserId: 'manager',
  idleThresholdSeconds: 3600,
  eligibleUserIds: ['A', 'B', 'C'],
  acknowledgedAbsencePolicy: 'keep_and_flag',
};
const person = (userId: string, over: Partial<Assignee> = {}): Assignee => ({
  userId,
  active: true,
  assignable: true,
  availability: 'available',
  openLeads: 0,
  ...over,
});
const team = [person('A'), person('B'), person('C'), person('backup'), person('manager')];
const now = new Date('2026-10-18T10:00:00Z');
const lead = (over: Partial<Lead> = {}): Lead => ({
  id: 'l1',
  workspaceId: 'w1',
  contactId: null,
  name: 'Olivia',
  source: 'manual',
  status: 'assigned',
  assignedTo: 'A',
  currentAssignmentId: 'as1',
  createdAt: '2026-10-18T09:00:00Z',
  updatedAt: '2026-10-18T09:00:00Z',
  firstAssignedAt: '2026-10-18T09:00:00Z',
  lastAssignedAt: '2026-10-18T09:00:00Z',
  firstAcknowledgedAt: null,
  acknowledgedAt: null,
  acknowledgementDeadline: '2026-10-18T09:59:00Z',
  escalationLevel: 0,
  lastActionAt: '2026-10-18T09:55:00Z',
  version: 1,
  ...over,
});

describe('eligibility', () => {
  it('requires active, assignable, available, under cap and in ring', () => {
    expect(isEligible(person('A'), rules)).toBe(true);
    for (const availability of ['busy', 'on_leave', 'offline'] as const) {
      expect(isEligible(person('A', {availability}), rules)).toBe(false);
    }
    expect(isEligible(person('A', {active: false}), rules)).toBe(false);
    expect(isEligible(person('A', {assignable: false}), rules)).toBe(false);
    expect(isEligible(person('A', {openLeads: 2}), rules)).toBe(false);
    expect(isEligible(person('Z'), rules)).toBe(false);
  });
});

describe('round robin', () => {
  const ring = ['A', 'B', 'C'];
  it('cycles A -> B -> C -> A', () => {
    expect(pickNextAssignee(ring, team, rules, null)).toBe('A');
    expect(pickNextAssignee(ring, team, rules, 'A')).toBe('B');
    expect(pickNextAssignee(ring, team, rules, 'B')).toBe('C');
    expect(pickNextAssignee(ring, team, rules, 'C')).toBe('A');
  });
  it('skips a busy employee: A -> C -> A', () => {
    const t = [person('A'), person('B', {availability: 'busy'}), person('C')];
    expect(pickNextAssignee(ring, t, rules, 'A')).toBe('C');
    expect(pickNextAssignee(ring, t, rules, 'C')).toBe('A');
  });
  it('skips employees at capacity and returns null when nobody is eligible', () => {
    const t = [person('A', {openLeads: 2}), person('B', {openLeads: 2}), person('C', {openLeads: 2})];
    expect(pickNextAssignee(ring, t, rules, null)).toBeNull();
  });
  it('prefers someone not excluded, but reuses only when no alternative', () => {
    expect(pickNextAssignee(ring, team, rules, null, ['A'])).toBe('B');
    const only = [person('A'), person('B', {availability: 'offline'}), person('C', {availability: 'offline'})];
    expect(pickNextAssignee(ring, only, rules, null, ['A'])).toBe('A');
  });
});

describe('deadlines', () => {
  it('uses the ack timeout at level 0 and per-level timeouts after', () => {
    expect(ackDeadline(now, rules, 0).toISOString()).toBe('2026-10-18T10:01:00.000Z');
    expect(ackDeadline(now, rules, 1).toISOString()).toBe('2026-10-18T10:00:30.000Z');
    expect(ackDeadline(now, rules, 2).toISOString()).toBe('2026-10-18T10:00:20.000Z');
    expect(ackDeadline(now, rules, 3).toISOString()).toBe('2026-10-18T10:01:00.000Z');
  });
});

describe('escalation chain', () => {
  const ring = ['A', 'B', 'C'];
  it('goes employee -> backup -> manager and never repeats the holder', () => {
    const l1 = nextEscalationTarget(lead(), ring, team, rules, 'A', []);
    expect(l1).toEqual({kind: 'employee', userId: 'B', level: 1});
    const l2 = nextEscalationTarget(lead({assignedTo: 'B', escalationLevel: 1}), ring, team, rules, 'B', ['A']);
    expect(l2).toEqual({kind: 'backup', userId: 'backup', level: 2});
    const l3 = nextEscalationTarget(lead({assignedTo: 'backup', escalationLevel: 2}), ring, team, rules, 'B', ['A', 'B']);
    expect(l3).toEqual({kind: 'manager', userId: 'manager', level: 3});
  });
  it('falls to backup when no other employee is eligible', () => {
    const t = [person('A'), person('B', {availability: 'offline'}), person('C', {availability: 'offline'}), person('backup'), person('manager')];
    expect(nextEscalationTarget(lead(), ring, t, rules, 'A', [])).toMatchObject({kind: 'backup'});
  });
  it('stays with the manager past max levels and reports an exception when nobody resolves', () => {
    const past = nextEscalationTarget(lead({assignedTo: 'manager', escalationLevel: 5}), ring, team, rules, null, []);
    expect(past.kind).toBe('manager');
    const bare = {...rules, backupUserId: null, managerUserId: null};
    const t = [person('A', {availability: 'offline'}), person('B', {availability: 'offline'}), person('C', {availability: 'offline'})];
    expect(nextEscalationTarget(lead(), ring, t, bare, null, [])).toEqual({kind: 'exception', level: 1});
  });
  it('only escalates unacknowledged, assigned, overdue leads', () => {
    expect(isEscalatable(lead(), now)).toBe(true);
    expect(isEscalatable(lead({acknowledgedAt: '2026-10-18T09:30:00Z'}), now)).toBe(false);
    expect(isEscalatable(lead({acknowledgementDeadline: '2026-10-18T10:30:00Z'}), now)).toBe(false);
    expect(isEscalatable(lead({status: 'exception', assignedTo: null}), now)).toBe(false);
  });
});

describe('recovery', () => {
  it('flags overdue, repeated escalation and idle, possibly several', () => {
    expect(recoveryReasons(lead(), rules, now)).toEqual(['unacknowledged_overdue']);
    expect(recoveryReasons(lead({escalationLevel: 2, acknowledgementDeadline: '2026-10-18T10:30:00Z'}), rules, now)).toEqual(['repeated_escalation']);
    const idle = lead({lastActionAt: '2026-10-18T07:00:00Z', acknowledgedAt: '2026-10-18T07:00:00Z'});
    expect(recoveryReasons(idle, rules, now)).toEqual(['idle']);
    expect(recoveryReasons(lead({escalationLevel: 3, lastActionAt: null, createdAt: '2026-10-17T00:00:00Z'}), rules, now)).toEqual([
      'unacknowledged_overdue',
      'repeated_escalation',
      'idle',
    ]);
    expect(recoveryReasons(lead({status: 'closed'}), rules, now)).toEqual([]);
  });
});

describe('metrics and contracts', () => {
  it('computes time to first response from first assignment, surviving reassignment', () => {
    expect(firstResponseSeconds({firstAssignedAt: '2026-10-18T09:00:00Z', firstAcknowledgedAt: '2026-10-18T09:02:30Z'})).toBe(150);
    expect(firstResponseSeconds({firstAssignedAt: '2026-10-18T09:00:00Z', firstAcknowledgedAt: null})).toBeNull();
  });
  it('recognises only qualifying actions', () => {
    expect(isQualifyingAction('note_added')).toBe(true);
    expect(isQualifyingAction('page_viewed')).toBe(false);
  });
  it('builds the notification payload with a deep link', () => {
    const p = buildEscalationNotification({
      workspaceId: 'w1', leadId: 'l1', leadName: 'Olivia', source: 'web_form', recipientUserId: 'B',
      eventId: 'e1', reason: 'timeout_escalation', baseUrl: 'https://app.example/', now,
    });
    expect(p).toMatchObject({lead_url: 'https://app.example/leads/l1', event_type: 'lead_escalated', source: 'web_form', lead_name: 'Olivia'});
  });
  it('derives countdown states', () => {
    const base = {acknowledgedAt: null, assignedTo: 'A', acknowledgementDeadline: '2026-10-18T10:01:00Z'};
    expect(countdownState(base, now, 'A')).toEqual({state: 'pending', remainingSeconds: 60});
    expect(countdownState(base, new Date('2026-10-18T10:00:45Z'), 'A').state).toBe('approaching');
    expect(countdownState(base, new Date('2026-10-18T10:02:00Z'), 'A').state).toBe('overdue');
    expect(countdownState({...base, acknowledgedAt: 'x'}, now, 'A').state).toBe('acknowledged');
    expect(countdownState(base, now, 'B').state).toBe('reassigned');
  });
});
