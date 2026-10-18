import { createFileRoute } from "@tanstack/react-router";
import { DashboardEntry } from "@/components/leadguard/crm/crm-entry";
import { pageHead } from "@/lib/page-head";
export const Route = createFileRoute("/")({
  head: () =>
    pageHead(
      "Operational dashboard",
      "LeadGuard workspace overview, lead activity, pipeline and team availability.",
    ),
  component: DashboardEntry,
});
