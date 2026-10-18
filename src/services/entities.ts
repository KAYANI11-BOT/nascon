import type {EntityService,RecordItem,ServiceResult} from '@/types/domain';
// CRM record adapters stay unavailable until CRM development connects them to the workspace-scoped tables.
const unavailable=async<T>():Promise<ServiceResult<T>>=>({data:null,error:'Configuration required: database services are not connected.'});
export const entityService:EntityService={list:(_workspaceId)=>unavailable<RecordItem[]>(),create:(_workspaceId,_input)=>unavailable<RecordItem>(),update:(_workspaceId,_id,_input)=>unavailable<RecordItem>()};
