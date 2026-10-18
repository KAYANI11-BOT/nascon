import type {Opportunity} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
// Value visibility must be enforced by an authenticated TanStack server boundary that returns value:null for unauthorised roles.
export const opportunityService=createUnavailableCrmService<Opportunity>('opportunity');
