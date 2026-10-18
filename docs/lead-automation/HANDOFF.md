# Lead Automation (Member 2) — Handoff

**Legend:** *Verified* = executed locally and passed. *Not verified* = written but never exercised against the real thing. Nothing here has been applied to any shared Supabase project, and the migration needs Member 1's review before it is.

The database is the source of truth and the only scheduler; the browser never escalates anything.

## How to run the checks
| Command | What it covers | Last result |
|---|---|---|
| `npm test` | unit + component tests (engine, service with fake client, intake rules, rules form, countdown render, routing, auth guard) | 70 passed |
| `npm run test:db` | Member 1's RLS suite, run against the full migration chain incl. mine | 50 passed |
| `npm run test:db:leads` | lead lifecycle on PGlite (single connection) | 87 passed |
| `npm run test:db:concurrency` | **real PostgreSQL 17.10** (embedded), many parallel connections | 23 passed |
| `npx vite build` | production build | exit 0 |
| `npx tsc --noEmit` | typecheck | no errors in lead files; pre-existing errors remain in `settings.tsx` / `shell.tsx` |

## Verified behaviour
- **Capture:** manual entry (`create_lead`, idempotent), public/messaging intake (`capture_external_lead`, service role only, slug → workspace, deduplicated), source labels, validation.
- **Assignment:** availability-aware round robin persisted in `assignment_rule_state`, per-employee/rule caps, busy/on_leave/offline skipped, backup → manager → durable `ownership_exception` (owner alerted).
- **Acknowledgement:** assignee or `leads.assign` supervisor only, stale assignment rejected, idempotent; implicit ack via `record_lead_action`; first-response stats.
- **Escalation:** peer → backup → manager at per-level timeouts, never back to a previous owner, stops at the final level, one escalation per assignment, one outbox row per escalation.
- **Absence:** on_leave/offline/away immediately reassigns unacknowledged leads (trigger, so direct table updates work); not counted as escalation; acknowledged leads kept + flagged (or reassigned by policy).
- **Recovery:** overdue / ≥2 escalations since last review / idle / ownership exception / unassigned, filters, `total_count` pagination, explicit `resolve_recovery`.
- **Real concurrency (parallel connections):** 30 parallel intakes → 10/10/10, no deadlock; capacity never exceeded; 12 parallel same-key requests → 1 lead; 8 overlapping schedulers escalate 20 leads exactly 20 times; 30 ack-vs-escalate races (12 ack, 18 escalation, never both, loser rejected); intake racing an availability change; 6 parallel outbox workers claim disjoint batches.
- **Security:** clients cannot write lifecycle columns, anon/employees cannot call service functions, cross-workspace denied, all SECURITY DEFINER functions pin `search_path`, RLS on every table.

## Frontend (live mode when signed in with a workspace; otherwise the existing demo pages render unchanged)
`/leads` (search, status filter, pagination, add lead, countdown cell), `/leads/$id` (countdown, acknowledge, reassign, assignment history, escalation timeline), `/recovery` (filters, reasons, reassign, resolve), `/availability` (persisted 4-status control), `/assignment-rules` (strategy, windows, levels, caps, backup/manager, ring order), `/lead-capture/$workspaceSlug` (public form: honeypot, min fill time, rate limit, idempotency key). Success messages appear only after the server confirms.
Realtime: subscription on lead tables with cleanup, plus 15 s polling fallback.

## Not verified (be honest in the demo)
- **The live screens against a real Supabase project.** They are typed, built and unit-tested through a fake client, but never driven in a browser against PostgREST/Auth/Realtime. Needs a configured project with the migration applied.
- **pg_cron and its schedule.** The extension is not in the embedded server. The migration schedules `'10 seconds'` and falls back to every minute, conditionally. If only per-minute cron exists, escalation can lag up to ~60 s. Do not claim exact-second escalation until confirmed on the project.
- **Supabase Realtime publication** (added conditionally in the migration) not exercised.
- **Messaging intake:** only the DB function exists; Member 4's webhook is untested with a real provider.
- **Provider delivery** (Telegram etc.) is Member 4's. The outbox/worker contract is verified at the database level only.
- **Public form rate limiter** is in-memory per server instance (the DB adds a coarse 60/min/workspace backstop). It needs `SUPABASE_SERVICE_ROLE_KEY` as a *server-only* env var; without it the form reports "temporarily unavailable" rather than pretending to save. No bot-protection service (CAPTCHA) is integrated: honeypot + minimum fill time only.
- **Implicit acknowledgement:** the lead detail page now has a "Log activity" form (note or call). It persists a real row in `lead_actions` (with an optional note, deduplicated by a per-submission key) and, when the current owner logs it, acknowledges the lead. Messages, stage changes and appointments are still recorded by Members 3/4's modules, which must call `record_lead_action`; nothing calls it for those yet. Verified in the DB suites and service tests; the form itself has not been driven in a browser.

## Review points for Member 1 (this work touches your objects)
1. **Replaced functions:** `private.guard_lead_assignment` (adds `current_user in ('authenticated','anon')` so definer automation is exempt from the client `leads.assign` check) and `private.record_lead_assignment` (richer history; ids pre-generated into `leads.current_assignment_id`).
2. **Availability:** adds `on_leave` (official); `away` kept as legacy and treated as absent. `src/types/database.ts` still lists `away`.
3. **Extended tables (additive columns):** `leads`, `assignment_rules`, `lead_assignments` (no longer purely append-only: `ended_at`/ack columns are set by definer code).
4. **New triggers:** `leads_lifecycle` (blocks client writes to lifecycle columns), `leads_auto_assign` (only for `round_robin`/`availability` rules), `employee_availability_reassign`.
5. `current_assignment_id` has no FK (circular with `lead_assignments`); invariants are trigger-maintained and tested. Multiple active rules: highest `priority`, then oldest, wins.
6. **Shared-file edits (one line each):** `src/lib/auth-guard.ts` whitelists `/lead-capture/` (public form); `package.json` adds scripts and dev deps `embedded-postgres`, `pg`; `src/routeTree.gen.ts` regenerated.
7. **Route rename:** `leads.$id.tsx` → `leads_.$id.tsx`. `/leads/<id>` previously rendered the list because `leads.tsx` has no `<Outlet/>` (same fix Member 3 applied to contacts).
8. The migration is manual-review only; apply order matters (…0500 then 0600).

## Contracts
**Rules:** `assignment_rules` + `assignment_rule_assignees` (ring order = `position`; replace atomically with `set_rule_assignees`). `strategy` `manual` = no auto-assign. Stage by level: ≤max-2 peer, =max-1 backup, ≥max manager.
**Client RPCs:** `create_lead`, `acknowledge_lead`, `record_lead_action`, `reassign_lead` (optimistic `version`), `resolve_recovery`, `get_recovery_queue`, `get_first_response_stats`, `set_rule_assignees`. Availability = plain upsert on `employee_availability`.
**Service-role only:** `capture_external_lead`, `escalate_overdue_leads`, `claim_notifications`, `complete_notification`.
**Member 3:** call `record_lead_action` after a successfully persisted note / message / call / stage change / appointment. First response = `first_acknowledged_at − first_assigned_at`; use `get_first_response_stats`.
**Member 4:** outbox `notification_outbox`, unique `(workspace_id, recipient_user_id, event_type, event_id)`. Payload: `workspace_id, lead_id, recipient_user_id, event_id, event_type, lead_name, source, reason, escalation_level, lead_url (relative), created_at`. Loop: `claim_notifications` → provider call **outside** any lead transaction using `event_id` as the idempotency key → `complete_notification`. Backoff `15s·2^attempts` capped at 15 min; `dead` after `max_attempts`, visible to `assignment_rules.manage`. At-least-once delivery. Destinations: `notification_destinations`. Messaging webhook: call `capture_external_lead` with `provider:eventId` in the idempotency key; F3.1 messaging is not complete until tested with a real webhook.

## Demo script (once the project has the migration, a service key and a sample workspace)
1. `/assignment-rules`: strategy round robin, ack window 20 s, timeouts `15, 15`, 3 levels, ring of 2–3 employees, backup, manager; save.
2. `/leads` → Add lead: shows the owner and a live countdown. Open it, Acknowledge: no escalation follows.
3. Add another lead and wait: the owner changes, history and escalation timeline show it, the outbox gains a `lead_escalated` row (watch for the scheduler interval limit above).
4. `/availability`: set the owner On leave: their unacknowledged leads move immediately.
5. `/recovery`: shows overdue/idle reasons; reassign or resolve an acknowledged lead.
6. `/lead-capture/<slug>`: submit the public form; the lead appears with source "Web form".
