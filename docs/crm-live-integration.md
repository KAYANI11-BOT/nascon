# Member 3 CRM live integration handoff

## Scope and Git

Implemented on `feature/crm-live-integration`, based on `origin/main` at
`53adca197cdd224df953cbfbad4ef8fedf681436`. PR #7 was already merged before work began.
No commits, pushes, PR creation, history rewrites or automatic merges were performed.
Unrelated `.claude/` settings were preserved. Environment files were not changed.

This is a partial live integration, not a claim that all Member 3 acceptance criteria
or remote persistence have passed. All feasible core integration work is implemented;
the dependencies below remain genuine blockers.

## Implemented

| Module | Frontend | Server | Remote persistence verified |
| --- | --- | --- | --- |
| Contacts | CRUD dialogs, ID links, server search/owner filter/pagination, loading/errors | Authenticated workspace CRUD and reference validation | No |
| Companies | CRUD, search/owner filter/pagination, related contacts by company ID | Authenticated workspace CRUD | No |
| Customer 360 | Contact, exact linked company, contact-ID opportunities, paginated contact audit | ID/workspace-scoped reads; audit permission and no audit snapshots | No |
| Opportunities | CRUD, real contact/company/pipeline/stage/employee IDs, date, currencies, search/sort/multiple filters | Authenticated CRUD, stage membership validation, derived status, monetary redaction | No |
| Pipeline | Paged board, create/delete pipeline, add/rename stage, move opportunities | Each supported change is one database write; stage/status move together | No |
| Custom Fields | Existing demo retained; live dependency stated | Non-schema custom values rejected; unavailable adapters retained | Blocked |
| Saved Filters | Existing builder and browser-tested demo retained; live multi-criteria filters | Persistence remains unavailable; no invented table | Blocked |
| Dashboard | Eight cards, currency-separated charts, three filtered record dialogs, personal scope, device preferences, polling | Six source-backed metric implementations; two explicitly unavailable integration metrics | No |

Backend mode is selected only when demo mode is explicitly disabled. It never falls
back to fixtures because auth or a query failed. The current local configuration still
enables demo mode; no `.env` change was made. Backend routes require the existing
authenticated workspace setup. Writes close dialogs only after confirmation and
invalidate shared CRM/dashboard queries. Polling runs every 30 seconds while mounted.
Caches include workspace, user, role and effective permissions.

## Files

- `src/services/crm-live.contracts.ts`: strict input schemas, workspace/permission guards,
  monetary policy, paginated contracts and minimal reference types.
- `src/services/crm-live.server.ts`: testable RLS-respecting database operations and safe errors.
- `src/services/crm-live.functions.ts`: authenticated TanStack GET/POST boundaries, reference
  queries and contact audit events (without old/new JSON snapshots).
- `src/services/crm-live-adapter.ts`: bridges existing typed service contracts to server functions;
  refuses to silently truncate array-list contracts above 100 records.
- `src/services/contacts.ts`, `companies.ts`, `opportunities.ts`, `pipelines.ts`: use live
  adapters for approved core tables; proposed custom-field adapters remain unavailable.
- `src/services/crm-dashboard.server.ts`: metric definitions and bounded server-only aggregation.
- `src/services/crm-dashboard.functions.ts`: authenticated overview and three drilldowns.
- `src/components/leadguard/crm/live-queries.ts`: live-mode gating and scoped React Query cache.
- `src/components/leadguard/crm/live-crm-page.tsx`: reusable live CRUD forms and paginated lists.
- `src/components/leadguard/crm/live-contact-detail.tsx`: relational Customer 360.
- `src/components/leadguard/crm/live-pipeline.tsx`: board and supported stage configuration.
- `src/components/leadguard/crm/live-dashboard.tsx`: operational metrics, preferences and drilldowns.
- `src/components/leadguard/crm/crm-entry.tsx`: preserves existing explicit demo screens.
- `src/routes/index.tsx`, `contacts.tsx`, `contacts_.$id.tsx`, `companies.tsx`,
  `opportunities.tsx`, `pipeline.tsx`: select the new mode-aware entry components.
- `src/test/crm-live.test.ts`, `crm-live-ui.test.tsx`, `crm-dashboard-ui.test.tsx`:
  server security/validation/metrics and async editor/dashboard interaction tests.
- `scripts/crm-browser-smoke.mjs`: optional Chrome/Playwright local browser smoke checks;
  accepts an installed Playwright module path, adds no project dependency.

## Database verification

Latest main contains Member 1's tenancy/auth/RLS/onboarding foundation and Member 2's
lead automation services/UI/migration/tests. No Member 4 live table or service contract
was available in this checkout for calendar, messaging or payments.

Read-only remote requests used the public configuration, never service-role access:

| Tables / check | Observed result | Meaning |
| --- | --- | --- |
| Supabase public configuration | Present | Does not prove authenticated access |
| companies, contacts, opportunities, pipelines, pipeline_stages | HTTP 401 / 42501 | Anonymous access denied; authenticated availability UNVERIFIED |
| saved_filters, pipeline_custom_fields, pipeline_stage_required_fields | HTTP 404 / PGRST205 | Not exposed in remote API schema; no local migration definition either |
| appointments, payments, refunds, conversations, notes | HTTP 404 / PGRST205 | Missing from API schema; no approved query contract available |
| Migration history / live RLS / authenticated memberships | UNVERIFIED | No authenticated test session or migration-history access used |

The six SQL files were tested only in a fresh local PGlite instance. Nothing was applied
to the remote project. `src/types/database.ts` remains Member 1's hand-written foundation
types, not newly generated remote types. Narrow lead extension contracts avoid editing it.

## Member 1 dependencies (no SQL changed)

1. Verify remote migration history and the complete reviewed chain, then verify real
   confirmed signup, onboarding, membership/permission loading and workspace isolation.
2. Approve and implement `pipeline_custom_fields`: workspace/pipeline FK, stable key, label,
   type, options, required flag, ordering, timestamps and uniqueness within pipeline.
3. Approve `pipeline_stage_required_fields`: workspace/pipeline/stage/field FKs that prevent
   cross-pipeline references and duplicate requirements.
4. Add `opportunities.custom_fields` with approved value typing/storage. Enforce required
   values, dropdown options and safe field/option deletion transactionally in the database
   (including direct table writes), and supply authenticated mutation RPC contracts.
5. Approve `saved_filters`: workspace ID, creator user ID, entity, name, nullable pipeline ID,
   validated versioned conditions, timestamps, per-user naming rules and private RLS.
   Persist stable stage/employee IDs, not demo display names. No tag support without schema.
6. Provide atomic stage reorder and move-and-delete RPCs: authenticate/authorize, lock the
   pipeline, validate workspace and target stage, reject unmet field requirements, move
   dependent opportunities and update positions in one transaction. Stage delete/reorder
   intentionally remain blocked; there are no multi-request browser approximations.
7. Define configurable CRM view/create/edit/delete/export and monetary read/edit permissions.
   Existing catalog only has entity `*.manage` and `records.delete`. New endpoints fail
   closed to Owner for monetary values. Existing SQL grants members direct SELECT/UPDATE
   on opportunity amounts: this remains a database-level F1.4 gap and must be fixed with
   safe privileges/views/RPCs. Server masking alone does not close direct PostgREST access.
8. Decide schema support for Contact status/source and Company email/status. These fields
   are absent from `crm_core.sql`; the live forms omit them instead of pretending to save them.
9. Regenerate database types from the verified schema and perform authenticated remote
   create/refresh/edit/refresh/delete tests in a dedicated test workspace.

Once these objects exist, Member 3 must finish persistent custom fields/Saved Filters and
atomic stage configuration against those approved contracts, then run live acceptance tests.

## Dashboard definitions and limits

Compared against the supplied official problem statement (F5.1–F5.5 and Section 7).

- New leads today uses the workspace timezone and actual `created_at`.
- Open opportunity values are grouped by open **stage type**, pipeline and currency.
- First response is first acknowledgement minus first assignment; workspace figures use
  Member 2's `get_first_response_stats`, personal figures use the user's assigned records.
- Recovery uses Member 2's `get_recovery_queue`, not a fabricated status heuristic.
- Escalations use actual automatic escalation events in the preceding 24 hours.
  Personal escalation figures count events assigning the lead to that user (`new_owner`).
- Availability requires Available status **and** open leads below the employee/rule cap.
- User figures are personal; Owner/Admin figures are workspace-wide, subject to monetary
  restrictions. Today/recovery/escalations open paginated matching records.
- Individual figures and chart sections can be hidden; preferences are remembered on the
  current device, scoped by workspace/user. Cross-device preference persistence is not implemented.
- Appointments and collected payments minus confirmed refunds remain unavailable until
  Member 4 provides authoritative tables/provider-confirmed states, IDs and currency contracts.
- Existing lead RPCs are reused, not changed. General aggregates are bounded at 10,000
  server-side rows (daily counts at 1,000 recent leads); exceeding limits shows unavailable,
  never a truncated total. Member 1 should provide aggregate RPCs for larger datasets and
  snapshot consistency under concurrent writes. Reference selectors have a visible 1,000-row
  limit and preserve omitted existing links. A searchable reference API is needed above it.

Customer 360 conversations/payments/appointments/notes and complete cross-module activity
remain dependent on Member 4/Member 1 contact-ID relationships. Only real contact audit
events are displayed; name-matched samples are never used in backend mode.

## Verification

- Automated unit/component suite: **146 passed across 16 files** (42 new checks).
- Production build: **passed**. Vite reports a large client chunk and the existing
  `vite-tsconfig-paths` configuration advisory; neither failed the build.
- ESLint on all changed TypeScript/TSX files: **passed, zero errors/warnings**.
- TypeScript: **zero new errors**, six existing errors in `settings.tsx`/`shell.tsx`.
- New tests cover auth rejection, workspace scope, permissions, injected identifiers,
  input validation, database confirmation, safe errors, amount/currency protection,
  multi-criteria filtering, stage/status updates, timezone/capacity/personal metrics,
  async forms, reference preservation, three drilldowns and remembered preferences.
- Local existing database suites: 50 RLS/onboarding and 87 lead lifecycle checks passed.
- Real Chrome headless: 14 checks passed, zero page errors. This covers demo Saved Filter
  create/apply/update/delete, demo CRM routes and backend-mode signed-out redirects.
- Browser live authenticated CRUD, refresh persistence, remote RLS and remote metric
  correctness remain UNVERIFIED. No remote user, login or business write was performed.
- Six pre-existing TypeScript errors remain in untouched `settings.tsx`/`shell.tsx`.
- No SQL migrations, auth implementation, teammate lead engine or external integrations
  were modified. The app remains buildable, but release readiness is blocked by the
  remote verification and missing contracts above.
