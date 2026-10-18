import type {Pipeline,PipelineCustomField,PipelineCustomFieldInput,PipelineInput,PipelineStage,PipelineStageInput,PipelineStageRequiredField,PipelineStageRequiredFieldInput} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
export const pipelineService=createUnavailableCrmService<Pipeline,PipelineInput>('pipeline');
// Stage deletion is also blocked by the database: opportunities reference stages without ON DELETE, so move them first.
export const pipelineStageService=createUnavailableCrmService<PipelineStage,PipelineStageInput>('pipeline stage');
// Proposed table (not in crm_core.sql yet); kept typed so the UI contract is ready once Member 1 adds it.
export const pipelineFieldService=createUnavailableCrmService<PipelineCustomField,PipelineCustomFieldInput>('pipeline custom field');
// Proposed join table: required fields per stage. The server must reject stage moves that miss these values.
export const stageRequirementService=createUnavailableCrmService<PipelineStageRequiredField,PipelineStageRequiredFieldInput>('stage requirement');
