import {useState, type ReactNode} from 'react';
import {ShieldCheck} from 'lucide-react';
import {Avatar, EmptyState, ErrorState, LoadingState, PageHeading, Panel, Status} from './shared';
import {useLeadRealtime, useLiveWorkspace, useSetAvailability, useTeam} from './lead-queries';
import type {AvailabilityStatus} from '@/types/leads';
import {AVAILABILITY_LABELS, AVAILABILITY_STATUSES} from '@/types/leads';

export function AvailabilityRoute({fallback}: {fallback: ReactNode}) {
  const {live} = useLiveWorkspace();
  return live ? <LiveAvailabilityPage /> : <>{fallback}</>;
}

function LiveAvailabilityPage() {
  const {workspaceId, userId, can} = useLiveWorkspace();
  useLeadRealtime(workspaceId);
  const team = useTeam(workspaceId);
  const set = useSetAvailability(workspaceId);
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const manageOthers = can('availability.manage_others');
  const rows = team.data ?? [];

  async function change(userId: string, name: string, status: AvailabilityStatus) {
    setMessage(null); setPendingUser(userId);
    try {
      await set.mutateAsync({userId, status});
      const absent = status === 'on_leave' || status === 'offline' || status === 'away';
      setMessage({kind: 'ok', text: absent ? `${name} is now ${AVAILABILITY_LABELS[status]}. Their unacknowledged leads were reassigned immediately.` : `${name} is now ${AVAILABILITY_LABELS[status]}.`});
    } catch (e) {
      setMessage({kind: 'error', text: e instanceof Error ? e.message : 'Availability could not be saved.'});
    } finally { setPendingUser(null); }
  }

  return (
    <>
      <PageHeading title="Employee availability" subtitle="A balanced team. A faster first response." />
      <div className="entity-summary">
        <div><span>Total members</span><strong>{rows.length}</strong></div>
        <div><span>Available now</span><strong>{rows.filter((t) => t.status === 'available').length}</strong></div>
        <div><span>Open leads</span><strong>{rows.reduce((a, t) => a + t.openLeads, 0)}</strong></div>
      </div>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mb-3 text-sm ${message.kind === 'error' ? 'text-destructive' : 'text-success'}`}>{message.text}</p>}
      <Panel title="Availability overview" description="Only Available employees receive new automatic assignments. On leave or Offline reassigns their unacknowledged leads at once; acknowledged leads follow the workspace policy.">
        {team.isPending ? <LoadingState /> : team.isError ? <ErrorState message={team.error.message} onRetry={() => { void team.refetch(); }} /> : rows.length === 0 ? <EmptyState title="No team members" description="Invite teammates to start distributing leads." /> : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Team member</th><th>Availability</th><th>Open leads</th><th>Lead limit</th><th>Update availability</th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const editable = t.userId === userId || manageOthers;
                  const options: AvailabilityStatus[] = t.status === 'away' ? [...AVAILABILITY_STATUSES, 'away'] : [...AVAILABILITY_STATUSES];
                  return (
                    <tr key={t.userId}>
                      <td><div className="flex items-center gap-3"><Avatar name={t.name} /><strong>{t.name}</strong>{t.userId === userId && <span className="table-subtext">You</span>}</div></td>
                      <td><Status>{AVAILABILITY_LABELS[t.status]}</Status></td>
                      <td>{t.openLeads}</td>
                      <td>{t.maxOpenLeads ?? 'Workspace default'}</td>
                      <td>
                        {editable ? (
                          <select aria-label={`${t.name} availability`} value={t.status} disabled={pendingUser === t.userId} onChange={(e) => { void change(t.userId, t.name, e.target.value as AvailabilityStatus); }}>
                            {options.map((s) => <option key={s} value={s}>{AVAILABILITY_LABELS[s]}</option>)}
                          </select>
                        ) : <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck size={14} />Managers only</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
