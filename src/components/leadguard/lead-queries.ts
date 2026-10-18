import {useEffect, useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useAuth} from '@/contexts/auth-context';
import {getSupabaseBrowserClient} from '@/lib/supabase-browser';
import {leadService} from '@/services/leads';
import type {ServiceResult} from '@/types/domain';
import type {AssignmentRules, AvailabilityStatus, LeadListFilters, QualifyingAction, RecoveryFilters} from '@/types/leads';

/** Unwraps a ServiceResult so React Query surfaces the server's message as the error. */
async function unwrap<T>(p: Promise<ServiceResult<T>>): Promise<T> {
  const r = await p;
  if (r.error !== null || r.data === null) throw new Error(r.error ?? 'No data returned.');
  return r.data;
}

const key = (ws: string, ...rest: unknown[]) => ['leads', ws, ...rest] as const;
const POLL_MS = 15_000; // fallback so views self-heal even if Realtime is unavailable

/** Live mode = real sign-in enforced and a workspace selected. Otherwise the demo screens render. */
export function useLiveWorkspace(): {live: boolean; workspaceId: string | null; userId: string | null; can: (p: Parameters<ReturnType<typeof useAuth>['can']>[0]) => boolean} {
  const auth = useAuth();
  const workspaceId = auth.activeWorkspace?.workspaceId ?? null;
  return {live: auth.enforced && auth.user !== null && workspaceId !== null, workspaceId, userId: auth.user?.id ?? null, can: auth.can};
}

export type RealtimeState = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribes to row changes for the lead tables of one workspace and invalidates cached queries.
 * Cleans up the channel on unmount. supabase-js reconnects on its own; on re-subscribe we refetch
 * once so nothing missed during the gap is shown stale.
 */
export function useLeadRealtime(workspaceId: string | null): RealtimeState {
  const qc = useQueryClient();
  const [state, setState] = useState<RealtimeState>('connecting');
  useEffect(() => {
    if (!workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void qc.invalidateQueries({queryKey: ['leads', workspaceId]}); }, 250);
    };
    let client: ReturnType<typeof getSupabaseBrowserClient>;
    try { client = getSupabaseBrowserClient(); } catch { setState('reconnecting'); return; }
    const channel = client.channel(`leadguard-leads:${workspaceId}`);
    for (const table of ['leads', 'lead_assignments', 'lead_escalations', 'employee_availability']) {
      channel.on('postgres_changes', {event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}`}, invalidate);
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { setState('live'); invalidate(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setState('reconnecting');
    });
    return () => { clearTimeout(timer); void client.removeChannel(channel); };
  }, [workspaceId, qc]);
  return state;
}

/** One shared ticking clock for tables (avoids a timer per row). Display only. */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}

export function useLeadList(ws: string | null, filters: LeadListFilters) {
  return useQuery({enabled: ws !== null, queryKey: key(ws ?? '', 'list', filters), queryFn: () => unwrap(leadService.listLeads(ws!, filters)), refetchInterval: POLL_MS, placeholderData: (prev) => prev});
}
export function useLeadDetail(ws: string | null, id: string) {
  return useQuery({enabled: ws !== null, queryKey: key(ws ?? '', 'detail', id), queryFn: () => unwrap(leadService.getLead(ws!, id)), refetchInterval: POLL_MS});
}
export function useRecoveryQueue(ws: string | null, filters: RecoveryFilters) {
  return useQuery({enabled: ws !== null, queryKey: key(ws ?? '', 'recovery', filters), queryFn: () => unwrap(leadService.recoveryQueue(ws!, filters)), refetchInterval: POLL_MS, placeholderData: (prev) => prev});
}
export function useTeam(ws: string | null) {
  return useQuery({enabled: ws !== null, queryKey: key(ws ?? '', 'team'), queryFn: () => unwrap(leadService.listTeam(ws!)), refetchInterval: POLL_MS});
}
export function useRules(ws: string | null) {
  return useQuery({
    enabled: ws !== null, queryKey: key(ws ?? '', 'rules'),
    queryFn: async () => { const r = await leadService.getRules(ws!); if (r.error !== null) throw new Error(r.error); return r.data; },
  });
}

/** userId -> display name, from the team query (falls back to a short id while loading). */
export function useNames(ws: string | null) {
  const team = useTeam(ws);
  return useMemo(() => {
    const map = new Map((team.data ?? []).map((t) => [t.userId, t.name]));
    return (id: string | null) => (id === null ? 'Unassigned' : map.get(id) ?? `Member ${id.slice(0, 4)}`);
  }, [team.data]);
}

function useRefresh(ws: string | null) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({queryKey: ['leads', ws ?? '']});
}

export function useCreateLead(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({
    mutationFn: (input: {name: string; email?: string; phone?: string; company?: string; message?: string; idempotencyKey: string}) => unwrap(leadService.createManual(ws!, input)),
    onSuccess: refresh,
  });
}
export function useAcknowledge(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({mutationFn: (v: {leadId: string; assignmentId: string}) => unwrap(leadService.acknowledge(v.leadId, v.assignmentId)), onSuccess: refresh, onError: refresh});
}
export function useRecordAction(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({mutationFn: (v: {leadId: string; action: QualifyingAction; dedupeKey: string; note?: string}) => unwrap(leadService.recordAction(v.leadId, v.action, v.dedupeKey, v.note)), onSuccess: refresh});
}
export function useReassign(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({mutationFn: (v: {leadId: string; toUserId: string; version: number}) => unwrap(leadService.reassign(v.leadId, v.toUserId, v.version)), onSuccess: refresh, onError: refresh});
}
export function useResolveRecovery(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({mutationFn: (leadId: string) => unwrap(leadService.resolveRecovery(leadId).then((r) => (r.error === null ? {data: true, error: null} : {data: null, error: r.error}))), onSuccess: refresh});
}
export function useSetAvailability(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({mutationFn: (v: {userId: string; status: AvailabilityStatus}) => unwrap(leadService.setAvailability(ws!, v.userId, v.status).then((r) => (r.error === null ? {data: true, error: null} : {data: null, error: r.error}))), onSuccess: refresh});
}
export function useSaveRules(ws: string | null) {
  const refresh = useRefresh(ws);
  return useMutation({mutationFn: (v: {ruleId: string; rules: AssignmentRules}) => unwrap(leadService.saveRules(ws!, v.ruleId, v.rules).then((r) => (r.error === null ? {data: true, error: null} : {data: null, error: r.error}))), onSuccess: refresh});
}
