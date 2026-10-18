import {useEffect, useState, type ReactNode} from 'react';
import {ArrowDown, ArrowUp, Save} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Switch} from '@/components/ui/switch';
import {parseRulesDraft, moveInRing, rulesToDraft, type RulesDraft} from '@/lib/rules-form';
import {EmptyState, ErrorState, LoadingState, PageHeading, Panel} from './shared';
import {useLiveWorkspace, useRules, useSaveRules, useTeam} from './lead-queries';

export function AssignmentRulesRoute({fallback}: {fallback: ReactNode}) {
  const {live} = useLiveWorkspace();
  return live ? <LiveAssignmentRulesPage /> : <>{fallback}</>;
}

function LiveAssignmentRulesPage() {
  const {workspaceId, can} = useLiveWorkspace();
  const rules = useRules(workspaceId);
  const team = useTeam(workspaceId);
  const save = useSaveRules(workspaceId);
  const [draft, setDraft] = useState<RulesDraft | null>(null);
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const canEdit = can('assignment_rules.manage');
  const loaded = rules.data;
  // Seed the form once per loaded rule; later refetches do not overwrite unsaved edits.
  const loadedId = loaded?.ruleId;
  useEffect(() => { if (loaded) setDraft(rulesToDraft(loaded.rules)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [loadedId]);

  if (rules.isPending || team.isPending) return <LoadingState />;
  if (rules.isError) return <ErrorState message={rules.error.message} onRetry={() => { void rules.refetch(); }} />;
  if (!loaded || !draft) return <EmptyState title="No assignment rule" description="Your workspace has no active assignment rule yet. Workspace onboarding normally creates one." />;

  const members = team.data ?? [];
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name ?? `Member ${id.slice(0, 4)}`;
  const set = <K extends keyof RulesDraft>(k: K, v: RulesDraft[K]) => setDraft((d) => (d ? {...d, [k]: v} : d));
  const inRing = (id: string) => draft.ring.includes(id);

  async function onSave() {
    if (!draft || !loaded) return;
    const parsed = parseRulesDraft(draft);
    if (parsed.error !== null) { setMessage({kind: 'error', text: parsed.error}); return; }
    setMessage(null);
    try {
      await save.mutateAsync({ruleId: loaded.ruleId, rules: parsed.rules});
      setMessage({kind: 'ok', text: 'Assignment rules saved. New leads and escalations use them from now on.'});
    } catch (e) {
      setMessage({kind: 'error', text: e instanceof Error ? e.message : 'Assignment rules could not be saved.'});
    }
  }

  return (
    <>
      <PageHeading title="Assignment rules" subtitle="Get every lead to the right person." />
      {!canEdit && <p className="mb-3 text-sm text-muted-foreground" role="status">You can view these rules. Only members with the assignment-rules permission can change them.</p>}
      <Panel title="Lead assignment" description="Availability-aware round robin with acknowledgement, escalation and recovery thresholds.">
        <fieldset disabled={!canEdit || save.isPending} className="settings-form border-0 p-0">
          <label className="field-label">Assignment strategy
            <select value={draft.strategy} onChange={(e) => set('strategy', e.target.value as RulesDraft['strategy'])}>
              <option value="manual">Manual assignment</option>
              <option value="round_robin">Round robin (available employees only)</option>
              <option value="availability">Availability-based round robin</option>
            </select>
          </label>
          <div className="setting-row"><div><h3>Rule active</h3><p>Inactive rules are ignored; leads then wait for a manual owner.</p></div><Switch checked={draft.active} onCheckedChange={(v) => set('active', v)} aria-label="Rule active" /></div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="field-label">Acknowledgement window (seconds)<Input inputMode="numeric" value={draft.ackSeconds} onChange={(e) => set('ackSeconds', e.target.value)} /></label>
            <label className="field-label">Escalation timeouts per level (seconds, comma separated)<Input value={draft.escalationTimeouts} placeholder="e.g. 300, 180" onChange={(e) => set('escalationTimeouts', e.target.value)} /></label>
            <label className="field-label">Escalation levels<Input inputMode="numeric" value={draft.maxLevels} onChange={(e) => set('maxLevels', e.target.value)} /></label>
            <label className="field-label">Max open leads per employee<Input inputMode="numeric" value={draft.maxOpenLeads} onChange={(e) => set('maxOpenLeads', e.target.value)} /></label>
            <label className="field-label">Idle recovery threshold (seconds)<Input inputMode="numeric" value={draft.idleSeconds} onChange={(e) => set('idleSeconds', e.target.value)} /></label>
            <label className="field-label">When an owner goes on leave or offline, acknowledged leads…
              <select value={draft.absencePolicy} onChange={(e) => set('absencePolicy', e.target.value as RulesDraft['absencePolicy'])}>
                <option value="keep_and_flag">stay with the owner and are flagged for manager review</option>
                <option value="reassign">are reassigned like unacknowledged leads</option>
              </select>
            </label>
            <label className="field-label">Designated backup
              <select value={draft.backupUserId} onChange={(e) => set('backupUserId', e.target.value)}><option value="">None</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>
            </label>
            <label className="field-label">Designated manager
              <select value={draft.managerUserId} onChange={(e) => set('managerUserId', e.target.value)}><option value="">None</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>
            </label>
          </div>
          <div>
            <h3 className="text-sm font-medium">Eligible employees and order</h3>
            <p className="text-xs text-muted-foreground">Leads rotate in this order, skipping anyone who is not Available or is at their limit.</p>
            <ol className="mt-2 space-y-2">
              {draft.ring.map((id, i) => (
                <li key={id} className="flex items-center gap-2">
                  <span className="w-5 text-xs text-muted-foreground">{i + 1}</span><span className="flex-1">{nameOf(id)}</span>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move ${nameOf(id)} up`} disabled={i === 0} onClick={() => set('ring', moveInRing(draft.ring, id, -1))}><ArrowUp /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move ${nameOf(id)} down`} disabled={i === draft.ring.length - 1} onClick={() => set('ring', moveInRing(draft.ring, id, 1))}><ArrowDown /></Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => set('ring', draft.ring.filter((x) => x !== id))}>Remove</Button>
                </li>
              ))}
              {draft.ring.length === 0 && <li className="text-sm text-muted-foreground">No eligible employees selected.</li>}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              {members.filter((m) => !inRing(m.userId)).map((m) => <Button key={m.userId} type="button" variant="outline" size="sm" onClick={() => set('ring', [...draft.ring, m.userId])}>Add {m.name}</Button>)}
            </div>
          </div>
          {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-destructive' : 'text-success'}`}>{message.text}</p>}
          {canEdit && <div className="flex justify-end"><Button type="button" onClick={() => { void onSave(); }} disabled={save.isPending}><Save />{save.isPending ? 'Saving…' : 'Save and activate'}</Button></div>}
        </fieldset>
      </Panel>
    </>
  );
}
