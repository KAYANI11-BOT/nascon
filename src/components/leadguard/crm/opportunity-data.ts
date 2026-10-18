import {useDemo} from '@/contexts/demo-context';
import {pipelineStages} from '@/data/demo';
import type {CrmCreateInput,Opportunity,RecordItem,TeamMember} from '@/types/domain';
export const opportunityStatuses=['Open','Won','Lost'];
export const opportunityCurrencies=['USD','EUR','GBP','PKR'];
export const demoPipelines=['Sales pipeline'];
export {pipelineStages};
// Display model shared by the page and form; value is null when the viewer may not see it (server decision, never client-side).
export interface OpportunityView {id:string;title:string;contact:string;company:string;value:number|null;currency:string;pipeline:string;stage:string;owner:string;status:string;closeDate:string;created:string;}
// value is null when the editor could not see it; saving then leaves the stored value unchanged.
export type OpportunityFormValues=Omit<OpportunityView,'id'|'created'>;
// Demo opportunities live in DemoProvider as RecordItems; fields RecordItem lacks ride along as optional session-only extras.
type OpportunityExtras={contact:string;currency:string;pipeline:string;closeDate:string};
type DemoOpportunityRecord=RecordItem&OpportunityExtras;
function toView(r:RecordItem,contacts:RecordItem[]):OpportunityView{const x=r as RecordItem&Partial<OpportunityExtras>;return {id:r.id,title:r.name,contact:x.contact??contacts.find(c=>c.company===r.company)?.name??'',company:r.company,value:r.value,currency:x.currency??'USD',pipeline:x.pipeline??demoPipelines[0]??'',stage:r.stage,owner:r.owner,status:r.status,closeDate:x.closeDate??'',created:r.created};}
// Single data boundary for the opportunities module; swap the demo branch for opportunityService.list once Supabase is connected.
export function useOpportunityRecords():{mode:'demo'|'unavailable';rows:OpportunityView[];contacts:string[];companies:string[];team:TeamMember[];save:((id:string|undefined,values:OpportunityFormValues)=>void)|null}{const{enabled,entities,team,saveRecord}=useDemo();const rows=entities.opportunities.map(r=>toView(r,entities.contacts));const save=enabled?(id:string|undefined,values:OpportunityFormValues)=>{const prev=id?entities.opportunities.find(r=>r.id===id):undefined;const row:DemoOpportunityRecord={id:prev?.id??`demo-${crypto.randomUUID()}`,name:values.title.trim(),email:prev?.email??'',company:values.company,owner:values.owner,status:values.status,source:prev?.source??'Manual',value:values.value??prev?.value??0,stage:values.stage,created:prev?.created??'2026-10-18',acknowledged:prev?.acknowledged??false,...(prev?.deadline?{deadline:prev.deadline}:{}),contact:values.contact,currency:values.currency,pipeline:values.pipeline,closeDate:values.closeDate};saveRecord('opportunities',row);}:null;return {mode:enabled?'demo':'unavailable',rows,contacts:Array.from(new Set(entities.contacts.map(c=>c.name))),companies:Array.from(new Set(entities.companies.map(c=>c.name))),team,save};}
export function formatValue(value:number|null,currency:string){return value===null?'Restricted':new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:0}).format(value);}
// Typed mapper for the future service call; contact, company, pipeline and owner ids must be resolved from workspace records first.
export function toOpportunityInput(values:OpportunityFormValues,refs:{contactId:string|null;companyId:string|null;pipelineId:string|null;ownerId:string|null}):CrmCreateInput<Opportunity>{return {title:values.title.trim(),contact_id:refs.contactId,company_id:refs.companyId,value:values.value,currency:values.currency,pipeline_id:refs.pipelineId,stage:values.stage,owner_id:refs.ownerId,status:values.status,expected_close_date:values.closeDate||null};}
