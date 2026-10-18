// Hand-written to match supabase/migrations/20261018000100..500. After the migrations are
// applied, regenerate with:  npx supabase gen types typescript --linked > src/types/database.ts
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type WorkspaceRoleValue = 'owner' | 'admin' | 'user';
export type PermissionKey =
  | 'workspace.settings.manage' | 'members.manage' | 'companies.manage' | 'contacts.manage'
  | 'opportunities.manage' | 'pipelines.manage' | 'leads.manage' | 'leads.assign'
  | 'assignment_rules.manage' | 'availability.manage_others' | 'records.delete' | 'audit.view';
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'recovery' | 'escalated' | 'converted' | 'lost';
export type AvailabilityStatus = 'available' | 'busy' | 'away' | 'offline';

type Timestamps = { created_at: string; updated_at: string; };
type Rel<Name extends string, Cols extends string[], Ref extends string, RefCols extends string[]> = {
  foreignKeyName: Name; columns: Cols; isOneToOne: false; referencedRelation: Ref; referencedColumns: RefCols;
};
/** Insert type: generated/defaulted columns become optional. */
type InsertOf<Row, Optional extends keyof Row> = Omit<Row, Optional> & Partial<Pick<Row, Optional>>;
type Table<Row, Optional extends keyof Row, Relationships extends unknown[] = []> = {
  Row: Row; Insert: InsertOf<Row, Optional>; Update: Partial<Row>; Relationships: Relationships;
};

export type ProfileRow = Timestamps & { id: string; full_name: string; avatar_url: string | null; };
export type WorkspaceRow = Timestamps & { id: string; name: string; industry: string; timezone: string; created_by: string | null; };
export type WorkspaceMemberRow = Timestamps & { id: string; workspace_id: string; user_id: string; role: WorkspaceRoleValue; };
export type PermissionRow = { key: PermissionKey; description: string; default_admin: boolean; default_user: boolean; };
export type WorkspaceRolePermissionRow = { workspace_id: string; role: Exclude<WorkspaceRoleValue, 'owner'>; permission_key: PermissionKey; allowed: boolean; updated_at: string; };
export type CompanyRow = Timestamps & { id: string; workspace_id: string; name: string; domain: string | null; industry: string | null; phone: string | null; owner_id: string | null; created_by: string | null; };
export type ContactRow = Timestamps & { id: string; workspace_id: string; company_id: string | null; full_name: string; email: string | null; phone: string | null; title: string | null; owner_id: string | null; created_by: string | null; };
export type PipelineRow = Timestamps & { id: string; workspace_id: string; name: string; is_default: boolean; };
export type PipelineStageRow = Timestamps & { id: string; workspace_id: string; pipeline_id: string; name: string; position: number; stage_type: 'open' | 'won' | 'lost'; probability: number | null; };
export type OpportunityRow = Timestamps & { id: string; workspace_id: string; pipeline_id: string; stage_id: string; name: string; amount: number; currency: string; status: 'open' | 'won' | 'lost'; expected_close_date: string | null; company_id: string | null; contact_id: string | null; owner_id: string | null; created_by: string | null; };
export type LeadRow = Timestamps & { id: string; workspace_id: string; full_name: string; email: string | null; phone: string | null; company_name: string | null; source: string | null; status: LeadStatus; estimated_value: number | null; company_id: string | null; contact_id: string | null; assigned_to: string | null; assigned_at: string | null; acknowledgement_due_at: string | null; acknowledged_at: string | null; created_by: string | null; };
export type EmployeeAvailabilityRow = { workspace_id: string; user_id: string; status: AvailabilityStatus; max_open_leads: number | null; updated_at: string; };
export type AssignmentRuleRow = Timestamps & { id: string; workspace_id: string; name: string; strategy: 'manual' | 'round_robin' | 'availability'; is_active: boolean; priority: number; acknowledgement_window_minutes: number; config: Json; created_by: string | null; };
export type LeadAssignmentRow = { id: string; workspace_id: string; lead_id: string; assigned_to: string | null; previous_assigned_to: string | null; assigned_by: string | null; rule_id: string | null; reason: string | null; created_at: string; };
export type AuditLogRow = { id: number; workspace_id: string; actor_id: string | null; action: 'insert' | 'update' | 'delete'; table_name: string; record_id: string | null; old_data: Json | null; new_data: Json | null; created_at: string; };

type Ts = 'created_at' | 'updated_at';
export interface Database {
  public: {
    Tables: {
      profiles: Table<ProfileRow, Ts | 'full_name' | 'avatar_url'>;
      workspaces: Table<WorkspaceRow, Ts | 'id' | 'industry' | 'timezone' | 'created_by'>;
      workspace_members: Table<WorkspaceMemberRow, Ts | 'id' | 'role', [
        Rel<'workspace_members_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id']>,
        Rel<'workspace_members_user_id_fkey', ['user_id'], 'profiles', ['id']>,
      ]>;
      permissions: Table<PermissionRow, 'default_admin' | 'default_user'>;
      workspace_role_permissions: Table<WorkspaceRolePermissionRow, 'allowed' | 'updated_at'>;
      companies: Table<CompanyRow, Ts | 'id' | 'domain' | 'industry' | 'phone' | 'owner_id' | 'created_by'>;
      contacts: Table<ContactRow, Ts | 'id' | 'company_id' | 'email' | 'phone' | 'title' | 'owner_id' | 'created_by'>;
      pipelines: Table<PipelineRow, Ts | 'id' | 'is_default'>;
      pipeline_stages: Table<PipelineStageRow, Ts | 'id' | 'stage_type' | 'probability'>;
      opportunities: Table<OpportunityRow, Ts | 'id' | 'amount' | 'currency' | 'status' | 'expected_close_date' | 'company_id' | 'contact_id' | 'owner_id' | 'created_by'>;
      leads: Table<LeadRow, Ts | 'id' | 'email' | 'phone' | 'company_name' | 'source' | 'status' | 'estimated_value' | 'company_id' | 'contact_id' | 'assigned_to' | 'assigned_at' | 'acknowledgement_due_at' | 'acknowledged_at' | 'created_by'>;
      employee_availability: Table<EmployeeAvailabilityRow, 'status' | 'max_open_leads' | 'updated_at'>;
      assignment_rules: Table<AssignmentRuleRow, Ts | 'id' | 'strategy' | 'is_active' | 'priority' | 'acknowledgement_window_minutes' | 'config' | 'created_by'>;
      lead_assignments: Table<LeadAssignmentRow, 'id' | 'assigned_to' | 'previous_assigned_to' | 'assigned_by' | 'rule_id' | 'reason' | 'created_at'>;
      audit_logs: Table<AuditLogRow, 'id' | 'actor_id' | 'record_id' | 'old_data' | 'new_data' | 'created_at'>;
    };
    Views: { [_ in never]: never };
    Functions: {
      create_workspace_with_owner: { Args: { p_name: string; p_industry?: string; p_timezone?: string }; Returns: string };
    };
    Enums: { workspace_role: WorkspaceRoleValue };
    CompositeTypes: { [_ in never]: never };
  };
}
