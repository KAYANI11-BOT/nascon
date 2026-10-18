import {useRef, useState, type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import {ArrowLeft, CheckCircle2, CircleAlert, Clock, Plus, ArrowUpRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {firstResponseSeconds} from '@/lib/lead-engine';
import {AcknowledgementCountdown} from './acknowledgement-countdown';
import {Avatar, EmptyState, ErrorState, LoadingState, PageHeading, Panel, Status} from './shared';
import {ackText, fmtDuration, fmtUtc, reasonText, sourceLabel} from './lead-format';
import {useAcknowledge, useLeadDetail, useLeadRealtime, useLiveWorkspace, useNames, useReassign, useRecordAction, useTeam} from './lead-queries';
import type {QualifyingAction} from '@/types/leads';

const ACTION_LABELS: Record<QualifyingAction, string> = {
  note_added: 'Note added', call_recorded: 'Call recorded', message_sent: 'Message sent', stage_changed: 'Stage changed', appointment_scheduled: 'Appointment scheduled',
};
// Manual producers offered on this page. Messages, stage changes and appointments are recorded by their own modules.
const MANUAL_ACTIONS: QualifyingAction[] = ['note_added', 'call_recorded'];

export function LeadDetailRoute({id, fallback}: {id: string; fallback: ReactNode}) {
  const {live} = useLiveWorkspace();
  return live ? <LiveLeadDetail id={id} /> : <>{fallback}</>;
}

function LiveLeadDetail({id}: {id: string}) {
  const {workspaceId, userId, can} = useLiveWorkspace();
  useLeadRealtime(workspaceId);
  const names = useNames(workspaceId);
  const team = useTeam(workspaceId);
  const detail = useLeadDetail(workspaceId, id);
  const ack = useAcknowledge(workspaceId);
  const reassign = useReassign(workspaceId);
  const record = useRecordAction(workspaceId);
  // One key per form submission: a double click or retry reuses it, so the action is recorded once.
  const actionKey = useRef(crypto.randomUUID());
  const [actionType, setActionType] = useState<QualifyingAction>('note_added');
  const [actionNote, setActionNote] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) {
    return /not found/i.test(detail.error.message)
      ? <EmptyState title="Lead not found" description="It may have been deleted, or it belongs to another workspace." />
      : <ErrorState message={detail.error.message} onRetry={() => { void detail.refetch(); }} />;
  }
  const {lead, assignments, escalations, actions} = detail.data;
  const isOwner = lead.assignedTo !== null && lead.assignedTo === userId;
  const canAcknowledge = lead.assignedTo !== null && lead.currentAssignmentId !== null && lead.acknowledgedAt === null && (isOwner || can('leads.assign'));
  const response = firstResponseSeconds(lead);

  async function onAcknowledge() {
    if (!lead.currentAssignmentId) return;
    setMessage(null);
    try {
      const r = await ack.mutateAsync({leadId: lead.id, assignmentId: lead.currentAssignmentId});
      setMessage({kind: 'ok', text: r.code === 'already_applied' ? 'This assignment was already acknowledged.' : 'Acknowledged. The deadline no longer applies.'});
    } catch (e) {
      setMessage({kind: 'error', text: e instanceof Error ? e.message : 'Could not acknowledge.'});
    }
  }
  async function onRecord() {
    if (record.isPending) return;
    if (actionType === 'note_added' && actionNote.trim().length === 0) { setMessage({kind: 'error', text: 'Write a note before saving it.'}); return; }
    setMessage(null);
    try {
      const r = await record.mutateAsync({leadId: lead.id, action: actionType, dedupeKey: actionKey.current, ...(actionNote.trim() ? {note: actionNote.trim()} : {})});
      actionKey.current = crypto.randomUUID();
      setActionNote('');
      setMessage({kind: 'ok', text: r.acknowledged ? 'Activity recorded. As the owner, this acknowledged the lead.' : 'Activity recorded.'});
    } catch (e) {
      setMessage({kind: 'error', text: e instanceof Error ? e.message : 'The activity could not be recorded.'});
    }
  }
  async function onReassign() {
    if (!target) return;
    setMessage(null);
    try {
      await reassign.mutateAsync({leadId: lead.id, toUserId: target, version: lead.version});
      setMessage({kind: 'ok', text: `Reassigned to ${names(target)}. The new owner has a fresh deadline.`});
      setTarget('');
    } catch (e) {
      setMessage({kind: 'error', text: e instanceof Error ? e.message : 'Could not reassign.'});
    }
  }

  return (
    <>
      <Button variant="ghost" asChild className="mb-5 -ml-3"><Link to="/leads"><ArrowLeft />Back to leads</Link></Button>
      <PageHeading title={lead.name} subtitle={`${lead.company ?? 'Lead'} · ${sourceLabel(lead.source)}`}>
        {canAcknowledge && <Button onClick={() => { void onAcknowledge(); }} disabled={ack.isPending}><CheckCircle2 />{ack.isPending ? 'Acknowledging…' : 'Acknowledge'}</Button>}
      </PageHeading>

      {lead.ownershipException && (
        <div className="configuration-notice" role="alert"><CircleAlert size={16} /><span>Accountable ownership could not be established: no eligible employee, backup or manager was available. A manager has been alerted and must assign this lead.</span></div>
      )}
      {lead.needsManagerReview && !lead.ownershipException && (
        <div className="configuration-notice" role="status"><CircleAlert size={16} /><span>Flagged for manager review (for example, the owner became unavailable after acknowledging, or escalation was exhausted).</span></div>
      )}
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-destructive' : 'text-success'}`}>{message.text}</p>}

      <div className="detail-grid">
        <Panel title="Acknowledgement" description="The server deadline is the source of truth; this countdown is display only.">
          <div className="p-5">
            {lead.assignedTo
              ? <AcknowledgementCountdown lead={lead} ownerName={names(lead.assignedTo)} />
              : <p className="text-sm text-muted-foreground">No current owner.</p>}
            {lead.acknowledgedAt && <p className="mt-3 text-xs text-muted-foreground">Acknowledged {fmtUtc(lead.acknowledgedAt)}</p>}
            {response !== null && <p className="mt-1 text-xs text-muted-foreground">Time to first response: {fmtDuration(response)} (first assignment to first acknowledgement)</p>}
            {lead.escalationLevel > 0 && <p className="mt-1 text-xs text-muted-foreground">Escalation level {lead.escalationLevel}</p>}
          </div>
        </Panel>
        <Panel title="Lead details">
          <dl className="description-list">
            <dt>Email</dt><dd>{lead.email ?? '—'}</dd>
            <dt>Phone</dt><dd>{lead.phone ?? '—'}</dd>
            <dt>Source</dt><dd>{sourceLabel(lead.source)}</dd>
            <dt>Status</dt><dd><Status>{lead.status.charAt(0).toUpperCase() + lead.status.slice(1)}</Status></dd>
            <dt>Current owner</dt><dd>{names(lead.assignedTo)}</dd>
            <dt>Created</dt><dd>{fmtUtc(lead.createdAt)}</dd>
            {lead.message && <><dt>Message</dt><dd className="whitespace-pre-wrap">{lead.message}</dd></>}
          </dl>
        </Panel>
      </div>

      <Panel title="Activity" description="Recorded actions count as a response: when the current owner logs one, the lead is acknowledged.">
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label="Activity type" value={actionType} onChange={(e) => setActionType(e.target.value as QualifyingAction)}>
              {MANUAL_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
            </select>
          </div>
          <textarea aria-label="Activity note" rows={3} maxLength={2000} className="w-full" placeholder={actionType === 'note_added' ? 'Write a note…' : 'Optional details of the call…'} value={actionNote} onChange={(e) => setActionNote(e.target.value)} />
          <Button variant="outline" disabled={record.isPending} onClick={() => { void onRecord(); }}>{record.isPending ? 'Saving…' : 'Save activity'}</Button>
        </div>
        {actions.length > 0 && (
          <div className="timeline">
            {actions.map((a) => (
              <div key={a.id}>
                <span><CheckCircle2 size={15} /></span>
                <h3>{ACTION_LABELS[a.action]}{a.actorId ? ` by ${names(a.actorId)}` : ''}</h3>
                {a.note && <p className="whitespace-pre-wrap">{a.note}</p>}
                <small>{fmtUtc(a.createdAt)}</small>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {can('leads.assign') && (
        <Panel title="Reassign" description="Manual reassignment is recorded separately from automatic escalation.">
          <div className="flex flex-wrap items-center gap-3 p-5">
            <select aria-label="New owner" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a team member…</option>
              {(team.data ?? []).filter((t) => t.userId !== lead.assignedTo).map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}
            </select>
            <Button variant="outline" disabled={!target || reassign.isPending} onClick={() => { void onReassign(); }}>{reassign.isPending ? 'Reassigning…' : 'Reassign'}<ArrowUpRight /></Button>
          </div>
        </Panel>
      )}

      <div className="detail-grid">
        <Panel title="Assignment history" description="Every owner, why they got the lead, and whether they acknowledged it.">
          {assignments.length === 0 ? <EmptyState title="No assignments yet" description="This lead has not been assigned." /> : (
            <div className="timeline">
              {[...assignments].reverse().map((a) => (
                <div key={a.id}>
                  <span><Plus size={15} /></span>
                  <h3>{a.assignedTo ? `Assigned to ${names(a.assignedTo)}` : 'Left without an owner'}</h3>
                  <p>{reasonText(a.reason)}{a.previousAssignedTo ? ` · from ${names(a.previousAssignedTo)}` : ''}{a.escalationLevel > 0 ? ` · level ${a.escalationLevel}` : ''}</p>
                  {a.assignedTo && <p>{ackText(a)}{a.acknowledgedBy && a.acknowledgedBy !== a.assignedTo ? ` (${names(a.acknowledgedBy)})` : ''}{!a.acknowledgedAt && a.deadline ? ` · deadline ${fmtUtc(a.deadline)}` : ''}</p>}
                  <small>{fmtUtc(a.createdAt)}{a.endedAt ? ` · ended ${fmtUtc(a.endedAt)}` : ' · current'}</small>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Escalation timeline" description="Automatic escalations after a missed acknowledgement deadline.">
          {escalations.length === 0 ? <EmptyState title="No escalations" description="This lead has never missed an acknowledgement deadline." /> : (
            <div className="timeline">
              {[...escalations].reverse().map((e) => (
                <div key={e.id}>
                  <span><Clock size={15} /></span>
                  <h3>Level {e.level}: {e.result === 'exhausted' ? 'no one else to escalate to' : `moved to ${names(e.newOwner)}`}</h3>
                  <p>From {names(e.previousOwner)} · {e.result === 'employee' ? 'next eligible employee' : e.result === 'exhausted' ? 'kept with owner, flagged for review' : e.result}</p>
                  <small>{fmtUtc(e.createdAt)}</small>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Avatar name={names(lead.assignedTo)} className="avatar-small" />Assignment and escalation are enforced by the database, not by this page.</div>
    </>
  );
}
