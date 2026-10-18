# Lead Automation (Member 2) — Handoff

**Status legend:** *Verified* = executed locally and passed. *Written, untested* = exists, never run. *Blocked* = needs another member / a real Supabase project.

Nothing here has been applied to any shared Supabase project. The database is the source of truth and the only scheduler; the browser never escalates anything.

## What is verified (local PGlite, `npm run test:db:leads`, 81 checks)
Run against Member 1's migrations 000100–000500 plus `20261018000600_lead_automation.sql`. Member 1's own `npm run test:db` (50 checks) still passes with the new migration applied.

- Round robin B→C→D→B persisted in `assignment_rule_state`; busy / on_leave / offline skipped; per-employee and rule caps enforced.
- Fallback order backup → manager → durable `ownership_exception` (never silently assigned; owner alerted via outbox).
- Idempotent intake (`unique(workspace_id, idempotency_key)`), single live assignment per lead, history/deadline/ack ledger.
- Acknowledge: current assignee or `leads.assign` supervisor only; stale assignment rejected; re-ack idempotent. Implicit ack via `record_lead_action` (dedupe key).
- Escalation: peer → backup → manager at configured per-level timeouts, no repeats of previous owners, stops at `max_escalation_levels`; one escalation per assignment (`lead_escalations.from_assignment_id` unique); one outbox row per escalation.
- Absence (`on_leave`/`offline`/legacy `away`) reassigns unacknowledged leads immediately via trigger (works for direct table updates), without counting as an escalation; acknowledged leads kept and flagged under `keep_and_flag`, moved under `reassign`.
- Recovery queue (overdue / ≥2 escalations since last review / idle / ownership exception / unassigned) with filters and `total_count` pagination; explicit `resolve_recovery`.
- Manual `reassign_lead` (optimistic `version`), first-response stats, outbox claim/complete/retry/dead contract.
- Security: clients cannot write lifecycle columns directly; anon/employees cannot call service functions; cross-workspace reads/acks denied; all SECURITY DEFINER functions pin `search_path`; RLS on every table.

## Honest limits (not verified)
- **Real concurrency.** PGlite is single-connection. Races are verified only as strict orderings (ack→escalate, escalate→ack, repeated runs). The row-lock design (lock order always rule → lead; unique escalation anchor) is reasoned, not stress-tested.
- **Scheduler.** `pg_cron` / sub-minute scheduling is conditional in the migration and untested. If only per-minute cron is available escalation latency is up to ~60 s: do not claim exact-second escalation.
- **Real Supabase** (PostgREST, JWT, Realtime publication) not exercised.
- **No frontend is wired yet.** `/leads`, `/leads/$id`, `/recovery`, `/availability`, `/assignment-rules` are still demo-only; `src/services/leads.ts` still returns "Configuration required".
- **Public intake route and messaging webhook** are not written: only the DB function `capture_external_lead` (service role only). Rate limiting beyond a coarse 60/min DB backstop and bot protection belong in the TanStack server function.
- **Provider delivery** (Telegram etc.) is Member 4's; the outbox/worker contract is below.

## Review points for Member 1 (this migration touches your objects)
1. **Replaced functions:** `private.guard_lead_assignment` (adds `current_user in ('authenticated','anon')` so definer automation is exempt from the `leads.assign` client check) and `private.record_lead_assignment` (richer history row; ids pre-generated into `leads.current_assignment_id`).
2. **Availability status:** adds `on_leave` (official). `away` kept as a legacy value and treated as absent. `src/types/database.ts` (`AvailabilityStatus`) and the demo UI still say `away`; update when wiring `/availability`.
3. **Tables extended:** `leads`, `assignment_rules`, `lead_assignments` (additive columns only). `lead_assignments` is no longer purely append-only: `ended_at` / ack columns are set by definer code.
4. **Triggers added on `leads`:** `leads_lifecycle` (BEFORE, invoker, blocks client writes to lifecycle columns and computes deadlines on direct reassignment), `leads_auto_assign` (AFTER INSERT, only when the active rule's strategy is `round_robin`/`availability`). `employee_availability_reassign` on availability.
5. `current_assignment_id` has no FK (circular with `lead_assignments`); invariants are trigger-maintained and tested.
6. Multiple active rules: the highest `priority`, then oldest, wins.
7. Apply order matters; migration is manual-review only.

## Contracts
**Rules (`assignment_rules` + `assignment_rule_assignees`)**: `strategy` (`manual` = no auto-assign; `round_robin`/`availability` both availability-aware), `acknowledgement_window_seconds` (falls back to minutes×60), `escalation_timeouts_seconds[level]`, `max_escalation_levels` (stage by level: ≤max-2 peer, =max-1 backup, ≥max manager), `backup_user_id`, `manager_user_id`, `max_open_leads` (overridable per employee in `employee_availability.max_open_leads`), `idle_threshold_seconds`, `acknowledged_absence_policy`. Ring order = `assignment_rule_assignees.position`.

**Client RPCs (authenticated):** `create_lead`, `acknowledge_lead(lead, assignment)`, `record_lead_action(lead, action, dedupe_key)`, `reassign_lead(lead, to, expected_version, reason)`, `resolve_recovery`, `get_recovery_queue(...)`, `get_first_response_stats`. Availability changes are plain upserts on `employee_availability` (the trigger reassigns).

**Service-role only:** `capture_external_lead(slug, name, email, phone, message, source, idempotency_key)`, `escalate_overdue_leads(batch)`, `claim_notifications(limit)`, `complete_notification(id, success, error, channel)`.

**Member 3:** call `record_lead_action` after a *successfully persisted* note / message / call / stage change / appointment. First response = `first_acknowledged_at − first_assigned_at` (never reset); use `get_first_response_stats`. `leads.contact_id` is Member 1's existing FK.

**Member 4:** outbox `notification_outbox`, unique `(workspace_id, recipient_user_id, event_type, event_id)`. Payload keys: `workspace_id, lead_id, recipient_user_id, event_id, event_type, lead_name, source, reason, escalation_level, lead_url, created_at`; `lead_url` is relative (`/leads/<id>`), prefix your base URL. Worker loop: `claim_notifications` → call provider **outside** any lead transaction using `event_id` as idempotency key → `complete_notification`. Backoff `15s·2^attempts` capped at 15 min; `dead` after `max_attempts` (visible to `assignment_rules.manage`). Delivery is at-least-once. Destinations: `notification_destinations(workspace_id, user_id, channel, address)`, self-managed. Webhook messaging intake: call `capture_external_lead` with `provider:eventId` folded into the idempotency key; F3.1 messaging is **not** complete until tested with a real provider webhook.

## Next steps (in order)
1. Member 1 reviews/applies the migration to the dev project, enables pg_cron, confirms the schedule interval.
2. Wire frontend through `src/services/leads.ts` using the Supabase browser client + React Query (+ Realtime on `leads`/`lead_assignments`), then mount `AcknowledgementCountdown` on `/leads/$id`.
3. TanStack server function for the public form (`/lead-capture/$workspaceSlug`) with validation, rate limit, bot check, then `capture_external_lead`.
4. Real-parallel concurrency test against a local Supabase/Postgres (needs Docker or a second connection).
