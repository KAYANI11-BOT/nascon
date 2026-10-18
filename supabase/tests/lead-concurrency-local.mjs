// REAL-concurrency verification of the lead automation migration against an embedded PostgreSQL
// server (many parallel connections, genuine row locks). Local only; never touches a remote DB.
// Run: npm run test:db:concurrency
// NOT covered: pg_cron (extension not available in the embedded server) and Supabase services.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 54329;
const dataDir = mkdtempSync(join(tmpdir(), 'leadguard-pg-'));
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'pw', port: PORT, persistent: false });
let pool;
async function shutdown(code) {
  try { await pool?.end(); } catch {}
  try { await server.stop(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e?.message ?? e); shutdown(2); });

await server.initialise();
await server.start();
await server.createDatabase('lg');
pool = new pg.Pool({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'lg', max: 16 });
const sa = (sql, p) => pool.query(sql, p); // superuser

await sa(`
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
const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await sa(readFileSync(join(dir, f), 'utf8')); console.log('applied', f); }
  catch (e) { console.error('FAILED', f, e.message); await shutdown(1); }
}

const id = (c) => `00000000-0000-4000-8000-0000000000${c}`;
const U = { A: id('0a'), B: id('0b'), C: id('0c'), D: id('0d'), E: id('0e') };
for (const [k, v] of Object.entries(U)) await sa(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [v, `${k.toLowerCase()}@t.local`]);

let passN = 0, failN = 0;
const ok = (name, cond, detail = '') => { cond ? passN++ : failN++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// One request = one transaction on its own pooled connection.
async function as(user, sql, params) {
  const c = await pool.connect();
  const role = user === 'service' ? 'service_role' : 'authenticated';
  const claims = user === 'service' ? '{"role":"service_role"}' : `{"sub":"${U[user]}","role":"authenticated"}`;
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) { try { await c.query('rollback'); } catch {} throw e; }
  finally { c.release(); }
}
const settle = (ps) => Promise.allSettled(ps);
const errs = (rs) => rs.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

const ws = (await as('A', `select public.create_workspace_with_owner('Concurrency Co','Technology','UTC') id`)).rows[0].id;
await sa(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'user'),($1,$3,'user'),($1,$4,'user'),($1,$5,'admin')`, [ws, U.B, U.C, U.D, U.E]);
await sa(`insert into employee_availability (workspace_id, user_id) values ($1,$2),($1,$3),($1,$4),($1,$5)`, [ws, U.B, U.C, U.D, U.E]);
const rule = (await sa(`select id from assignment_rules where workspace_id=$1`, [ws])).rows[0].id;
await sa(`insert into assignment_rule_assignees (rule_id, workspace_id, user_id, position) values ($1,$2,$3,0),($1,$2,$4,1),($1,$2,$5,2)`, [rule, ws, U.B, U.C, U.D]);
async function reset(maxOpen = 100) {
  // multi-statement text: simple query protocol, so no bind parameters (ids are test constants)
  await sa(`delete from leads where workspace_id='${ws}'; delete from assignment_rule_state;
    update employee_availability set status='available', max_open_leads=null where workspace_id='${ws}';
    update assignment_rules set strategy='round_robin', is_active=true, acknowledgement_window_seconds=60, max_open_leads=${maxOpen},
      escalation_timeouts_seconds='{30,20}', max_escalation_levels=3, idle_threshold_seconds=3600,
      backup_user_id='${U.E}', manager_user_id='${U.A}' where id='${rule}'`);
}
let n = 0;
const create = (name, key = `ckey-${++n}-${Math.random().toString(36).slice(2, 8)}`) =>
  as('A', `select * from public.create_lead($1,$2,null,null,null,null,$3)`, [ws, name, key]);
const liveCountSql = `select lead_id, count(*)::int c from lead_assignments where ended_at is null group by lead_id having count(*) > 1`;

// ---- C: concurrent intake: valid single owners, balanced round robin, no capacity violation ----
await reset();
let rs = await settle(Array.from({ length: 30 }, (_, i) => create(`Par ${i}`)));
ok('30 parallel intakes: all succeeded without errors/deadlocks', errs(rs).length === 0, errs(rs)[0] ?? '');
let owners = (await sa(`select assigned_to, count(*)::int c from leads where workspace_id=$1 group by 1 order by 1`, [ws])).rows;
ok('every concurrent lead has exactly one owner, round-robin stays balanced (10/10/10)',
  owners.length === 3 && owners.every((o) => o.c === 10 && [U.B, U.C, U.D].includes(o.assigned_to)), JSON.stringify(owners.map((o) => o.c)));
ok('no lead has two live assignments', (await sa(liveCountSql)).rows.length === 0);

await reset(4);
rs = await settle(Array.from({ length: 15 }, (_, i) => create(`Cap ${i}`)));
const capRows = (await sa(`select assigned_to, count(*)::int c from leads where workspace_id=$1 group by 1`, [ws])).rows;
const empMax = Math.max(0, ...capRows.filter((r) => [U.B, U.C, U.D].includes(r.assigned_to)).map((r) => r.c));
ok('capacity (4) never exceeded under 15 parallel intakes', errs(rs).length === 0 && empMax <= 4, `max per employee ${empMax}, errors ${errs(rs)[0] ?? 'none'}`);
ok('overflow is routed to backup/manager, none dropped', capRows.reduce((a, r) => a + r.c, 0) === 15 && capRows.every((r) => r.assigned_to !== null));

// ---- duplicate intake with one idempotency key ----
await reset();
const dupKey = 'same-key-parallel-001';
rs = await settle(Array.from({ length: 12 }, () => create('Dup', dupKey)));
const dupIds = new Set(rs.filter((r) => r.status === 'fulfilled').map((r) => r.value.rows[0].id));
ok('12 parallel requests with one idempotency key create exactly one lead',
  dupIds.size === 1 && (await sa(`select count(*)::int c from leads where idempotency_key=$1`, [dupKey])).rows[0].c === 1, errs(rs)[0] ?? '');
const svcKey = 'svc-intake-key-0001';
await sa(`insert into lead_intake_channels (slug, workspace_id) values ('conc-leads',$1)`, [ws]);
rs = await settle(Array.from({ length: 10 }, () => as('service', `select public.capture_external_lead('conc-leads','Visitor',null,null,null,'web_form',$1) r`, [svcKey])));
ok('10 parallel public intakes with one key create exactly one lead',
  new Set(rs.filter((r) => r.status === 'fulfilled').map((r) => r.value.rows[0].r.lead_id)).size === 1, errs(rs)[0] ?? '');

// ---- A: overlapping schedulers ----
await reset();
const overdueIds = [];
for (let i = 0; i < 20; i++) overdueIds.push((await create(`Overdue ${i}`)).rows[0].id);
await sa(`update leads set acknowledgement_due_at = now() - interval '1 second' where workspace_id=$1`, [ws]);
rs = await settle(Array.from({ length: 8 }, () => sa(`select public.escalate_overdue_leads(100) n`)));
const total = rs.filter((r) => r.status === 'fulfilled').reduce((a, r) => a + r.value.rows[0].n, 0);
ok('8 overlapping scheduler runs: no errors or deadlocks', errs(rs).length === 0, errs(rs)[0] ?? '');
ok('20 overdue leads escalated exactly 20 times in total across the runs', total === 20, `total ${total}`);
const escCounts = (await sa(`select lead_id, count(*)::int c from lead_escalations group by lead_id`)).rows;
ok('every lead has exactly one escalation event and one escalation notification',
  escCounts.length === 20 && escCounts.every((r) => r.c === 1) &&
  (await sa(`select count(*)::int c from notification_outbox where event_type='lead_escalated'`)).rows[0].c === 20);
ok('no duplicate live assignments after concurrent escalation', (await sa(liveCountSql)).rows.length === 0);
ok('escalated leads moved to a different owner at level 1', (await sa(`select count(*)::int c from leads where workspace_id=$1 and escalation_level=1`, [ws])).rows[0].c === 20);

// ---- B: acknowledge racing escalation ----
await reset();
const raceIds = [];
for (let i = 0; i < 30; i++) raceIds.push((await create(`Race ${i}`)).rows[0]);
await sa(`update leads set acknowledgement_due_at = now() - interval '1 second' where workspace_id=$1`, [ws]);
const name = (uid) => Object.keys(U).find((k) => U[k] === uid);
const outcomes = await Promise.all(raceIds.map(async (l) => {
  const [ack, esc] = await settle([
    as(name(l.assigned_to), `select public.acknowledge_lead($1,$2) r`, [l.id, l.current_assignment_id]),
    sa(`select public.escalate_overdue_leads(100) n`),
  ]).then((x) => x);
  return { id: l.id, assignment: l.current_assignment_id, ackOk: ack.status === 'fulfilled', ackErr: ack.reason?.message, escErr: esc.reason?.message };
}));
let bothWon = 0, ackWins = 0, escWins = 0, inconsistent = [];
for (const o of outcomes) {
  const lead = (await sa(`select acknowledged_at, escalation_level, current_assignment_id from leads where id=$1`, [o.id])).rows[0];
  const escalatedFromOriginal = (await sa(`select count(*)::int c from lead_escalations where from_assignment_id=$1`, [o.assignment])).rows[0].c;
  const acked = (await sa(`select acknowledged_at from lead_assignments where id=$1`, [o.assignment])).rows[0].acknowledged_at !== null;
  if (acked && escalatedFromOriginal) bothWon++;
  else if (acked) ackWins++;
  else if (escalatedFromOriginal && !o.ackOk) escWins++;
  else inconsistent.push(o.id);
}
ok('ack vs escalation race (30 leads): never both applied to the same assignment', bothWon === 0, `ack won ${ackWins}, escalation won ${escWins}`);
ok('every race has exactly one winner; a losing ack is rejected, never silently applied', inconsistent.length === 0 && ackWins + escWins === 30, `inconsistent ${inconsistent.length}`);
ok('no scheduler/ack errors other than the expected stale-assignment rejection',
  outcomes.every((o) => !o.escErr && (!o.ackErr || /no longer current/.test(o.ackErr))), outcomes.find((o) => o.escErr)?.escErr ?? '');

// ---- E: availability change racing assignment ----
await reset(100);
const flight = [
  ...Array.from({ length: 24 }, (_, i) => create(`Avail ${i}`)),
  as('B', `update employee_availability set status='offline' where user_id=$1 and workspace_id=$2`, [U.B, ws]),
];
rs = await settle(flight);
ok('assignments racing an availability change: no errors or deadlocks', errs(rs).length === 0, errs(rs)[0] ?? '');
ok('after the dust settles, the offline employee holds no unacknowledged leads (none committed to an unavailable owner)',
  (await sa(`select count(*)::int c from leads where workspace_id=$1 and assigned_to=$2 and acknowledged_at is null`, [ws, U.B])).rows[0].c === 0);
ok('all 24 leads still have an owner', (await sa(`select count(*)::int c from leads where workspace_id=$1 and assigned_to is not null`, [ws])).rows[0].c === 24);
ok('no duplicate live assignments', (await sa(liveCountSql)).rows.length === 0);

// ---- outbox claiming ----
await reset();
await sa(`delete from notification_outbox`);
const anyLead = (await create('Outbox host')).rows[0].id;
await sa(`delete from notification_outbox`);
for (let i = 0; i < 40; i++) {
  await sa(`insert into notification_outbox (workspace_id, lead_id, recipient_user_id, event_id, event_type, payload)
    values ($1,$2,$3,gen_random_uuid(),'lead_assigned','{}'::jsonb)`, [ws, anyLead, U.B]);
}
rs = await settle(Array.from({ length: 6 }, () => as('service', `select id from public.claim_notifications(10)`)));
const claimedIds = rs.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value.rows.map((x) => x.id));
ok('6 parallel workers claim disjoint batches: no row claimed twice', errs(rs).length === 0 && new Set(claimedIds).size === claimedIds.length, errs(rs)[0] ?? '');
ok('claimed rows cover the due queue (up to 40, batches of 10)', claimedIds.length >= 40 || claimedIds.length === 40, `claimed ${claimedIds.length}`);

// ---- global invariants ----
ok('invariant: no lead anywhere has more than one live assignment', (await sa(liveCountSql)).rows.length === 0);
ok('invariant: every owned lead points to its live assignment',
  (await sa(`select count(*)::int c from leads l where l.assigned_to is not null and not exists
    (select 1 from lead_assignments a where a.id = l.current_assignment_id and a.ended_at is null and a.assigned_to = l.assigned_to)`)).rows[0].c === 0);

console.log(`\n${passN} passed, ${failN} failed`);
await shutdown(failN ? 1 : 0);
