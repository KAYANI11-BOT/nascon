-- LeadGuard lead routing foundation: leads, employee availability, assignment rules and
-- assignment history. Automation itself is out of scope; this is the data contract.

create table public.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  strategy text not null default 'manual' check (strategy in ('manual', 'round_robin', 'availability')),
  is_active boolean not null default false,
  priority integer not null default 0,
  acknowledgement_window_minutes integer not null default 15 check (acknowledgement_window_minutes between 1 and 10080),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index assignment_rules_active_idx on public.assignment_rules (workspace_id, is_active, priority);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  email text check (email is null or (char_length(email) <= 320 and email like '%_@_%')),
  phone text check (phone is null or char_length(phone) <= 40),
  company_name text check (company_name is null or char_length(company_name) <= 200),
  source text check (source is null or char_length(source) <= 80),
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'recovery', 'escalated', 'converted', 'lost')),
  estimated_value numeric(14, 2) check (estimated_value is null or estimated_value >= 0),
  company_id uuid,
  contact_id uuid,
  assigned_to uuid,
  assigned_at timestamptz,
  acknowledgement_due_at timestamptz,
  acknowledged_at timestamptz,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, company_id) references public.companies (workspace_id, id) on delete set null (company_id),
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete set null (contact_id),
  foreign key (workspace_id, assigned_to) references public.workspace_members (workspace_id, user_id) on delete set null (assigned_to)
);
create index leads_workspace_status_idx on public.leads (workspace_id, status, created_at desc);
create index leads_assigned_idx on public.leads (workspace_id, assigned_to);
create index leads_ack_due_idx on public.leads (workspace_id, acknowledgement_due_at) where acknowledged_at is null;
create index leads_workspace_email_idx on public.leads (workspace_id, lower(email));
create index leads_company_idx on public.leads (workspace_id, company_id);
create index leads_contact_idx on public.leads (workspace_id, contact_id);

create table public.employee_availability (
  workspace_id uuid not null,
  user_id uuid not null,
  status text not null default 'available' check (status in ('available', 'busy', 'away', 'offline')),
  max_open_leads integer check (max_open_leads is null or max_open_leads between 0 and 10000),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id) references public.workspace_members (workspace_id, user_id) on delete cascade
);

-- Append-only history, written by trigger (or a future server-side automation), never by clients.
create table public.lead_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  lead_id uuid not null,
  assigned_to uuid,
  previous_assigned_to uuid,
  assigned_by uuid references public.profiles (id) on delete set null,
  rule_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  foreign key (workspace_id, rule_id) references public.assignment_rules (workspace_id, id) on delete set null (rule_id),
  foreign key (workspace_id) references public.workspaces (id) on delete cascade
);
create index lead_assignments_lead_idx on public.lead_assignments (workspace_id, lead_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['assignment_rules', 'leads', 'employee_availability'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.prevent_workspace_change()', t || '_lock_workspace', t);
  end loop;
end;
$$;
create trigger leads_lock_created_by before update on public.leads for each row execute function private.lock_created_by();
create trigger assignment_rules_lock_created_by before update on public.assignment_rules for each row execute function private.lock_created_by();
create function private.guard_availability_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'availability user cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger employee_availability_lock_user before update on public.employee_availability
  for each row execute function private.guard_availability_update();

-- ---------------------------------------------------------------------------
-- Assignment enforcement and history
-- ---------------------------------------------------------------------------
create function private.guard_lead_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  -- Client sessions need leads.assign to assign others; self-assignment on create is allowed.
  -- Foreign-key cascades (depth > 1) and server-side automation (no auth.uid()) are exempt.
  if v_uid is not null and pg_trigger_depth() = 1 then
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

create trigger leads_guard_assignment before insert or update on public.leads
  for each row execute function private.guard_lead_assignment();

create function private.record_lead_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Skip while the workspace itself is being deleted (cascade nulling assigned_to).
  if not exists (select 1 from public.workspaces w where w.id = new.workspace_id) then
    return null;
  end if;
  if tg_op = 'INSERT' and new.assigned_to is not null
     or tg_op = 'UPDATE' and new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_assignments (workspace_id, lead_id, assigned_to, previous_assigned_to, assigned_by)
    values (new.workspace_id, new.id, new.assigned_to,
            case when tg_op = 'UPDATE' then old.assigned_to end, (select auth.uid()));
  end if;
  return null;
end;
$$;
revoke all on function private.record_lead_assignment() from public, anon, authenticated;

create trigger leads_record_assignment after insert or update of assigned_to on public.leads
  for each row execute function private.record_lead_assignment();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.assignment_rules enable row level security;
alter table public.leads enable row level security;
alter table public.employee_availability enable row level security;
alter table public.lead_assignments enable row level security;

revoke all on table public.assignment_rules, public.leads, public.employee_availability, public.lead_assignments from anon, authenticated;
grant select, insert, update, delete on table public.assignment_rules, public.leads to authenticated;
grant select, insert, update on table public.employee_availability to authenticated;
grant select on table public.lead_assignments to authenticated;

create policy "assignment_rules: members read" on public.assignment_rules
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "assignment_rules: managers insert" on public.assignment_rules
  for insert to authenticated
  with check (private.has_workspace_permission(workspace_id, 'assignment_rules.manage') and created_by = (select auth.uid()));
create policy "assignment_rules: managers update" on public.assignment_rules
  for update to authenticated
  using (private.has_workspace_permission(workspace_id, 'assignment_rules.manage'))
  with check (private.has_workspace_permission(workspace_id, 'assignment_rules.manage'));
create policy "assignment_rules: managers delete" on public.assignment_rules
  for delete to authenticated using (private.has_workspace_permission(workspace_id, 'assignment_rules.manage'));

create policy "leads: members read" on public.leads
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "leads: managers insert" on public.leads
  for insert to authenticated
  with check (private.has_workspace_permission(workspace_id, 'leads.manage') and created_by = (select auth.uid()));
-- Managers edit any lead; assignees may update (e.g. acknowledge) leads assigned to them.
create policy "leads: managers or assignee update" on public.leads
  for update to authenticated
  using (private.has_workspace_permission(workspace_id, 'leads.manage')
         or (assigned_to = (select auth.uid()) and private.is_workspace_member(workspace_id)))
  with check (private.has_workspace_permission(workspace_id, 'leads.manage')
              or (assigned_to = (select auth.uid()) and private.is_workspace_member(workspace_id)));
create policy "leads: deleters delete" on public.leads
  for delete to authenticated
  using (private.has_workspace_permission(workspace_id, 'leads.manage') and private.has_workspace_permission(workspace_id, 'records.delete'));

create policy "employee_availability: members read" on public.employee_availability
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "employee_availability: self or manager insert" on public.employee_availability
  for insert to authenticated
  with check ((user_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
              or private.has_workspace_permission(workspace_id, 'availability.manage_others'));
create policy "employee_availability: self or manager update" on public.employee_availability
  for update to authenticated
  using ((user_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
         or private.has_workspace_permission(workspace_id, 'availability.manage_others'))
  with check ((user_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
              or private.has_workspace_permission(workspace_id, 'availability.manage_others'));

create policy "lead_assignments: members read" on public.lead_assignments
  for select to authenticated using (private.is_workspace_member(workspace_id));
