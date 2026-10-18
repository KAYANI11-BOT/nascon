import {useState, type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import {ArrowUpRight, ChevronLeft, ChevronRight, Clock} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Avatar, EmptyState, ErrorState, LoadingState, PageHeading, Panel, Status} from './shared';
import {fmtAge, fmtUtc, sourceLabel} from './lead-format';
import {useLeadRealtime, useLiveWorkspace, useNames, useNow, useReassign, useRecoveryQueue, useResolveRecovery, useTeam} from './lead-queries';
import type {LeadStatus, RecoveryItem, RecoveryReason} from '@/types/leads';
import {LEAD_SOURCES, RECOVERY_REASON_LABELS} from '@/types/leads';

const PAGE_SIZE = 10;
const REASONS = Object.keys(RECOVERY_REASON_LABELS) as RecoveryReason[];
const STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'recovery', 'escalated'];

export function RecoveryRoute({fallback}: {fallback: ReactNode}) {
  const {live} = useLiveWorkspace();
  return live ? <LiveRecoveryPage /> : <>{fallback}</>;
}

function LiveRecoveryPage() {
  const {workspaceId, can} = useLiveWorkspace();
  useLeadRealtime(workspaceId);
  const names = useNames(workspaceId);
  const team = useTeam(workspaceId);
  const now = useNow(5000);
  const [page, setPage] = useState(1);
  const [reason, setReason] = useState<RecoveryReason | ''>('');
  const [owner, setOwner] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const query = useRecoveryQueue(workspaceId, {page, pageSize: PAGE_SIZE, ...(reason ? {reason} : {}), ...(owner ? {ownerId: owner} : {}), ...(source ? {source} : {}), ...(status ? {status} : {})});
  const reassign = useReassign(workspaceId);
  const resolve = useResolveRecovery(workspaceId);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const total = query.data?.total ?? 0;
  const rows = query.data?.rows ?? [];
  const reset = (fn: () => void) => { fn(); setPage(1); };

  async function onReassign(item: RecoveryItem, version: number) {
    const to = targets[item.leadId];
    if (!to) return;
    setMessage(null);
    try { await reassign.mutateAsync({leadId: item.leadId, toUserId: to, version}); setMessage({kind: 'ok', text: `${item.name} reassigned to ${names(to)}.`}); }
    catch (e) { setMessage({kind: 'error', text: e instanceof Error ? e.message : 'Could not reassign.'}); }
  }
  async function onResolve(item: RecoveryItem) {
    setMessage(null);
    try { await resolve.mutateAsync(item.leadId); setMessage({kind: 'ok', text: `${item.name} resolved and removed from the queue.`}); }
    catch (e) { setMessage({kind: 'error', text: e instanceof Error ? e.message : 'Could not resolve.'}); }
  }

  return (
    <>
      <PageHeading title="Recovery queue" subtitle="Give every missed opportunity a second chance." />
      <div className="recovery-banner"><span className="empty-icon"><Clock /></span><div><h3>{total} {total === 1 ? 'lead needs' : 'leads need'} attention</h3><p>Computed by the database from deadlines, escalation history and recorded activity.</p></div></div>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mb-3 text-sm ${message.kind === 'error' ? 'text-destructive' : 'text-success'}`}>{message.text}</p>}
      <Panel title="At-risk leads" description="A lead leaves the queue only when its conditions clear or a manager resolves it.">
        <div className="flex flex-wrap gap-3 border-b px-5 py-3">
          <select aria-label="Filter reason" value={reason} onChange={(e) => reset(() => setReason(e.target.value as RecoveryReason | ''))}><option value="">All reasons</option>{REASONS.map((r) => <option key={r} value={r}>{RECOVERY_REASON_LABELS[r]}</option>)}</select>
          <select aria-label="Filter owner" value={owner} onChange={(e) => reset(() => setOwner(e.target.value))}><option value="">All owners</option>{(team.data ?? []).map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select>
          <select aria-label="Filter source" value={source} onChange={(e) => reset(() => setSource(e.target.value))}><option value="">All sources</option>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}</select>
          <select aria-label="Filter status" value={status} onChange={(e) => reset(() => setStatus(e.target.value as LeadStatus | ''))}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}</select>
        </div>
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState message={query.error.message} onRetry={() => { void query.refetch(); }} /> : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Lead</th><th>Source</th><th>Owner</th><th>Status</th><th>Age</th><th>Acknowledgement</th><th>Escalations</th><th>Reason</th><th>Last action</th><th>Deadline (UTC)</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.leadId}>
                    <td><Link className="table-name" to="/leads/$id" params={{id: r.leadId}}>{r.name}</Link>{r.needsManagerReview && <span className="table-subtext">Manager review</span>}</td>
                    <td>{sourceLabel(r.source)}</td>
                    <td>{r.assignedTo ? <div className="flex items-center gap-2"><Avatar name={names(r.assignedTo)} className="avatar-small" />{names(r.assignedTo)}</div> : <span className="text-muted-foreground">Unassigned</span>}</td>
                    <td><Status>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</Status></td>
                    <td>{fmtAge(r.createdAt, now)}</td>
                    <td><Status>{r.acknowledged ? 'Acknowledged' : r.assignedTo ? 'Unacknowledged' : 'Unassigned'}</Status></td>
                    <td>{r.escalationLevel}{r.escalationsSinceReview !== r.escalationLevel ? ` (${r.escalationsSinceReview} since review)` : ''}</td>
                    <td><div className="flex flex-col gap-1">{r.reasons.map((x) => <span key={x} className="text-xs">{RECOVERY_REASON_LABELS[x]}</span>)}</div></td>
                    <td className="text-xs">{r.lastActionAt ? `${fmtAge(r.lastActionAt, now)} ago` : 'None recorded'}</td>
                    <td className="text-xs">{r.acknowledged ? '—' : fmtUtc(r.deadline)}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" asChild><Link to="/leads/$id" params={{id: r.leadId}}>Open<ArrowUpRight /></Link></Button>
                        {can('leads.assign') && (
                          <>
                            <select aria-label={`Reassign ${r.name}`} value={targets[r.leadId] ?? ''} onChange={(e) => setTargets((t) => ({...t, [r.leadId]: e.target.value}))}>
                              <option value="">Reassign to…</option>{(team.data ?? []).filter((t) => t.userId !== r.assignedTo).map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}
                            </select>
                            <Button size="sm" variant="outline" disabled={!targets[r.leadId] || reassign.isPending} onClick={() => { void onReassign(r, r.version); }}>Reassign</Button>
                            {r.acknowledged && r.assignedTo && <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => { void onResolve(r); }}>Resolve</Button>}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <EmptyState title="All caught up" description="No leads currently meet a recovery condition." />}
          </div>
        )}
        <div className="table-footer">
          <span>Showing {rows.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{(page - 1) * PAGE_SIZE + rows.length} of {total}</span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft />Previous</Button>
            <Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Next<ChevronRight /></Button>
          </div>
        </div>
      </Panel>
    </>
  );
}
