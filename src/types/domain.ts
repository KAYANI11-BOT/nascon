export type Role = 'Owner' | 'Admin' | 'User';
export type EntityKind = 'leads' | 'contacts' | 'companies' | 'opportunities';
export interface RecordItem { id:string; name:string; email:string; company:string; status:string; source:string; owner:string; value:number; stage:string; created:string; acknowledged:boolean; deadline?:string; }
export interface TeamMember { id:string; name:string; email:string; role:Role; initials:string; availability:'Available'|'Busy'|'Away'; leads:number; }
export interface ServiceResult<T> { data:T|null; error:string|null; }
export interface Workspace { id:string; name:string; industry:string; timezone:string; }
export interface EntityService { list(workspaceId:string):Promise<ServiceResult<RecordItem[]>>; create(workspaceId:string,input:Omit<RecordItem,'id'>):Promise<ServiceResult<RecordItem>>; update(workspaceId:string,id:string,input:Partial<RecordItem>):Promise<ServiceResult<RecordItem>>; }

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
