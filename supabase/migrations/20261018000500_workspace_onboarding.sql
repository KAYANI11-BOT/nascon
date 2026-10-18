-- Secure workspace onboarding. The caller is derived from the authenticated JWT; the
-- workspace, Owner membership, default permissions, default pipeline and availability are
-- created in one transaction. Retries are idempotent: a user who already owns a workspace
-- receives that workspace instead of a duplicate (enforced by a unique index as well).

create function public.create_workspace_with_owner(p_name text, p_industry text default 'Other', p_timezone text default 'UTC')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_industry text := left(btrim(coalesce(nullif(p_industry, ''), 'Other')), 80);
  v_timezone text := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  v_workspace_id uuid;
  v_pipeline_id uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)) then
    raise exception 'confirm your email address before creating a workspace' using errcode = '42501';
  end if;
  if char_length(v_name) not between 2 and 120 then
    raise exception 'workspace name must be between 2 and 120 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = v_timezone) then
    raise exception 'unknown timezone' using errcode = '22023';
  end if;

  -- Serialise concurrent retries for the same user, then return any existing owned workspace.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('leadguard.onboarding:' || v_uid::text, 0));
  select m.workspace_id into v_workspace_id
  from public.workspace_members m where m.user_id = v_uid and m.role = 'owner';
  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  -- Profiles normally come from the auth trigger; ensure one exists for older accounts.
  insert into public.profiles (id) values (v_uid) on conflict (id) do nothing;

  insert into public.workspaces (name, industry, timezone, created_by)
  values (v_name, v_industry, v_timezone, v_uid)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_uid, 'owner');

  insert into public.workspace_role_permissions (workspace_id, role, permission_key, allowed)
  select v_workspace_id, r.role, p.key, case when r.role = 'admin' then p.default_admin else p.default_user end
  from public.permissions p
  cross join (values ('admin'::public.workspace_role), ('user'::public.workspace_role)) as r(role);

  insert into public.pipelines (workspace_id, name, is_default)
  values (v_workspace_id, 'Sales pipeline', true)
  returning id into v_pipeline_id;

  insert into public.pipeline_stages (workspace_id, pipeline_id, name, position, stage_type, probability)
  values
    (v_workspace_id, v_pipeline_id, 'Discovery', 0, 'open', 10),
    (v_workspace_id, v_pipeline_id, 'Qualified', 1, 'open', 30),
    (v_workspace_id, v_pipeline_id, 'Proposal', 2, 'open', 50),
    (v_workspace_id, v_pipeline_id, 'Negotiation', 3, 'open', 75),
    (v_workspace_id, v_pipeline_id, 'Won', 4, 'won', 100),
    (v_workspace_id, v_pipeline_id, 'Lost', 5, 'lost', 0);

  insert into public.employee_availability (workspace_id, user_id) values (v_workspace_id, v_uid);

  insert into public.assignment_rules (workspace_id, name, strategy, is_active, created_by)
  values (v_workspace_id, 'Manual assignment', 'manual', true, v_uid);

  return v_workspace_id;
end;
$$;

revoke all on function public.create_workspace_with_owner(text, text, text) from public, anon;
grant execute on function public.create_workspace_with_owner(text, text, text) to authenticated;
