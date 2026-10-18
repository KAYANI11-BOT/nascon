import {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import {ChevronLeft, ChevronRight, Plus, Search} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {countdownState} from '@/lib/lead-engine';
import {Avatar, EmptyState, ErrorState, LoadingState, PageHeading, Status} from './shared';
import {fmtUtc, sourceLabel} from './lead-format';
import {formatRemaining} from './acknowledgement-countdown';
import {useCreateLead, useLeadList, useLeadRealtime, useLiveWorkspace, useNames, useNow} from './lead-queries';
import type {Lead, LeadStatus} from '@/types/leads';

const PAGE_SIZE = 10;
const STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'recovery', 'escalated', 'converted', 'lost'];
const STATUS_LABEL = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Renders the live, database-backed page when signed in with a workspace; otherwise the demo page. */
export function LeadsRoute({fallback}: {fallback: ReactNode}) {
  const {live} = useLiveWorkspace();
  return live ? <LiveLeadsPage /> : <>{fallback}</>;
}

export function AckCell({lead, now}: {lead: Pick<Lead, 'acknowledgedAt' | 'acknowledgementDeadline' | 'assignedTo' | 'ownershipException'>; now: Date}) {
  if (lead.ownershipException) return <Status>Escalated</Status>;
  if (!lead.assignedTo) return <Status>Unassigned</Status>;
  const {state, remainingSeconds} = countdownState(lead, now, null);
  if (state === 'acknowledged') return <Status>Acknowledged</Status>;
  if (state === 'overdue') return <Status>Overdue</Status>;
  return <span className="flex items-center gap-2"><Status>Unacknowledged</Status><span className="text-xs text-muted-foreground">{remainingSeconds !== null ? `${formatRemaining(remainingSeconds)} left` : ''}</span></span>;
}

function LiveLeadsPage() {
  const {workspaceId, can} = useLiveWorkspace();
  const realtime = useLeadRealtime(workspaceId);
  const names = useNames(workspaceId);
  const now = useNow();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);

  const query = useLeadList(workspaceId, {page, pageSize: PAGE_SIZE, ...(debounced ? {search: debounced} : {}), ...(status ? {status} : {})});
  const total = query.data?.total ?? 0;
  const rows = query.data?.rows ?? [];
  const awaiting = rows.filter((l) => l.assignedTo && !l.acknowledgedAt).length;

  return (
    <>
      <PageHeading title="Leads" subtitle="Every opportunity starts with a conversation. Make it count.">
        <span className="text-xs text-muted-foreground" role="status">{realtime === 'live' ? 'Live updates on' : realtime === 'connecting' ? 'Connecting…' : 'Reconnecting — refreshing every 15s'}</span>
        {can('leads.manage') && <Button onClick={() => setOpen(true)}><Plus />Add lead</Button>}
      </PageHeading>
      <div className="entity-summary">
        <div><span>Total leads</span><strong>{total}</strong></div>
        <div><span>Awaiting acknowledgement · this page</span><strong>{awaiting}</strong></div>
        <div><span>Page</span><strong>{page}</strong></div>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <div className="search-field"><Search size={17} /><Input aria-label="Search leads" placeholder="Search leads..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <select aria-label="Filter status" value={status} onChange={(e) => { setStatus(e.target.value as LeadStatus | ''); setPage(1); }}>
            <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL(s)}</option>)}
          </select>
        </div>
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState message={query.error.message} onRetry={() => { void query.refetch(); }} /> : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Source</th><th>Status</th><th>Assigned to</th><th>Acknowledgement</th><th>Deadline (UTC)</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td><div className="flex items-center gap-3"><Avatar name={l.name} /><div><Link className="table-name" to="/leads/$id" params={{id: l.id}}>{l.name}</Link><span className="table-subtext">{l.email ?? l.phone ?? ''}</span></div></div></td>
                    <td>{sourceLabel(l.source)}</td>
                    <td><Status>{STATUS_LABEL(l.status)}</Status></td>
                    <td>{l.assignedTo ? <div className="flex items-center gap-2"><Avatar name={names(l.assignedTo)} className="avatar-small" /><span>{names(l.assignedTo)}</span></div> : <span className="text-muted-foreground">Unassigned</span>}</td>
                    <td><AckCell lead={l} now={now} /></td>
                    <td className="text-xs">{l.acknowledgedAt ? '—' : fmtUtc(l.acknowledgementDeadline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <EmptyState title="No leads yet" description={debounced || status ? 'No leads match these filters.' : 'New leads from the web form, manual entry or messaging will appear here.'} />}
          </div>
        )}
        <div className="table-footer">
          <span>Showing {rows.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{(page - 1) * PAGE_SIZE + rows.length} of {total} leads</span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft />Previous</Button>
            <Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Next<ChevronRight /></Button>
          </div>
        </div>
      </section>
      {workspaceId && <AddLeadDialog workspaceId={workspaceId} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

function AddLeadDialog({workspaceId, open, onClose}: {workspaceId: string; open: boolean; onClose: () => void}) {
  const create = useCreateLead(workspaceId);
  const names = useNames(workspaceId);
  // One key per dialog "session": a double click or network retry reuses it, so it cannot create two leads.
  const idempotencyKey = useRef(crypto.randomUUID());
  const [error, setError] = useState('');
  const [savedTo, setSavedTo] = useState<string | null>(null);

  function close() { setError(''); setSavedTo(null); create.reset(); onClose(); }
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (create.isPending) return;
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    const email = String(f.get('email') ?? '').trim();
    if (name.length < 1) { setError('Enter the lead’s name.'); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email address.'); return; }
    setError('');
    try {
      const lead = await create.mutateAsync({name, ...(email ? {email} : {}), phone: String(f.get('phone') ?? '').trim(), company: String(f.get('company') ?? '').trim(), message: String(f.get('message') ?? '').trim(), idempotencyKey: idempotencyKey.current});
      idempotencyKey.current = crypto.randomUUID();
      setSavedTo(lead.assignedTo ? `Saved and assigned to ${names(lead.assignedTo)}.` : lead.ownershipException ? 'Saved, but no eligible owner was available. A manager has been alerted.' : 'Saved. This workspace uses manual assignment, so the lead is waiting for an owner.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The lead could not be saved.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Add lead</DialogTitle><DialogDescription>The lead is saved to the database and assigned automatically when assignment rules are active.</DialogDescription></DialogHeader>
        {savedTo ? (
          <div className="space-y-4"><p role="status" className="text-sm">{savedTo}</p><Button onClick={close}>Done</Button></div>
        ) : (
          <form className="space-y-4" onSubmit={onSubmit}>
            <label className="field-label">Name<Input name="name" autoFocus required maxLength={200} /></label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="field-label">Email<Input name="email" type="email" maxLength={320} /></label>
              <label className="field-label">Phone<Input name="phone" type="tel" maxLength={40} /></label>
              <label className="field-label sm:col-span-2">Company<Input name="company" maxLength={200} /></label>
            </div>
            <label className="field-label">Notes<textarea name="message" rows={3} maxLength={2000} /></label>
            <p className="text-xs text-muted-foreground">Source: Manual entry</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Add lead'}</Button></div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
