import {createContext,useContext,useEffect,useMemo,type ReactNode} from 'react';
import {queryOptions,useQuery,useQueryClient} from '@tanstack/react-query';
import {useRouter} from '@tanstack/react-router';
import {getSupabaseConfiguration} from '@/lib/supabase';
import {getSupabaseBrowserClient} from '@/lib/supabase-browser';
import {authService} from '@/services/auth';
import {getAuthContext} from '@/services/workspace.functions';
import type {AuthContext,PermissionKey} from '@/types/domain';

export const authQueryKey=['auth-context'] as const;
/** Shared by the root route guard and components so both read the same server-verified state. */
export const authContextQuery=()=>queryOptions({queryKey:authQueryKey,queryFn:()=>getAuthContext(),staleTime:60_000});

interface AuthState extends AuthContext {
  /** Re-reads the session and memberships, then re-runs route guards. */
  refresh:()=>Promise<void>;
  signOut:()=>Promise<string|null>;
  /** UI hint only. Database policies and server checks enforce access. */
  can:(permission:PermissionKey)=>boolean;
}
const Ctx=createContext<AuthState|null>(null);

export function AuthProvider({initial,children}:{initial:AuthContext;children:ReactNode}){
  const queryClient=useQueryClient();const router=useRouter();
  const {data=initial}=useQuery({...authContextQuery(),initialData:initial});
  const refresh=async()=>{await queryClient.invalidateQueries({queryKey:authQueryKey});await router.invalidate();};
  useEffect(()=>{
    if(!getSupabaseConfiguration().configured)return;
    const {data:sub}=getSupabaseBrowserClient().auth.onAuthStateChange(event=>{
      // Defer: Supabase warns against awaiting other calls inside this callback.
      if(event==='SIGNED_IN'||event==='SIGNED_OUT'||event==='USER_UPDATED')setTimeout(()=>{void refresh();},0);
    });
    return()=>sub.subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const value=useMemo<AuthState>(()=>({...data,refresh,
    signOut:async()=>{const result=await authService.signOut();queryClient.removeQueries({queryKey:authQueryKey});await router.invalidate();return result.error;},
    can:permission=>data.permissions.includes(permission)}),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Authenticated user, active workspace and permissions for any feature module. */
export function useAuth(){const state=useContext(Ctx);if(!state)throw new Error('AuthProvider is required.');return state;}
