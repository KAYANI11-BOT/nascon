// Pure parsing/validation for the assignment-rules form so the rules are tested without React.
import type {AssignmentRules} from '@/types/leads';

export interface RulesDraft {
  strategy: AssignmentRules['strategy'];
  active: boolean;
  ackSeconds: string;
  escalationTimeouts: string;
  maxLevels: string;
  maxOpenLeads: string;
  idleSeconds: string;
  backupUserId: string;
  managerUserId: string;
  absencePolicy: AssignmentRules['acknowledgedAbsencePolicy'];
  ring: string[];
}

export const rulesToDraft = (r: AssignmentRules): RulesDraft => ({
  strategy: r.strategy, active: r.active, ackSeconds: String(r.ackTimeoutSeconds), escalationTimeouts: r.escalationTimeoutsSeconds.join(', '),
  maxLevels: String(r.maxEscalationLevels), maxOpenLeads: String(r.maxOpenLeads), idleSeconds: String(r.idleThresholdSeconds),
  backupUserId: r.backupUserId ?? '', managerUserId: r.managerUserId ?? '', absencePolicy: r.acknowledgedAbsencePolicy, ring: [...r.eligibleUserIds],
});

const wholeNumber = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

/** Mirrors the database CHECK constraints so users get an immediate message; the database still enforces them. */
export function parseRulesDraft(d: RulesDraft): {rules: AssignmentRules; error: null} | {rules: null; error: string} {
  const ack = wholeNumber(d.ackSeconds);
  if (!(ack >= 5 && ack <= 604800)) return {rules: null, error: 'The acknowledgement window must be between 5 seconds and 7 days.'};
  const timeouts = d.escalationTimeouts.split(',').map((s) => s.trim()).filter(Boolean).map(wholeNumber);
  if (timeouts.length > 10 || timeouts.some((n) => !(n >= 5 && n <= 604800))) return {rules: null, error: 'Escalation timeouts must be up to 10 whole numbers of seconds (5 or more), separated by commas.'};
  const levels = wholeNumber(d.maxLevels);
  if (!(levels >= 1 && levels <= 10)) return {rules: null, error: 'Escalation levels must be between 1 and 10.'};
  const cap = wholeNumber(d.maxOpenLeads);
  if (!(cap >= 1 && cap <= 10000)) return {rules: null, error: 'The open-lead limit must be between 1 and 10000.'};
  const idle = wholeNumber(d.idleSeconds);
  if (!(idle >= 10 && idle <= 31536000)) return {rules: null, error: 'The idle threshold must be at least 10 seconds.'};
  if (new Set(d.ring).size !== d.ring.length) return {rules: null, error: 'An employee appears twice in the assignment order.'};
  if (d.strategy !== 'manual' && d.active && d.ring.length === 0 && !d.backupUserId && !d.managerUserId) {
    return {rules: null, error: 'Automatic assignment needs at least one eligible employee, a backup or a manager.'};
  }
  return {
    error: null,
    rules: {
      strategy: d.strategy, active: d.active, ackTimeoutSeconds: ack, escalationTimeoutsSeconds: timeouts, maxEscalationLevels: levels,
      maxOpenLeads: cap, idleThresholdSeconds: idle, backupUserId: d.backupUserId || null, managerUserId: d.managerUserId || null,
      eligibleUserIds: d.ring, acknowledgedAbsencePolicy: d.absencePolicy,
    },
  };
}

/** Moves one entry up or down in the ring, returning a new array. */
export function moveInRing(ring: string[], userId: string, delta: -1 | 1): string[] {
  const i = ring.indexOf(userId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ring.length) return ring;
  const next = [...ring];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
