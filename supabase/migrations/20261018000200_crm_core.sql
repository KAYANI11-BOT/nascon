-- LeadGuard CRM core: companies, contacts, pipelines, stages and opportunities.
-- Every table is workspace-scoped. Composite foreign keys (workspace_id, id) make it
-- impossible to link a record to a parent or member from a different workspace.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  domain text check (domain is null or char_length(domain) <= 253),
  industry text check (industry is null or char_length(industry) <= 80),
  phone text check (phone is null or char_length(phone) <= 40),
  owner_id uuid,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references public.workspace_members (workspace_id, user_id) on delete set null (owner_id)
);
create index companies_workspace_name_idx on public.companies (workspace_id, lower(name));
create index companies_owner_idx on public.companies (workspace_id, owner_id);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  email text check (email is null or (char_length(email) <= 320 and email like '%_@_%')),
  phone text check (phone is null or char_length(phone) <= 40),
  title text check (title is null or char_length(title) <= 120),
  owner_id uuid,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, company_id) references public.companies (workspace_id, id) on delete set null (company_id),
  foreign key (workspace_id, owner_id) references public.workspace_members (workspace_id, user_id) on delete set null (owner_id)
);
create index contacts_workspace_email_idx on public.contacts (workspace_id, lower(email));
create index contacts_company_idx on public.contacts (workspace_id, company_id);
create index contacts_owner_idx on public.contacts (workspace_id, owner_id);

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index pipelines_one_default_per_workspace on public.pipelines (workspace_id) where is_default;

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  pipeline_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position integer not null check (position >= 0),
  stage_type text not null default 'open' check (stage_type in ('open', 'won', 'lost')),
  probability smallint check (probability between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, pipeline_id, id),
  constraint pipeline_stages_position_unique unique (pipeline_id, position) deferrable initially deferred,
  foreign key (workspace_id, pipeline_id) references public.pipelines (workspace_id, id) on delete cascade
);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  pipeline_id uuid not null,
  stage_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  expected_close_date date,
  company_id uuid,
  contact_id uuid,
  owner_id uuid,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  -- The stage must belong to the opportunity's pipeline in the same workspace.
  foreign key (workspace_id, pipeline_id, stage_id) references public.pipeline_stages (workspace_id, pipeline_id, id),
  foreign key (workspace_id, company_id) references public.companies (workspace_id, id) on delete set null (company_id),
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete set null (contact_id),
  foreign key (workspace_id, owner_id) references public.workspace_members (workspace_id, user_id) on delete set null (owner_id)
);
create index opportunities_stage_idx on public.opportunities (workspace_id, pipeline_id, stage_id);
create index opportunities_company_idx on public.opportunities (workspace_id, company_id);
create index opportunities_contact_idx on public.opportunities (workspace_id, contact_id);
create index opportunities_owner_idx on public.opportunities (workspace_id, owner_id);

-- Triggers: updated_at and immutable workspace_id on every table.
do $$
declare t text;
begin
  foreach t in array array['companies', 'contacts', 'pipelines', 'pipeline_stages', 'opportunities'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.prevent_workspace_change()', t || '_lock_workspace', t);
  end loop;
end;
$$;

-- RLS: members read; writes require the matching configurable permission; deletes require records.delete.
alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.pipelines enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.opportunities enable row level security;

revoke all on table public.companies, public.contacts, public.pipelines, public.pipeline_stages, public.opportunities from anon, authenticated;
grant select, insert, update, delete on table public.companies, public.contacts, public.pipelines, public.pipeline_stages, public.opportunities to authenticated;

do $$
declare
  t text;
  perm text;
begin
  for t, perm in select * from (values
    ('companies', 'companies.manage'),
    ('contacts', 'contacts.manage'),
    ('pipelines', 'pipelines.manage'),
    ('pipeline_stages', 'pipelines.manage'),
    ('opportunities', 'opportunities.manage')
  ) as v(t, perm) loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_workspace_member(workspace_id))', t || ': members read', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.has_workspace_permission(workspace_id, %L)) with check (private.has_workspace_permission(workspace_id, %L))', t || ': managers update', t, perm, perm);
    execute format('create policy %I on public.%I for delete to authenticated using (private.has_workspace_permission(workspace_id, %L) and private.has_workspace_permission(workspace_id, ''records.delete''))', t || ': deleters delete', t, perm);
    if t in ('companies', 'contacts', 'opportunities') then
      -- created_by must be the caller; it defaults to auth.uid().
      execute format('create policy %I on public.%I for insert to authenticated with check (private.has_workspace_permission(workspace_id, %L) and created_by = (select auth.uid()))', t || ': managers insert', t, perm);
    else
      execute format('create policy %I on public.%I for insert to authenticated with check (private.has_workspace_permission(workspace_id, %L))', t || ': managers insert', t, perm);
    end if;
  end loop;
end;
$$;

-- created_by is set on insert only.
create function private.lock_created_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- pg_trigger_depth() > 1 means a foreign-key cascade (profile deletion) is nulling the column.
  if new.created_by is distinct from old.created_by and pg_trigger_depth() = 1 then
    raise exception 'created_by cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger companies_lock_created_by before update on public.companies for each row execute function private.lock_created_by();
create trigger contacts_lock_created_by before update on public.contacts for each row execute function private.lock_created_by();
create trigger opportunities_lock_created_by before update on public.opportunities for each row execute function private.lock_created_by();
