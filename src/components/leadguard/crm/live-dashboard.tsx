import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getLiveDashboard, getDashboardDrilldown } from "@/services/crm-dashboard.functions";
import type { Metric } from "@/services/crm-dashboard.server";
import { PageHeading, Panel } from "../shared";
import { useCrmMode } from "./live-queries";
import { LiveUnavailable, QueryError } from "./live-crm-page";
import { formatValue } from "./opportunity-data";
function display<T>(m: Metric<T>, f: (value: T) => string) {
  return m.available ? f(m.value) : "Unavailable";
}
const sections = [
  "pipeline",
  "availability",
  "New leads today",
  "Open pipeline value by stage",
  "Average first acknowledgement",
  "Recovery queue",
  "Escalations (last 24 hours)",
  "Employee availability",
  "Upcoming appointments",
  "Collected this month less confirmed refunds",
] as const;
export function LiveDashboard() {
  const mode = useCrmMode();
  const preferenceKey = `leadguard-dashboard:${mode.workspaceId}:${mode.auth.user?.id}`;
  const [hidden, setHidden] = useState<string[]>([]);
  const [drill, setDrill] = useState<"today" | "recovery" | "escalations" | null>(null);
  const [drillPage, setDrillPage] = useState(1);
  useEffect(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? "[]");
      setHidden(
        Array.isArray(value)
          ? value.filter((x): x is string => typeof x === "string" && sections.some((s) => s === x))
          : [],
      );
    } catch {
      setHidden([]);
    }
  }, [preferenceKey]);
  const q = useQuery({
    queryKey: ["crm-dashboard", mode.workspaceId, mode.scope],
    enabled: mode.ready,
    queryFn: () => getLiveDashboard({ data: { workspaceId: mode.workspaceId! } }),
    refetchInterval: 30_000,
  });
  const details = useQuery({
    queryKey: [
      "crm-dashboard",
      mode.workspaceId,
      mode.scope,
      "drill",
      drill,
      drillPage,
      q.data?.asOf,
    ],
    enabled: mode.ready && !!drill && !!q.data,
    queryFn: () =>
      getDashboardDrilldown({
        data: { workspaceId: mode.workspaceId!, kind: drill!, page: drillPage, asOf: q.data!.asOf },
      }),
  });
  if (!mode.ready) return <LiveUnavailable />;
  if (q.isLoading) return <p role="status">Loading operational dashboard…</p>;
  if (q.error) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  if (!q.data) return null;
  const d = q.data;
  const metrics = [
    {
      name: "New leads today",
      metric: d.newLeads,
      value: display(d.newLeads, String),
      to: "/leads",
    },
    {
      name: "Open pipeline value by stage",
      metric: d.pipeline,
      value: display(d.pipeline, (v) => `${v.length} stage / currency groups`),
      to: "/pipeline",
    },
    {
      name: "Average first acknowledgement",
      metric: d.acknowledgement,
      value: display(d.acknowledgement, (v) =>
        v === null ? "No acknowledged leads" : `${Math.round(v)} seconds`,
      ),
      to: "/leads",
    },
    {
      name: "Recovery queue",
      metric: d.recovery,
      value: display(d.recovery, String),
      to: "/recovery",
    },
    {
      name: "Escalations (last 24 hours)",
      metric: d.escalations,
      value: display(d.escalations, String),
      to: "/recovery",
    },
    {
      name: "Employee availability",
      metric: d.availability,
      value: display(
        d.availability,
        (v) => `${v.filter((x) => x.eligible).length} available / ${v.length}`,
      ),
      to: "/availability",
    },
    {
      name: "Upcoming appointments",
      metric: d.appointments,
      value: display(d.appointments, String),
      to: "/appointments",
    },
    {
      name: "Collected this month less confirmed refunds",
      metric: d.payments,
      value: display(d.payments, String),
      to: "/payments",
    },
  ] as const;
  return (
    <>
      <PageHeading
        title="Operational dashboard"
        subtitle={`${d.scope === "personal" ? "Your records" : "Workspace records"} - Timezone: ${d.timezone} · Updated ${new Date(d.asOf).toLocaleTimeString()}`}
      >
        <Button variant="outline" onClick={() => void q.refetch()}>
          Refresh
        </Button>
      </PageHeading>
      <div className="metrics-grid">
        {metrics
          .filter((m) => !hidden.includes(m.name))
          .map((m) => (
            <article className="metric-card" key={m.name}>
              <h2 className="metric-label">{m.name}</h2>
              <strong className="text-xl">{m.value}</strong>
              {!m.metric.available && (
                <p className="text-xs text-muted-foreground">{m.metric.reason}</p>
              )}
              {["New leads today", "Recovery queue", "Escalations (last 24 hours)"].includes(
                m.name,
              ) ? (
                <Button
                  variant="link"
                  disabled={!m.metric.available}
                  onClick={() => {
                    setDrill(
                      m.name === "New leads today"
                        ? "today"
                        : m.name === "Recovery queue"
                          ? "recovery"
                          : "escalations",
                    );
                    setDrillPage(1);
                  }}
                >
                  View matching records
                </Button>
              ) : (
                <Button asChild variant="link">
                  <Link to={m.to}>View details</Link>
                </Button>
              )}
            </article>
          ))}
      </div>
      <details className="my-5 rounded border p-4">
        <summary>Dashboard preferences · saved on this device</summary>
        {sections.map((s) => (
          <label className="mr-5 inline-flex gap-2" key={s}>
            <input
              type="checkbox"
              checked={!hidden.includes(s)}
              onChange={(e) => {
                const next = e.target.checked ? hidden.filter((v) => v !== s) : [...hidden, s];
                setHidden(next);
                try {
                  localStorage.setItem(preferenceKey, JSON.stringify(next));
                } catch {
                  /* device storage unavailable */
                }
              }}
            />
            {s}
          </label>
        ))}
      </details>
      {!hidden.includes("pipeline") && (
        <Panel
          title="Open pipeline by stage"
          description="Separate totals and charts for every currency; no currency conversion."
        >
          {d.pipeline.available ? (
            d.pipeline.value.length ? (
              <>
                {Array.from(new Set(d.pipeline.value.map((v) => v.currency))).map((currency) => (
                  <div key={currency} className="p-5">
                    <h3>{currency}</h3>
                    <div className="h-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={
                            d.pipeline.available
                              ? d.pipeline.value
                                  .filter((v) => v.currency === currency)
                                  .map((v) => ({ ...v, label: `${v.pipeline} / ${v.stage}` }))
                              : []
                          }
                        >
                          <XAxis dataKey="label" />
                          <YAxis />
                          <Tooltip />
                          <Bar dataKey="amount" fill="var(--brand)" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ))}
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pipeline / stage</th>
                      <th>Count</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.pipeline.value.map((v) => (
                      <tr key={`${v.stageId}:${v.currency}`}>
                        <td>
                          {v.pipeline} / {v.stage}
                        </td>
                        <td>{v.count}</td>
                        <td>{formatValue(v.amount, v.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="p-5">No open opportunities.</p>
            )
          ) : (
            <p className="p-5">{d.pipeline.reason}</p>
          )}
        </Panel>
      )}
      {!hidden.includes("availability") && (
        <Panel
          title="Employee availability"
          description="Authoritative employee availability records"
        >
          {d.availability.available ? (
            <ul className="p-5">
              {d.availability.value.map((v) => (
                <li key={v.userId}>
                  Member {v.userId.slice(0, 8)} · {v.status} - {v.openLeads} open /{" "}
                  {v.capacity ?? "unknown"} capacity - {v.eligible ? "Eligible" : "Not eligible"}
                </li>
              ))}
              {!d.availability.value.length && <li>No availability records.</li>}
            </ul>
          ) : (
            <p className="p-5">{d.availability.reason}</p>
          )}
        </Panel>
      )}
      {drill && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setDrill(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogTitle>Matching {drill} records</DialogTitle>
            <DialogDescription>
              Filtered to the same workspace, role and time window as the dashboard. Recovery
              reflects the current queue.
            </DialogDescription>
            {details.isLoading ? (
              <p>Loading...</p>
            ) : details.error ? (
              <QueryError error={details.error} />
            ) : (
              <>
                <ul>
                  {details.data?.rows.map((r) => (
                    <li className="border-b py-3" key={r.id}>
                      <Link to="/leads/$id" params={{ id: r.leadId }}>
                        {r.label}
                      </Link>
                      <p>
                        {r.detail} - {r.time}
                      </p>
                    </li>
                  ))}
                  {details.data?.total === 0 && <li>No matching records.</li>}
                </ul>
                <p>{details.data?.total ?? 0} records</p>
                <div className="flex gap-3">
                  <Button disabled={drillPage <= 1} onClick={() => setDrillPage((v) => v - 1)}>
                    Previous
                  </Button>
                  <Button
                    disabled={drillPage * 20 >= (details.data?.total ?? 0)}
                    onClick={() => setDrillPage((v) => v + 1)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
