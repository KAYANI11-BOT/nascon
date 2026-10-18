import type {Company,CompanyInput} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
export const companyService=createUnavailableCrmService<Company,CompanyInput>('company');
