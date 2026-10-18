import type {SupabaseClient} from '@supabase/supabase-js';
import {describe, expect, it} from 'vitest';
import {createLeadService, sanitizeSearch, toLead, toRecoveryItem, toRules} from '@/services/leads';

type Result = {data?: unknown; error?: {code?: string; message?: string} | null; count?: number | null};

/** Chainable PostgREST-style fake. Records every call and resolves with the queued result. */
function fakeClient(results: Record<string, Result>) {
  const calls: {target: string; steps: [string, unknown[]][]}[] = [];
  const make = (target: string) => {
    const rec = {target, steps: [] as [string, unknown[]][]};
    calls.push(rec);
    const result = () => ({data: null, error: null, count: null, ...(results[target] ?? {})});
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'not', 'order', 'range', 'limit', 'update', 'upsert', 'maybeSingle']) {
      chain[m] = (...args: unknown[]) => { rec.steps.push([m, args]); return chain; };
    }
    chain['then'] = (resolve: (v: unknown) => unknown) => resolve(result());
    return chain;
  };
  const client = {from: (t: string) => make(`from:${t}`), rpc: (fn: string, args: unknown) => { const c = make(`rpc:${fn}`); (c as {args?: unknown}).args = args; calls.at(-1)!.steps.push(['args', [args]]); return c; }};
  return {client: client as unknown as SupabaseClient, calls};
}
const leadRow = {id: 'l1', workspace_id: 'w1', full_name: 'Olivia', email: 'o@x.io', phone: null, company_name: null, message: null, source: 'web_form',
  status: 'new', assigned_to: 'u1', current_assignment_id: 'a1', created_at: '2026-10-18T09:00:00Z', updated_at: '2026-10-18T09:00:00Z',
  first_assigned_at: '2026-10-18T09:00:00Z', assigned_at: '2026-10-18T09:00:00Z', first_acknowledged_at: null, acknowledged_at: null,
  acknowledgement_due_at: '2026-10-18T09:01:00Z', escalation_level: 1, last_action_at: null, needs_manager_review: false, ownership_exception: false,
  recovery_resolved_at: null, version: 4};

describe('row mappers', () => {
  it('maps a lead row to the domain model', () => {
    expect(toLead(leadRow)).toMatchObject({id: 'l1', name: 'Olivia', assignedTo: 'u1', acknowledgementDeadline: '2026-10-18T09:01:00Z', escalationLevel: 1, version: 4, source: 'web_form'});
  });
  it('maps recovery rows including reasons and total-independent fields', () => {
    const item = toRecoveryItem({lead_id: 'l1', full_name: 'X', source: 'manual', assigned_to: null, status: 'new', created_at: 't', acknowledged: false,
      escalation_level: 2, escalations_since_review: '2', last_action_at: null, acknowledgement_due_at: null, needs_manager_review: true, reasons: ['idle', 'repeated_escalation']});
    expect(item).toMatchObject({leadId: 'l1', escalationsSinceReview: 2, needsManagerReview: true, reasons: ['idle', 'repeated_escalation']});
  });
  it('prefers second-level ack windows and falls back to minutes', () => {
    expect(toRules({acknowledgement_window_seconds: 45, strategy: 'round_robin', is_active: true}, ['a']).ackTimeoutSeconds).toBe(45);
    expect(toRules({acknowledgement_window_minutes: 15, strategy: 'manual', is_active: false}, []).ackTimeoutSeconds).toBe(900);
  });
  it('sanitises search text so it cannot alter the filter expression', () => {
    expect(sanitizeSearch('a,b),full_name.eq.x')).not.toMatch(/[,()]/);
    expect(sanitizeSearch('  50%  off ')).toBe('50 off');
  });
});

describe('lead service', () => {
  it('lists leads scoped to the workspace with filters and database pagination', async () => {
    const {client, calls} = fakeClient({'from:leads': {data: [leadRow], count: 41}});
    const r = await createLeadService(() => client).listLeads('w1', {page: 3, pageSize: 10, status: 'new', ownerId: 'u1', search: 'oli'});
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({total: 41});
    const steps = calls[0]!.steps;
    expect(steps).toContainEqual(['eq', ['workspace_id', 'w1']]);
    expect(steps).toContainEqual(['eq', ['status', 'new']]);
    expect(steps).toContainEqual(['eq', ['assigned_to', 'u1']]);
    expect(steps).toContainEqual(['range', [20, 29]]);
  });

  it('surfaces database errors and never reports success', async () => {
    const {client} = fakeClient({'from:leads': {error: {code: '42501', message: 'rls'}}});
    const r = await createLeadService(() => client).listLeads('w1', {page: 1, pageSize: 10});
    expect(r.data).toBeNull();
    expect(r.error).toBe('You do not have permission to do that.');
  });

  it('creates a lead through the idempotent RPC and maps the saved row', async () => {
    const {client, calls} = fakeClient({'rpc:create_lead': {data: leadRow}});
    const r = await createLeadService(() => client).createManual('w1', {name: 'Olivia', idempotencyKey: 'key-12345678'});
    expect(r.data?.id).toBe('l1');
    expect(calls[0]!.steps[0]![1][0]).toMatchObject({p_workspace: 'w1', p_full_name: 'Olivia', p_idempotency_key: 'key-12345678'});
  });

  it('does not treat an empty or error RPC response as a saved lead', async () => {
    expect((await createLeadService(() => fakeClient({'rpc:create_lead': {data: null}}).client).createManual('w1', {name: 'x', idempotencyKey: 'key-12345678'})).error).toBeTruthy();
    expect((await createLeadService(() => fakeClient({'rpc:create_lead': {error: {message: 'boom'}}}).client).createManual('w1', {name: 'x', idempotencyKey: 'key-12345678'})).data).toBeNull();
  });

  it('acknowledge requires an explicit ok/already_applied from the server', async () => {
    const good = await createLeadService(() => fakeClient({'rpc:acknowledge_lead': {data: {code: 'ok'}}}).client).acknowledge('l1', 'a1');
    expect(good.data).toEqual({code: 'ok'});
    const unknown = await createLeadService(() => fakeClient({'rpc:acknowledge_lead': {data: {}}}).client).acknowledge('l1', 'a1');
    expect(unknown.data).toBeNull();
    const stale = await createLeadService(() => fakeClient({'rpc:acknowledge_lead': {error: {code: '40001', message: 'this assignment is no longer current'}}}).client).acknowledge('l1', 'a1');
    expect(stale.error).toMatch(/changed while you were working/);
  });

  it('records an activity with its note and reports whether it acknowledged the lead', async () => {
    const {client, calls} = fakeClient({'rpc:record_lead_action': {data: {code: 'ok', acknowledged: true}}});
    const r = await createLeadService(() => client).recordAction('l1', 'note_added', 'dedupe-key-0001', 'Called back');
    expect(r.data).toEqual({acknowledged: true});
    expect(calls[0]!.steps[0]![1][0]).toEqual({p_lead: 'l1', p_action: 'note_added', p_dedupe_key: 'dedupe-key-0001', p_note: 'Called back'});
    const failed = await createLeadService(() => fakeClient({'rpc:record_lead_action': {error: {code: '22023', message: 'note is too long'}}}).client).recordAction('l1', 'call_recorded', 'dedupe-key-0002');
    expect(failed.data).toBeNull();
  });

  it('loads a lead with assignments, escalations and recorded activity', async () => {
    const {client, calls} = fakeClient({
      'from:leads': {data: leadRow},
      'from:lead_assignments': {data: [{id: 'a1', lead_id: 'l1', assigned_to: 'u1', created_at: 't', escalation_level: 0}]},
      'from:lead_escalations': {data: [{id: 'e1', lead_id: 'l1', level: 1, reason: 'ack_timeout', result: 'employee', created_at: 't'}]},
      'from:lead_actions': {data: [{id: 'x1', lead_id: 'l1', action: 'note_added', actor_id: 'u1', note: 'hi', created_at: 't'}]},
    });
    const r = await createLeadService(() => client).getLead('w1', 'l1');
    expect(r.data?.actions).toEqual([{id: 'x1', leadId: 'l1', action: 'note_added', actorId: 'u1', note: 'hi', createdAt: 't'}]);
    expect(r.data?.assignments).toHaveLength(1);
    expect(r.data?.escalations[0]).toMatchObject({level: 1, result: 'employee'});
    expect(calls.filter((c) => c.target === 'from:lead_actions')[0]!.steps).toContainEqual(['eq', ['workspace_id', 'w1']]);
  });

  it('reads recovery rows with total_count from the first row', async () => {
    const row = {lead_id: 'l1', full_name: 'X', source: null, assigned_to: 'u1', status: 'new', created_at: 't', acknowledged: false, escalation_level: 0,
      escalations_since_review: 0, last_action_at: null, acknowledgement_due_at: 't', needs_manager_review: false, reasons: ['unacknowledged_overdue'], total_count: 7};
    const {client, calls} = fakeClient({'rpc:get_recovery_queue': {data: [row]}});
    const r = await createLeadService(() => client).recoveryQueue('w1', {page: 2, pageSize: 5, reason: 'idle'});
    expect(r.data?.total).toBe(7);
    expect(calls[0]!.steps[0]![1][0]).toMatchObject({p_workspace: 'w1', p_reason: 'idle', p_limit: 5, p_offset: 5});
  });

  it('builds the team view from members, availability and open workloads (missing availability = offline)', async () => {
    const {client} = fakeClient({
      'from:workspace_members': {data: [{user_id: 'u1', profiles: {full_name: 'Ann'}}, {user_id: 'u2', profiles: [{full_name: 'Bo'}]}]},
      'from:employee_availability': {data: [{user_id: 'u1', status: 'busy', max_open_leads: 3}]},
      'from:leads': {data: [{assigned_to: 'u1', status: 'new'}, {assigned_to: 'u1', status: 'lost'}, {assigned_to: 'u2', status: 'contacted'}]},
    });
    const r = await createLeadService(() => client).listTeam('w1');
    expect(r.data).toEqual([
      {userId: 'u1', name: 'Ann', status: 'busy', maxOpenLeads: 3, openLeads: 1},
      {userId: 'u2', name: 'Bo', status: 'offline', maxOpenLeads: null, openLeads: 1},
    ]);
  });

  it('saves rules in two confirmed steps and reports failure of either', async () => {
    const rules = toRules({strategy: 'round_robin', is_active: true, acknowledgement_window_seconds: 60}, ['u1', 'u2']);
    const good = fakeClient({});
    expect((await createLeadService(() => good.client).saveRules('w1', 'r1', rules)).error).toBeNull();
    expect(good.calls.map((c) => c.target)).toEqual(['from:assignment_rules', 'rpc:set_rule_assignees']);
    const ringFail = await createLeadService(() => fakeClient({'rpc:set_rule_assignees': {error: {code: '42501', message: 'no'}}}).client).saveRules('w1', 'r1', rules);
    expect(ringFail.error).toBeTruthy();
    const ruleFail = fakeClient({'from:assignment_rules': {error: {message: 'bad'}}});
    expect((await createLeadService(() => ruleFail.client).saveRules('w1', 'r1', rules)).error).toBe('bad');
    expect(ruleFail.calls.map((c) => c.target)).toEqual(['from:assignment_rules']);
  });

  it('writes availability as an upsert keyed by workspace and user', async () => {
    const {client, calls} = fakeClient({});
    const r = await createLeadService(() => client).setAvailability('w1', 'u1', 'on_leave');
    expect(r.error).toBeNull();
    expect(calls[0]!.steps[0]).toEqual(['upsert', [{workspace_id: 'w1', user_id: 'u1', status: 'on_leave'}, {onConflict: 'workspace_id,user_id'}]]);
  });
});
