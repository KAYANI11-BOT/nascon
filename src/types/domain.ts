export type Role = 'Owner' | 'Admin' | 'User';
export type EntityKind = 'leads' | 'contacts' | 'companies' | 'opportunities';
export interface RecordItem { id:string; name:string; email:string; company:string; status:string; source:string; owner:string; value:number; stage:string; created:string; acknowledged:boolean; deadline?:string; }
export interface TeamMember { id:string; name:string; email:string; role:Role; initials:string; availability:'Available'|'Busy'|'Away'; leads:number; }
export interface ServiceResult<T> { data:T|null; error:string|null; }
export interface Workspace { id:string; name:string; industry:string; timezone:string; }
export interface EntityService { list(workspaceId:string):Promise<ServiceResult<RecordItem[]>>; create(workspaceId:string,input:Omit<RecordItem,'id'>):Promise<ServiceResult<RecordItem>>; update(workspaceId:string,id:string,input:Partial<RecordItem>):Promise<ServiceResult<RecordItem>>; }
