export type Role = 'Owner' | 'Admin' | 'User';
export type EntityKind = 'leads' | 'contacts' | 'companies' | 'opportunities';
export interface RecordItem { id:string; name:string; email:string; company:string; status:string; source:string; owner:string; value:number; stage:string; created:string; acknowledged:boolean; deadline?:string; }
export interface TeamMember { id:string; name:string; email:string; role:Role; initials:string; availability:'Available'|'Busy'|'Away'; leads:number; }
export interface ServiceResult<T> { data:T|null; error:string|null; }
export interface Workspace { id:string; name:string; industry:string; timezone:string; }
export interface EntityService { list(workspaceId:string):Promise<ServiceResult<RecordItem[]>>; create(workspaceId:string,input:Omit<RecordItem,'id'>):Promise<ServiceResult<RecordItem>>; update(workspaceId:string,id:string,input:Partial<RecordItem>):Promise<ServiceResult<RecordItem>>; }
// CRM rows use snake_case so they can map to future workspace-scoped PostgreSQL tables; field names await schema confirmation.
export interface WorkspaceRow { id:string; workspace_id:string; created_at:string; updated_at:string; }
export interface Contact extends WorkspaceRow { name:string; email:string|null; phone:string|null; company_id:string|null; status:string; source:string|null; owner_id:string|null; }
export interface Company extends WorkspaceRow { name:string; email:string|null; phone:string|null; website:string|null; industry:string|null; status:string; owner_id:string|null; }
// value is null when the server withholds it from a caller without permission to view opportunity values.
export interface Opportunity extends WorkspaceRow { title:string; contact_id:string|null; company_id:string|null; value:number|null; currency:string; pipeline_id:string|null; stage:string; owner_id:string|null; status:string; expected_close_date:string|null; }
export type CrmCreateInput<T extends WorkspaceRow> = Omit<T,keyof WorkspaceRow>;
export type CrmUpdateInput<T extends WorkspaceRow> = Partial<CrmCreateInput<T>>;
export interface CrmService<T extends WorkspaceRow> { list(workspaceId:string):Promise<ServiceResult<T[]>>; getById(workspaceId:string,id:string):Promise<ServiceResult<T>>; create(workspaceId:string,input:CrmCreateInput<T>):Promise<ServiceResult<T>>; update(workspaceId:string,id:string,input:CrmUpdateInput<T>):Promise<ServiceResult<T>>; delete(workspaceId:string,id:string):Promise<ServiceResult<null>>; }

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
