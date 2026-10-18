// Remote foundation check using ORDINARY user sessions (publishable key + password sign-in).
// Service-role requests bypass RLS and cannot prove isolation, so none are used here.
//
// Run only after the reviewed migrations are applied, with two dedicated, already-confirmed
// test accounts. Values come from .env.test.local (git-ignored), never from the command line:
//   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY)
//   TEST_A_EMAIL, TEST_A_PASSWORD, TEST_B_EMAIL, TEST_B_PASSWORD
// Run: bun run test:remote
//
// Side effects: each test account gets (or reuses) one workspace and one test lead/company.
import { createClient } from '@supabase/supabase-js';

const env = process.env;
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const missing = ['VITE_SUPABASE_URL', 'TEST_A_EMAIL', 'TEST_A_PASSWORD', 'TEST_B_EMAIL', 'TEST_B_PASSWORD'].filter((k) => !env[k]);
if (!key) missing.push('VITE_SUPABASE_PUBLISHABLE_KEY');
if (missing.length) { console.error(`Missing: ${missing.join(', ')}`); process.exit(2); }
if (key.startsWith('sb_secret_')) { console.error('Refusing to run with a secret key: it bypasses RLS.'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function signIn(email, password) {
  const c = client();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for a test account: ${error.message}`);
  return { c, uid: data.user.id };
}

const anon = client();
const A = await signIn(env.TEST_A_EMAIL, env.TEST_A_PASSWORD);
const B = await signIn(env.TEST_B_EMAIL, env.TEST_B_PASSWORD);
ok('both test accounts sign in with a session', Boolean(A.uid && B.uid && A.uid !== B.uid));

const wsA = (await A.c.rpc('create_workspace_with_owner', { p_name: 'LG Test A', p_industry: 'Other', p_timezone: 'UTC' })).data;
const wsA2 = (await A.c.rpc('create_workspace_with_owner', { p_name: 'LG Test A retry', p_industry: 'Other', p_timezone: 'UTC' })).data;
const wsB = (await B.c.rpc('create_workspace_with_owner', { p_name: 'LG Test B', p_industry: 'Other', p_timezone: 'UTC' })).data;
ok('onboarding returns a workspace for each account', Boolean(wsA && wsB && wsA !== wsB));
ok('retrying onboarding returns the same workspace', wsA === wsA2);
const { data: ownA } = await A.c.from('workspace_members').select('role').eq('user_id', A.uid);
ok('A has exactly one membership, as Owner', ownA?.length === 1 && ownA[0].role === 'owner', JSON.stringify(ownA));

for (const t of ['workspaces', 'workspace_members', 'leads', 'companies', 'audit_logs', 'profiles']) {
  const { data, error } = await anon.from(t).select('*').limit(1);
  ok(`signed-out client cannot read ${t}`, Boolean(error) || (data ?? []).length === 0, error?.message ?? `${data?.length} rows`);
}

const { data: leadB } = await B.c.from('leads').insert({ workspace_id: wsB, full_name: 'LG isolation probe' }).select('id').single();
const { data: compB } = await B.c.from('companies').insert({ workspace_id: wsB, name: 'LG isolation company' }).select('id').single();
ok('B can create records in own workspace', Boolean(leadB?.id && compB?.id));

ok('A cannot read workspace B', ((await A.c.from('workspaces').select('id').eq('id', wsB)).data ?? []).length === 0);
ok('A cannot read B leads', ((await A.c.from('leads').select('id').eq('workspace_id', wsB)).data ?? []).length === 0);
ok('A cannot read B memberships', ((await A.c.from('workspace_members').select('id').eq('workspace_id', wsB)).data ?? []).length === 0);
const updB = await A.c.from('leads').update({ full_name: 'tampered' }).eq('id', leadB.id).select('id');
ok('A cannot update B lead', (updB.data ?? []).length === 0, updB.error?.message);
const delB = await A.c.from('companies').delete().eq('id', compB.id).select('id');
ok('A cannot delete B company', (delB.data ?? []).length === 0, delB.error?.message);
const insB = await A.c.from('leads').insert({ workspace_id: wsB, full_name: 'injected' });
ok('A cannot insert into workspace B', Boolean(insB.error), insB.error?.message);
const xfk = await A.c.from('contacts').insert({ workspace_id: wsA, full_name: 'X', company_id: compB.id });
ok('A cannot link own contact to B company', Boolean(xfk.error), xfk.error?.message);

const join = await A.c.from('workspace_members').insert({ workspace_id: wsB, user_id: A.uid, role: 'admin' });
ok('A cannot join workspace B', Boolean(join.error), join.error?.message);
const promote = await A.c.from('workspace_members').update({ role: 'admin' }).eq('user_id', A.uid).select('id');
ok('A cannot change own membership role', Boolean(promote.error) || (promote.data ?? []).length === 0, promote.error?.message);
const moveWs = await A.c.from('workspace_members').update({ workspace_id: wsB }).eq('user_id', A.uid).select('id');
ok('A cannot move own membership to another workspace', Boolean(moveWs.error) || (moveWs.data ?? []).length === 0, moveWs.error?.message);
const forge = await A.c.from('audit_logs').insert({ workspace_id: wsA, action: 'insert', table_name: 'forged' });
ok('A cannot forge audit records', Boolean(forge.error), forge.error?.message);
const { data: auditA } = await A.c.from('audit_logs').select('workspace_id').limit(50);
ok('Owner reads only own workspace audit trail', (auditA ?? []).length > 0 && auditA.every((r) => r.workspace_id === wsA));

// Clean up B's probe rows (B is Owner, so records.delete applies).
await B.c.from('leads').delete().eq('id', leadB.id);
await B.c.from('companies').delete().eq('id', compB.id);
await A.c.auth.signOut(); await B.c.auth.signOut();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
