import type { Contact, ContactInput } from "@/types/domain";
import { createLiveCrmService } from "./crm-live-adapter";
export const contactService = createLiveCrmService<Contact, ContactInput>("contacts");
