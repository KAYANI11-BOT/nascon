import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, PageHeading, Panel } from "../shared";
import {
  canReadMoney,
  type CrmReferences,
  type LiveEntity,
  type LiveRow,
} from "@/services/crm-live.contracts";
import { useCrmMode, useCrmMutation, useCrmReferences, useLiveRecords } from "./live-queries";
import { formatValue } from "./opportunity-data";

const titles = {
  contacts: "Contacts",
  companies: "Companies",
  opportunities: "Opportunities",
  pipelines: "Pipelines",
  pipeline_stages: "Stages",
};
export function LiveUnavailable() {
  return (
    <EmptyState
      title="CRM unavailable"
      description="Configure Supabase, sign in and select a workspace. Demo records are not used in backend mode."
    />
  );
}
export function QueryError({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div role="alert" className="rounded border p-4">
      <p>{error.message}</p>
      {retry && (
        <Button variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
export function ReferenceSelect({
  label,
  name,
  options,
  value,
  defaultValue,
  required = false,
  onChange,
}: {
  label: string;
  name: string;
  options: { id: string; name: string }[];
  value?: string;
  defaultValue?: string;
  required?: boolean;
  onChange?: (v: string) => void;
}) {
  return (
    <label className="field-label">
      {label}
      <select
        name={name}
        required={required}
        {...(value !== undefined ? { value } : { defaultValue: defaultValue ?? "" })}
        onChange={(e) => onChange?.(e.target.value)}
      >
        <option value="">{required ? "Choose…" : "None"}</option>
        {(defaultValue && !options.some((o) => o.id === defaultValue)
          ? [
              ...options,
              { id: defaultValue, name: "Current linked record (not in reference page)" },
            ]
          : options
        ).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LiveRecordEditor({
  entity,
  record,
  refs,
  onClose,
}: {
  entity: LiveEntity;
  record?: LiveRow;
  refs: CrmReferences;
  onClose: () => void;
}) {
  const mutation = useCrmMutation();
  const { auth } = useCrmMode();
  const [pipelineId, setPipelineId] = useState(record?.pipeline_id ?? refs.pipelines[0]?.id ?? "");
  const [stageId, setStageId] = useState(record?.stage_id ?? "");
  const stages = refs.stages.filter((s) => s.pipeline_id === pipelineId);
  const money = canReadMoney(auth);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const val = (key: string) => String(form.get(key) ?? "").trim();
    const nullable = (key: string) => val(key) || null;
    let values: Record<string, unknown>;
    if (entity === "contacts")
      values = {
        full_name: val("name"),
        email: nullable("email"),
        phone: nullable("phone"),
        title: nullable("title"),
        company_id: nullable("company_id"),
        owner_id: nullable("owner_id"),
      };
    else if (entity === "companies")
      values = {
        name: val("name"),
        domain: nullable("domain"),
        industry: nullable("industry"),
        phone: nullable("phone"),
        owner_id: nullable("owner_id"),
      };
    else if (entity === "opportunities")
      values = {
        name: val("name"),
        pipeline_id: pipelineId,
        stage_id: stageId,
        company_id: nullable("company_id"),
        contact_id: nullable("contact_id"),
        owner_id: nullable("owner_id"),
        ...(money ? { amount: Number(val("amount")) } : {}),
        ...(!record || money ? { currency: val("currency") } : {}),
        expected_close_date: nullable("expected_close_date"),
      };
    else if (entity === "pipelines") values = { name: val("name") };
    else
      values = record
        ? { name: val("name") }
        : {
            name: val("name"),
            pipeline_id: pipelineId,
            position: Number(val("position")),
            stage_type: val("stage_type"),
          };
    try {
      await mutation.mutateAsync({
        entity,
        action: record ? "update" : "create",
        ...(record ? { id: record.id } : {}),
        values,
      });
      onClose();
    } catch {
      /* mutation error rendered below */
    }
  }
  const field = (label: string, name: string, value = "", type = "text", required = false) => (
    <label className="field-label">
      {label}
      <Input
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        {...(type === "number" ? { min: 0, step: name === "amount" ? "0.01" : "1" } : {})}
      />
    </label>
  );
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !mutation.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {record ? "Edit" : "Add"} {titles[entity]}
          </DialogTitle>
          <DialogDescription>
            Changes are saved to your active workspace after server validation.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {field("Name", "name", record?.full_name ?? record?.name ?? "", "text", true)}
          {entity === "contacts" && (
            <>
              {field("Email", "email", record?.email ?? "", "email")}
              {field("Job title", "title", record?.title ?? "")}
            </>
          )}
          {entity === "companies" && (
            <>
              {field("Domain", "domain", record?.domain ?? "")}
              {field("Industry", "industry", record?.industry ?? "")}
            </>
          )}
          {["contacts", "companies"].includes(entity) &&
            field("Phone", "phone", record?.phone ?? "", "tel")}
          {["contacts", "opportunities"].includes(entity) && (
            <ReferenceSelect
              label="Company"
              name="company_id"
              defaultValue={record?.company_id ?? ""}
              options={refs.companies.map((c) => ({ id: c.id, name: c.name }))}
              key={`company-${record?.id ?? "new"}`}
            />
          )}
          {entity === "opportunities" && (
            <>
              <ReferenceSelect
                label="Contact"
                name="contact_id"
                defaultValue={record?.contact_id ?? ""}
                options={refs.contacts.map((c) => ({ id: c.id, name: c.full_name }))}
              />
              <ReferenceSelect
                label="Pipeline"
                name="pipeline_id"
                options={refs.pipelines}
                value={pipelineId}
                required
                onChange={(v) => {
                  setPipelineId(v);
                  setStageId("");
                }}
              />
              <ReferenceSelect
                label="Stage"
                name="stage_id"
                options={stages}
                value={stageId}
                required
                onChange={setStageId}
              />
              {money ? (
                field("Amount", "amount", String(record?.amount ?? 0), "number", true)
              ) : (
                <p>Amount restricted; existing amount is preserved.</p>
              )}
              {!record || money ? (
                field("Currency (ISO code)", "currency", record?.currency ?? "USD", "text", true)
              ) : (
                <p>Currency: {record.currency} (restricted)</p>
              )}
              {field(
                "Expected close",
                "expected_close_date",
                record?.expected_close_date ?? "",
                "date",
              )}
              <p className="text-xs text-muted-foreground">
                Custom values require Member 1’s approved schema and enforcement.
              </p>
            </>
          )}
          {entity === "pipeline_stages" && !record && (
            <>
              <ReferenceSelect
                label="Pipeline"
                name="pipeline_id"
                options={refs.pipelines}
                value={pipelineId}
                required
                onChange={setPipelineId}
              />
              {field(
                "Position",
                "position",
                String(Math.max(-1, ...stages.map((s) => s.position)) + 1),
                "number",
                true,
              )}
              <label className="field-label">
                Type
                <select name="stage_type">
                  <option value="open">Open</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
              </label>
            </>
          )}
          {["contacts", "companies", "opportunities"].includes(entity) && (
            <ReferenceSelect
              label="Assigned employee"
              name="owner_id"
              defaultValue={record?.owner_id ?? ""}
              options={refs.members}
            />
          )}
          {mutation.error && <QueryError error={mutation.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LiveCrmPage({
  entity,
  initialCompanyId,
}: {
  entity: LiveEntity;
  initialCompanyId?: string;
}) {
  const mode = useCrmMode();
  const refs = useCrmReferences();
  const mutation = useCrmMutation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [ownerId, setOwnerId] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [status, setStatus] = useState<"open" | "won" | "lost" | "">("");
  const [sort, setSort] = useState<"newest" | "name" | "close" | "amount">("newest");
  const [closeFrom, setCloseFrom] = useState("");
  const [closeTo, setCloseTo] = useState("");
  const [relatedCompany, setRelatedCompany] = useState<string | null>(null);
  const [editor, setEditor] = useState<LiveRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<LiveRow | null>(null);
  const result = useLiveRecords({
    entity,
    page,
    pageSize: 20,
    search,
    sort,
    ...(closeFrom ? { closeFrom } : {}),
    ...(closeTo ? { closeTo } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(pipelineId ? { pipelineId } : {}),
    ...(stageId ? { stageId } : {}),
    ...(status ? { status } : {}),
    ...(initialCompanyId ? { companyId: initialCompanyId } : {}),
  });
  useEffect(() => {
    setPage(1);
    setEditor(null);
    setDeleting(null);
    setRelatedCompany(null);
  }, [mode.workspaceId]);
  const permission = entity === "pipeline_stages" ? "pipelines.manage" : `${entity}.manage`;
  const canWrite = mode.auth.permissions.some((p) => p === permission);
  const canDelete = canWrite && mode.auth.can("records.delete") && entity !== "pipeline_stages";
  if (!mode.ready) return <LiveUnavailable />;
  const names = (id: string | null | undefined, items: { id: string; name: string }[]) =>
    items.find((x) => x.id === id)?.name ?? (id ? "Related record" : "Unassigned");
  return (
    <>
      <PageHeading title={titles[entity]} subtitle="Workspace records · refreshes every 30 seconds">
        <Button
          variant="outline"
          onClick={() => {
            void result.refetch();
            void refs.refetch();
          }}
        >
          Refresh
        </Button>
        <Button disabled={!canWrite || !refs.data} onClick={() => setEditor("new")}>
          Add record
        </Button>
      </PageHeading>
      {refs.error && <QueryError error={refs.error} retry={() => void refs.refetch()} />}
      {refs.data?.truncated && (
        <p role="status">
          Some reference options are omitted (1,000 record limit). Refine data before linking an
          omitted record.
        </p>
      )}
      <section className="panel">
        <div className="table-toolbar flex flex-wrap gap-3">
          <Input
            aria-label={`Search ${entity}`}
            placeholder="Search by name"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          {["contacts", "companies", "opportunities"].includes(entity) && (
            <ReferenceSelect
              label="Employee"
              name="owner"
              value={ownerId}
              options={refs.data?.members ?? []}
              onChange={(v) => {
                setOwnerId(v);
                setPage(1);
              }}
            />
          )}
          {["opportunities", "pipeline_stages"].includes(entity) && (
            <ReferenceSelect
              label="Pipeline"
              name="pipeline"
              value={pipelineId}
              options={refs.data?.pipelines ?? []}
              onChange={(v) => {
                setPipelineId(v);
                setStageId("");
                setPage(1);
              }}
            />
          )}
          {entity === "opportunities" && (
            <>
              <ReferenceSelect
                label="Stage"
                name="stage"
                value={stageId}
                options={(refs.data?.stages ?? []).filter(
                  (s) => !pipelineId || s.pipeline_id === pipelineId,
                )}
                onChange={(v) => {
                  setStageId(v);
                  setPage(1);
                }}
              />
              <select
                aria-label="Status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as typeof status);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                <option>open</option>
                <option>won</option>
                <option>lost</option>
              </select>
            </>
          )}
          {entity === "opportunities" && (
            <>
              <label className="field-label">
                Closing from
                <Input
                  aria-label="Closing from"
                  type="date"
                  value={closeFrom}
                  onChange={(e) => {
                    setCloseFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label className="field-label">
                Closing to
                <Input
                  aria-label="Closing to"
                  type="date"
                  value={closeTo}
                  onChange={(e) => {
                    setCloseTo(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
            </>
          )}
          <select
            aria-label="Sort"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as typeof sort);
              setPage(1);
            }}
          >
            <option value="newest">Newest first</option>
            <option value="name">Name</option>
            {entity === "opportunities" && (
              <>
                <option value="close">Closing date</option>
                {canReadMoney(mode.auth) && <option value="amount">Amount</option>}
              </>
            )}
          </select>
        </div>
        {result.isLoading ? (
          <p role="status" className="p-5">
            Loading records…
          </p>
        ) : result.error ? (
          <QueryError error={result.error} retry={() => void result.refetch()} />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Details</th>
                    <th>Assigned to</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data?.rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {entity === "contacts" ? (
                          <Link to="/contacts/$id" params={{ id: r.id }}>
                            {r.full_name}
                          </Link>
                        ) : (
                          r.name
                        )}
                      </td>
                      <td>
                        {entity === "contacts" ? (
                          <>
                            {r.email || "No email"} ·{" "}
                            {names(r.company_id, refs.data?.companies ?? [])}
                          </>
                        ) : entity === "opportunities" ? (
                          <>
                            {names(r.stage_id, refs.data?.stages ?? [])} · {r.status} ·{" "}
                            {formatValue(r.amount ?? null, r.currency ?? "USD")} ·{" "}
                            {r.expected_close_date || "No close date"}
                          </>
                        ) : entity === "companies" ? (
                          <>
                            {r.domain || r.industry || "—"}
                            <Button variant="link" onClick={() => setRelatedCompany(r.id)}>
                              Related contacts
                            </Button>
                          </>
                        ) : entity === "pipeline_stages" ? (
                          <>
                            {r.stage_type} · Position {r.position}
                          </>
                        ) : (
                          "Pipeline"
                        )}{" "}
                      </td>
                      <td>{names(r.owner_id, refs.data?.members ?? [])}</td>
                      <td>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            disabled={!canWrite || !refs.data}
                            onClick={() => setEditor(r)}
                          >
                            Edit
                          </Button>
                          {canDelete && (
                            <Button variant="outline" onClick={() => setDeleting(r)}>
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.data?.rows.length && (
              <EmptyState
                title="No matching records"
                description="Create a record or change the filters."
              />
            )}
            <div className="table-footer">
              <span>
                {result.data?.total ?? 0} records · Page {page}
              </span>
              <div className="flex gap-2">
                <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  disabled={page * 20 >= (result.data?.total ?? 0)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
      {editor && refs.data && (
        <LiveRecordEditor
          key={typeof editor === "string" ? editor : editor.id}
          entity={entity}
          {...(editor === "new" ? {} : { record: editor })}
          refs={refs.data}
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v && !mutation.isPending) setDeleting(null);
          }}
        >
          <DialogContent>
            <DialogTitle>Delete {deleting.full_name ?? deleting.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the record. Linked records follow the database’s approved
              constraints.
            </DialogDescription>
            {mutation.error && <QueryError error={mutation.error} />}
            <Button
              disabled={mutation.isPending}
              onClick={async () => {
                try {
                  await mutation.mutateAsync({ entity, action: "delete", id: deleting.id });
                  setDeleting(null);
                } catch {
                  /* error shown */
                }
              }}
            >
              Confirm deletion
            </Button>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {entity === "companies" && relatedCompany && (
        <Panel title="Related contacts" description="Linked by company ID">
          <RelatedContacts companyId={relatedCompany} />
        </Panel>
      )}
    </>
  );
}
function RelatedContacts({ companyId }: { companyId: string }) {
  const q = useLiveRecords({ entity: "contacts", companyId, pageSize: 100 });
  return q.isLoading ? (
    <p>Loading contacts…</p>
  ) : q.error ? (
    <QueryError error={q.error} />
  ) : (
    <ul className="p-4">
      {q.data?.rows.map((c) => (
        <li key={c.id}>
          <Link to="/contacts/$id" params={{ id: c.id }}>
            {c.full_name}
          </Link>
        </li>
      ))}
      {q.data?.total === 0 && <li>No linked contacts.</li>}
      {(q.data?.total ?? 0) > 100 && <li>Showing first 100 of {q.data?.total} contacts.</li>}
    </ul>
  );
}
