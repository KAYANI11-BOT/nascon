import { createFileRoute } from '@tanstack/react-router';
import { EntityPage } from '@/components/leadguard/entity-pages';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/leads')({head:()=>pageHead('Lead management','Review, filter and manage lead relationships in LeadGuard.'),component:Page});
function Page(){return <EntityPage kind="leads"/>;}
