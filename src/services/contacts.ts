import type {Contact} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
export const contactService=createUnavailableCrmService<Contact>('contact');
