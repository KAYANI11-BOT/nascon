import type {AssignmentHistoryEntry} from '@/types/leads';
import {SOURCE_LABELS} from '@/types/leads';

export const sourceLabel = (s: string | null) => (s ? SOURCE_LABELS[s] ?? s : 'Unknown');

/** "2026-10-18T09:00:00Z" -> "2026-10-18 09:00:00 UTC". Always UTC so it matches the server clock. */
export function fmtUtc(iso: string | null | undefined): string {
  return iso ? iso.replace('T', ' ').replace(/\.\d+/, '').replace(/(Z|\+00:00)$/, ' UTC') : '—';
}

/** Compact age: 45s, 12m, 3h, 2d. */
export function fmtAge(fromIso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const REASONS: Record<string, string> = {
  auto_round_robin: 'Automatic (round robin)',
  fallback_backup: 'Fallback: designated backup',
  fallback_manager: 'Fallback: designated manager',
  escalation_peer: 'Escalated to next eligible employee',
  escalation_backup: 'Escalated to designated backup',
  escalation_manager: 'Escalated to designated manager',
  absence_reassignment: 'Reassigned: owner became unavailable',
  manual_reassignment: 'Manual reassignment',
  manual_assignment: 'Manual assignment',
  ownership_exception: 'No eligible owner could be found',
  backfill: 'Existing assignment',
};
export const reasonText = (r: string | null) => (r ? REASONS[r] ?? r : '—');

export function ackText(a: Pick<AssignmentHistoryEntry, 'acknowledgedAt' | 'ackMethod'>): string {
  if (!a.acknowledgedAt) return 'Not acknowledged';
  return a.ackMethod === 'explicit' ? 'Acknowledged' : a.ackMethod === 'supervisor' ? 'Acknowledged by a supervisor' : `Acknowledged via ${String(a.ackMethod ?? 'action').replace(/_/g, ' ')}`;
}
