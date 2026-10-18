import { createFileRoute } from "@tanstack/react-router";
import { OpportunitiesEntry } from "@/components/leadguard/crm/crm-entry";
import { pageHead } from "@/lib/page-head";
export const Route = createFileRoute("/opportunities")({
  head: () =>
    pageHead("Opportunities", "Track the value and progress of your sales opportunities."),
  component: Page,
});
function Page() {
  return <OpportunitiesEntry />;
}
