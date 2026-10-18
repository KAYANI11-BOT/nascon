import { Dashboard } from "../dashboard";
import { ContactsPage } from "./contacts-page";
import { CompaniesPage } from "./companies-page";
import { ContactDetailPage } from "./contact-detail-page";
import { OpportunitiesPage } from "./opportunities-page";
import { PipelinePage } from "./pipeline-page";
import { useCrmMode } from "./live-queries";
import { LiveCrmPage } from "./live-crm-page";
import { LiveContactDetail } from "./live-contact-detail";
import { LivePipeline } from "./live-pipeline";
import { LiveDashboard } from "./live-dashboard";

export function ContactsEntry() {
  return useCrmMode().demo ? <ContactsPage /> : <LiveCrmPage entity="contacts" />;
}
export function CompaniesEntry() {
  return useCrmMode().demo ? <CompaniesPage /> : <LiveCrmPage entity="companies" />;
}
export function ContactEntry({ id }: { id: string }) {
  return useCrmMode().demo ? <ContactDetailPage id={id} /> : <LiveContactDetail id={id} />;
}
export function OpportunitiesEntry() {
  return useCrmMode().demo ? (
    <OpportunitiesPage />
  ) : (
    <>
      <LiveCrmPage entity="opportunities" />
      <p className="my-4 text-sm">
        Persistent Saved Filters and custom fields await Member 1’s approved tables and server
        validation contracts. Use the workspace search, employee, pipeline, stage and status filters
        above.
      </p>
    </>
  );
}
export function PipelineEntry() {
  return useCrmMode().demo ? <PipelinePage /> : <LivePipeline />;
}
export function DashboardEntry() {
  return useCrmMode().demo ? <Dashboard /> : <LiveDashboard />;
}
