import type { Company, CompanyInput } from "@/types/domain";
import { createLiveCrmService } from "./crm-live-adapter";
export const companyService = createLiveCrmService<Company, CompanyInput>("companies");
