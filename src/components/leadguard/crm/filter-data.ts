import {useDemo} from '@/contexts/demo-context';
import type {FilterDefinition} from '@/types/domain';
import {createSavedFilter,deleteSavedFilter,updateSavedFilter} from './filter-rules';
import type {RuleResult} from './pipeline-rules';
type Done=RuleResult<null>;
const done:Done={ok:true,value:null};
// Saved-filter boundary. Demo mode keeps filters in DemoProvider for this browser session only; later each action maps to
// savedFilterService calls made by the signed-in user behind an authenticated server boundary.
export function useSavedFilters(){const{enabled,savedFilters,updateSavedFilters,pipelines}=useDemo();const unavailable:Done={ok:false,error:'Configuration required. Database services are not connected.'};
// Validates against the rendered snapshot for an immediate answer, then re-applies the rule to the latest list.
const commit=(rule:(list:typeof savedFilters)=>RuleResult<typeof savedFilters>):Done=>{if(!enabled)return unavailable;const r=rule(savedFilters);if(!r.ok)return r;updateSavedFilters(prev=>{const again=rule(prev);return again.ok?again.value:prev;});return done;};
return {mode:enabled?'demo' as const:'unavailable' as const,filters:savedFilters,
create:(name:string,def:FilterDefinition):RuleResult<string>=>{const id=`demo-filter-${crypto.randomUUID()}`;const r=commit(list=>createSavedFilter(list,name,def,pipelines,id));return r.ok?{ok:true,value:id}:r;},
update:(id:string,name:string,def:FilterDefinition)=>commit(list=>updateSavedFilter(list,id,name,def,pipelines)),
remove:(id:string)=>commit(list=>deleteSavedFilter(list,id))};}
