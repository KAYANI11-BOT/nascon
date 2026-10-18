// Lead Protection Engine contracts (Member 2).
// ASSUMPTION (needs Member 1 confirmation): workspace/user ids are UUID strings and
// roles live outside profiles. Nothing here creates or replaces core tables.
import type {ServiceResult} from '@/types/domain';

export const AVAILABILITY_STATUSES = ['available', 'busy', 'on_leave', 'offline'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const LEAD_SOURCES = ['manual', 'web_form', 'messaging'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export type LeadStatus = 'new' | 'assigned' | 'acknowledged' | 'exception' | 'closed';

export type AssignmentReason =
  | 'intake'
  | 'round_robin'
  | 'timeout_escalation'
  | 'absence_reassignment'
  | 'manual_reassignment'
  | 'fallback_backup'
  | 'fallback_manager';

export type RecoveryReason = 'unacknowledged_overdue' | 'repeated_escalation' | 'idle';

export interface Lead {
  id: string;
  workspaceId: string;
  contactId: string | null;
  name: string;
  source: LeadSource;
  status: LeadStatus;
  assignedTo: string | null;
  currentAssignmentId: string | null;
  createdAt: string;
  updatedAt: string;
  firstAssignedAt: string | null;
  lastAssignedAt: string | null;
  firstAcknowledgedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgementDeadline: string | null;
  escalationLevel: number;
  lastActionAt: string | null;
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
  previousOwner: string | null;
  newOwner: string | null;
  reason: AssignmentReason;
  actor: string | 'system';
  level: number;
  assignedAt: string;
  acknowledgedAt: string | null;
}

/** Qualifying recorded actions that implicitly acknowledge a lead (F3.4). */
export const QUALIFYING_ACTIONS = ['note_added', 'message_sent', 'call_recorded', 'stage_changed', 'appointment_scheduled'] as const;
export type QualifyingAction = (typeof QUALIFYING_ACTIONS)[number];

export interface NotificationOutboxPayload {
  workspace_id: string;
  lead_id: string;
  recipient_user_id: string;
  event_id: string;
  event_type: 'lead_escalated' | 'lead_assigned' | 'lead_exception';
  lead_name: string;
  source: LeadSource;
  reason: string;
  lead_url: string;
  created_at: string;
}

export interface IncomingLeadInput {
  workspaceId: string;
  provider: string;
  providerEventId: string;
  contactIdentifier: string;
  messageRef: string;
  source: LeadSource;
  idempotencyKey: string;
  name?: string;
}

export interface LeadService {
  createManual(input: {name: string; email?: string; phone?: string; idempotencyKey: string}): Promise<ServiceResult<Lead>>;
  captureIncomingLead(input: IncomingLeadInput): Promise<ServiceResult<Lead>>;
  acknowledge(leadId: string, assignmentId: string): Promise<ServiceResult<Lead>>;
  setAvailability(userId: string, status: AvailabilityStatus): Promise<ServiceResult<{reassigned: number}>>;
  reassign(leadId: string, toUserId: string, expectedVersion: number): Promise<ServiceResult<Lead>>;
  saveRules(rules: AssignmentRules): Promise<ServiceResult<AssignmentRules>>;
}
