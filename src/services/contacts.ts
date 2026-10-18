import type {Contact,ContactInput} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
export const contactService=createUnavailableCrmService<Contact,ContactInput>('contact');
