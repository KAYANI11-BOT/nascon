-- LeadGuard lead protection & automation engine (Member 2).
-- ADDITIVE on top of 20261018000100..500. REVIEW REQUIRED (Member 1): not applied to any shared
-- project. Two Member 1 functions are replaced narrowly (see section 4); everything else only
-- adds columns, tables, triggers and functions.
--
-- Model: the database is the source of truth and the only scheduler. Every ownership change goes
-- through leads.assigned_to, so the assignment history/deadline/acknowledgement ledger is
-- maintained by triggers even for direct table writes. Automation functions are SECURITY DEFINER;
-- client roles (authenticated/anon) are detected with current_user, which inside a definer
-- function is the function owner.

-- ---------------------------------------------------------------------------
-- 1. Additive columns
-- ---------------------------------------------------------------------------
alter table public.employee_availability drop constraint employee_availability_status_check;
-- 'away' is kept as a legacy value (treated as absent); 'on_leave' is the official status.
alter table public.employee_availability add constraint employee_availability_status_check
  check (status in ('available', 'busy', 'away', 'on_leave', 'offline'));

create function private.valid_timeouts(p_values integer[])
returns boolean language sql immutable set search_path = ''
as $$ select coalesce(bool_and(v between 5 and 604800), true) and coalesce(array_length(p_values, 1), 0) <= 10 from unnest(p_values) v $$;

alter table public.assignment_rules
  add column acknowledgement_window_seconds integer check (acknowledgement_window_seconds between 5 and 604800),
  add column max_open_leads integer not null default 10 check (max_open_leads between 1 and 10000),
  add column escalation_timeouts_seconds integer[] not null default '{}' check (private.valid_timeouts(escalation_timeouts_seconds)),
  add column max_escalation_levels integer not null default 3 check (max_escalation_levels between 1 and 10),
  add column backup_user_id uuid,
  add column manager_user_id uuid,
  add column idle_threshold_seconds integer not null default 86400 check (idle_threshold_seconds between 10 and 31536000),
  add column acknowledged_absence_policy text not null default 'keep_and_flag' check (acknowledged_absence_policy in ('keep_and_flag', 'reassign')),
  add foreign key (workspace_id, backup_user_id) references public.workspace_members (workspace_id, user_id) on delete set null (backup_user_id),
  add foreign key (workspace_id, manager_user_id) references public.workspace_members (workspace_id, user_id) on delete set null (manager_user_id);

alter table public.leads
  add column message text check (message is null or char_length(message) <= 2000),
  add column idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  add column current_assignment_id uuid,
  add column first_assigned_at timestamptz,
  add column first_acknowledged_at timestamptz,
  add column escalation_level integer not null default 0 check (escalation_level between 0 and 10),
  add column last_action_at timestamptz,
  add column needs_manager_review boolean not null default false,
  add column ownership_exception boolean not null default false,
  add column recovery_resolved_at timestamptz,
  add column version integer not null default 1;
create unique index leads_idempotency_key_idx on public.leads (workspace_id, idempotency_key) where idempotency_key is not null;
create index leads_overdue_idx on public.leads (acknowledgement_due_at) where acknowledged_at is null and assigned_to is not null;
create index leads_open_owner_idx on public.leads (workspace_id, assigned_to) where status not in ('converted', 'lost');
create index leads_last_action_idx on public.leads (workspace_id, last_action_at);

alter table public.lead_assignments
  add column escalation_level integer not null default 0,
  add column deadline timestamptz,
  add column acknowledged_at timestamptz,
  add column acknowledged_by uuid references public.profiles (id) on delete set null,
  add column ack_method text,
  add column ended_at timestamptz,
  add column end_reason text;

-- Backfill so the single-live-assignment invariant can be enforced on existing data.
update public.leads set first_assigned_at = assigned_at, first_acknowledged_at = acknowledged_at,
  last_action_at = coalesce(acknowledged_at, assigned_at) where assigned_at is not null or acknowledged_at is not null;
update public.lead_assignments a set ended_at = a.created_at, end_reason = 'unassigned' where a.assigned_to is null and a.ended_at is null;
update public.lead_assignments a set ended_at = now(), end_reason = 'superseded'
  where a.ended_at is null and exists (select 1 from public.lead_assignments b where b.lead_id = a.lead_id and (b.created_at, b.id) > (a.created_at, a.id));
insert into public.lead_assignments (workspace_id, lead_id, assigned_to, reason, deadline, created_at)
  select l.workspace_id, l.id, l.assigned_to, 'backfill', l.acknowledgement_due_at, coalesce(l.assigned_at, now())
  from public.leads l where l.assigned_to is not null and not exists (select 1 from public.lead_assignments a where a.lead_id = l.id);
update public.leads l set current_assignment_id = (
  select a.id from public.lead_assignments a where a.lead_id = l.id and a.ended_at is null and a.assigned_to is not null order by a.created_at desc limit 1)
  where l.assigned_to is not null;
create unique index lead_assignments_one_live_idx on public.lead_assignments (lead_id) where ended_at is null;

-- ---------------------------------------------------------------------------
-- 2. New tables
-- ---------------------------------------------------------------------------
-- Ordered round-robin ring (eligible assignees) per rule.
create table public.assignment_rule_assignees (
  rule_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  position integer not null default 0 check (position >= 0),
  primary key (rule_id, user_id),
  foreign key (workspace_id, rule_id) references public.assignment_rules (workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references public.workspace_members (workspace_id, user_id) on delete cascade
);
create index assignment_rule_assignees_ws_idx on public.assignment_rule_assignees (workspace_id, rule_id, position);

-- Persisted routing position; automation-only (no client grants, no audit noise).
create table public.assignment_rule_state (
  rule_id uuid primary key references public.assignment_rules (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rr_last_user_id uuid,
  updated_at timestamptz not null default now()
);

-- One escalation per (lead, assignment): the idempotency anchor for overlapping schedulers/retries.
create table public.lead_escalations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  lead_id uuid not null,
  from_assignment_id uuid not null unique references public.lead_assignments (id) on delete cascade,
  to_assignment_id uuid references public.lead_assignments (id) on delete set null,
  previous_owner uuid,
  new_owner uuid,
  level integer not null,
  reason text not null,
  result text not null check (result in ('pending', 'employee', 'backup', 'manager', 'exhausted')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index lead_escalations_lead_idx on public.lead_escalations (workspace_id, lead_id, created_at desc);

-- Recorded actions that may implicitly acknowledge a lead. Producers (CRM, messaging) call
-- public.record_lead_action after their own write succeeds; dedupe_key makes retries safe.
create table public.lead_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  lead_id uuid not null,
  assignment_id uuid,
  action text not null check (action in ('note_added', 'message_sent', 'call_recorded', 'stage_changed', 'appointment_scheduled')),
  actor_id uuid,
  dedupe_key text not null check (char_length(dedupe_key) between 8 and 200),
  created_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index lead_actions_lead_idx on public.lead_actions (workspace_id, lead_id, created_at desc);

-- Public intake: an unguessable-by-ID slug resolves to a workspace; used only by a server function.
create table public.lead_intake_channels (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lead_intake_channels_ws_idx on public.lead_intake_channels (workspace_id);

create table public.notification_destinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  channel text not null check (channel in ('telegram', 'sms', 'email')),
  address text not null check (char_length(btrim(address)) between 3 and 320),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, channel),
  foreign key (workspace_id, user_id) references public.workspace_members (workspace_id, user_id) on delete cascade
);

-- Durable outbox. Provider delivery (Member 4) happens outside any lead transaction.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  lead_id uuid not null,
  recipient_user_id uuid not null,
  event_id uuid not null,
  event_type text not null check (event_type in ('lead_assigned', 'lead_escalated', 'lead_exception')),
  reason text,
  payload jsonb not null,
  channel text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, recipient_user_id, event_type, event_id),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index notification_outbox_due_idx on public.notification_outbox (next_attempt_at) where status in ('pending', 'failed');
create index notification_outbox_recipient_idx on public.notification_outbox (workspace_id, recipient_user_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['assignment_rule_assignees', 'lead_intake_channels', 'notification_destinations'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.prevent_workspace_change()', t || '_lock_workspace', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.write_audit_log()', t || '_audit', t);
  end loop;
  foreach t in array array['lead_intake_channels', 'notification_destinations'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (definer; EXECUTE granted only where an invoker trigger needs it)
-- ---------------------------------------------------------------------------
create function private.active_rule(p_workspace_id uuid)
returns public.assignment_rules language sql stable security definer set search_path = ''
as $$
  select r.* from public.assignment_rules r where r.workspace_id = p_workspace_id and r.is_active
  order by r.priority desc, r.created_at, r.id limit 1;
$$;

-- Locks the active rule: the per-workspace serialisation point. LOCK ORDER IS ALWAYS rule -> lead.
create function private.lock_active_rule(p_workspace_id uuid)
returns public.assignment_rules language sql security definer set search_path = ''
as $$
  select r.* from public.assignment_rules r where r.workspace_id = p_workspace_id and r.is_active
  order by r.priority desc, r.created_at, r.id limit 1 for update;
$$;

create function private.ack_window_seconds(p_rule public.assignment_rules, p_level integer)
returns integer language sql immutable set search_path = ''
as $$
  select coalesce(case when p_level > 0 then p_rule.escalation_timeouts_seconds[p_level] end,
                  p_rule.acknowledgement_window_seconds, p_rule.acknowledgement_window_minutes * 60, 900);
$$;

-- Next eligible user in ring order after the persisted pointer. Eligible = ring member, status
-- 'available', open leads below the per-employee (or rule) cap. p_strict forbids excluded users.
create function private.ring_pick(p_rule public.assignment_rules, p_exclude uuid[], p_strict boolean)
returns uuid language sql stable security definer set search_path = ''
as $$
  with ring as (
    select a.user_id, row_number() over (order by a.position, a.user_id) rn
    from public.assignment_rule_assignees a where a.rule_id = p_rule.id
  ),
  pivot as (
    select coalesce((select r.rn from ring r join public.assignment_rule_state s on s.rr_last_user_id = r.user_id where s.rule_id = p_rule.id), 0) p
  )
  select r.user_id
  from ring r
  join public.employee_availability ea on ea.workspace_id = p_rule.workspace_id and ea.user_id = r.user_id
  cross join pivot
  where ea.status = 'available'
    and (select count(*) from public.leads l where l.workspace_id = p_rule.workspace_id and l.assigned_to = r.user_id
         and l.status not in ('converted', 'lost')) < coalesce(ea.max_open_leads, p_rule.max_open_leads)
    and not (p_strict and r.user_id = any (coalesce(p_exclude, '{}')))
  order by (r.user_id = any (coalesce(p_exclude, '{}'))), case when r.rn > pivot.p then 0 else 1 end, r.rn
  limit 1;
$$;

create function private.enqueue_notification(p_lead_id uuid, p_recipient uuid, p_type text, p_event_id uuid, p_reason text)
returns void language sql security definer set search_path = ''
as $$
  insert into public.notification_outbox (workspace_id, lead_id, recipient_user_id, event_id, event_type, reason, payload)
  select l.workspace_id, l.id, p_recipient, p_event_id, p_type, p_reason,
    jsonb_build_object('workspace_id', l.workspace_id, 'lead_id', l.id, 'recipient_user_id', p_recipient,
      'event_id', p_event_id, 'event_type', p_type, 'lead_name', l.full_name, 'source', l.source,
      'reason', p_reason, 'escalation_level', l.escalation_level, 'lead_url', '/leads/' || l.id, 'created_at', now())
  from public.leads l where l.id = p_lead_id
  on conflict (workspace_id, recipient_user_id, event_type, event_id) do nothing;
$$;

-- Performs one ownership change. Caller holds the rule lock (rule -> lead order).
create function private.apply_assignment(
  p_lead_id uuid, p_target uuid, p_reason text, p_actor uuid, p_level integer,
  p_notify text, p_event_id uuid default null, p_advance_rr boolean default false, p_review boolean default false)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid;
  v_rule public.assignment_rules;
  v_assignment uuid;
begin
  select workspace_id into v_ws from public.leads where id = p_lead_id for update;
  v_rule := private.active_rule(v_ws);
  perform pg_catalog.set_config('leadguard.reason', p_reason, true);
  perform pg_catalog.set_config('leadguard.actor', coalesce(p_actor::text, ''), true);
  update public.leads set
    assigned_to = p_target, acknowledged_at = null,
    acknowledgement_due_at = now() + make_interval(secs => private.ack_window_seconds(v_rule, p_level)),
    escalation_level = p_level, ownership_exception = false, needs_manager_review = p_review,
    status = case when p_reason like 'escalation\_%' then 'escalated' else status end
  where id = p_lead_id returning current_assignment_id into v_assignment;
  perform pg_catalog.set_config('leadguard.reason', '', true);
  perform pg_catalog.set_config('leadguard.actor', '', true);
  if p_advance_rr and v_rule.id is not null then
    insert into public.assignment_rule_state (rule_id, workspace_id, rr_last_user_id) values (v_rule.id, v_ws, p_target)
    on conflict (rule_id) do update set rr_last_user_id = excluded.rr_last_user_id, updated_at = now();
  end if;
  perform private.enqueue_notification(p_lead_id, p_target, p_notify, coalesce(p_event_id, v_assignment), p_reason);
  return v_assignment;
end;
$$;

-- Intake / absence placement: ring first, then backup, then manager, else a durable exception.
create function private.assign_auto(p_lead_id uuid, p_reason text, p_actor uuid, p_exclude uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_rule public.assignment_rules;
  v_target uuid;
  v_kind text;
  v_recipient uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id;
  v_rule := private.lock_active_rule(v_lead.workspace_id);
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_rule.id is not null then
    v_target := private.ring_pick(v_rule, p_exclude, false); v_kind := 'employee';
    if v_target is null and v_rule.backup_user_id is not null and not (v_rule.backup_user_id = any (p_exclude)) then
      v_target := v_rule.backup_user_id; v_kind := 'backup';
    end if;
    if v_target is null and v_rule.manager_user_id is not null and not (v_rule.manager_user_id = any (p_exclude)) then
      v_target := v_rule.manager_user_id; v_kind := 'manager';
    end if;
  end if;

  if v_target is null then
    perform pg_catalog.set_config('leadguard.reason', 'ownership_exception', true);
    perform pg_catalog.set_config('leadguard.actor', coalesce(p_actor::text, ''), true);
    update public.leads set assigned_to = null, acknowledged_at = null, acknowledgement_due_at = null,
      ownership_exception = true, needs_manager_review = true where id = p_lead_id;
    perform pg_catalog.set_config('leadguard.reason', '', true);
    perform pg_catalog.set_config('leadguard.actor', '', true);
    v_recipient := coalesce(v_rule.manager_user_id,
      (select m.user_id from public.workspace_members m where m.workspace_id = v_lead.workspace_id and m.role = 'owner'));
    if v_recipient is not null then
      perform private.enqueue_notification(p_lead_id, v_recipient, 'lead_exception', pg_catalog.gen_random_uuid(), 'no_eligible_owner');
    end if;
    return null;
  end if;

  return private.apply_assignment(p_lead_id, v_target,
    case when p_reason = 'intake' then case v_kind when 'employee' then 'auto_round_robin' else 'fallback_' || v_kind end else p_reason end,
    p_actor, v_lead.escalation_level, 'lead_assigned', null, p_reason = 'intake' and v_kind = 'employee', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Triggers (and two narrow replacements of Member 1 functions)
-- ---------------------------------------------------------------------------
-- REPLACED (Member 1): same rule as before, but trusted automation (definer functions, where
-- current_user is not a client role) is exempt from the leads.assign client check.
create or replace function private.guard_lead_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is not null and pg_trigger_depth() = 1 and current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.assigned_to is not null and new.assigned_to <> v_uid
         and not private.has_workspace_permission(new.workspace_id, 'leads.assign') then
        raise exception 'permission leads.assign is required to assign leads to others' using errcode = '42501';
      end if;
    elsif new.assigned_to is distinct from old.assigned_to
       and not private.has_workspace_permission(new.workspace_id, 'leads.assign') then
      raise exception 'permission leads.assign is required to reassign leads' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' and new.assigned_to is not null
     or tg_op = 'UPDATE' and new.assigned_to is distinct from old.assigned_to then
    new.assigned_at := case when new.assigned_to is null then null else now() end;
  end if;
  return new;
end;
$$;

-- REPLACED (Member 1): history rows now also carry level/deadline/ack ledger columns and the
-- id pre-generated into leads.current_assignment_id. Still append-only from clients' view.
create or replace function private.record_lead_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(pg_catalog.current_setting('leadguard.reason', true), '');
  v_actor uuid;
begin
  if not exists (select 1 from public.workspaces w where w.id = new.workspace_id) then
    return null;
  end if;
  if tg_op = 'INSERT' and new.assigned_to is not null
     or tg_op = 'UPDATE' and new.assigned_to is distinct from old.assigned_to then
    v_actor := case when v_reason is null then (select auth.uid())
                    else nullif(pg_catalog.current_setting('leadguard.actor', true), '')::uuid end;
    update public.lead_assignments set ended_at = now(), end_reason = coalesce(v_reason, 'manual_reassignment')
      where lead_id = new.id and ended_at is null;
    insert into public.lead_assignments (id, workspace_id, lead_id, assigned_to, previous_assigned_to, assigned_by, reason,
                                         escalation_level, deadline, ended_at, end_reason)
    values (coalesce(new.current_assignment_id, pg_catalog.gen_random_uuid()), new.workspace_id, new.id, new.assigned_to,
            case when tg_op = 'UPDATE' then old.assigned_to end, v_actor, coalesce(v_reason, 'manual_assignment'),
            new.escalation_level, new.acknowledgement_due_at,
            case when new.assigned_to is null then now() end, case when new.assigned_to is null then v_reason end);
  end if;
  return null;
end;
$$;
revoke all on function private.record_lead_assignment() from public, anon, authenticated;

-- Lifecycle guard (INVOKER on purpose: current_user tells client sessions from automation).
create function private.leads_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_client and (new.acknowledged_at is not null or new.acknowledgement_due_at is not null or new.first_assigned_at is not null
        or new.first_acknowledged_at is not null or new.escalation_level <> 0 or new.current_assignment_id is not null
        or new.last_action_at is not null or new.needs_manager_review or new.ownership_exception
        or new.recovery_resolved_at is not null or new.version <> 1) then
      raise exception 'lead lifecycle fields are managed by the automation engine' using errcode = '42501';
    end if;
    if new.assigned_to is not null then
      new.first_assigned_at := coalesce(new.first_assigned_at, now());
      new.current_assignment_id := pg_catalog.gen_random_uuid();
      new.acknowledgement_due_at := coalesce(new.acknowledgement_due_at,
        now() + make_interval(secs => private.ack_window_seconds(private.active_rule(new.workspace_id), 0)));
    end if;
    return new;
  end if;

  -- Clients never write lifecycle columns directly (use the RPCs). The deadline and assigned_at
  -- change only together with assigned_to, and are computed below, after this check.
  if v_client and (new.acknowledged_at is distinct from old.acknowledged_at
      or new.first_assigned_at is distinct from old.first_assigned_at
      or new.first_acknowledged_at is distinct from old.first_acknowledged_at
      or new.escalation_level is distinct from old.escalation_level
      or new.current_assignment_id is distinct from old.current_assignment_id
      or new.last_action_at is distinct from old.last_action_at
      or new.needs_manager_review is distinct from old.needs_manager_review
      or new.ownership_exception is distinct from old.ownership_exception
      or new.recovery_resolved_at is distinct from old.recovery_resolved_at
      or new.idempotency_key is distinct from old.idempotency_key
      or (new.assigned_to is not distinct from old.assigned_to
          and (new.acknowledgement_due_at is distinct from old.acknowledgement_due_at
               or new.assigned_at is distinct from old.assigned_at))) then
    raise exception 'lead lifecycle fields are managed by the automation engine' using errcode = '42501';
  end if;

  new.version := old.version + 1;
  if new.assigned_to is distinct from old.assigned_to then
    new.acknowledged_at := null;
    if new.assigned_to is null then
      new.current_assignment_id := null;
      new.acknowledgement_due_at := null;
    else
      new.current_assignment_id := pg_catalog.gen_random_uuid();
      new.first_assigned_at := coalesce(old.first_assigned_at, now());
      if v_client then
        new.acknowledgement_due_at := now() + make_interval(secs => private.ack_window_seconds(private.active_rule(new.workspace_id), 0));
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger leads_lifecycle before insert or update on public.leads
  for each row execute function private.leads_lifecycle();

-- Automatic assignment on intake (any insert path, including direct client inserts).
create function private.leads_auto_assign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.assignment_rules := private.active_rule(new.workspace_id);
begin
  if new.assigned_to is null and v_rule.strategy in ('round_robin', 'availability') then
    perform private.assign_auto(new.id, 'intake', null);
  end if;
  return null;
end;
$$;
create trigger leads_auto_assign after insert on public.leads
  for each row execute function private.leads_auto_assign();

-- Absence: on_leave/offline/away immediately reassigns unacknowledged leads (never waits for a timeout).
create function private.availability_reassign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.assignment_rules;
  r record;
  v_absent text[] := array['on_leave', 'offline', 'away'];
begin
  if not (new.status = any (v_absent)) or (tg_op = 'UPDATE' and old.status = any (v_absent)) then
    return null;
  end if;
  v_rule := private.lock_active_rule(new.workspace_id);
  for r in select l.id, l.acknowledged_at from public.leads l
           where l.workspace_id = new.workspace_id and l.assigned_to = new.user_id and l.status not in ('converted', 'lost')
           order by l.created_at for update
  loop
    if r.acknowledged_at is null or v_rule.acknowledged_absence_policy = 'reassign' then
      perform private.assign_auto(r.id, 'absence_reassignment', (select auth.uid()), array[new.user_id]);
    else
      update public.leads set needs_manager_review = true where id = r.id;
    end if;
  end loop;
  return null;
end;
$$;
create trigger employee_availability_reassign after insert or update of status on public.employee_availability
  for each row execute function private.availability_reassign();

-- ---------------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------------
create function public.create_lead(
  p_workspace uuid, p_full_name text, p_email text, p_phone text, p_company text, p_message text, p_idempotency_key text)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lead public.leads;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.has_workspace_permission(p_workspace, 'leads.manage') then
    raise exception 'permission leads.manage is required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'idempotency key is required (8-200 characters)' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) not between 1 and 200 then
    raise exception 'name is required (1-200 characters)' using errcode = '22023';
  end if;
  if p_email is not null and p_email <> '' and p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  insert into public.leads (workspace_id, full_name, email, phone, company_name, message, source, idempotency_key, created_by)
  values (p_workspace, btrim(p_full_name), nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''), nullif(btrim(p_company), ''),
          nullif(btrim(p_message), ''), 'manual', p_idempotency_key, v_uid)
  on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing;
  select * into v_lead from public.leads where workspace_id = p_workspace and idempotency_key = p_idempotency_key;
  return v_lead;
end;
$$;

-- Public web form / messaging intake. SERVICE ROLE ONLY: called from a TanStack server function
-- after it validates input, applies rate/bot protection and verifies the provider signature.
create function public.capture_external_lead(
  p_slug text, p_full_name text, p_email text, p_phone text, p_message text, p_source text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_id uuid;
begin
  if (select auth.uid()) is not null then raise exception 'service operation' using errcode = '42501'; end if;
  if p_source not in ('web_form', 'messaging') then raise exception 'invalid source' using errcode = '22023'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) not between 1 and 200 then
    raise exception 'name is required' using errcode = '22023';
  end if;
  if p_email is not null and p_email <> '' and p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  select c.workspace_id into v_ws from public.lead_intake_channels c where c.slug = p_slug and c.enabled;
  if v_ws is null then raise exception 'unknown intake channel' using errcode = 'P0002'; end if;
  select id into v_id from public.leads where workspace_id = v_ws and idempotency_key = p_idempotency_key;
  if v_id is not null then return jsonb_build_object('lead_id', v_id, 'duplicate', true); end if;
  -- coarse backstop; the server function applies the real per-client rate limit
  if (select count(*) from public.leads l where l.workspace_id = v_ws and l.source in ('web_form', 'messaging')
        and l.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'intake rate limit exceeded' using errcode = '53400';
  end if;
  insert into public.leads (workspace_id, full_name, email, phone, message, source, idempotency_key)
  values (v_ws, btrim(p_full_name), nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''), nullif(btrim(p_message), ''), p_source, p_idempotency_key)
  on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.leads where workspace_id = v_ws and idempotency_key = p_idempotency_key;
    return jsonb_build_object('lead_id', v_id, 'duplicate', true);
  end if;
  return jsonb_build_object('lead_id', v_id, 'duplicate', false);
end;
$$;

create function public.acknowledge_lead(p_lead uuid, p_assignment uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lead public.leads;
  v_supervisor boolean;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_lead from public.leads where id = p_lead for update;
  if not found or not private.is_workspace_member(v_lead.workspace_id) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  if v_lead.current_assignment_id is distinct from p_assignment or v_lead.assigned_to is null then
    raise exception 'this assignment is no longer current' using errcode = '40001';
  end if;
  v_supervisor := private.has_workspace_permission(v_lead.workspace_id, 'leads.assign');
  if v_lead.assigned_to <> v_uid and not v_supervisor then
    raise exception 'only the current assignee or a supervisor can acknowledge' using errcode = '42501';
  end if;
  if v_lead.acknowledged_at is not null then
    return jsonb_build_object('code', 'already_applied', 'lead_id', p_lead, 'assignment_id', p_assignment);
  end if;
  update public.lead_assignments set acknowledged_at = now(), acknowledged_by = v_uid,
    ack_method = case when v_lead.assigned_to = v_uid then 'explicit' else 'supervisor' end
    where id = p_assignment and acknowledged_at is null;
  update public.leads set acknowledged_at = now(), first_acknowledged_at = coalesce(first_acknowledged_at, now()),
    last_action_at = now(), needs_manager_review = false,
    status = case when status in ('new', 'escalated', 'recovery') then 'contacted' else status end
    where id = p_lead;
  return jsonb_build_object('code', 'ok', 'lead_id', p_lead, 'assignment_id', p_assignment);
end;
$$;

create function public.record_lead_action(p_lead uuid, p_action text, p_dedupe_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lead public.leads;
  v_inserted uuid;
  v_ack boolean := false;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_action not in ('note_added', 'message_sent', 'call_recorded', 'stage_changed', 'appointment_scheduled') then
    raise exception 'not a qualifying action' using errcode = '22023';
  end if;
  select * into v_lead from public.leads where id = p_lead for update;
  if not found or not private.is_workspace_member(v_lead.workspace_id) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  insert into public.lead_actions (workspace_id, lead_id, assignment_id, action, actor_id, dedupe_key)
  values (v_lead.workspace_id, p_lead, v_lead.current_assignment_id, p_action, v_uid, p_dedupe_key)
  on conflict (workspace_id, dedupe_key) do nothing returning id into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('code', 'already_applied', 'lead_id', p_lead);
  end if;
  update public.leads set last_action_at = now() where id = p_lead;
  if v_lead.assigned_to = v_uid and v_lead.acknowledged_at is null and v_lead.current_assignment_id is not null then
    update public.lead_assignments set acknowledged_at = now(), acknowledged_by = v_uid, ack_method = p_action
      where id = v_lead.current_assignment_id and acknowledged_at is null;
    update public.leads set acknowledged_at = now(), first_acknowledged_at = coalesce(first_acknowledged_at, now()),
      needs_manager_review = false,
      status = case when status in ('new', 'escalated', 'recovery') then 'contacted' else status end
      where id = p_lead;
    v_ack := true;
  end if;
  return jsonb_build_object('code', 'ok', 'lead_id', p_lead, 'acknowledged', v_ack);
end;
$$;

-- Manual reassignment (supervisor). Not an escalation: level is unchanged.
create function public.reassign_lead(p_lead uuid, p_to uuid, p_expected_version integer, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lead public.leads;
  v_assignment uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_lead from public.leads where id = p_lead;
  if not found or not private.has_workspace_permission(v_lead.workspace_id, 'leads.assign') then
    raise exception 'permission leads.assign is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = v_lead.workspace_id and m.user_id = p_to) then
    raise exception 'target is not a workspace member' using errcode = '22023';
  end if;
  perform private.lock_active_rule(v_lead.workspace_id);
  select * into v_lead from public.leads where id = p_lead for update;
  if v_lead.version is distinct from p_expected_version then
    raise exception 'lead changed since it was loaded' using errcode = '40001';
  end if;
  if v_lead.assigned_to is not distinct from p_to then
    return jsonb_build_object('code', 'already_applied', 'lead_id', p_lead, 'assignment_id', v_lead.current_assignment_id);
  end if;
  v_assignment := private.apply_assignment(p_lead, p_to, 'manual_reassignment', v_uid, v_lead.escalation_level, 'lead_assigned');
  return jsonb_build_object('code', 'ok', 'lead_id', p_lead, 'assignment_id', v_assignment);
end;
$$;

-- Explicit, persisted way to leave the recovery queue: the lead must be owned and acknowledged;
-- conditions are then re-evaluated only from this point (escalations/idle counted afterwards).
create function public.resolve_recovery(p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead public.leads;
begin
  if (select auth.uid()) is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_lead from public.leads where id = p_lead for update;
  if not found or not private.has_workspace_permission(v_lead.workspace_id, 'leads.assign') then
    raise exception 'permission leads.assign is required' using errcode = '42501';
  end if;
  if v_lead.assigned_to is null or v_lead.acknowledged_at is null then
    raise exception 'reassign or acknowledge the lead before resolving recovery' using errcode = '55000';
  end if;
  update public.leads set recovery_resolved_at = now(), last_action_at = now(), needs_manager_review = false where id = p_lead;
  return jsonb_build_object('code', 'ok', 'lead_id', p_lead);
end;
$$;

create function public.get_recovery_queue(
  p_workspace uuid, p_reason text default null, p_owner uuid default null, p_source text default null,
  p_status text default null, p_created_from timestamptz default null, p_created_to timestamptz default null,
  p_limit integer default 25, p_offset integer default 0)
returns table (
  lead_id uuid, full_name text, source text, assigned_to uuid, status text, created_at timestamptz,
  acknowledged boolean, escalation_level integer, escalations_since_review bigint, last_action_at timestamptz,
  acknowledgement_due_at timestamptz, needs_manager_review boolean, version integer, reasons text[], total_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    select coalesce((x).idle_threshold_seconds, 86400) idle, private.ack_window_seconds(x, 0) win
    from (select private.active_rule(p_workspace) x) s
  ),
  base as (
    select l.*, cfg.idle, cfg.win,
      (select count(*) from public.lead_escalations e where e.lead_id = l.id
         and e.created_at > coalesce(l.recovery_resolved_at, '-infinity'::timestamptz)) esc_since
    from public.leads l cross join cfg
    where l.workspace_id = p_workspace and l.status not in ('converted', 'lost')
      and (p_owner is null or l.assigned_to = p_owner) and (p_source is null or l.source = p_source)
      and (p_status is null or l.status = p_status)
      and (p_created_from is null or l.created_at >= p_created_from) and (p_created_to is null or l.created_at <= p_created_to)
  ),
  flagged as (
    select b.*, array_remove(array[
      case when b.assigned_to is not null and b.acknowledged_at is null and b.acknowledgement_due_at < now() then 'unacknowledged_overdue' end,
      case when b.esc_since >= 2 then 'repeated_escalation' end,
      case when now() - greatest(coalesce(b.last_action_at, b.created_at), coalesce(b.recovery_resolved_at, b.created_at))
                > make_interval(secs => b.idle) then 'idle' end,
      case when b.ownership_exception then 'ownership_exception' end,
      case when b.assigned_to is null and not b.ownership_exception
                and now() - b.created_at > make_interval(secs => b.win) then 'unassigned' end
    ], null) reasons from base b
  )
  select f.id, f.full_name, f.source, f.assigned_to, f.status, f.created_at, f.acknowledged_at is not null,
         f.escalation_level, f.esc_since, f.last_action_at, f.acknowledgement_due_at, f.needs_manager_review,
         f.version, f.reasons, count(*) over ()
  from flagged f
  where cardinality(f.reasons) > 0 and (p_reason is null or p_reason = any (f.reasons))
  order by f.created_at
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

-- Atomically replaces a rule's round-robin ring (order = array order). Requires assignment_rules.manage.
create function public.set_rule_assignees(p_rule uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if (select auth.uid()) is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select workspace_id into v_ws from public.assignment_rules where id = p_rule;
  if v_ws is null or not private.has_workspace_permission(v_ws, 'assignment_rules.manage') then
    raise exception 'permission assignment_rules.manage is required' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) u group by u having count(*) > 1) then
    raise exception 'duplicate assignee in ring' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) u
             where not exists (select 1 from public.workspace_members m where m.workspace_id = v_ws and m.user_id = u)) then
    raise exception 'every assignee must be a workspace member' using errcode = '22023';
  end if;
  perform 1 from public.assignment_rules where id = p_rule for update;
  delete from public.assignment_rule_assignees where rule_id = p_rule;
  insert into public.assignment_rule_assignees (rule_id, workspace_id, user_id, position)
  select p_rule, v_ws, u.user_id, (u.ord - 1)::int from unnest(coalesce(p_user_ids, '{}')) with ordinality as u(user_id, ord);
end;
$$;

-- Time to first response = first acknowledgement - first assignment (never reset by reassignment).
create function public.get_first_response_stats(p_workspace uuid, p_from timestamptz default null, p_to timestamptz default null)
returns table (responded bigint, avg_seconds double precision, median_seconds double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*), avg(extract(epoch from l.first_acknowledged_at - l.first_assigned_at)),
         percentile_cont(0.5) within group (order by extract(epoch from l.first_acknowledged_at - l.first_assigned_at))
  from public.leads l
  where l.workspace_id = p_workspace and l.first_assigned_at is not null and l.first_acknowledged_at is not null
    and l.first_assigned_at >= coalesce(p_from, '-infinity'::timestamptz) and l.first_assigned_at <= coalesce(p_to, 'infinity'::timestamptz);
$$;

-- Scheduler entry point (pg_cron / service role only). Safe to run concurrently and repeatedly:
-- rule lock serialises per workspace, state is re-checked under the lead lock, and
-- lead_escalations.from_assignment_id is unique so one assignment escalates at most once.
create function public.escalate_overdue_leads(p_batch integer default 50)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_rule public.assignment_rules;
  v_lead public.leads;
  v_level integer;
  v_stage integer;
  v_target uuid;
  v_kind text;
  v_prev uuid[];
  v_esc uuid;
  v_assignment uuid;
  v_count integer := 0;
begin
  if (select auth.uid()) is not null then raise exception 'scheduler only' using errcode = '42501'; end if;
  for r in select l.id, l.workspace_id from public.leads l
           where l.assigned_to is not null and l.acknowledged_at is null and l.acknowledgement_due_at <= now()
             and l.status not in ('converted', 'lost')
           order by l.acknowledgement_due_at limit least(greatest(p_batch, 1), 500)
  loop
    v_rule := private.lock_active_rule(r.workspace_id);
    continue when v_rule.id is null;
    select * into v_lead from public.leads where id = r.id for update;
    continue when not (v_lead.assigned_to is not null and v_lead.acknowledged_at is null and v_lead.acknowledgement_due_at <= now()
                       and v_lead.escalation_level < v_rule.max_escalation_levels and v_lead.current_assignment_id is not null
                       and v_lead.status not in ('converted', 'lost'));
    v_level := v_lead.escalation_level + 1;
    v_esc := null;
    insert into public.lead_escalations (workspace_id, lead_id, from_assignment_id, previous_owner, level, reason, result)
    values (v_lead.workspace_id, v_lead.id, v_lead.current_assignment_id, v_lead.assigned_to, v_level, 'ack_timeout', 'pending')
    on conflict (from_assignment_id) do nothing returning id into v_esc;
    continue when v_esc is null;

    v_prev := array(select distinct a.assigned_to from public.lead_assignments a where a.lead_id = v_lead.id and a.assigned_to is not null);
    v_stage := case when v_level <= v_rule.max_escalation_levels - 2 then 0
                    when v_level = v_rule.max_escalation_levels - 1 then 1 else 2 end;
    v_target := null; v_kind := null;
    if v_stage = 0 then v_target := private.ring_pick(v_rule, v_prev, true); v_kind := 'peer'; end if;
    if v_target is null and v_stage <= 1 and v_rule.backup_user_id is not null and not (v_rule.backup_user_id = any (v_prev)) then
      v_target := v_rule.backup_user_id; v_kind := 'backup';
    end if;
    if v_target is null and v_rule.manager_user_id is not null
       and (v_rule.manager_user_id <> v_lead.assigned_to or v_stage = 2) then
      v_target := v_rule.manager_user_id; v_kind := 'manager';
    end if;
    if v_target is null and v_rule.backup_user_id is not null and v_rule.backup_user_id <> v_lead.assigned_to then
      v_target := v_rule.backup_user_id; v_kind := 'backup';
    end if;
    if v_target = v_lead.assigned_to then v_target := null; end if;

    if v_target is null then
      -- Nobody different to escalate to: keep the owner, flag for manager review, and stop looping.
      update public.leads set escalation_level = v_level, needs_manager_review = true, status = 'escalated',
        acknowledgement_due_at = now() + make_interval(secs => private.ack_window_seconds(v_rule, v_level))
        where id = v_lead.id;
      update public.lead_escalations set result = 'exhausted', new_owner = v_lead.assigned_to where id = v_esc;
    else
      v_assignment := private.apply_assignment(v_lead.id, v_target, 'escalation_' || v_kind, null, v_level, 'lead_escalated', v_esc);
      update public.lead_escalations set to_assignment_id = v_assignment, new_owner = v_target,
        result = case v_kind when 'peer' then 'employee' else v_kind end where id = v_esc;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Delivery worker contract (Member 4). SERVICE ROLE ONLY.
create function public.claim_notifications(p_limit integer default 20)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then raise exception 'worker only' using errcode = '42501'; end if;
  update public.notification_outbox set status = 'dead', last_error = coalesce(last_error, 'lease expired after max attempts')
    where status = 'processing' and locked_until < now() and attempts >= max_attempts;
  return query
  update public.notification_outbox o set status = 'processing', attempts = o.attempts + 1, locked_until = now() + interval '2 minutes'
  where o.id in (
    select x.id from public.notification_outbox x
    where ((x.status in ('pending', 'failed') and x.next_attempt_at <= now()) or (x.status = 'processing' and x.locked_until < now()))
      and x.attempts < x.max_attempts
    order by x.next_attempt_at limit least(greatest(p_limit, 1), 100) for update skip locked)
  returning o.*;
end;
$$;

create function public.complete_notification(p_id uuid, p_success boolean, p_error text default null, p_channel text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then raise exception 'worker only' using errcode = '42501'; end if;
  update public.notification_outbox set
    status = case when p_success then 'sent' when attempts >= max_attempts then 'dead' else 'failed' end,
    sent_at = case when p_success then now() end,
    channel = coalesce(p_channel, channel),
    last_error = case when p_success then null else left(p_error, 1000) end,
    next_attempt_at = case when p_success then next_attempt_at else now() + least(make_interval(secs => 15 * power(2, attempts)), interval '15 minutes') end,
    locked_until = null
  where id = p_id and status = 'processing';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Row level security and grants
-- ---------------------------------------------------------------------------
alter table public.assignment_rule_assignees enable row level security;
alter table public.assignment_rule_state enable row level security;
alter table public.lead_escalations enable row level security;
alter table public.lead_actions enable row level security;
alter table public.lead_intake_channels enable row level security;
alter table public.notification_destinations enable row level security;
alter table public.notification_outbox enable row level security;

revoke all on table public.assignment_rule_assignees, public.assignment_rule_state, public.lead_escalations, public.lead_actions,
  public.lead_intake_channels, public.notification_destinations, public.notification_outbox from anon, authenticated;
grant select, insert, update, delete on table public.assignment_rule_assignees, public.lead_intake_channels, public.notification_destinations to authenticated;
grant select on table public.assignment_rule_state, public.lead_escalations, public.lead_actions, public.notification_outbox to authenticated;

create policy "assignment_rule_assignees: members read" on public.assignment_rule_assignees
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "assignment_rule_assignees: managers write" on public.assignment_rule_assignees
  for all to authenticated
  using (private.has_workspace_permission(workspace_id, 'assignment_rules.manage'))
  with check (private.has_workspace_permission(workspace_id, 'assignment_rules.manage'));
create policy "assignment_rule_state: members read" on public.assignment_rule_state
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "lead_escalations: members read" on public.lead_escalations
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "lead_actions: members read" on public.lead_actions
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "lead_intake_channels: members read" on public.lead_intake_channels
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "lead_intake_channels: settings managers write" on public.lead_intake_channels
  for all to authenticated
  using (private.has_workspace_permission(workspace_id, 'workspace.settings.manage'))
  with check (private.has_workspace_permission(workspace_id, 'workspace.settings.manage'));
create policy "notification_destinations: self or member managers read" on public.notification_destinations
  for select to authenticated
  using (user_id = (select auth.uid()) or private.has_workspace_permission(workspace_id, 'members.manage'));
create policy "notification_destinations: self write" on public.notification_destinations
  for all to authenticated
  using (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id));
create policy "notification_outbox: recipient or rule managers read" on public.notification_outbox
  for select to authenticated
  using (recipient_user_id = (select auth.uid()) or private.has_workspace_permission(workspace_id, 'assignment_rules.manage'));

-- Function privileges: everything revoked, then granted narrowly.
revoke all on function private.valid_timeouts(integer[]), private.active_rule(uuid), private.lock_active_rule(uuid),
  private.ack_window_seconds(public.assignment_rules, integer), private.ring_pick(public.assignment_rules, uuid[], boolean),
  private.enqueue_notification(uuid, uuid, text, uuid, text),
  private.apply_assignment(uuid, uuid, text, uuid, integer, text, uuid, boolean, boolean),
  private.assign_auto(uuid, text, uuid, uuid[]) from public, anon, authenticated;
-- Invoker triggers/queries call these as the client role.
grant execute on function private.valid_timeouts(integer[]), private.active_rule(uuid),
  private.ack_window_seconds(public.assignment_rules, integer) to authenticated;
revoke all on function private.leads_lifecycle(), private.leads_auto_assign(), private.availability_reassign() from public, anon, authenticated;

revoke all on function public.create_lead(uuid, text, text, text, text, text, text),
  public.capture_external_lead(text, text, text, text, text, text, text),
  public.acknowledge_lead(uuid, uuid), public.record_lead_action(uuid, text, text),
  public.reassign_lead(uuid, uuid, integer, text), public.resolve_recovery(uuid),
  public.get_recovery_queue(uuid, text, uuid, text, text, timestamptz, timestamptz, integer, integer),
  public.get_first_response_stats(uuid, timestamptz, timestamptz), public.set_rule_assignees(uuid, uuid[]),
  public.escalate_overdue_leads(integer), public.claim_notifications(integer),
  public.complete_notification(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.create_lead(uuid, text, text, text, text, text, text),
  public.acknowledge_lead(uuid, uuid), public.record_lead_action(uuid, text, text),
  public.set_rule_assignees(uuid, uuid[]),
  public.reassign_lead(uuid, uuid, integer, text), public.resolve_recovery(uuid),
  public.get_recovery_queue(uuid, text, uuid, text, text, timestamptz, timestamptz, integer, integer),
  public.get_first_response_stats(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.capture_external_lead(text, text, text, text, text, text, text),
  public.escalate_overdue_leads(integer), public.claim_notifications(integer),
  public.complete_notification(uuid, boolean, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Scheduling and realtime (conditional; untested outside a real Supabase project)
-- ---------------------------------------------------------------------------
-- pg_cron must be enabled in the project first. Sub-minute schedules need pg_cron >= 1.5;
-- otherwise this falls back to every minute (so escalation latency can be up to ~60s: do not
-- claim exact-second escalation in that case).
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('leadguard-escalation', '10 seconds', 'select public.escalate_overdue_leads(100)');
    exception when others then
      perform cron.schedule('leadguard-escalation', '* * * * *', 'select public.escalate_overdue_leads(100)');
    end;
  else
    raise notice 'pg_cron is not installed: schedule public.escalate_overdue_leads() from a trusted server job.';
  end if;
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.leads, public.lead_assignments, public.lead_escalations, public.employee_availability;
  end if;
end;
$$;
