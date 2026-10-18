-- LeadGuard tenancy foundation: profiles, workspaces, memberships and configurable permissions.
-- Manual-review artifact. Apply only through the reviewed migration workflow.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create type public.workspace_role as enum ('owner', 'admin', 'user');

-- ---------------------------------------------------------------------------
-- Generic trigger helpers
-- ---------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Rows can never move between workspaces once created.
create function private.prevent_workspace_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles (personal details only; roles live on workspace_members)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120))
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Reconcile accounts that existed before this migration.
insert into public.profiles (id, full_name)
select u.id, left(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), 120)
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Workspaces and memberships
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  industry text not null default 'Other' check (char_length(industry) <= 80),
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.workspace_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index workspace_members_user_id_idx on public.workspace_members (user_id);
-- Exactly one Owner per workspace, and (v1) each user owns at most one workspace.
create unique index workspace_members_one_owner_per_workspace on public.workspace_members (workspace_id) where role = 'owner';
create unique index workspace_members_one_owned_workspace_per_user on public.workspace_members (user_id) where role = 'owner';

create trigger workspace_members_set_updated_at before update on public.workspace_members
  for each row execute function private.set_updated_at();

-- Defence in depth: even if membership update grants are added later, identity columns are
-- immutable, nobody changes their own role from a client session, and Owner changes require
-- a dedicated privileged operation.
create function private.guard_workspace_member_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id or new.user_id is distinct from old.user_id then
    raise exception 'membership workspace and user cannot be changed' using errcode = '42501';
  end if;
  if new.role is distinct from old.role and (select auth.uid()) is not null then
    if old.user_id = (select auth.uid()) then
      raise exception 'members cannot change their own role' using errcode = '42501';
    end if;
    if old.role = 'owner' or new.role = 'owner' then
      raise exception 'ownership changes require a dedicated transfer operation' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger workspace_members_guard before update on public.workspace_members
  for each row execute function private.guard_workspace_member_update();

-- ---------------------------------------------------------------------------
-- Configurable permissions (Owner always has every permission)
-- ---------------------------------------------------------------------------
create table public.permissions (
  key text primary key check (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description text not null,
  default_admin boolean not null default false,
  default_user boolean not null default false
);

insert into public.permissions (key, description, default_admin, default_user) values
  ('workspace.settings.manage', 'Edit workspace settings', true, false),
  ('members.manage', 'Invite and manage team members', true, false),
  ('companies.manage', 'Create and edit companies', true, true),
  ('contacts.manage', 'Create and edit contacts', true, true),
  ('opportunities.manage', 'Create and edit opportunities', true, true),
  ('pipelines.manage', 'Configure pipelines and stages', true, false),
  ('leads.manage', 'Create and edit leads', true, true),
  ('leads.assign', 'Assign leads to team members', true, false),
  ('assignment_rules.manage', 'Configure lead assignment rules', true, false),
  ('availability.manage_others', 'Change other members'' availability', true, false),
  ('records.delete', 'Delete workspace records', true, false),
  ('audit.view', 'View audit history', true, false);

create table public.workspace_role_permissions (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role public.workspace_role not null check (role <> 'owner'),
  permission_key text not null references public.permissions (key) on delete cascade,
  allowed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, role, permission_key)
);

create trigger workspace_role_permissions_set_updated_at before update on public.workspace_role_permissions
  for each row execute function private.set_updated_at();
create trigger workspace_role_permissions_lock_workspace before update on public.workspace_role_permissions
  for each row execute function private.prevent_workspace_change();

-- ---------------------------------------------------------------------------
-- Authorization helpers. SECURITY DEFINER so policies can read memberships without
-- re-entering workspace_members RLS (prevents recursive policies). Always scoped to auth.uid().
-- ---------------------------------------------------------------------------
create function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid())
  );
$$;

create function private.workspace_role(p_workspace_id uuid)
returns public.workspace_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid());
$$;

create function private.has_workspace_permission(p_workspace_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when m.role = 'owner' then true
      else coalesce((
        select rp.allowed from public.workspace_role_permissions rp
        where rp.workspace_id = m.workspace_id and rp.role = m.role and rp.permission_key = p_permission
      ), false)
    end
    from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid())
  ), false);
$$;

create function private.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = p_user_id
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public, anon;
revoke all on function private.workspace_role(uuid) from public, anon;
revoke all on function private.has_workspace_permission(uuid, text) from public, anon;
revoke all on function private.shares_workspace_with(uuid) from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.workspace_role(uuid) to authenticated;
grant execute on function private.has_workspace_permission(uuid, text) to authenticated;
grant execute on function private.shares_workspace_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and least-privilege grants
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.permissions enable row level security;
alter table public.workspace_role_permissions enable row level security;

revoke all on table public.profiles, public.workspaces, public.workspace_members,
  public.permissions, public.workspace_role_permissions from anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (full_name, avatar_url) on table public.profiles to authenticated;
create policy "profiles: read self and workspace teammates" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.shares_workspace_with(id));
create policy "profiles: update self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Workspaces are created only through public.create_workspace_with_owner().
grant select on table public.workspaces to authenticated;
grant update (name, industry, timezone) on table public.workspaces to authenticated;
create policy "workspaces: members read" on public.workspaces
  for select to authenticated using (private.is_workspace_member(id));
create policy "workspaces: settings managers update" on public.workspaces
  for update to authenticated
  using (private.has_workspace_permission(id, 'workspace.settings.manage'))
  with check (private.has_workspace_permission(id, 'workspace.settings.manage'));

-- Memberships are read-only for clients. Invitations and role changes will be privileged
-- server operations, so users cannot join arbitrary workspaces or change roles.
grant select on table public.workspace_members to authenticated;
create policy "workspace_members: members read" on public.workspace_members
  for select to authenticated using (private.is_workspace_member(workspace_id));

grant select on table public.permissions to authenticated;
create policy "permissions: catalog readable" on public.permissions
  for select to authenticated using (true);

-- Only the Owner may change role permissions, so Admins cannot grant themselves more access.
grant select on table public.workspace_role_permissions to authenticated;
grant update (allowed) on table public.workspace_role_permissions to authenticated;
create policy "workspace_role_permissions: members read" on public.workspace_role_permissions
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "workspace_role_permissions: owner updates" on public.workspace_role_permissions
  for update to authenticated
  using (private.workspace_role(workspace_id) = 'owner')
  with check (private.workspace_role(workspace_id) = 'owner');
