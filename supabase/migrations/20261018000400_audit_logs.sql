-- LeadGuard audit log. Rows are written only by the SECURITY DEFINER trigger below; clients
-- receive SELECT (with audit.view) and nothing else, so they cannot forge or alter records.

create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  table_name text not null,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_workspace_created_idx on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_record_idx on public.audit_logs (workspace_id, table_name, record_id);

create function private.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_workspace_id uuid := case when tg_table_name = 'workspaces' then (v_row ->> 'id')::uuid else (v_row ->> 'workspace_id')::uuid end;
begin
  -- When a whole workspace is deleted its audit trail is removed with it.
  if not exists (select 1 from public.workspaces w where w.id = v_workspace_id) then
    return null;
  end if;
  insert into public.audit_logs (workspace_id, actor_id, action, table_name, record_id, old_data, new_data)
  values (
    v_workspace_id,
    (select auth.uid()),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'permission_key'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end;
$$;
revoke all on function private.write_audit_log() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'workspaces', 'workspace_members', 'workspace_role_permissions',
    'companies', 'contacts', 'pipelines', 'pipeline_stages', 'opportunities',
    'leads', 'assignment_rules', 'employee_availability'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.write_audit_log()', t || '_audit', t);
  end loop;
end;
$$;

alter table public.audit_logs enable row level security;
revoke all on table public.audit_logs from anon, authenticated;
grant select on table public.audit_logs to authenticated;
create policy "audit_logs: auditors read" on public.audit_logs
  for select to authenticated using (private.has_workspace_permission(workspace_id, 'audit.view'));
