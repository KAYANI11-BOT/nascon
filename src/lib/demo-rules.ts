import type {RecordItem} from '@/types/domain';
export function filterRecords(rows:RecordItem[],query:string,status:string){const q=query.trim().toLowerCase();return rows.filter(r=>(status==='All statuses'||r.status===status)&&[r.name,r.email,r.company,r.owner].some(v=>v.toLowerCase().includes(q)));}
export function moveOpportunity(rows:RecordItem[],id:string,stage:string,stages:string[]){if(!stages.includes(stage))return rows;return rows.map(r=>r.id===id?{...r,stage}:r);}
export function validateRecord(name:string,email:string){if(name.trim().length<2)return 'Enter a name with at least two characters.';if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return 'Enter a valid email address.';return '';}
