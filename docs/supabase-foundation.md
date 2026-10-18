# Supabase foundation

Shared authentication, workspace tenancy and database contract for LeadGuard. Read this
before building CRM or lead-automation features.

## Status

| Area | State |
| --- | --- |
| Migrations | Written and reviewed; verified on local embedded Postgres (`bun run test:db`, 50 checks). **Not applied to the remote project.** |
| Authentication UI | Signup, email confirmation, login, logout, session restore, route guard and onboarding are wired to Supabase. |
| CRM data services | Not connected. `src/services/entities.ts` still returns "not connected". |
| Remote verification | Pending: needs configuration, applied migrations and two test accounts (`supabase/tests/verify-remote.mjs`). |

Only the designated database owner applies shared migrations.

## Environment variables (names only)

Put them in `.env.local` at the project root (git-ignored). `.env.example` has placeholders.

| Name | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | browser + server | Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | browser + server | Public key (`sb_publishable_...`), preferred |
| `VITE_SUPABASE_ANON_KEY` | browser + server | Legacy public anon key; used only if the publishable key is empty |
| `VITE_DEMO_MODE` | browser + server | `false` = every app page requires sign-in and a workspace |
| `TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, `TEST_B_PASSWORD` | `.env.test.local` only | Dedicated accounts for the remote isolation check |

No secret or service-role key is used. Never place one in a `VITE_` variable.
`VITE_` values are inlined at build time, so a Lovable or Cloudflare build needs the same
public values configured in that environment.

## Migrations (apply in order)

1. `supabase/migrations/20261018000100_tenancy_foundation.sql`: `private` helper schema, `workspace_role` enum, profiles (auto-created from `auth.users`), workspaces, workspace_members, permission catalog, per-workspace role permissions, RLS helpers.
2. `supabase/migrations/20261018000200_crm_core.sql`: companies, contacts, pipelines, pipeline_stages, opportunities.
3. `supabase/migrations/20261018000300_lead_routing.sql`: assignment_rules, leads, employee_availability, lead_assignments (history), assignment enforcement triggers.
4. `supabase/migrations/20261018000400_audit_logs.sql`: audit_logs and an audit trigger on all business tables.
5. `supabase/migrations/20261018000500_workspace_onboarding.sql`: `public.create_workspace_with_owner(p_name, p_industry, p_timezone)`.

### Security model

- **Workspace isolation:** every business table has `workspace_id`. RLS allows reads only to members (`private.is_workspace_member`) and writes only with the matching permission.
- **Cross-workspace links:** child rows use composite foreign keys `(workspace_id, x_id)`, so a record can never point at a parent, stage or assignee from another workspace. Assignees and owners must be members of the same workspace.
- **Immutable tenancy:** a trigger blocks any change to `workspace_id`.
- **Memberships:** clients can only `SELECT` memberships. There is no client insert, update or delete, so nobody can join a workspace or change a role. A guard trigger also blocks self role changes and owner changes if grants are added later.
- **Roles:** Owner, Admin and User live only on `workspace_members.role`, never on profiles. The Owner always has every permission. Admin and User permissions are configurable in `workspace_role_permissions`, and only the Owner can change them.
- **Audit:** `audit_logs` is written only by a `SECURITY DEFINER` trigger. The actor comes from `auth.uid()`. Clients get `SELECT` (with `audit.view`) and nothing else. `lead_assignments` history is also trigger-written.
- **Functions:** every `SECURITY DEFINER` function sets `search_path = ''`. Helpers live in the unexposed `private` schema. Execute is revoked from `public` and `anon`.
- **No recursive policies:** membership checks run inside `SECURITY DEFINER` helpers that bypass RLS.
- **Onboarding:** the RPC derives the user from the JWT, requires a confirmed email, and creates the workspace, Owner membership, default permissions, a default pipeline with stages, availability and a manual assignment rule in one transaction. Retries are idempotent: an advisory lock plus a unique "one owned workspace per user" index return the existing workspace instead of creating a duplicate.

### Remaining risks and decisions

- **One owned workspace per user (v1).** It is enforced by an index. Users can still be invited into other workspaces once invitations exist. Allowing more than one requires a new migration.
- **Exactly one Owner per workspace.** Ownership transfer, invitations and member removal still need privileged server operations, which are not built yet.
- **Deleting an Owner's auth account** cascades the membership and leaves the workspace without an owner. Handle this in a future account-deletion flow.
- **Audit volume:** full row snapshots are stored, including contact emails. Add retention before heavy automation writes.
- **Any member can read every lead** in their workspace. Restricting Users to their own leads would be a policy change.
- **Types** in `src/types/database.ts` are hand-written. Regenerate them after applying: `npx supabase gen types typescript --linked > src/types/database.ts`.
- The local test stubs Supabase's `auth` schema. The remote check (`verify-remote.mjs`) is still required.

## How feature modules get the user and workspace

```tsx
import { useAuth } from '@/contexts/auth-context';

const { user, activeWorkspace, permissions, can, refresh, signOut } = useAuth();
// user: { id, email, fullName } | null
// activeWorkspace: { workspaceId, role: 'Owner'|'Admin'|'User', workspace: { id, name, industry, timezone } } | null
if (can('leads.manage')) { /* show edit controls (UI hint only; RLS enforces) */ }
```

Server-side code (TanStack server functions or server routes) must create a client per request:

```ts
import { createServerFn } from '@tanstack/react-start';
import { createSupabaseServerClient } from '@/lib/supabase.server';

export const listLeads = createServerFn({ method: 'GET' })
  .validator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const supabase = createSupabaseServerClient(); // runs as the signed-in user, RLS applies
    return supabase.from('leads').select('*').eq('workspace_id', data.workspaceId);
  });
```

Rules:

- Always filter by `workspace_id` and include it on inserts. RLS rejects rows for workspaces you are not a member of.
- Never cache a server client in module scope. `getSupabaseBrowserClient()` is browser-only.
- Do not add Supabase Edge Functions. Privileged automation should use authenticated TanStack server boundaries. A service-role key, if ever needed, stays in server-only (non-`VITE_`) configuration.

## Shared contracts

| File | Provides |
| --- | --- |
| `src/types/database.ts` | `Database` type plus row types (`LeadRow`, `CompanyRow`, ...), `PermissionKey`, `LeadStatus` |
| `src/types/domain.ts` | `AuthContext`, `AuthUser`, `WorkspaceMembership`, `Role`, `ServiceResult` |
| `src/contexts/auth-context.tsx` | `AuthProvider`, `useAuth()`, `authContextQuery()` |
| `src/services/workspace.functions.ts` | `getAuthContext`, `createWorkspace`, `setActiveWorkspace` server functions |
| `src/services/auth.ts` | `authService.signUp/signIn/resendConfirmation/signOut` |
| `src/lib/auth-guard.ts` | `resolveAuthRedirect`, `safeRedirectPath` |
| `src/lib/supabase.ts` | Configuration boundary (`getSupabaseConfiguration`, `isAuthEnforced`) |

Ready for CRM development: companies, contacts, pipelines, stages and opportunities (tables, RLS and types).
Ready for lead automation: leads, availability, assignment rules and assignment history (tables, RLS and triggers). Automation runners themselves are not built.

## Supabase Dashboard configuration

1. **Project URL and key:** open the project's **Connect** dialog, or **Project Settings → API Keys**. Copy the Project URL and the **publishable** key. If you only have legacy keys, use the `anon` `public` key from the legacy tab. Never copy the secret or service_role key.
2. **Email provider:** go to **Authentication → Sign In / Providers → Email**. Keep **Confirm email** enabled.
3. **URL configuration:** go to **Authentication → URL Configuration**.
   - Site URL: your deployed origin, or `http://localhost:8080` while developing.
   - Redirect URLs: `http://localhost:8080/auth/confirm` plus `https://<your-deployed-domain>/auth/confirm`.
4. **Email template (recommended):** go to **Authentication → Emails → Confirm signup** and change the link to
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/onboarding`
   so confirmation works even when the link is opened on another device. The default template also works, but only in the browser that signed up.

### Signup flow with confirmation enabled

1. The user submits signup. Supabase creates the account without a session, and the page shows "Check your inbox".
2. The user opens the email link, which goes to `/auth/confirm`. The server verifies the token, sets session cookies and redirects to `/onboarding`.
3. Onboarding creates the workspace and Owner membership, then the dashboard loads.
4. If the user signs in before confirming, login shows "Confirm your email" with a resend option.
