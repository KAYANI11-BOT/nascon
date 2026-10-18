// Local-only verification of LeadGuard migrations against an embedded Postgres with a
// stubbed Supabase auth schema. Never connects to a remote database.
// Run: bun run test:db (or npm run test:db)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('../migrations/', import.meta.url));
const db = new PGlite();
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e?.message ?? e); process.exit(2); });

// Mimic Supabase roles, auth schema and default privileges (so our revokes are exercised).
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

const U = { A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b', C: '00000000-0000-4000-8000-00000000000c', D: '00000000-0000-4000-8000-00000000000d', E: '00000000-0000-4000-8000-00000000000e' };
await db.exec(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('${U.A}', 'a@test.local', '{"full_name":"Alice A"}', now()), ('${U.B}', 'b@test.local', '{"full_name":"Bob B"}', now()),
  ('${U.C}', 'c@test.local', '{}', null), ('${U.D}', 'd@test.local', '{"full_name":"Dana D"}', now()), ('${U.E}', 'e@test.local', '{}', now());`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function as(user, sql, params) {
  // Each call is its own transaction with a fresh role/claims, like one PostgREST request.
  const claims = user === 'anon' ? '{"role":"anon"}' : `{"sub":"${U[user]}","role":"authenticated"}`;
  await db.exec(`begin; set local role ${user === 'anon' ? 'anon' : 'authenticated'}; select set_config('request.jwt.claims', '${claims}', true);`);
  try { const r = await db.query(sql, params); await db.exec('commit'); return r; }
  catch (e) { await db.exec('rollback'); throw e; }
}
async function attempt(user, sql, params) { try { return { res: await as(user, sql, params) }; } catch (e) { return { err: e.message }; } }

// Onboarding
const wsA = (await as('A', `select public.create_workspace_with_owner('Alpha Co', 'Technology', 'Asia/Karachi') id`)).rows[0].id;
const wsA2 = (await as('A', `select public.create_workspace_with_owner('Alpha Co again', 'Technology', 'UTC') id`)).rows[0].id;
ok('retrying onboarding returns the same workspace', wsA === wsA2);
const counts = (await db.query(`select (select count(*) from workspaces where created_by='${U.A}')::int ws, (select count(*) from workspace_members where user_id='${U.A}')::int m, (select role from workspace_members where user_id='${U.A}') r`)).rows[0];
ok('exactly one workspace and one Owner membership', counts.ws === 1 && counts.m === 1 && counts.r === 'owner', JSON.stringify(counts));
ok('default pipeline with 6 stages seeded', (await db.query(`select count(*)::int c from pipeline_stages where workspace_id='${wsA}'`)).rows[0].c === 6);
ok('role permissions seeded for admin and user', (await db.query(`select count(*)::int c from workspace_role_permissions where workspace_id='${wsA}'`)).rows[0].c === 24);
const c1 = await attempt('C', `select public.create_workspace_with_owner('Unconfirmed', 'Other', 'UTC')`);
ok('unconfirmed user cannot create a workspace', !!c1.err, c1.err);
ok('anonymous caller cannot create a workspace', !!(await attempt('anon', `select public.create_workspace_with_owner('Anon', 'Other', 'UTC')`)).err);
ok('invalid timezone rejected', !!(await attempt('B', `select public.create_workspace_with_owner('Bad tz', 'Other', 'Mars/Base')`)).err);
const wsB = (await as('B', `select public.create_workspace_with_owner('Beta Ltd', 'Other', 'UTC') id`)).rows[0].id;

// Concurrent-ish duplicate protection at the index level
const dupOwner = await db.query(`select 1`).then(async () => { try { await db.query(`insert into workspace_members (workspace_id, user_id, role) values ('${wsB}', '${U.A}', 'owner')`); return 'inserted'; } catch (e) { return e.message; } });
ok('unique index blocks a second owned workspace / second owner', dupOwner !== 'inserted', dupOwner);

// Seed records in B as B
const compB = (await as('B', `insert into companies (workspace_id, name) values ('${wsB}', 'Beta Customer') returning id`)).rows[0].id;
const leadB = (await as('B', `insert into leads (workspace_id, full_name, email) values ('${wsB}', 'Lead in B', 'lb@x.io') returning id`)).rows[0].id;
const leadA = (await as('A', `insert into leads (workspace_id, full_name, assigned_to) values ('${wsA}', 'Lead in A', '${U.A}') returning id`)).rows[0].id;

// Signed-out access
for (const t of ['workspaces', 'workspace_members', 'leads', 'companies', 'profiles', 'audit_logs']) {
  const r = await attempt('anon', `select * from public.${t}`);
  ok(`anon cannot read ${t}`, !!r.err || r.res.rows.length === 0, r.err ?? `${r.res.rows.length} rows`);
}

// Cross-workspace isolation
ok('A cannot see workspace B', (await as('A', `select id from workspaces`)).rows.every((r) => r.id === wsA));
ok('A cannot read B leads', (await as('A', `select id from leads where id='${leadB}'`)).rows.length === 0);
ok('A cannot read B memberships', (await as('A', `select * from workspace_members where workspace_id='${wsB}'`)).rows.length === 0);
ok('A cannot read B profile', (await as('A', `select * from profiles where id='${U.B}'`)).rows.length === 0);
ok('A can read own profile', (await as('A', `select full_name from profiles where id='${U.A}'`)).rows[0]?.full_name === 'Alice A');
const updB = await as('A', `update leads set full_name='hacked' where id='${leadB}'`);
ok('A cannot update B lead', updB.affectedRows === 0);
const delB = await as('A', `delete from companies where id='${compB}'`);
ok('A cannot delete B company', delB.affectedRows === 0);
const insB = await attempt('A', `insert into leads (workspace_id, full_name) values ('${wsB}', 'injected')`);
ok('A cannot insert into workspace B', !!insB.err, insB.err);
const moveA = await attempt('A', `update leads set workspace_id='${wsB}' where id='${leadA}'`);
ok('A cannot move a record to another workspace', !!moveA.err, moveA.err);
const xfk = await attempt('A', `insert into contacts (workspace_id, full_name, company_id) values ('${wsA}', 'X', '${compB}')`);
ok('cross-workspace link (A contact -> B company) rejected', !!xfk.err, xfk.err);
const xassign = await attempt('A', `update leads set assigned_to='${U.B}' where id='${leadA}'`);
ok('cannot assign a lead to a non-member', !!xassign.err, xassign.err);

// Membership / role protection
const joinB = await attempt('A', `insert into workspace_members (workspace_id, user_id, role) values ('${wsB}', '${U.A}', 'admin')`);
ok("A cannot join workspace B", !!joinB.err, joinB.err);
const selfPromote = await attempt('A', `update workspace_members set role='admin' where user_id='${U.A}'`);
ok('member role update denied to clients', !!selfPromote.err, selfPromote.err);
const wsCreateDirect = await attempt('A', `insert into workspaces (name) values ('direct')`);
ok('direct workspace insert denied', !!wsCreateDirect.err, wsCreateDirect.err);

// Add D as User and E as Admin of A (privileged setup, like a future invitation operation)
await db.exec(`insert into workspace_members (workspace_id, user_id, role) values ('${wsA}', '${U.D}', 'user'), ('${wsA}', '${U.E}', 'admin');`);
ok('teammates can see each other\'s profiles', (await as('D', `select id from profiles where id='${U.A}'`)).rows.length === 1);
const dPerm = await as('D', `update workspace_role_permissions set allowed=true where workspace_id='${wsA}' and role='user'`);
ok('User cannot change role permissions', dPerm.affectedRows === 0);
const ePerm = await as('E', `update workspace_role_permissions set allowed=true where workspace_id='${wsA}' and role='admin' and permission_key='audit.view'`);
ok('Admin cannot change role permissions (Owner only)', ePerm.affectedRows === 0);
const dPipe = await attempt('D', `insert into pipelines (workspace_id, name) values ('${wsA}', 'mine')`);
ok('User without pipelines.manage cannot create pipelines', !!dPipe.err, dPipe.err);
const dLead = (await as('D', `insert into leads (workspace_id, full_name) values ('${wsA}', 'D lead') returning id`)).rows[0].id;
const dAssign = await attempt('D', `update leads set assigned_to='${U.E}' where id='${dLead}'`);
ok('User without leads.assign cannot reassign', !!dAssign.err, dAssign.err);
const eAssign = await attempt('E', `update leads set assigned_to='${U.D}' where id='${dLead}'`);
ok('Admin with leads.assign can assign within workspace', !eAssign.err, eAssign.err);
const dDel = await as('D', `delete from leads where id='${dLead}'`);
ok('User without records.delete cannot delete', dDel.affectedRows === 0);
const dAudit = await as('D', `select * from audit_logs`);
ok('User without audit.view cannot read audit logs', dAudit.rows.length === 0);
const dAvail = await as('D', `update employee_availability set status='busy' where user_id='${U.A}'`);
ok('User cannot change others\' availability', dAvail.affectedRows === 0);
await db.exec(`insert into employee_availability (workspace_id, user_id) values ('${wsA}', '${U.D}')`);
const dAvailSelf = await as('D', `update employee_availability set status='busy' where user_id='${U.D}' and workspace_id='${wsA}'`);
ok('User can change own availability', dAvailSelf.affectedRows === 1);
const ePromote = await attempt('E', `update workspace_members set role='owner' where user_id='${U.E}'`);
ok('Admin cannot promote self', !!ePromote.err, ePromote.err);

// Audit integrity
const aAudit = await as('A', `select table_name, actor_id from audit_logs`);
ok('Owner reads own workspace audit trail', aAudit.rows.length > 0 && (await as('A', `select 1 from audit_logs where workspace_id='${wsB}'`)).rows.length === 0, `${aAudit.rows.length} rows`);
ok('assignment history recorded', (await as('A', `select count(*)::int c from lead_assignments where lead_id='${dLead}'`)).rows[0].c === 1);
for (const [label, sql] of [
  ['insert', `insert into audit_logs (workspace_id, action, table_name) values ('${wsA}', 'insert', 'forged')`],
  ['update', `update audit_logs set table_name='x'`],
  ['delete', `delete from audit_logs`],
  ['insert assignment history', `insert into lead_assignments (workspace_id, lead_id) values ('${wsA}', '${leadA}')`],
]) { const r = await attempt('A', sql); ok(`client cannot ${label} audit records`, !!r.err, r.err); }

// Privileged functions are not callable by anon, and private helpers are not in the API schema
const anonFn = await attempt('anon', `select private.is_workspace_member('${wsA}')`);
ok('anon cannot call private helpers', !!anonFn.err, anonFn.err);
const defs = (await db.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef`)).rows;
ok('every SECURITY DEFINER function pins search_path', defs.every((d) => (d.proconfig ?? []).some((c) => c.startsWith('search_path='))), defs.map((d) => d.proname).join(', '));
const noRls = (await db.query(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and not relrowsecurity`)).rows;
ok('RLS enabled on every public table', noRls.length === 0, noRls.map((r) => r.relname).join(', '));

// User deletion cascades cleanly
const delUser = await db.query(`delete from auth.users where id='${U.D}'`).then(() => 'ok', (e) => e.message);
ok('deleting a non-owner user account cascades cleanly', delUser === 'ok', delUser);
const delWs = await db.query(`delete from workspaces where id='${wsB}'`).then(() => 'ok', (e) => e.message);
ok('deleting a workspace cascades cleanly (service operation)', delWs === 'ok', delWs);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

