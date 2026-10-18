import {useDemo} from '@/contexts/demo-context';
import type {PipelineConfig} from '@/types/domain';
import {pipelineIdOf} from './opportunity-data';
import {addPipeline,addStage,planStageDeletion,renameStage,reorderStage,statusForStage,type RuleResult} from './pipeline-rules';
type Done=RuleResult<null>;
const done:Done={ok:true,value:null};
// Pipeline configuration boundary. Demo mode edits session-only DemoProvider state and keeps opportunities in sync;
// later each action maps to pipelineService / pipelineStageService calls behind an authenticated server boundary.
export function usePipelineManager(){const{enabled,pipelines,updatePipelines,entities,saveRecord}=useDemo();const unavailable:Done={ok:false,error:'Configuration required. Database services are not connected.'};const find=(id:string)=>pipelines.find(p=>p.id===id);const replace=(next:PipelineConfig)=>updatePipelines(prev=>prev.map(p=>p.id===next.id?next:p));const inStage=(pipelineId:string,stage:string)=>entities.opportunities.filter(r=>pipelineIdOf(r,pipelines)===pipelineId&&r.stage===stage);const apply=<T,>(result:RuleResult<T>,effect:(v:T)=>void):Done=>{if(!result.ok)return result;effect(result.value);return done;};const withPipeline=(id:string,fn:(p:PipelineConfig)=>Done):Done=>{if(!enabled)return unavailable;const p=find(id);return p?fn(p):{ok:false,error:'Pipeline not found.'};};return {mode:enabled?'demo' as const:'unavailable' as const,pipelines,countInStage:(pipelineId:string,stage:string)=>inStage(pipelineId,stage).length,
createPipeline:(name:string):RuleResult<string>=>{if(!enabled)return unavailable;const r=addPipeline(pipelines,name,`demo-pipeline-${crypto.randomUUID()}`);if(!r.ok)return r;updatePipelines(prev=>[...prev,r.value]);return {ok:true,value:r.value.id};},
addStage:(pipelineId:string,name:string)=>withPipeline(pipelineId,p=>apply(addStage(p,name,`demo-stage-${crypto.randomUUID()}`),replace)),
reorderStage:(pipelineId:string,stageId:string,direction:-1|1)=>withPipeline(pipelineId,p=>apply(reorderStage(p,stageId,direction),replace)),
// Renaming keeps opportunities attached: demo records store the stage name, so matching records are renamed too.
renameStage:(pipelineId:string,stageId:string,name:string)=>withPipeline(pipelineId,p=>apply(renameStage(p,stageId,name),({pipeline,from,to})=>{replace(pipeline);if(from!==to)inStage(pipelineId,from).forEach(r=>saveRecord('opportunities',{...r,stage:to}));})),
deleteStage:(pipelineId:string,stageId:string,moveToId?:string)=>withPipeline(pipelineId,p=>{const stage=p.stages.find(s=>s.id===stageId);const rows=stage?inStage(pipelineId,stage.name):[];return apply(planStageDeletion(p,stageId,rows.length,moveToId),({pipeline,moveTo})=>{if(moveTo)rows.forEach(r=>saveRecord('opportunities',{...r,stage:moveTo.name,status:statusForStage(moveTo.type)}));replace(pipeline);});})};}
