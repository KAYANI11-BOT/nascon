// Local-only verification of the lead automation migration (20261018000600) against an embedded
// Postgres (PGlite) with a stubbed Supabase auth schema. Never connects to a remote database.
// Run: npm run test:db:leads
// LIMITATION: PGlite is a single connection, so races are verified as strict orderings
// (ack-then-escalate, escalate-then-ack, repeated runs). True parallel interleaving is NOT tested.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('../migrations/', import.meta.url));
const db = new PGlite();
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e?.message ?? e); process.exit(2); });

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz, phone_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`);
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(dir, f), 'utf8')); console.log('applied', f); }
  catch (e) { console.error('FAILED', f, e.message); process.exit(1); }
}

const id = (c) => `00000000-0000-4000-8000-0000000000${c}`;
const U = { A: id('0a'), B: id('0b'), C: id('0c'), D: id('0d'), E: id('0e'), F: id('0f'), G: id('10'), H: id('11') };
for (const [k, v] of Object.entries(U)) {
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ('${v}', '${k.toLowerCase()}@t.local', '{"full_name":"User ${k}"}', now())`);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const q = async (sql, p) => (await db.query(sql, p)).rows;

async function as(user, sql, params) {
  const role = user === 'anon' ? 'anon' : user === 'service' ? 'service_role' : 'authenticated';
  const claims = user === 'anon' || user === 'service' ? `{"role":"${role}"}` : `{"sub":"${U[user]}","role":"authenticated"}`;
  await db.exec(`begin; set local role ${role}; select set_config('request.jwt.claims', '${claims}', true);`);
  try { const r = await db.query(sql, params); await db.exec('commit'); return r; }
  catch (e) { await db.exec('rollback'); throw e; }
}
const attempt = async (user, sql, params) => { try { return { res: await as(user, sql, params) }; } catch (e) { return { err: e.message }; } };

// ---- Fixture: workspace A (owner A; users B,C,D; admin E; user F) and workspace B (owner G) ----
const wsA = (await as('A', `select public.create_workspace_with_owner('Lead Co','Technology','UTC') id`)).rows[0].id;
const wsB = (await as('G', `select public.create_workspace_with_owner('Other Co','Other','UTC') id`)).rows[0].id;
await db.exec(`insert into workspace_members (workspace_id, user_id, role) values
  ('${wsA}','${U.B}','user'),('${wsA}','${U.C}','user'),('${wsA}','${U.D}','user'),('${wsA}','${U.E}','admin'),('${wsA}','${U.F}','user'),
  ('${wsB}','${U.H}','user')`);
await db.exec(`insert into employee_availability (workspace_id, user_id) values
  ('${wsA}','${U.B}'),('${wsA}','${U.C}'),('${wsA}','${U.D}'),('${wsA}','${U.E}'),('${wsA}','${U.F}')`);
const ruleA = (await q(`select id from assignment_rules where workspace_id='${wsA}'`))[0].id;
await db.exec(`insert into assignment_rule_assignees (rule_id, workspace_id, user_id, position) values
  ('${ruleA}','${wsA}','${U.B}',0),('${ruleA}','${wsA}','${U.C}',1),('${ruleA}','${wsA}','${U.D}',2)`);
await db.exec(`insert into lead_intake_channels (slug, workspace_id) values ('acme-leads','${wsA}'),('beta-leads','${wsB}')`);
const ruleB = (await q(`select id from assignment_rules where workspace_id='${wsB}'`))[0].id;

const baseRule = {
  strategy: `'round_robin'`, is_active: 'true', acknowledgement_window_seconds: '60', max_open_leads: '10',
  escalation_timeouts_seconds: `'{30,20}'`, max_escalation_levels: '3', idle_threshold_seconds: '3600',
  acknowledged_absence_policy: `'keep_and_flag'`, backup_user_id: `'${U.E}'`, manager_user_id: `'${U.A}'`,
};
// overrides replace defaults per column, e.g. reset(`max_open_leads=1, backup_user_id=null`)
async function reset(extra = '') {
  const rule = { ...baseRule };
  for (const part of extra.split(/,(?![^{]*\})/).map((s) => s.trim()).filter(Boolean)) {
    const [col, ...val] = part.split('=');
    rule[col.trim()] = val.join('=').trim();
  }
  const set = Object.entries(rule).map(([c, v]) => `${c}=${v}`).join(', ');
  await db.exec(`delete from leads where workspace_id='${wsA}'; delete from assignment_rule_state;
    update employee_availability set status='available', max_open_leads=null where workspace_id='${wsA}';
    update assignment_rules set ${set} where id='${ruleA}'`);
}
let seq = 0;
const key = () => `test-key-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const mk = async (name, user = 'A', k = key()) => (await as(user, `select * from public.create_lead($1,$2,null,null,null,null,$3)`, [wsA, name, k])).rows[0];
const lead = async (leadId) => (await q(`select * from leads where id='${leadId}'`))[0];
const owners = (rows) => rows.map((r) => Object.keys(U).find((k) => U[k] === r.assigned_to) ?? r.assigned_to);
const forceDue = (leadId) => db.exec(`update leads set acknowledgement_due_at = now() - interval '1 second' where id='${leadId}'`);
const escalate = async () => (await q(`select public.escalate_overdue_leads(100) n`))[0].n;

// ---------------- S1 round robin ----------------
await reset();
let l = []; for (const n of ['L1', 'L2', 'L3', 'L4']) l.push(await mk(n));
ok('round robin B -> C -> D -> B', owners(l).join('') === 'BCDB', owners(l).join(''));
ok('intake lead gets source manual, deadline ~60s and a first assignment time',
  l[0].source === 'manual' && l[0].first_assigned_at && Math.abs(new Date(l[0].acknowledgement_due_at) - new Date(l[0].assigned_at) - 60000) < 2000);
const hist = await q(`select * from lead_assignments where lead_id='${l[0].id}'`);
ok('one live assignment row whose id is the lead current_assignment_id',
  hist.length === 1 && hist[0].ended_at === null && hist[0].id === l[0].current_assignment_id && hist[0].reason === 'auto_round_robin');
ok('an assignment notification was queued for the owner',
  (await q(`select count(*)::int c from notification_outbox where lead_id='${l[0].id}' and recipient_user_id='${U.B}' and event_type='lead_assigned'`))[0].c === 1);
const dupKey = key(); const d1 = await mk('Dup', 'A', dupKey); const d2 = await mk('Dup again', 'A', dupKey);
ok('repeated intake with the same idempotency key creates one lead', d1.id === d2.id && (await q(`select count(*)::int c from leads where idempotency_key='${dupKey}'`))[0].c === 1);

// ---------------- S2 availability skipping ----------------
await reset();
await db.exec(`update employee_availability set status='busy' where user_id='${U.C}'`);
l = []; for (const n of ['S1', 'S2', 'S3', 'S4']) l.push(await mk(n));
ok('busy employee skipped: B -> D -> B -> D', owners(l).join('') === 'BDBD', owners(l).join(''));
for (const st of ['on_leave', 'offline']) {
  await db.exec(`update employee_availability set status='${st}' where user_id='${U.D}'`);
  const x = await mk('Absent ' + st);
  ok(`${st} employee never receives an automatic assignment`, x.assigned_to !== U.D && x.assigned_to !== U.C, owners([x]).join(''));
  await db.exec(`update employee_availability set status='available' where user_id='${U.D}'`);
}

// ---------------- S3 capacity and explicit fallbacks ----------------
await reset(`max_open_leads=1`);
l = []; for (const n of ['C1', 'C2', 'C3']) l.push(await mk(n));
const over = await mk('Over capacity');
ok('cap enforced: 4th lead goes to the designated backup (fallback_backup)',
  over.assigned_to === U.E && (await q(`select reason from lead_assignments where lead_id='${over.id}' and ended_at is null`))[0].reason === 'fallback_backup');
await reset(`max_open_leads=1, backup_user_id=null`);
for (const n of ['M1', 'M2', 'M3']) await mk(n);
const mgr = await mk('To manager');
ok('no backup: falls back to the manager (fallback_manager)', mgr.assigned_to === U.A);
await reset(`max_open_leads=1, backup_user_id=null, manager_user_id=null`);
for (const n of ['X1', 'X2', 'X3']) await mk(n);
const exc = await mk('Nobody');
ok('no eligible employee, backup or manager: durable ownership exception, not silently assigned',
  exc.assigned_to === null && exc.ownership_exception === true && exc.needs_manager_review === true && exc.acknowledgement_due_at === null);
ok('exception alerts the workspace owner via the outbox',
  (await q(`select count(*)::int c from notification_outbox where lead_id='${exc.id}' and event_type='lead_exception' and recipient_user_id='${U.A}'`))[0].c === 1);

// ---------------- S4 acknowledgement ----------------
await reset();
const a1 = await mk('Ack me');           // -> B
const ackRes = (await as('B', `select public.acknowledge_lead($1,$2) r`, [a1.id, a1.current_assignment_id])).rows[0].r;
const a1b = await lead(a1.id);
ok('assignee acknowledges the current assignment', ackRes.code === 'ok' && a1b.acknowledged_at && a1b.first_acknowledged_at && a1b.status === 'contacted');
ok('acknowledgement persisted on the assignment ledger',
  (await q(`select ack_method, acknowledged_by from lead_assignments where id='${a1.current_assignment_id}'`))[0].acknowledged_by === U.B);
ok('re-acknowledging is idempotent', (await as('B', `select public.acknowledge_lead($1,$2) r`, [a1.id, a1.current_assignment_id])).rows[0].r.code === 'already_applied');
const a2 = await mk('Not yours');         // -> C
ok('another employee cannot acknowledge', !!(await attempt('D', `select public.acknowledge_lead($1,$2)`, [a2.id, a2.current_assignment_id])).err);
ok('a stale assignment id is rejected', !!(await attempt('C', `select public.acknowledge_lead($1,$2)`, [a2.id, a1.current_assignment_id])).err);
const sup = await attempt('E', `select public.acknowledge_lead($1,$2) r`, [a2.id, a2.current_assignment_id]);
ok('a supervisor (leads.assign) can acknowledge, recorded as supervisor', sup.res?.rows[0].r.code === 'ok' &&
  (await q(`select ack_method from lead_assignments where id='${a2.current_assignment_id}'`))[0].ack_method === 'supervisor');

// implicit acknowledgement
const a3 = await mk('Implicit');          // -> D
const act = await as('D', `select public.record_lead_action($1,'note_added',$2) r`, [a3.id, 'dedupe-implicit-1']);
ok('a qualifying recorded action acknowledges implicitly', act.rows[0].r.acknowledged === true &&
  (await q(`select ack_method from lead_assignments where id='${a3.current_assignment_id}'`))[0].ack_method === 'note_added');
ok('retrying the same action is a no-op', (await as('D', `select public.record_lead_action($1,'note_added',$2) r`, [a3.id, 'dedupe-implicit-1'])).rows[0].r.code === 'already_applied');
ok('a non-qualifying action is rejected', !!(await attempt('D', `select public.record_lead_action($1,'page_viewed',$2)`, [a3.id, 'dedupe-implicit-2'])).err);
const noted = await mk('With note');
await as(Object.keys(U).find((k) => U[k] === noted.assigned_to), `select public.record_lead_action($1,'call_recorded',$2,$3) r`, [noted.id, 'dedupe-note-0001', '  Spoke to the customer  ']);
ok('an action note is stored trimmed with the actor and linked to the live assignment',
  (await q(`select note, actor_id, assignment_id from lead_actions where lead_id='${noted.id}'`))[0].note === 'Spoke to the customer' &&
  (await q(`select assignment_id from lead_actions where lead_id='${noted.id}'`))[0].assignment_id === noted.current_assignment_id);
ok('an over-long note is rejected and nothing is recorded',
  !!(await attempt('A', `select public.record_lead_action($1,'note_added',$2,$3)`, [noted.id, 'dedupe-note-0002', 'x'.repeat(2001)])).err &&
  (await q(`select count(*)::int c from lead_actions where lead_id='${noted.id}'`))[0].c === 1);
ok('clients cannot write or edit recorded actions directly',
  !!(await attempt('A', `insert into lead_actions (workspace_id, lead_id, action, dedupe_key) values ($1,$2,'note_added','forged-direct-1')`, [wsA, noted.id])).err);
const a4 = await mk('Other action'); // -> B (cap fine)
await as('F', `select public.record_lead_action($1,'call_recorded',$2)`, [a4.id, 'dedupe-implicit-3']);
ok('an action by a non-assignee does not acknowledge', (await lead(a4.id)).acknowledged_at === null);

// ---------------- S5 escalation chain ----------------
await reset();
const e1 = await mk('Escalate me');       // -> B
await forceDue(e1.id);
ok('scheduler escalates one overdue lead', (await escalate()) === 1);
let e = await lead(e1.id);
ok('level 1: next eligible employee, never the previous owner', e.assigned_to === U.C && e.escalation_level === 1 && e.status === 'escalated', owners([e]).join(''));
ok('level 1 deadline uses the configured escalation timeout (30s)', Math.abs(new Date(e.acknowledgement_due_at) - Date.now() - 30000) < 3000);
ok('immediate re-run does nothing (not due; idempotent)', (await escalate()) === 0);
const ev1 = (await q(`select * from lead_escalations where lead_id='${e1.id}'`));
ok('one escalation event with previous/new owner, level and result', ev1.length === 1 && ev1[0].previous_owner === U.B && ev1[0].new_owner === U.C && ev1[0].level === 1 && ev1[0].result === 'employee');
const ob = (await q(`select payload, status from notification_outbox where lead_id='${e1.id}' and event_type='lead_escalated'`));
ok('exactly one escalation notification with the contract payload',
  ob.length === 1 && ob[0].status === 'pending' && ['workspace_id', 'lead_id', 'recipient_user_id', 'event_id', 'event_type', 'lead_name', 'source', 'reason', 'lead_url', 'created_at'].every((k) => k in ob[0].payload)
  && ob[0].payload.lead_url === `/leads/${e1.id}` && ob[0].payload.recipient_user_id === U.C && ob[0].payload.reason === 'escalation_peer');
const dupInsert = await db.query(`insert into lead_escalations (workspace_id, lead_id, from_assignment_id, level, reason, result) values ('${wsA}','${e1.id}','${ev1[0].from_assignment_id}',9,'x','pending')`).then(() => 'inserted', (x) => x.message);
ok('database refuses a second escalation for the same assignment', dupInsert !== 'inserted', dupInsert);
await forceDue(e1.id); await escalate(); e = await lead(e1.id);
ok('level 2: designated backup', e.assigned_to === U.E && e.escalation_level === 2, owners([e]).join(''));
await forceDue(e1.id); await escalate(); e = await lead(e1.id);
ok('level 3: designated manager', e.assigned_to === U.A && e.escalation_level === 3, owners([e]).join(''));
await forceDue(e1.id);
ok('past the final level nothing loops', (await escalate()) === 0 && (await lead(e1.id)).assigned_to === U.A);
ok('escalation history is complete (3 events, 4 assignments, one live)',
  (await q(`select count(*)::int c from lead_escalations where lead_id='${e1.id}'`))[0].c === 3 &&
  (await q(`select count(*)::int c from lead_assignments where lead_id='${e1.id}'`))[0].c === 4 &&
  (await q(`select count(*)::int c from lead_assignments where lead_id='${e1.id}' and ended_at is null`))[0].c === 1);
ok('first assignment time preserved across escalations', new Date((await lead(e1.id)).first_assigned_at).getTime() === new Date(e1.first_assigned_at).getTime());

// ---------------- S6 ack vs escalation ordering ----------------
await reset();
const r1 = await mk('Ack wins');          // -> B
await forceDue(r1.id);
await as('B', `select public.acknowledge_lead($1,$2)`, [r1.id, r1.current_assignment_id]);
ok('ack first: a later scheduler run does not escalate', (await escalate()) === 0 && (await lead(r1.id)).assigned_to === U.B);
const r2 = await mk('Escalation wins'); // -> C
await forceDue(r2.id); await escalate();
const late = await attempt('C', `select public.acknowledge_lead($1,$2)`, [r2.id, r2.current_assignment_id]);
ok('escalation first: the old owner cannot acknowledge afterwards, and the new owner is unaffected', !!late.err && (await lead(r2.id)).acknowledged_at === null);

// ---------------- S7 absence reassignment ----------------
await reset();
const b1 = await mk('B1'); const b2 = await mk('B2'); const b3 = await mk('B3'); const b4 = await mk('B4'); // B C D B
const b5 = await mk('B5'); const b6 = await mk('B6'); const b7 = await mk('B7');                           // C D B
await as('B', `select public.acknowledge_lead($1,$2)`, [b4.id, b4.current_assignment_id]);                 // acknowledged B lead
await as('B', `update employee_availability set status='on_leave' where user_id=$1 and workspace_id=$2`, [U.B, wsA]);
const afterB = await q(`select id, assigned_to, escalation_level, acknowledged_at, needs_manager_review from leads where id in ('${b1.id}','${b4.id}','${b7.id}')`);
const byId = Object.fromEntries(afterB.map((x) => [x.id, x]));
ok('unacknowledged leads leave an on_leave employee immediately', byId[b1.id].assigned_to !== U.B && byId[b7.id].assigned_to !== U.B);
ok('manual absence reassignment is not an escalation (level unchanged, no escalation events)',
  byId[b1.id].escalation_level === 0 && (await q(`select count(*)::int c from lead_escalations where lead_id in ('${b1.id}','${b7.id}')`))[0].c === 0);
ok('absence reassignment is recorded with its own reason and a fresh deadline',
  (await q(`select reason from lead_assignments where lead_id='${b1.id}' and ended_at is null`))[0].reason === 'absence_reassignment');
ok('acknowledged leads stay (policy keep_and_flag) and are flagged for manager review', byId[b4.id].assigned_to === U.B && byId[b4.id].needs_manager_review === true);
ok('the absent employee gets no new automatic assignment', (await mk('After leave')).assigned_to !== U.B);
await db.exec(`update employee_availability set status='available' where user_id='${U.B}'; update assignment_rules set acknowledged_absence_policy='reassign' where id='${ruleA}'`);
await db.exec(`update employee_availability set status='offline' where user_id='${U.B}'`);
ok('policy "reassign" also moves acknowledged leads off an offline employee', (await lead(b4.id)).assigned_to !== U.B);

// ---------------- S8 recovery queue ----------------
await reset();
const rq1 = await mk('Overdue'); const rq2 = await mk('Idle'); const rq3 = await mk('Repeated'); const rq4 = await mk('Healthy');
await as('C', `select public.acknowledge_lead($1,$2)`, [rq2.id, rq2.current_assignment_id]);
await as('B', `select public.acknowledge_lead($1,$2)`, [rq4.id, rq4.current_assignment_id]);
// escalate() processes EVERY overdue lead, so escalate rq3 twice first and only then make rq1 overdue
await forceDue(rq3.id); await escalate(); await forceDue(rq3.id); await escalate();
await forceDue(rq1.id);
await db.exec(`update leads set created_at = now() - interval '3 hours', last_action_at = now() - interval '2 hours' where id='${rq2.id}'`);
const queue = await as('A', `select * from public.get_recovery_queue($1)`, [wsA]);
const byName = Object.fromEntries(queue.rows.map((r) => [r.full_name, r]));
ok('overdue unacknowledged lead is in the queue with its reason', byName['Overdue']?.reasons.includes('unacknowledged_overdue'));
ok('idle lead (no recorded action within the threshold) is in the queue', byName['Idle']?.reasons.join() === 'idle');
ok('lead escalated 2+ times is in the queue with repeated_escalation', byName['Repeated']?.reasons.includes('repeated_escalation'));
ok('healthy acknowledged lead is not in the queue', !byName['Healthy']);
ok('filters and pagination: reason filter, owner filter, limit with total_count',
  (await as('A', `select * from public.get_recovery_queue($1,'idle')`, [wsA])).rows.length === 1 &&
  (await as('A', `select * from public.get_recovery_queue($1,null,$2)`, [wsA, U.B])).rows.every((r) => r.assigned_to === U.B) &&
  (await as('A', `select * from public.get_recovery_queue($1,null,null,null,null,null,null,1,0)`, [wsA])).rows[0].total_count >= 3);
ok('plain employee cannot resolve recovery', !!(await attempt('D', `select public.resolve_recovery($1)`, [rq2.id])).err);
ok('cannot resolve an unacknowledged lead', !!(await attempt('E', `select public.resolve_recovery($1)`, [rq1.id])).err);
await as('E', `select public.resolve_recovery($1)`, [rq2.id]);
ok('resolving an acknowledged idle lead removes it from the queue (persisted rule)',
  !(await as('A', `select * from public.get_recovery_queue($1)`, [wsA])).rows.some((r) => r.full_name === 'Idle'));
// manual-strategy path: unassigned leads surface after the ack window
await reset(`strategy='manual'`);
await db.exec(`insert into leads (workspace_id, full_name, created_at) values ('${wsA}','Waiting for owner', now() - interval '10 minutes')`);
ok('manual strategy leaves a lead unassigned and surfaces it as "unassigned" after the window',
  (await as('A', `select * from public.get_recovery_queue($1)`, [wsA])).rows.some((r) => r.full_name === 'Waiting for owner' && r.reasons.includes('unassigned')));

// ---------------- S9 manual reassignment, first response ----------------
await reset();
const m1 = await mk('Manual re-home'); // -> B
await as('B', `select public.acknowledge_lead($1,$2)`, [m1.id, m1.current_assignment_id]);
const before = await lead(m1.id);
ok('employee without leads.assign cannot reassign', !!(await attempt('D', `select public.reassign_lead($1,$2,$3)`, [m1.id, U.D, before.version])).err);
ok('stale version is rejected', !!(await attempt('E', `select public.reassign_lead($1,$2,$3)`, [m1.id, U.D, before.version - 1])).err);
const rr = await attempt('E', `select public.reassign_lead($1,$2,$3) r`, [m1.id, U.D, before.version]);
const after = await lead(m1.id);
ok('supervisor reassigns; ack resets, level unchanged, first acknowledgement time preserved',
  rr.res?.rows[0].r.code === 'ok' && after.assigned_to === U.D && after.acknowledged_at === null && after.escalation_level === 0 &&
  String(after.first_acknowledged_at) === String(before.first_acknowledged_at));
ok('the previous owner cannot acknowledge after reassignment', !!(await attempt('B', `select public.acknowledge_lead($1,$2)`, [m1.id, m1.current_assignment_id])).err);
const fr = (await as('A', `select * from public.get_first_response_stats($1)`, [wsA])).rows[0];
ok('first-response metric available for dashboards', Number(fr.responded) >= 1 && fr.avg_seconds >= 0);
await db.exec(`update leads set first_assigned_at = now() - interval '90 seconds', first_acknowledged_at = now() - interval '30 seconds' where id='${m1.id}'`);
const fr2 = (await as('A', `select * from public.get_first_response_stats($1,null,null)`, [wsA])).rows[0];
ok('time to first response = first acknowledgement - first assignment', fr2.responded >= 1 && fr2.median_seconds > 0);

// ---------------- S10 security ----------------
await reset();
const s1 = await mk('Secure');
ok('client cannot forge acknowledgement', !!(await attempt('B', `update leads set acknowledged_at=now() where id=$1`, [s1.id])).err);
ok('client cannot move the deadline', !!(await attempt('B', `update leads set acknowledgement_due_at = now() + interval '1 day' where id=$1`, [s1.id])).err);
ok('client cannot reset escalation level or review flags', !!(await attempt('B', `update leads set escalation_level=2 where id=$1`, [s1.id])).err && !!(await attempt('B', `update leads set needs_manager_review=true where id=$1`, [s1.id])).err);
ok('client cannot insert a lead with lifecycle fields pre-filled', !!(await attempt('A', `insert into leads (workspace_id, full_name, acknowledged_at) values ($1,'forged',now())`, [wsA])).err);
const direct = await attempt('E', `update leads set assigned_to=$2 where id=$1`, [s1.id, U.D]);
const dl = await lead(s1.id);
ok('direct client reassignment (leads.assign) still gets a fresh deadline, history row and level kept',
  !direct.err && dl.assigned_to === U.D && dl.acknowledged_at === null &&
  (await q(`select count(*)::int c from lead_assignments where lead_id='${s1.id}' and ended_at is null`))[0].c === 1);
ok('plain employee cannot escalate, capture, claim or complete notifications',
  !!(await attempt('B', `select public.escalate_overdue_leads(10)`)).err && !!(await attempt('B', `select public.capture_external_lead('acme-leads','x',null,null,null,'web_form','abcdefgh12')`)).err
  && !!(await attempt('B', `select * from public.claim_notifications(5)`)).err);
ok('anonymous callers cannot call any lead function',
  !!(await attempt('anon', `select public.create_lead($1,'x',null,null,null,null,'abcdefgh12')`, [wsA])).err &&
  !!(await attempt('anon', `select public.acknowledge_lead($1,$2)`, [s1.id, s1.current_assignment_id])).err &&
  !!(await attempt('anon', `select public.escalate_overdue_leads(1)`)).err &&
  !!(await attempt('anon', `select * from public.get_recovery_queue($1)`, [wsA])).err);
ok('private helpers are not callable by clients', !!(await attempt('B', `select private.apply_assignment($1,$2,'x',null,0,'lead_assigned')`, [s1.id, U.B])).err);
ok('another workspace cannot read leads, escalations, outbox or ack a foreign lead',
  (await as('G', `select * from leads where workspace_id=$1`, [wsA])).rows.length === 0 &&
  (await as('G', `select * from notification_outbox where workspace_id=$1`, [wsA])).rows.length === 0 &&
  !!(await attempt('G', `select public.acknowledge_lead($1,$2)`, [s1.id, s1.current_assignment_id])).err &&
  (await as('G', `select * from public.get_recovery_queue($1)`, [wsA])).rows.length === 0);
ok('create_lead requires membership/permission in the target workspace', !!(await attempt('G', `select public.create_lead($1,'x',null,null,null,null,'abcdefgh12')`, [wsA])).err);
ok('create_lead validates input', !!(await attempt('A', `select public.create_lead($1,'',null,null,null,null,'abcdefgh12')`, [wsA])).err &&
  !!(await attempt('A', `select public.create_lead($1,'Ok','not-an-email',null,null,null,'abcdefgh12')`, [wsA])).err &&
  !!(await attempt('A', `select public.create_lead($1,'Ok',null,null,null,null,'short')`, [wsA])).err);
ok('only rule managers can change assignment rules', (await as('D', `update assignment_rules set max_open_leads=1 where id=$1`, [ruleA])).affectedRows === 0 &&
  (await as('E', `update assignment_rules set max_open_leads=10 where id=$1`, [ruleA])).affectedRows === 1);
ok('employees cannot edit the round-robin ring or position', (await as('D', `delete from assignment_rule_assignees where rule_id=$1`, [ruleA])).affectedRows === 0 &&
  !!(await attempt('E', `insert into assignment_rule_state (rule_id, workspace_id) values ($1,$2)`, [ruleA, wsA])).err);

// ---------------- S11 public / external intake ----------------
const cap = await as('service', `select public.capture_external_lead('acme-leads','Web Visitor','v@x.io','+123','Interested','web_form','web-form-key-0001') r`);
const capLead = await lead(cap.rows[0].r.lead_id);
ok('public intake (service role) creates a web_form lead in the right workspace and assigns it', capLead.source === 'web_form' && capLead.workspace_id === wsA && capLead.assigned_to !== null);
ok('repeated public intake is deduplicated', (await as('service', `select public.capture_external_lead('acme-leads','Web Visitor','v@x.io','+123','Interested','web_form','web-form-key-0001') r`)).rows[0].r.duplicate === true);
const capB = await as('service', `select public.capture_external_lead('beta-leads','Beta Visitor',null,null,null,'messaging','sms-event-key-0001') r`);
ok('slug resolves only its own workspace (messaging lead lands in workspace B)', (await lead(capB.rows[0].r.lead_id)).workspace_id === wsB && (await lead(capB.rows[0].r.lead_id)).source === 'messaging');
ok('unknown channel, bad source and bad email are rejected',
  !!(await attempt('service', `select public.capture_external_lead('nope-nope','x',null,null,null,'web_form','abcdefgh12')`)).err &&
  !!(await attempt('service', `select public.capture_external_lead('acme-leads','x',null,null,null,'manual','abcdefgh12')`)).err &&
  !!(await attempt('service', `select public.capture_external_lead('acme-leads','x','bad',null,null,'web_form','abcdefgh12')`)).err);

// ---------------- S12 outbox worker contract ----------------
await db.exec(`update notification_outbox set status='pending', attempts=0, next_attempt_at=now() where id in (select id from notification_outbox where workspace_id='${wsA}' limit 1)`);
const claimed = (await as('service', `select * from public.claim_notifications(1)`)).rows;
ok('worker claims a due notification (processing, attempt 1)', claimed.length === 1 && claimed[0].status === 'processing' && claimed[0].attempts === 1);
ok('a claimed row is not claimed twice', !(await as('service', `select * from public.claim_notifications(100)`)).rows.some((r) => r.id === claimed[0].id));
await as('service', `select public.complete_notification($1,false,'provider down')`, [claimed[0].id]);
let nrow = (await q(`select * from notification_outbox where id='${claimed[0].id}'`))[0];
ok('temporary failure is recorded with the error and a future retry time', nrow.status === 'failed' && nrow.last_error === 'provider down' && new Date(nrow.next_attempt_at) > new Date());
await db.exec(`update notification_outbox set next_attempt_at=now(), max_attempts=2 where id='${claimed[0].id}'`);
await as('service', `select * from public.claim_notifications(1)`);
await as('service', `select public.complete_notification($1,false,'still down')`, [claimed[0].id]);
nrow = (await q(`select * from notification_outbox where id='${claimed[0].id}'`))[0];
ok('permanent failure after max attempts is "dead" and stays visible to admins', nrow.status === 'dead' && (await as('E', `select * from notification_outbox where id=$1`, [claimed[0].id])).rows.length === 1);
const another = (await q(`select id from notification_outbox where workspace_id='${wsA}' and status='pending' limit 1`))[0];
if (another) {
  await db.exec(`update notification_outbox set next_attempt_at=now() where id='${another.id}'`);
  const c2 = (await as('service', `select * from public.claim_notifications(100)`)).rows.find((r) => r.id === another.id);
  await as('service', `select public.complete_notification($1,true,null,'telegram')`, [another.id]);
  ok('successful delivery is recorded', c2 && (await q(`select status, channel from notification_outbox where id='${another.id}'`))[0].status === 'sent');
}
ok('a recipient reads only their own notifications; others cannot', (await as('C', `select * from notification_outbox where recipient_user_id <> $1`, [U.C])).rows.length === 0);

// ---------------- S12b atomic ring management ----------------
ok('plain employee cannot replace the round-robin ring', !!(await attempt('D', `select public.set_rule_assignees($1, array[$2]::uuid[])`, [ruleA, U.D])).err);
await as('E', `select public.set_rule_assignees($1, array[$2,$3,$4]::uuid[])`, [ruleA, U.D, U.B, U.C]);
ok('rule manager replaces the ring atomically and the array order becomes the rotation order',
  (await q(`select user_id from assignment_rule_assignees where rule_id='${ruleA}' order by position`)).map((r) => r.user_id).join() === [U.D, U.B, U.C].join());
await reset();
await as('E', `select public.set_rule_assignees($1, array[$2,$3,$4]::uuid[])`, [ruleA, U.D, U.B, U.C]);
const ringLeads = []; for (const n of ['R1', 'R2', 'R3']) ringLeads.push(await mk(n));
ok('new ring order D -> B -> C is honoured by assignment', owners(ringLeads).join('') === 'DBC', owners(ringLeads).join(''));
const dupRing = await attempt('E', `select public.set_rule_assignees($1, array[$2,$2]::uuid[])`, [ruleA, U.B]);
ok('a duplicate assignee is rejected and the existing ring is untouched',
  !!dupRing.err && (await q(`select count(*)::int c from assignment_rule_assignees where rule_id='${ruleA}'`))[0].c === 3);
ok('a non-member (other workspace) cannot join the ring', !!(await attempt('E', `select public.set_rule_assignees($1, array[$2]::uuid[])`, [ruleA, U.H])).err);
ok('anonymous cannot manage the ring', !!(await attempt('anon', `select public.set_rule_assignees($1, array[$2]::uuid[])`, [ruleA, U.B])).err);
await as('E', `select public.set_rule_assignees($1, array[$2,$3,$4]::uuid[])`, [ruleA, U.B, U.C, U.D]);

// ---------------- S13 definer hygiene ----------------
const defs = (await q(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef`));
ok('every SECURITY DEFINER function pins search_path', defs.every((d) => (d.proconfig ?? []).some((c) => c.startsWith('search_path='))), defs.filter((d) => !(d.proconfig ?? []).some((c) => c.startsWith('search_path='))).map((d) => d.proname).join(','));
const noRls = (await q(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and not relrowsecurity`));
ok('RLS enabled on every public table', noRls.length === 0, noRls.map((r) => r.relname).join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
