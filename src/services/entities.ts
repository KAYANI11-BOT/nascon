import type {EntityService,RecordItem,ServiceResult} from '@/types/domain';
const unavailable=async<T>():Promise<ServiceResult<T>>=>({data:null,error:'Configuration required: database services are not connected.'});
export const entityService:EntityService={list:(_workspaceId)=>unavailable<RecordItem[]>(),create:(_workspaceId,_input)=>unavailable<RecordItem>(),update:(_workspaceId,_id,_input)=>unavailable<RecordItem>()};
export const authService={signIn:async(_email:string,_password:string)=>unavailable<{userId:string}>(),signUp:async(_email:string,_password:string,_name:string)=>unavailable<{userId:string}>(),signOut:async()=>unavailable<null>()};
