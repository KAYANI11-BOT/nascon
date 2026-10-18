import {ArrowUpRight,Check,CircleAlert,Inbox,ShieldCheck} from 'lucide-react';
import type {ReactNode} from 'react';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';
export function Brand({compact=false}:{compact?:boolean}){return <div className="flex items-center gap-2.5"><span className="brand-symbol"><ShieldCheck size={23}/></span>{!compact&&<span className="text-xl font-semibold">LeadGuard<span className="text-brand">.</span></span>}</div>;}
export function Avatar({name,className}:{name:string;className?:string}){return <span className={cn('avatar',className)}>{name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span>;}
export function Status({children}:{children:ReactNode}){const s=String(children);return <span className={cn('status',['Available','Active','Paid','Qualified','Customer','Won','Acknowledged'].includes(s)?'status-success':['Recovery','Escalated','Overdue'].includes(s)?'status-danger':['Busy','Pending','Contacted','Unacknowledged'].includes(s)?'status-warning':'status-neutral')}><span className="size-1.5 rounded-full bg-current"/>{children}</span>;}
export function PageHeading({title,subtitle,children}:{title:string;subtitle:string;children?:ReactNode}){return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="flex flex-wrap items-center gap-2">{children}</div></div>;}
export function Panel({title,description,children,action,className}:{title:string;description?:string;children:ReactNode;action?:ReactNode;className?:string}){return <section className={cn('panel',className)}><div className="panel-heading"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{action}</div>{children}</section>;}
export function EmptyState({title='No results found',description='Try a different search or filter.'}:{title?:string;description?:string}){return <div className="empty-state"><span className="empty-icon"><Inbox size={26}/></span><h3>{title}</h3><p>{description}</p></div>;}
export function ConfigurationNotice(){return <div className="configuration-notice"><CircleAlert size={16}/><span>Configuration required. Authentication, database storage and integrations are not connected.</span></div>;}
export function LoadingState(){return <div className="space-y-4 p-6"><Skeleton className="h-10 w-1/3"/>{[1,2,3,4].map(i=><Skeleton key={i} className="h-14 w-full"/>)}</div>;}
export function ErrorState({message,onRetry}:{message:string;onRetry:()=>void}){return <div className="empty-state"><CircleAlert className="text-destructive"/><h3>Something went wrong</h3><p>{message}</p><Button variant="outline" onClick={onRetry}>Try again</Button></div>;}
export function Change({children}:{children:ReactNode}){return <span className="inline-flex items-center gap-1 text-success text-xs font-medium"><ArrowUpRight size={14}/>{children}</span>;}
export function LocalNotice(){return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Check size={14}/>Demo changes stay in this session only.</p>;}
