import type { Opportunity, OpportunityInput } from "@/types/domain";
import { createLiveCrmService } from "./crm-live-adapter";
// Value visibility must be enforced by an authenticated TanStack server boundary that returns amount:null for unauthorised roles.
export const opportunityService = createLiveCrmService<Opportunity, OpportunityInput>(
  "opportunities",
);
