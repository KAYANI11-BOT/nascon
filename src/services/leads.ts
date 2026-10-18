import type {SupabaseClient} from '@supabase/supabase-js';
import {getSupabaseConfiguration} from '@/lib/supabase';
import {getSupabaseBrowserClient} from '@/lib/supabase-browser';
import type {ServiceResult} from '@/types/domain';
import type {
  AssignmentHistoryEntry, AssignmentRules, AvailabilityStatus, EscalationEvent, Lead, LeadService, LeadStatus,
  RecoveryItem, RecoveryReason, TeamAvailability,
} from '@/types/leads';
import {CLOSED_STATUSES} from '@/types/leads';

// Row types are snake_case straight from PostgREST. They are declared here (not in the shared
// src/types/database.ts) so Member 1's generated types can be regenerated without conflicts.
type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : fallback);

export function toLead(r: Row): Lead {
  return {
    id: String(r['id']), workspaceId: String(r['workspace_id']), name: String(r['full_name']),
    email: str(r['email']), phone: str(r['phone']), company: str(r['company_name']), message: str(r['message']),
    source: str(r['source']), status: r['status'] as LeadStatus, assignedTo: str(r['assigned_to']),
    currentAssignmentId: str(r['current_assignment_id']), createdAt: String(r['created_at']), updatedAt: String(r['updated_at']),
    firstAssignedAt: str(r['first_assigned_at']), assignedAt: str(r['assigned_at']),
    firstAcknowledgedAt: str(r['first_acknowledged_at']), acknowledgedAt: str(r['acknowledged_at']),
    acknowledgementDeadline: str(r['acknowledgement_due_at']), escalationLevel: int(r['escalation_level']),
    lastActionAt: str(r['last_action_at']), needsManagerReview: r['needs_manager_review'] === true,
    ownershipException: r['ownership_exception'] === true, recoveryResolvedAt: str(r['recovery_resolved_at']),
    version: int(r['version'], 1),
  };
}

export function toAssignment(r: Row): AssignmentHistoryEntry {
  return {
    id: String(r['id']), leadId: String(r['lead_id']), assignedTo: str(r['assigned_to']), previousAssignedTo: str(r['previous_assigned_to']),
    assignedBy: str(r['assigned_by']), reason: str(r['reason']), escalationLevel: int(r['escalation_level']), deadline: str(r['deadline']),
    acknowledgedAt: str(r['acknowledged_at']), acknowledgedBy: str(r['acknowledged_by']), ackMethod: str(r['ack_method']),
    createdAt: String(r['created_at']), endedAt: str(r['ended_at']), endReason: str(r['end_reason']),
  };
}

export function toEscalation(r: Row): EscalationEvent {
  return {
    id: String(r['id']), leadId: String(r['lead_id']), previousOwner: str(r['previous_owner']), newOwner: str(r['new_owner']),
    level: int(r['level']), reason: String(r['reason']), result: r['result'] as EscalationEvent['result'], createdAt: String(r['created_at']),
  };
}

export function toRecoveryItem(r: Row): RecoveryItem {
  return {
    leadId: String(r['lead_id']), name: String(r['full_name']), source: str(r['source']), assignedTo: str(r['assigned_to']),
    status: r['status'] as LeadStatus, createdAt: String(r['created_at']), acknowledged: r['acknowledged'] === true,
    escalationLevel: int(r['escalation_level']), escalationsSinceReview: int(r['escalations_since_review']),
    lastActionAt: str(r['last_action_at']), deadline: str(r['acknowledgement_due_at']), needsManagerReview: r['needs_manager_review'] === true,
    reasons: (Array.isArray(r['reasons']) ? r['reasons'] : []) as RecoveryReason[],
  };
}

export function toRules(r: Row, ring: string[]): AssignmentRules {
  const seconds = r['acknowledgement_window_seconds'];
  return {
    active: r['is_active'] === true, strategy: r['strategy'] as AssignmentRules['strategy'], maxOpenLeads: int(r['max_open_leads'], 10),
    ackTimeoutSeconds: typeof seconds === 'number' ? seconds : int(r['acknowledgement_window_minutes'], 15) * 60,
    escalationTimeoutsSeconds: Array.isArray(r['escalation_timeouts_seconds']) ? (r['escalation_timeouts_seconds'] as number[]) : [],
    maxEscalationLevels: int(r['max_escalation_levels'], 3), backupUserId: str(r['backup_user_id']), managerUserId: str(r['manager_user_id']),
    idleThresholdSeconds: int(r['idle_threshold_seconds'], 86400), eligibleUserIds: ring,
    acknowledgedAbsencePolicy: r['acknowledged_absence_policy'] === 'reassign' ? 'reassign' : 'keep_and_flag',
  };
}

/** Strips characters that would alter a PostgREST `or()` filter expression. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const MESSAGES: Record<string, string> = {
  '40001': 'This lead changed while you were working. Refresh and try again.',
  '42501': 'You do not have permission to do that.',
  '28000': 'Your session has expired. Please sign in again.',
  '55000': 'Acknowledge or reassign the lead before resolving recovery.',
  '22023': 'Some of the details are not valid.',
};
function fail<T>(error: {code?: string; message?: string} | null | undefined, fallback: string): ServiceResult<T> {
  return {data: null, error: (error?.code && MESSAGES[error.code]) || error?.message || fallback};
}
const ok = <T,>(data: T): ServiceResult<T> => ({data, error: null});

/**
 * Lead automation service over Supabase (RLS + SECURITY DEFINER RPCs). It never reports success
 * unless the database confirmed it. `getClient` is injected so tests can use a fake.
 */
export function createLeadService(getClient: () => SupabaseClient): LeadService {
  const db = () => getClient();
  return {
    async listLeads(workspaceId, f) {
      let q = db().from('leads').select('*', {count: 'exact'}).eq('workspace_id', workspaceId);
      const search = f.search ? sanitizeSearch(f.search) : '';
      if (search) q = q.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,company_name.ilike.%${search}%`);
      if (f.status) q = q.eq('status', f.status);
      if (f.ownerId) q = q.eq('assigned_to', f.ownerId);
      if (f.source) q = q.eq('source', f.source);
      const from = Math.max(0, (f.page - 1) * f.pageSize);
      const {data, error, count} = await q.order('created_at', {ascending: false}).range(from, from + f.pageSize - 1);
      if (error) return fail(error, 'Leads could not be loaded.');
      return ok({rows: (data ?? []).map((r) => toLead(r as Row)), total: count ?? 0});
    },

    async getLead(workspaceId, leadId) {
      const {data, error} = await db().from('leads').select('*').eq('workspace_id', workspaceId).eq('id', leadId).maybeSingle();
      if (error) return fail(error, 'The lead could not be loaded.');
      if (!data) return fail(null, 'Lead not found.');
      const [assignments, escalations] = await Promise.all([
        db().from('lead_assignments').select('*').eq('workspace_id', workspaceId).eq('lead_id', leadId).order('created_at', {ascending: true}),
        db().from('lead_escalations').select('*').eq('workspace_id', workspaceId).eq('lead_id', leadId).order('created_at', {ascending: true}),
      ]);
      if (assignments.error) return fail(assignments.error, 'Assignment history could not be loaded.');
      if (escalations.error) return fail(escalations.error, 'Escalation history could not be loaded.');
      return ok({
        lead: toLead(data as Row),
        assignments: (assignments.data ?? []).map((r) => toAssignment(r as Row)),
        escalations: (escalations.data ?? []).map((r) => toEscalation(r as Row)),
      });
    },

    async createManual(workspaceId, input) {
      const {data, error} = await db().rpc('create_lead', {
        p_workspace: workspaceId, p_full_name: input.name, p_email: input.email ?? null, p_phone: input.phone ?? null,
        p_company: input.company ?? null, p_message: input.message ?? null, p_idempotency_key: input.idempotencyKey,
      });
      if (error) return fail(error, 'The lead could not be saved.');
      if (!data) return fail(null, 'The lead could not be saved.');
      return ok(toLead(data as Row));
    },

    async acknowledge(leadId, assignmentId) {
      const {data, error} = await db().rpc('acknowledge_lead', {p_lead: leadId, p_assignment: assignmentId});
      if (error) return fail(error, 'The lead could not be acknowledged.');
      const code = (data as Row | null)?.['code'];
      if (code !== 'ok' && code !== 'already_applied') return fail(null, 'The server did not confirm the acknowledgement.');
      return ok({code});
    },

    async recordAction(leadId, action, dedupeKey) {
      const {data, error} = await db().rpc('record_lead_action', {p_lead: leadId, p_action: action, p_dedupe_key: dedupeKey});
      if (error) return fail(error, 'The action could not be recorded.');
      return ok({acknowledged: (data as Row | null)?.['acknowledged'] === true});
    },

    async reassign(leadId, toUserId, expectedVersion, reason) {
      const {data, error} = await db().rpc('reassign_lead', {p_lead: leadId, p_to: toUserId, p_expected_version: expectedVersion, p_reason: reason ?? null});
      if (error) return fail(error, 'The lead could not be reassigned.');
      const code = (data as Row | null)?.['code'];
      if (typeof code !== 'string') return fail(null, 'The server did not confirm the reassignment.');
      return ok({code});
    },

    async recoveryQueue(workspaceId, f) {
      const {data, error} = await db().rpc('get_recovery_queue', {
        p_workspace: workspaceId, p_reason: f.reason ?? null, p_owner: f.ownerId ?? null, p_source: f.source ?? null, p_status: f.status ?? null,
        p_created_from: f.createdFrom ?? null, p_created_to: f.createdTo ?? null, p_limit: f.pageSize, p_offset: Math.max(0, (f.page - 1) * f.pageSize),
      });
      if (error) return fail(error, 'The recovery queue could not be loaded.');
      const rows = (data ?? []) as Row[];
      return ok({rows: rows.map(toRecoveryItem), total: rows.length ? int(rows[0]?.['total_count']) : 0});
    },

    async resolveRecovery(leadId) {
      const {error} = await db().rpc('resolve_recovery', {p_lead: leadId});
      return error ? fail(error, 'Recovery could not be resolved.') : ok(null);
    },

    async listTeam(workspaceId) {
      const [members, availability, owned] = await Promise.all([
        db().from('workspace_members').select('user_id, profiles(full_name)').eq('workspace_id', workspaceId),
        db().from('employee_availability').select('user_id, status, max_open_leads').eq('workspace_id', workspaceId),
        db().from('leads').select('assigned_to, status').eq('workspace_id', workspaceId).not('assigned_to', 'is', null),
      ]);
      if (members.error) return fail(members.error, 'The team could not be loaded.');
      if (availability.error) return fail(availability.error, 'Availability could not be loaded.');
      if (owned.error) return fail(owned.error, 'Workloads could not be loaded.');
      const status = new Map((availability.data ?? []).map((a) => [String(a['user_id']), a as Row]));
      const open = new Map<string, number>();
      for (const l of owned.data ?? []) {
        if (!(CLOSED_STATUSES as readonly string[]).includes(String(l['status']))) open.set(String(l['assigned_to']), (open.get(String(l['assigned_to'])) ?? 0) + 1);
      }
      const team: TeamAvailability[] = (members.data ?? []).map((m) => {
        const uid = String(m['user_id']);
        const profile = m['profiles'] as {full_name?: string} | {full_name?: string}[] | null;
        const name = (Array.isArray(profile) ? profile[0]?.full_name : profile?.full_name) || 'Team member';
        const a = status.get(uid);
        return {userId: uid, name, status: (a?.['status'] as AvailabilityStatus | undefined) ?? 'offline', maxOpenLeads: a && a['max_open_leads'] !== null ? int(a['max_open_leads']) : null, openLeads: open.get(uid) ?? 0};
      });
      return ok(team);
    },

    async setAvailability(workspaceId, userId, status) {
      const {error} = await db().from('employee_availability').upsert({workspace_id: workspaceId, user_id: userId, status}, {onConflict: 'workspace_id,user_id'});
      return error ? fail(error, 'Availability could not be saved.') : ok(null);
    },

    async getRules(workspaceId) {
      const {data, error} = await db().from('assignment_rules').select('*').eq('workspace_id', workspaceId).eq('is_active', true)
        .order('priority', {ascending: false}).order('created_at', {ascending: true}).limit(1).maybeSingle();
      if (error) return fail(error, 'Assignment rules could not be loaded.');
      if (!data) return ok(null);
      const ring = await db().from('assignment_rule_assignees').select('user_id, position').eq('rule_id', String((data as Row)['id'])).order('position', {ascending: true});
      if (ring.error) return fail(ring.error, 'The assignee ring could not be loaded.');
      return ok({ruleId: String((data as Row)['id']), rules: toRules(data as Row, (ring.data ?? []).map((r) => String(r['user_id'])))});
    },

    async saveRules(workspaceId, ruleId, rules) {
      const {error} = await db().from('assignment_rules').update({
        strategy: rules.strategy, is_active: rules.active, acknowledgement_window_seconds: rules.ackTimeoutSeconds,
        max_open_leads: rules.maxOpenLeads, escalation_timeouts_seconds: rules.escalationTimeoutsSeconds,
        max_escalation_levels: rules.maxEscalationLevels, backup_user_id: rules.backupUserId, manager_user_id: rules.managerUserId,
        idle_threshold_seconds: rules.idleThresholdSeconds, acknowledged_absence_policy: rules.acknowledgedAbsencePolicy,
      }).eq('workspace_id', workspaceId).eq('id', ruleId);
      if (error) return fail(error, 'Assignment rules could not be saved.');
      const ring = await db().rpc('set_rule_assignees', {p_rule: ruleId, p_user_ids: rules.eligibleUserIds});
      return ring.error ? fail(ring.error, 'The assignee ring could not be saved.') : ok(null);
    },
  };
}

const unavailableMessage = 'Configuration required: Supabase is not configured, so lead automation is unavailable.';
const unavailable = async <T,>(): Promise<ServiceResult<T>> => ({data: null, error: unavailableMessage});

/** Live service when Supabase is configured; otherwise every call reports "Configuration required". */
export const leadService: LeadService = getSupabaseConfiguration().configured
  ? createLeadService(() => getSupabaseBrowserClient() as unknown as SupabaseClient)
  : {
      listLeads: unavailable, getLead: unavailable, createManual: unavailable, acknowledge: unavailable, recordAction: unavailable,
      reassign: unavailable, recoveryQueue: unavailable, resolveRecovery: unavailable, listTeam: unavailable,
      setAvailability: unavailable, getRules: unavailable, saveRules: unavailable,
    };
