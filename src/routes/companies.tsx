import { createFileRoute } from '@tanstack/react-router';
import { EntityPage } from '@/components/leadguard/entity-pages';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/companies')({head:()=>pageHead('Companies','Explore company relationships in your LeadGuard workspace.'),component:Page});
function Page(){return <EntityPage kind="companies"/>;}
