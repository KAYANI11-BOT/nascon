export type Role = 'Owner' | 'Admin' | 'User';
export type EntityKind = 'leads' | 'contacts' | 'companies' | 'opportunities';
export interface RecordItem { id:string; name:string; email:string; company:string; status:string; source:string; owner:string; value:number; stage:string; created:string; acknowledged:boolean; deadline?:string; }
export interface TeamMember { id:string; name:string; email:string; role:Role; initials:string; availability:'Available'|'Busy'|'Away'; leads:number; }
export interface ServiceResult<T> { data:T|null; error:string|null; }
export interface Workspace { id:string; name:string; industry:string; timezone:string; }
export interface EntityService { list(workspaceId:string):Promise<ServiceResult<RecordItem[]>>; create(workspaceId:string,input:Omit<RecordItem,'id'>):Promise<ServiceResult<RecordItem>>; update(workspaceId:string,id:string,input:Partial<RecordItem>):Promise<ServiceResult<RecordItem>>; }
// --- CRM contracts: rows come from supabase/migrations/20261018000200_crm_core.sql via ./database ---
import type { CompanyRow, ContactRow, Database, OpportunityRow, PipelineRow, PipelineStageRow } from './database';
type CrmTables = Database['public']['Tables'];
// Callers never set ids, workspace scope, timestamps or authorship; the server boundary does.
type CrmInsert<K extends keyof CrmTables> = Omit<CrmTables[K]['Insert'],'id'|'workspace_id'|'created_at'|'updated_at'|'created_by'>;
export type Contact = ContactRow;
export type Company = CompanyRow;
export type Pipeline = PipelineRow;
export type PipelineStage = PipelineStageRow;
export type StageType = PipelineStageRow['stage_type'];
// amount is null when the server withholds it from a caller without permission to view opportunity values.
export type Opportunity = Omit<OpportunityRow,'amount'> & { amount:number|null; custom_fields?:OpportunityCustomValues };
export type ContactInput = CrmInsert<'contacts'>;
export type CompanyInput = CrmInsert<'companies'>;
export type PipelineInput = CrmInsert<'pipelines'>;
export type PipelineStageInput = CrmInsert<'pipeline_stages'>;
export type OpportunityInput = CrmInsert<'opportunities'> & { custom_fields?:OpportunityCustomValues };
export interface CrmService<Row,Input> { list(workspaceId:string):Promise<ServiceResult<Row[]>>; getById(workspaceId:string,id:string):Promise<ServiceResult<Row>>; create(workspaceId:string,input:Input):Promise<ServiceResult<Row>>; update(workspaceId:string,id:string,input:Partial<Input>):Promise<ServiceResult<Row>>; delete(workspaceId:string,id:string):Promise<ServiceResult<null>>; }
// Per-pipeline custom fields (F2.2–F2.4). PROPOSED contract, NOT in crm_core.sql yet: needs pipeline_custom_fields,
// pipeline_stage_required_fields and an opportunities.custom_fields jsonb column (to be agreed with Member 1).
export type CustomFieldType = 'text'|'number'|'date'|'select'|'checkbox';
export interface PipelineCustomField { id:string; workspace_id:string; pipeline_id:string; key:string; label:string; field_type:CustomFieldType; options:string[]|null; required:boolean; position:number; created_at:string; updated_at:string; }
export type PipelineCustomFieldInput = Omit<PipelineCustomField,'id'|'workspace_id'|'created_at'|'updated_at'>;
// A field that must have a value before an opportunity may enter the stage.
export interface PipelineStageRequiredField { workspace_id:string; pipeline_id:string; stage_id:string; field_id:string; created_at:string; }
export type PipelineStageRequiredFieldInput = Omit<PipelineStageRequiredField,'workspace_id'|'created_at'>;
export type OpportunityCustomValues = Record<string,string|number|boolean|null>;
// UI configuration shape for one pipeline, used by demo session state and by future service-backed loaders.
export interface CustomFieldConfig { id:string; key:string; label:string; type:CustomFieldType; options?:string[]; required:boolean; }
export interface PipelineStageConfig { id:string; name:string; type:StageType; requiredFieldIds:string[]; }
export interface PipelineConfig { id:string; name:string; isDefault:boolean; stages:PipelineStageConfig[]; fields:CustomFieldConfig[]; }
// --- Saved filters (F2.6). PROPOSED contract, NOT in the approved schema: needs a saved_filters table (see SavedFilter).
// The schema has no tags/labels column on opportunities, so tag conditions are not supported.
export type FilterDateField = 'created'|'closeDate';
export type FilterDateOperator = 'before'|'after'|'on'|'between';
export type FilterCustomOperator = 'equals'|'contains'|'gt'|'lt';
// Conditions are combined with AND. Stage conditions store the stage name as the UI knows it; a persisted version
// should reference stage_id so renaming a stage does not break a saved filter.
export type FilterCondition =
  | { id:string; kind:'stage'; value:string }
  | { id:string; kind:'owner'; value:string }
  | { id:string; kind:'date'; dateField:FilterDateField; operator:FilterDateOperator; value:string; valueTo?:string }
  | { id:string; kind:'custom'; pipelineId:string; fieldKey:string; operator:FilterCustomOperator; value:string };
export type FilterConditionKind = FilterCondition['kind'];
/** pipelineId is 'all' for every pipeline, otherwise the pipeline the filter is limited to. */
export interface FilterDefinition { pipelineId:string; conditions:FilterCondition[]; }
export interface SavedFilterConfig extends FilterDefinition { id:string; name:string; }
// Proposed table row: workspace-scoped and private to its creator (user_id) unless a sharing rule is agreed.
export interface SavedFilter { id:string; workspace_id:string; user_id:string; entity:'opportunities'; name:string; pipeline_id:string|null; conditions:FilterCondition[]; created_at:string; updated_at:string; }
export type SavedFilterInput = Omit<SavedFilter,'id'|'workspace_id'|'user_id'|'created_at'|'updated_at'>;

// --- Authentication and workspace contracts (shared by all feature modules) ---
export type { PermissionKey } from './database';
import type { PermissionKey } from './database';
export interface AuthUser { id:string; email:string; fullName:string; }
export interface WorkspaceMembership { workspaceId:string; role:Role; workspace:Workspace; }
export interface AuthContext {
  /** Supabase URL and public key are present (does not prove the connection works). */
  configured:boolean;
  /** Signed-out visitors are redirected to /login (configured and VITE_DEMO_MODE=false). */
  enforced:boolean;
  user:AuthUser|null;
  memberships:WorkspaceMembership[];
  activeWorkspace:WorkspaceMembership|null;
  /** Effective permissions in the active workspace. UI hints only; RLS enforces access. */
  permissions:PermissionKey[];
  /** Set when the session or workspace lookup failed (e.g. migrations not applied yet). */
  error:string|null;
}
