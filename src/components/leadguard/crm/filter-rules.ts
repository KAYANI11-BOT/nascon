import type {CustomFieldConfig,FilterCondition,FilterConditionKind,FilterCustomOperator,FilterDefinition,PipelineConfig,SavedFilterConfig} from '@/types/domain';
import type {OpportunityView} from './opportunity-data';
import type {RuleResult} from './pipeline-rules';
// Pure filter rules. They run in the browser to narrow a list and to give fast feedback; they are not access control.
// Conditions are always combined with AND. Money values are deliberately not filterable so restricted amounts cannot leak.
export const maxConditions=10;
export const conditionKindLabels:Record<FilterConditionKind,string>={stage:'Stage',owner:'Assigned to',date:'Date',custom:'Custom field'};
export const customOperatorLabels:Record<FilterCustomOperator,string>={equals:'is',contains:'contains',gt:'greater than',lt:'less than'};
const fail=(error:string):{ok:false;error:string}=>({ok:false,error});
const isIsoDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v));
const num=(v:string)=>v.trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
export function operatorsFor(type:CustomFieldConfig['type']):FilterCustomOperator[]{return type==='text'?['equals','contains']:type==='number'||type==='date'?['equals','gt','lt']:['equals'];}
function scopeStages(scope:string,pipelines:PipelineConfig[]){return (scope==='all'?pipelines:pipelines.filter(p=>p.id===scope)).flatMap(p=>p.stages.map(s=>s.name));}
export function scopeName(scope:string,pipelines:PipelineConfig[]){return scope==='all'?'all pipelines':pipelines.find(p=>p.id===scope)?.name??'this pipeline';}
/** Problems with one condition; an empty list means it can be applied. */
export function conditionErrors(c:FilterCondition,scope:string,pipelines:PipelineConfig[]):string[]{
  if(c.kind==='stage'){if(!c.value)return ['Choose a stage.'];return scopeStages(scope,pipelines).includes(c.value)?[]:[`“${c.value}” is not a stage of ${scopeName(scope,pipelines)}.`];}
  if(c.kind==='owner')return c.value.trim()?[]:['Choose an employee.'];
  if(c.kind==='date'){if(!isIsoDate(c.value))return ['Enter a valid date.'];if(c.operator==='between'){if(!c.valueTo||!isIsoDate(c.valueTo))return ['Enter a valid end date.'];if(c.valueTo<c.value)return ['The end date must not be before the start date.'];}return [];}
  const pipeline=pipelines.find(p=>p.id===c.pipelineId);if(!pipeline)return ['Choose a pipeline for this custom field.'];
  if(scope!=='all'&&c.pipelineId!==scope)return [`${pipeline.name} fields cannot be used in a filter limited to ${scopeName(scope,pipelines)}.`];
  const field=pipeline.fields.find(f=>f.key===c.fieldKey);if(!field)return [`Choose a ${pipeline.name} field.`];
  if(!operatorsFor(field.type).includes(c.operator))return [`${field.label} cannot be filtered with “${customOperatorLabels[c.operator]}”.`];
  const v=c.value.trim();if(!v)return [`Enter a value for ${field.label}.`];
  if(field.type==='number'&&num(v)===null)return [`${field.label} must be a number.`];
  if(field.type==='date'&&!isIsoDate(v))return [`${field.label} must be a valid date.`];
  if(field.type==='select'&&!field.options?.includes(v))return [`${field.label} must be one of: ${(field.options??[]).join(', ')}.`];
  if(field.type==='checkbox'&&v!=='true'&&v!=='false')return [`${field.label} must be checked or unchecked.`];
  return [];}
export function validateDefinition(def:FilterDefinition,pipelines:PipelineConfig[]):string[]{
  if(def.pipelineId!=='all'&&!pipelines.some(p=>p.id===def.pipelineId))return ['The selected pipeline no longer exists.'];
  if(!def.conditions.length)return ['Add at least one condition before saving.'];
  if(def.conditions.length>maxConditions)return [`A filter can have at most ${maxConditions} conditions.`];
  return def.conditions.flatMap((c,i)=>conditionErrors(c,def.pipelineId,pipelines).map(e=>`Condition ${i+1}: ${e}`));}
export function validateName(name:string,existing:{id:string;name:string}[],exceptId?:string){const n=name.trim();if(!n)return 'Enter a name for this filter.';if(n.length>80)return 'Filter names can be at most 80 characters.';if(existing.some(f=>f.id!==exceptId&&f.name.toLowerCase()===n.toLowerCase()))return `A saved filter named “${n}” already exists.`;return '';}
/** Conditions that are complete and valid; incomplete rows are ignored while the user is still building the filter. */
export function activeConditions(def:FilterDefinition,pipelines:PipelineConfig[]){return def.conditions.filter(c=>conditionErrors(c,def.pipelineId,pipelines).length===0);}
function compare(a:string,b:string){const x=num(a),y=num(b);return x!==null&&y!==null?x-y:a<b?-1:a>b?1:0;}
function conditionMatches(c:FilterCondition,row:OpportunityView){
  if(c.kind==='stage')return row.stage===c.value;
  if(c.kind==='owner')return row.owner===c.value;
  if(c.kind==='date'){const d=(c.dateField==='created'?row.created:row.closeDate).slice(0,10);if(!d)return false;return c.operator==='before'?d<c.value:c.operator==='after'?d>c.value:c.operator==='on'?d===c.value:d>=c.value&&d<=(c.valueTo??c.value);}
  // Custom values belong to one pipeline, so an opportunity from any other pipeline can never match.
  if(row.pipelineId!==c.pipelineId)return false;
  const raw=(row.customFields[c.fieldKey]??'').trim();const want=c.value.trim();
  if(want==='false'&&c.operator==='equals')return raw===''||raw==='false';
  if(raw==='')return false;
  if(c.operator==='contains')return raw.toLowerCase().includes(want.toLowerCase());
  if(c.operator==='equals'){const x=num(raw),y=num(want);return x!==null&&y!==null?x===y:raw.toLowerCase()===want.toLowerCase();}
  return c.operator==='gt'?compare(raw,want)>0:compare(raw,want)<0;}
/** True when the opportunity is in the filter's pipeline scope and satisfies every condition (AND). */
export function matchesFilter(def:FilterDefinition,row:OpportunityView){return (def.pipelineId==='all'||row.pipelineId===def.pipelineId)&&def.conditions.every(c=>conditionMatches(c,row));}
export function newCondition(kind:FilterConditionKind,scope:string,pipelines:PipelineConfig[],id:string):FilterCondition{
  if(kind==='stage')return {id,kind,value:''};
  if(kind==='owner')return {id,kind,value:''};
  if(kind==='date')return {id,kind,dateField:'closeDate',operator:'before',value:''};
  const pipeline=scope!=='all'?pipelines.find(p=>p.id===scope):pipelines.find(p=>p.fields.length>0);
  return {id,kind,pipelineId:pipeline?.id??'',fieldKey:pipeline?.fields[0]?.key??'',operator:'equals',value:''};}
// --- Saved filter list operations: each returns the next list or the reason it was refused. ---
function clean(def:FilterDefinition):FilterDefinition{return {pipelineId:def.pipelineId,conditions:def.conditions.map(c=>({...c}))};}
function check(name:string,def:FilterDefinition,list:SavedFilterConfig[],pipelines:PipelineConfig[],exceptId?:string){const nameError=validateName(name,list,exceptId);if(nameError)return nameError;return validateDefinition(def,pipelines)[0]??'';}
export function createSavedFilter(list:SavedFilterConfig[],name:string,def:FilterDefinition,pipelines:PipelineConfig[],id:string):RuleResult<SavedFilterConfig[]>{const error=check(name,def,list,pipelines);if(error)return fail(error);return {ok:true,value:[...list,{id,name:name.trim(),...clean(def)}]};}
export function updateSavedFilter(list:SavedFilterConfig[],id:string,name:string,def:FilterDefinition,pipelines:PipelineConfig[]):RuleResult<SavedFilterConfig[]>{if(!list.some(f=>f.id===id))return fail('Saved filter not found.');const error=check(name,def,list,pipelines,id);if(error)return fail(error);return {ok:true,value:list.map(f=>f.id===id?{id,name:name.trim(),...clean(def)}:f)};}
export function deleteSavedFilter(list:SavedFilterConfig[],id:string):RuleResult<SavedFilterConfig[]>{if(!list.some(f=>f.id===id))return fail('Saved filter not found.');return {ok:true,value:list.filter(f=>f.id!==id)};}
