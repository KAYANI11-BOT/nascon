// Pure lead lifecycle rules. The database functions in the SQL proposal mirror these;
// these are NOT the production scheduler or source of truth (the database is).
import type {
  Assignee,
  AssignmentRules,
  Lead,
  NotificationOutboxPayload,
  QualifyingAction,
  RecoveryReason,
} from '@/types/leads';
import {CLOSED_STATUSES, QUALIFYING_ACTIONS} from '@/types/leads';

export function isEligible(a: Assignee, rules: Pick<AssignmentRules, 'maxOpenLeads' | 'eligibleUserIds'>): boolean {
  return (
    a.active &&
    a.assignable &&
    a.availability === 'available' &&
    a.openLeads < rules.maxOpenLeads &&
    rules.eligibleUserIds.includes(a.userId)
  );
}

/**
 * Availability-aware round-robin. `ring` is the stable ordering; `lastUserId` is the persisted
 * routing position. Returns the next eligible user after lastUserId, skipping `exclude`
 * (users who already held this lead) unless nobody else is eligible.
 */
export function pickNextAssignee(
  ring: string[],
  assignees: Assignee[],
  rules: Pick<AssignmentRules, 'maxOpenLeads' | 'eligibleUserIds'>,
  lastUserId: string | null,
  exclude: string[] = [],
): string | null {
  if (ring.length === 0) return null;
  const byId = new Map(assignees.map((a) => [a.userId, a]));
  const start = lastUserId ? ring.indexOf(lastUserId) : -1;
  const ordered = ring.map((_, i) => ring[(start + 1 + i) % ring.length]!);
  const eligible = ordered.filter((id) => {
    const a = byId.get(id);
    return a !== undefined && isEligible(a, rules);
  });
  return eligible.find((id) => !exclude.includes(id)) ?? eligible[0] ?? null;
}

export function ackDeadline(assignedAt: Date, rules: Pick<AssignmentRules, 'ackTimeoutSeconds' | 'escalationTimeoutsSeconds'>, level: number): Date {
  const seconds = level <= 0 ? rules.ackTimeoutSeconds : (rules.escalationTimeoutsSeconds[level - 1] ?? rules.ackTimeoutSeconds);
  return new Date(assignedAt.getTime() + seconds * 1000);
}

export type EscalationTarget =
  | {kind: 'employee'; userId: string; level: number}
  | {kind: 'backup'; userId: string; level: number}
  | {kind: 'manager'; userId: string; level: number}
  | {kind: 'exception'; level: number};

/**
 * Chain: next eligible employee -> backup -> manager. `level` is the lead's current level;
 * the result carries level+1. Never loops: past maxEscalationLevels stays with the manager
 * (or exception when no manager resolves).
 */
export function nextEscalationTarget(
  lead: Pick<Lead, 'assignedTo' | 'escalationLevel'>,
  ring: string[],
  assignees: Assignee[],
  rules: AssignmentRules,
  lastUserId: string | null,
  previousOwners: string[] = [],
): EscalationTarget {
  const level = lead.escalationLevel + 1;
  const valid = (id: string | null) => (id !== null && assignees.some((a) => a.userId === id && a.active) ? id : null);
  const backup = valid(rules.backupUserId);
  const manager = valid(rules.managerUserId);
  const exclude = [...previousOwners, ...(lead.assignedTo ? [lead.assignedTo] : [])];

  // Stage by level: <= max-2 employee, == max-1 backup, >= max manager. Each stage falls
  // through to the next when it cannot resolve to a different, valid destination.
  const stage = level <= rules.maxEscalationLevels - 2 ? 0 : level === rules.maxEscalationLevels - 1 ? 1 : 2;
  if (stage === 0) {
    const next = pickNextAssignee(ring, assignees, rules, lastUserId, exclude);
    if (next && !exclude.includes(next)) return {kind: 'employee', userId: next, level};
  }
  if (stage <= 1 && backup && !exclude.includes(backup)) return {kind: 'backup', userId: backup, level};
  if (manager && (manager !== lead.assignedTo || stage === 2)) return {kind: 'manager', userId: manager, level};
  if (backup && backup !== lead.assignedTo) return {kind: 'backup', userId: backup, level};
  return {kind: 'exception', level};
}

/** Mirrors public.escalate_overdue_leads: owned, unacknowledged, overdue, open, below the final level. */
export function isEscalatable(lead: Lead, now: Date, maxEscalationLevels = Number.POSITIVE_INFINITY): boolean {
  return (
    !CLOSED_STATUSES.includes(lead.status) &&
    lead.assignedTo !== null &&
    lead.acknowledgedAt === null &&
    lead.acknowledgementDeadline !== null &&
    new Date(lead.acknowledgementDeadline).getTime() <= now.getTime() &&
    lead.escalationLevel < maxEscalationLevels
  );
}

/**
 * Mirrors public.get_recovery_queue. `escalationsSinceReview` counts escalation events after the
 * last recovery review; it defaults to the lead's level when events are not available.
 */
export function recoveryReasons(
  lead: Lead,
  rules: Pick<AssignmentRules, 'idleThresholdSeconds' | 'ackTimeoutSeconds'>,
  now: Date,
  escalationsSinceReview: number = lead.escalationLevel,
): RecoveryReason[] {
  if (CLOSED_STATUSES.includes(lead.status)) return [];
  const reasons: RecoveryReason[] = [];
  if (lead.assignedTo !== null && lead.acknowledgedAt === null && lead.acknowledgementDeadline !== null && new Date(lead.acknowledgementDeadline) < now) {
    reasons.push('unacknowledged_overdue');
  }
  if (escalationsSinceReview >= 2) reasons.push('repeated_escalation');
  const created = new Date(lead.createdAt).getTime();
  const lastAction = Math.max(new Date(lead.lastActionAt ?? lead.createdAt).getTime(), new Date(lead.recoveryResolvedAt ?? lead.createdAt).getTime());
  if (now.getTime() - Math.max(lastAction, created) > rules.idleThresholdSeconds * 1000) reasons.push('idle');
  if (lead.ownershipException) reasons.push('ownership_exception');
  if (lead.assignedTo === null && !lead.ownershipException && now.getTime() - created > rules.ackTimeoutSeconds * 1000) reasons.push('unassigned');
  return reasons;
}

/** Time to first response = first acknowledgement − first assignment, in seconds. */
export function firstResponseSeconds(lead: Pick<Lead, 'firstAssignedAt' | 'firstAcknowledgedAt'>): number | null {
  if (!lead.firstAssignedAt || !lead.firstAcknowledgedAt) return null;
  const s = (new Date(lead.firstAcknowledgedAt).getTime() - new Date(lead.firstAssignedAt).getTime()) / 1000;
  return s < 0 ? null : s;
}

export function isQualifyingAction(action: string): action is QualifyingAction {
  return (QUALIFYING_ACTIONS as readonly string[]).includes(action);
}

export function buildEscalationNotification(args: {
  workspaceId: string;
  leadId: string;
  leadName: string;
  source: string | null;
  recipientUserId: string;
  eventId: string;
  reason: string;
  baseUrl: string;
  now: Date;
  eventType?: NotificationOutboxPayload['event_type'];
}): NotificationOutboxPayload {
  return {
    workspace_id: args.workspaceId,
    lead_id: args.leadId,
    recipient_user_id: args.recipientUserId,
    event_id: args.eventId,
    event_type: args.eventType ?? 'lead_escalated',
    lead_name: args.leadName,
    source: args.source,
    reason: args.reason,
    lead_url: `${args.baseUrl.replace(/\/$/, '')}/leads/${args.leadId}`,
    created_at: args.now.toISOString(),
  };
}

export type CountdownState = 'pending' | 'approaching' | 'overdue' | 'acknowledged' | 'reassigned';

export function countdownState(
  lead: Pick<Lead, 'acknowledgedAt' | 'acknowledgementDeadline' | 'assignedTo'>,
  now: Date,
  viewedAssignee: string | null,
  warnSeconds = 30,
): {state: CountdownState; remainingSeconds: number | null} {
  if (viewedAssignee !== null && lead.assignedTo !== viewedAssignee) return {state: 'reassigned', remainingSeconds: null};
  if (lead.acknowledgedAt) return {state: 'acknowledged', remainingSeconds: null};
  if (!lead.acknowledgementDeadline) return {state: 'pending', remainingSeconds: null};
  const remaining = Math.ceil((new Date(lead.acknowledgementDeadline).getTime() - now.getTime()) / 1000);
  if (remaining <= 0) return {state: 'overdue', remainingSeconds: 0};
  return {state: remaining <= warnSeconds ? 'approaching' : 'pending', remainingSeconds: remaining};
}
