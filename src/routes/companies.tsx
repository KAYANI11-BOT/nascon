import { createFileRoute } from "@tanstack/react-router";
import { CompaniesEntry } from "@/components/leadguard/crm/crm-entry";
import { pageHead } from "@/lib/page-head";
export const Route = createFileRoute("/companies")({
  head: () => pageHead("Companies", "Explore company relationships in your LeadGuard workspace."),
  component: Page,
});
function Page() {
  return <CompaniesEntry />;
}
