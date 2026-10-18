import {useDemo} from '@/contexts/demo-context';
import {demoAppointments,demoAudit,demoMessages,demoPayments} from '@/data/demo';
import type {CompanyInput,ContactInput,RecordItem,TeamMember} from '@/types/domain';
export type CrmKind='contacts'|'companies';
export const crmCopy={contacts:{title:'Contacts',singular:'contact',subtitle:'The people behind your business relationships.',namePlaceholder:'Full name'},companies:{title:'Companies',singular:'company',subtitle:'A connected view of the companies you work with.',namePlaceholder:'Company name'}} as const;
export interface CrmFormValues {name:string;email:string;company:string;owner:string;status:string;source:string;}
// Single data boundary for CRM pages. Demo mode reads session-only DemoProvider state; otherwise records stay empty
// and saving is unavailable until contactService/companyService are backed by a real workspace-scoped database.
export function useCrmRecords(kind:CrmKind):{mode:'demo'|'unavailable';rows:RecordItem[];team:TeamMember[];save:((row:RecordItem)=>void)|null}{const{enabled,entities,team,saveRecord}=useDemo();return {mode:enabled?'demo':'unavailable',rows:entities[kind],team,save:enabled?row=>saveRecord(kind,row):null};}
// Customer 360 relation shapes: the minimum each future workspace-scoped service must return for a contact.
export interface ConversationSummary {id:string;channel:string;preview:string;time:string;}
export interface PaymentSummary {id:string;amount:number;status:string;date:string;}
export interface AppointmentSummary {id:string;title:string;day:number;time:string;duration:string;owner:string;}
export interface ActivityEntry {id:string;actor:string;action:string;time:string;}
export interface ContactRelations {opportunities:RecordItem[];conversations:ConversationSummary[];payments:PaymentSummary[];appointments:AppointmentSummary[];activity:ActivityEntry[];}
const noRelations:ContactRelations={opportunities:[],conversations:[],payments:[],appointments:[],activity:[]};
// Demo relations are matched by contact or company name only, so they are sample links, never verified relationships.
// Later: replace with contactService.getById plus contact_id-filtered conversation, payment, appointment and audit queries.
export function useContactDetail(id:string){const{mode,rows,team,save}=useCrmRecords('contacts');const{entities}=useDemo();const contact=rows.find(r=>r.id===id);const company=contact?entities.companies.find(c=>c.name===contact.company):undefined;const relations:ContactRelations=mode==='demo'&&contact?{opportunities:entities.opportunities.filter(r=>r.company===contact.company),conversations:demoMessages.filter(m=>m.name===contact.name),payments:demoPayments.filter(p=>p.name===contact.company),appointments:demoAppointments.filter(a=>a.contact===contact.name),activity:demoAudit.filter(a=>a.target===contact.name)}:noRelations;return {mode,contact,company,relations,team,save};}
export function toDemoRecord(values:CrmFormValues,record?:RecordItem):RecordItem{return {id:record?.id??`demo-${crypto.randomUUID()}`,name:values.name.trim(),email:values.email,company:values.company,owner:values.owner,status:values.status,source:values.source,value:record?.value??0,stage:record?.stage??'Discovery',created:record?.created??'2026-10-18',acknowledged:record?.acknowledged??false,...(record?.deadline?{deadline:record.deadline}:{})};}
// Typed mappers for the future service calls; company and owner ids must be resolved from workspace records first.
// Form status/source (contacts) and email/status (companies) are demo-only: crm_core.sql has no columns for them.
export function toContactInput(values:CrmFormValues,refs:{companyId:string|null;ownerId:string|null}):ContactInput{return {full_name:values.name.trim(),email:values.email||null,phone:null,title:null,company_id:refs.companyId,owner_id:refs.ownerId};}
export function toCompanyInput(values:CrmFormValues,refs:{ownerId:string|null}):CompanyInput{return {name:values.name.trim(),domain:null,industry:null,phone:null,owner_id:refs.ownerId};}
