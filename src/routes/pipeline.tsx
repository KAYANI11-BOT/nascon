import { createFileRoute } from "@tanstack/react-router";
import { PipelineEntry } from "@/components/leadguard/crm/crm-entry";
import { pageHead } from "@/lib/page-head";
export const Route = createFileRoute("/pipeline")({
  head: () =>
    pageHead("Sales pipeline", "A visual sales pipeline from discovery to closed opportunities."),
  component: Page,
});
function Page() {
  return <PipelineEntry />;
}
