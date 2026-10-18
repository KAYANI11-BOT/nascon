import { createFileRoute } from "@tanstack/react-router";
import { ContactEntry } from "@/components/leadguard/crm/crm-entry";
import { pageHead } from "@/lib/page-head";
export const Route = createFileRoute("/contacts_/$id")({
  head: () => pageHead("Contacts details", "Relationship information and activity in LeadGuard."),
  component: Page,
});
function Page() {
  const { id } = Route.useParams();
  return <ContactEntry id={id} />;
}
