// Lead Protection Engine domain model (Member 2), aligned with migrations 20261018000300 + 000600.
// Rows from the database are snake_case (see LeadRow); the domain model below is camelCase and
// is produced by mappers in src/services/leads.ts. Nothing here creates or replaces core tables.
import type {ServiceResult} from '@/types/domain';

/** 'on_leave' is the official status; 'away' is a legacy value still allowed by the database. */
export const AVAILABILITY_STATUSES = ['available', 'busy', 'on_leave', 'offline'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number] | 'away';
export const ABSENT_STATUSES: readonly AvailabilityStatus[] = ['on_leave', 'offline', 'away'];
export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  available: 'Available', busy: 'Busy', on_leave: 'On leave', offline: 'Offline', away: 'Away (legacy)',
};

export const LEAD_SOURCES = ['manual', 'web_form', 'messaging'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const SOURCE_LABELS: Record<string, string> = {manual: 'Manual entry', web_form: 'Web form', messaging: 'Messaging'};

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'recovery' | 'escalated' | 'converted' | 'lost';
export const CLOSED_STATUSES: readonly LeadStatus[] = ['converted', 'lost'];

export type RecoveryReason = 'unacknowledged_overdue' | 'repeated_escalation' | 'idle' | 'ownership_exception' | 'unassigned';
export const RECOVERY_REASON_LABELS: Record<RecoveryReason, string> = {
  unacknowledged_overdue: 'Unacknowledged past deadline',
  repeated_escalation: 'Escalated 2+ times',
  idle: 'No recorded action (idle)',
  ownership_exception: 'No owner could be assigned',
  unassigned: 'Unassigned',
};

/** Qualifying recorded actions that implicitly acknowledge a lead (F3.4). */
export const QUALIFYING_ACTIONS = ['note_added', 'message_sent', 'call_recorded', 'stage_changed', 'appointment_scheduled'] as const;
export type QualifyingAction = (typeof QUALIFYING_ACTIONS)[number];

export interface Lead {
  id: string;
  workspaceId: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  message: string | null;
  source: string | null;
  status: LeadStatus;
  assignedTo: string | null;
  currentAssignmentId: string | null;
  createdAt: string;
  updatedAt: string;
  firstAssignedAt: string | null;
  assignedAt: string | null;
  firstAcknowledgedAt: string | null;
  /** Acknowledgement of the CURRENT assignment (null after every reassignment). */
  acknowledgedAt: string | null;
  acknowledgementDeadline: string | null;
  escalationLevel: number;
  lastActionAt: string | null;
  needsManagerReview: boolean;
  ownershipException: boolean;
  recoveryResolvedAt: string | null;
  version: number;
}

export interface Assignee {
  userId: string;
  active: boolean;
  assignable: boolean;
  availability: AvailabilityStatus;
  openLeads: number;
}

export interface AssignmentRules {
  active: boolean;
  strategy: 'manual' | 'round_robin' | 'availability';
  maxOpenLeads: number;
  ackTimeoutSeconds: number;
  /** Timeout per escalation level (index 0 = level 1). Falls back to ackTimeoutSeconds. */
  escalationTimeoutsSeconds: number[];
  maxEscalationLevels: number;
  backupUserId: string | null;
  managerUserId: string | null;
  idleThresholdSeconds: number;
  /** Ordered ring used for round-robin; only members of the ring are eligible. */
  eligibleUserIds: string[];
  /** 'keep_and_flag' keeps acknowledged leads with the absent owner for manager review. */
  acknowledgedAbsencePolicy: 'keep_and_flag' | 'reassign';
}

export interface AssignmentHistoryEntry {
  id: string;
  leadId: string;
  assignedTo: string | null;
  previousAssignedTo: string | null;
  assignedBy: string | null;
  reason: string | null;
  escalationLevel: number;
  deadline: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackMethod: string | null;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface EscalationEvent {
  id: string;
  leadId: string;
  previousOwner: string | null;
  newOwner: string | null;
  level: number;
  reason: string;
  result: 'pending' | 'employee' | 'backup' | 'manager' | 'exhausted';
  createdAt: string;
}

export interface RecoveryItem {
  leadId: string;
  name: string;
  source: string | null;
  assignedTo: string | null;
  status: LeadStatus;
  createdAt: string;
  acknowledged: boolean;
  escalationLevel: number;
  escalationsSinceReview: number;
  lastActionAt: string | null;
  deadline: string | null;
  needsManagerReview: boolean;
  /** Lead version, required for optimistic-concurrency reassignment. */
  version: number;
  reasons: RecoveryReason[];
}

export interface TeamAvailability {
  userId: string;
  name: string;
  status: AvailabilityStatus;
  maxOpenLeads: number | null;
  openLeads: number;
}

export interface NotificationOutboxPayload {
  workspace_id: string;
  lead_id: string;
  recipient_user_id: string;
  event_id: string;
  event_type: 'lead_escalated' | 'lead_assigned' | 'lead_exception';
  lead_name: string;
  source: string | null;
  reason: string;
  lead_url: string;
  created_at: string;
}

export interface LeadListFilters {
  search?: string;
  status?: LeadStatus;
  ownerId?: string;
  source?: string;
  page: number;
  pageSize: number;
}
export interface Page<T> { rows: T[]; total: number }

export interface RecoveryFilters {
  reason?: RecoveryReason;
  ownerId?: string;
  source?: string;
  status?: LeadStatus;
  createdFrom?: string;
  createdTo?: string;
  page: number;
  pageSize: number;
}

export interface LeadDetail {
  lead: Lead;
  assignments: AssignmentHistoryEntry[];
  escalations: EscalationEvent[];
}

export interface LeadService {
  listLeads(workspaceId: string, filters: LeadListFilters): Promise<ServiceResult<Page<Lead>>>;
  getLead(workspaceId: string, leadId: string): Promise<ServiceResult<LeadDetail>>;
  createManual(workspaceId: string, input: {name: string; email?: string; phone?: string; company?: string; message?: string; idempotencyKey: string}): Promise<ServiceResult<Lead>>;
  acknowledge(leadId: string, assignmentId: string): Promise<ServiceResult<{code: 'ok' | 'already_applied'}>>;
  recordAction(leadId: string, action: QualifyingAction, dedupeKey: string): Promise<ServiceResult<{acknowledged: boolean}>>;
  reassign(leadId: string, toUserId: string, expectedVersion: number, reason?: string): Promise<ServiceResult<{code: string}>>;
  recoveryQueue(workspaceId: string, filters: RecoveryFilters): Promise<ServiceResult<Page<RecoveryItem>>>;
  resolveRecovery(leadId: string): Promise<ServiceResult<null>>;
  listTeam(workspaceId: string): Promise<ServiceResult<TeamAvailability[]>>;
  setAvailability(workspaceId: string, userId: string, status: AvailabilityStatus): Promise<ServiceResult<null>>;
  getRules(workspaceId: string): Promise<ServiceResult<{ruleId: string; rules: AssignmentRules} | null>>;
  saveRules(workspaceId: string, ruleId: string, rules: AssignmentRules): Promise<ServiceResult<null>>;
}
