import type {ServiceResult} from '@/types/domain';
import type {LeadService} from '@/types/leads';

// Typed unavailable adapter: no fixtures, no fake success. Replace each method with an
// authenticated TanStack server function that calls the reviewed SQL functions once
// Member 1's schema is applied (see docs/lead-automation/HANDOFF.md).
const unavailable = async <T,>(): Promise<ServiceResult<T>> => ({
  data: null,
  error: 'Configuration required: lead automation backend is not connected.',
});

export const leadService: LeadService = {
  createManual: () => unavailable(),
  captureIncomingLead: () => unavailable(),
  acknowledge: () => unavailable(),
  setAvailability: () => unavailable(),
  reassign: () => unavailable(),
  saveRules: () => unavailable(),
};
