import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCrmActivity } from "@/services/crm-live.functions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Panel } from "../shared";
import { useCrmMode } from "./live-queries";

export function OpportunityHistoryDialog({
  id,
  name,
  onClose,
}: {
  id: string;
  name: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>Opportunity history from the approved audit log.</DialogDescription>
        <LiveCrmActivity key={id} entity="opportunities" id={id} />
      </DialogContent>
    </Dialog>
  );
}

export function LiveCrmActivity({
  entity,
  id,
}: {
  entity: "contacts" | "opportunities";
  id: string;
}) {
  const mode = useCrmMode();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["crm", mode.workspaceId, mode.scope, "activity", entity, id, page],
    enabled: mode.ready && !mode.demo && mode.auth.can("audit.view"),
    queryFn: () => getCrmActivity({ data: { workspaceId: mode.workspaceId!, entity, id, page } }),
    refetchInterval: 30_000,
  });
  const timezone = mode.auth.activeWorkspace?.workspace.timezone ?? "UTC";
  return (
    <Panel title="Activity timeline" description="Recorded changes from the workspace audit log">
      {!mode.auth.can("audit.view") ? (
        <p className="p-5">Audit viewing permission required.</p>
      ) : q.isLoading ? (
        <p role="status" className="p-5">
          Loading activity...
        </p>
      ) : q.error ? (
        <div role="alert" className="p-5">
          <p>{q.error.message}</p>
          <Button variant="outline" onClick={() => void q.refetch()}>
            Retry activity
          </Button>
        </div>
      ) : (
        <>
          {q.isFetching && (
            <p role="status" className="p-5">
              Refreshing activity; displayed entries are from the previous load.
            </p>
          )}
          <ol className="p-5 space-y-3">
            {q.data?.rows.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.action}</strong>
                <p>
                  {entry.actorName}
                  {entry.actorId && (
                    <span className="text-xs text-muted-foreground"> ({entry.actorId})</span>
                  )}
                </p>
                <time dateTime={entry.createdAt}>
                  {new Intl.DateTimeFormat("en-GB", {
                    timeZone: timezone,
                    dateStyle: "medium",
                    timeStyle: "long",
                  }).format(new Date(entry.createdAt))}{" "}
                  ({timezone})
                </time>
              </li>
            ))}
          </ol>
          {q.data?.total === 0 && <p className="p-5">No recorded activity for this record.</p>}
          <div className="p-4 flex gap-3">
            <Button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
              Previous activity
            </Button>
            <Button
              disabled={page * 20 >= (q.data?.total ?? 0)}
              onClick={() => setPage((v) => v + 1)}
            >
              Next activity
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
