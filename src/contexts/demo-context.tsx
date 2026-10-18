import {createContext,useContext,useState,type ReactNode} from 'react';
import {demoEntities,demoPipelines,demoTeam,demoWorkspace} from '@/data/demo';
import {getSupabaseConfiguration} from '@/lib/supabase';
import {moveOpportunity} from '@/lib/demo-rules';
import type {EntityKind,PipelineConfig,RecordItem,TeamMember,Workspace} from '@/types/domain';
interface DemoState {enabled:boolean;entities:Record<EntityKind,RecordItem[]>;team:TeamMember[];workspace:Workspace;setWorkspace:(w:Workspace)=>void;saveRecord:(kind:EntityKind,row:RecordItem)=>void;move:(id:string,stage:string,stages:string[])=>void;setAvailability:(id:string,value:TeamMember['availability'])=>void;pipelines:PipelineConfig[];updatePipelines:(fn:(prev:PipelineConfig[])=>PipelineConfig[])=>void;}
const DemoContext=createContext<DemoState|null>(null);
const noPipelines:PipelineConfig[]=[];
export function DemoProvider({children}:{children:ReactNode}){const[entities,setEntities]=useState(demoEntities);const[team,setTeam]=useState(demoTeam);const[workspace,setWorkspace]=useState(demoWorkspace);const[pipelines,setPipelines]=useState(demoPipelines);const enabled=getSupabaseConfiguration().demoMode;const saveRecord=(kind:EntityKind,row:RecordItem)=>setEntities(prev=>({...prev,[kind]:prev[kind].some(r=>r.id===row.id)?prev[kind].map(r=>r.id===row.id?row:r):[row,...prev[kind]]}));return <DemoContext.Provider value={{enabled,entities:enabled?entities:{leads:[],contacts:[],companies:[],opportunities:[]},team:enabled?team:[],workspace,setWorkspace,saveRecord,move:(id,stage,stages)=>setEntities(prev=>({...prev,opportunities:moveOpportunity(prev.opportunities,id,stage,stages)})),setAvailability:(id,availability)=>setTeam(prev=>prev.map(r=>r.id===id?{...r,availability}:r)),pipelines:enabled?pipelines:noPipelines,updatePipelines:setPipelines}}>{children}</DemoContext.Provider>;}
export function useDemo(){const state=useContext(DemoContext);if(!state)throw new Error('DemoProvider is required.');return state;}
