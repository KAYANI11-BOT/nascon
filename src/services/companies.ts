import type {Company} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
export const companyService=createUnavailableCrmService<Company>('company');
