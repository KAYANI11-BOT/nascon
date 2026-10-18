import { OpportunityHistoryDialog } from "./live-activity";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeading, Panel } from "../shared";
import { LiveCrmPage, LiveUnavailable, QueryError, ReferenceSelect } from "./live-crm-page";
import { useCrmMode, useCrmMutation, useCrmReferences, useLiveRecords } from "./live-queries";
import { formatValue } from "./opportunity-data";

export function LivePipeline() {
  const mode = useCrmMode();
  const refs = useCrmReferences();
  const mutation = useCrmMutation();
  const [tab, setTab] = useState("board");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<{ id: string; name: string } | null>(null);
  const pipelineId =
    selected ||
    refs.data?.pipelines.find((p) => p.is_default)?.id ||
    refs.data?.pipelines[0]?.id ||
    "";
  const q = useLiveRecords({
    entity: "opportunities",
    ...(pipelineId ? { pipelineId } : {}),
    page,
    pageSize: 60,
  });
  useEffect(() => {
    if (refs.isSuccess && selected && !refs.data.pipelines.some((p) => p.id === selected)) {
      setSelected("");
      setPage(1);
    }
  }, [refs.isSuccess, refs.data, selected]);
  useEffect(() => {
    if (q.isSuccess) setPage((p) => Math.min(p, Math.max(1, Math.ceil(q.data.total / 60))));
  }, [q.isSuccess, q.data?.total]);
  if (!mode.ready) return <LiveUnavailable />;
  return (
    <>
      <PageHeading
        title="Sales pipeline"
        subtitle="Workspace stages and opportunities share the same persisted records."
      />
      {history && (
        <OpportunityHistoryDialog
          id={history.id}
          name={history.name}
          onClose={() => setHistory(null)}
        />
      )}
      <nav className="flex gap-2 mb-5">
        {["board", "pipelines", "stages"].map((t) => (
          <Button key={t} variant={t === tab ? "default" : "outline"} onClick={() => setTab(t)}>
            {t}
          </Button>
        ))}
      </nav>
      {tab === "pipelines" ? (
        <LiveCrmPage entity="pipelines" />
      ) : tab === "stages" ? (
        <>
          <LiveCrmPage entity="pipeline_stages" />
          <p className="p-4 text-sm">
            Atomic reorder and move-and-delete await Member 1’s transaction RPCs. Renaming and
            adding stages are available.
          </p>
        </>
      ) : (
        <>
          <ReferenceSelect
            label="Selected pipeline"
            name="pipeline"
            options={refs.data?.pipelines ?? []}
            value={pipelineId}
            onChange={(v) => {
              setSelected(v);
              setPage(1);
            }}
          />
          {refs.error && <QueryError error={refs.error} />}
          {q.error && <QueryError error={q.error} />}
          {mutation.error && <QueryError error={mutation.error} />}
          {q.isLoading && <p role="status">Loading pipeline…</p>}
          {(q.isFetching || refs.isFetching) && (
            <p role="status">Refreshing pipeline; displayed cards are from the previous load.</p>
          )}
          <p className="my-3 text-sm">
            {q.data?.total ?? 0} opportunities · Page {page}. Card amounts are individual records;
            dashboard totals aggregate all open records.
          </p>
          <div className="flex gap-4 overflow-x-auto">
            {!q.isError &&
              !refs.isError &&
              refs.data?.stages
                .filter((s) => s.pipeline_id === pipelineId)
                .map((stage) => (
                  <div key={stage.id} className="min-w-64 flex-1">
                    <Panel title={stage.name} description={stage.stage_type}>
                      {q.data?.rows
                        .filter((r) => r.stage_id === stage.id)
                        .map((r) => (
                          <article className="m-3 rounded border p-3 space-y-2" key={r.id}>
                            <h3>{r.name}</h3>
                            <Button
                              variant="link"
                              onClick={() =>
                                setHistory({ id: r.id, name: r.name ?? "Opportunity" })
                              }
                            >
                              History
                            </Button>
                            <p>{formatValue(r.amount ?? null, r.currency ?? "USD")}</p>
                            <select
                              aria-label={`Move ${r.name}`}
                              value={r.stage_id}
                              disabled={
                                mutation.isPending || !mode.auth.can("opportunities.manage")
                              }
                              onChange={async (e) => {
                                try {
                                  await mutation.mutateAsync({
                                    entity: "opportunities",
                                    action: "update",
                                    id: r.id,
                                    ...(r.updated_at ? { expectedUpdatedAt: r.updated_at } : {}),
                                    values: { stage_id: e.target.value },
                                  });
                                } catch {
                                  /* server error shown */
                                }
                              }}
                            >
                              {refs.data?.stages
                                .filter((s) => s.pipeline_id === pipelineId)
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                            </select>
                          </article>
                        ))}
                    </Panel>
                  </div>
                ))}
          </div>
          <div className="my-4 flex gap-3">
            <Button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
              Previous
            </Button>
            <Button
              disabled={page * 60 >= (q.data?.total ?? 0)}
              onClick={() => setPage((v) => v + 1)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </>
  );
}
