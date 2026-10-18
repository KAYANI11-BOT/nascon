import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getContactActivity } from "@/services/crm-live.functions";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PageHeading, Panel, EmptyState } from "../shared";
import { useCrmMode, useCrmReferences, useLiveRecord, useLiveRecords } from "./live-queries";
import { LiveRecordEditor, LiveUnavailable, QueryError } from "./live-crm-page";
import { formatValue } from "./opportunity-data";

export function LiveContactDetail({ id }: { id: string }) {
  const mode = useCrmMode();
  const q = useLiveRecord("contacts", id);
  const refs = useCrmReferences();
  const [edit, setEdit] = useState(false);
  const [page, setPage] = useState(1);
  const opportunities = useLiveRecords({
    entity: "opportunities",
    contactId: id,
    page,
    pageSize: 20,
  });
  const companyQuery = useLiveRecord("companies", q.data?.company_id ?? "");
  const [activityPage, setActivityPage] = useState(1);
  const activity = useQuery({
    queryKey: ["crm", mode.workspaceId, mode.scope, "activity", id, activityPage],
    enabled: mode.ready && mode.auth.can("audit.view"),
    queryFn: () =>
      getContactActivity({
        data: { workspaceId: mode.workspaceId!, contactId: id, page: activityPage },
      }),
    refetchInterval: 30_000,
  });
  if (!mode.ready) return <LiveUnavailable />;
  if (q.isLoading) return <p role="status">Loading contact…</p>;
  if (q.error) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  if (!q.data) return <EmptyState title="Contact not found" />;
  const c = q.data;
  const company = companyQuery.data;
  const owner = refs.data?.members.find((x) => x.id === c.owner_id);
  return (
    <>
      <Button asChild variant="link">
        <Link to="/contacts">Back to contacts</Link>
      </Button>
      <PageHeading
        title={c.full_name ?? "Contact"}
        subtitle="Customer 360 · linked by workspace and contact ID"
      >
        <Button
          disabled={!refs.data || !mode.auth.can("contacts.manage")}
          onClick={() => setEdit(true)}
        >
          Edit contact
        </Button>
      </PageHeading>
      {refs.error && <QueryError error={refs.error} />}
      <div className="detail-grid">
        <Panel title="Contact information">
          <dl className="description-list">
            <dt>Email</dt>
            <dd>{c.email || "Not set"}</dd>
            <dt>Phone</dt>
            <dd>{c.phone || "Not set"}</dd>
            <dt>Job title</dt>
            <dd>{c.title || "Not set"}</dd>
            <dt>Assigned employee</dt>
            <dd>{owner?.name ?? (c.owner_id ? "Member" : "Unassigned")}</dd>
            <dt>Created</dt>
            <dd>{c.created_at}</dd>
          </dl>
        </Panel>
        <Panel title="Company">
          <p className="p-5">
            {company?.name ??
              (c.company_id ? "Linked company not in reference page" : "No company linked")}
          </p>
        </Panel>
      </div>
      <Panel
        title="Related opportunities"
        description="Only records whose contact_id matches this contact"
      >
        {opportunities.isLoading ? (
          <p>Loading…</p>
        ) : opportunities.error ? (
          <QueryError error={opportunities.error} />
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Stage</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.data?.rows.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td>{refs.data?.stages.find((s) => s.id === o.stage_id)?.name ?? "Stage"}</td>
                    <td>{formatValue(o.amount ?? null, o.currency ?? "USD")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!opportunities.data?.rows.length && <p className="p-5">No linked opportunities.</p>}
            <div className="flex gap-3 p-4">
              <Button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
                Previous
              </Button>
              <Button
                disabled={page * 20 >= (opportunities.data?.total ?? 0)}
                onClick={() => setPage((v) => v + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Panel>
      {companyQuery.error && <QueryError error={companyQuery.error} />}
      <Panel
        title="Activity timeline"
        description="Persisted contact audit events; related-module history is not inferred"
      >
        {!mode.auth.can("audit.view") ? (
          <p className="p-5">Audit viewing permission required.</p>
        ) : activity.isLoading ? (
          <p>Loading activity…</p>
        ) : activity.error ? (
          <QueryError error={activity.error} />
        ) : (
          <>
            <ul className="p-5">
              {activity.data?.rows.map((a) => (
                <li key={a.id}>
                  {a.action} · {a.created_at} ·{" "}
                  {refs.data?.members.find((m) => m.id === a.actor_id)?.name ?? "System or member"}
                </li>
              ))}
              {activity.data?.total === 0 && <li>No recorded contact activity.</li>}
            </ul>
            <div className="p-4 flex gap-3">
              <Button disabled={activityPage <= 1} onClick={() => setActivityPage((v) => v - 1)}>
                Previous activity
              </Button>
              <Button
                disabled={activityPage * 20 >= (activity.data?.total ?? 0)}
                onClick={() => setActivityPage((v) => v + 1)}
              >
                Next activity
              </Button>
            </div>
          </>
        )}
      </Panel>
      {["Conversations", "Payments", "Appointments", "Notes"].map((title) => (
        <Panel key={title} title={title} description="Unavailable">
          <p className="p-5">
            The approved contact-linked source or secure query contract is unavailable. No sample
            history is shown.
          </p>
        </Panel>
      ))}
      {edit && refs.data && (
        <LiveRecordEditor
          entity="contacts"
          record={c}
          refs={refs.data}
          onClose={() => setEdit(false)}
        />
      )}
    </>
  );
}
