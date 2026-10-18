import { createFileRoute } from '@tanstack/react-router';
import { EntityPage } from '@/components/leadguard/entity-pages';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/opportunities')({head:()=>pageHead('Opportunities','Track the value and progress of your sales opportunities.'),component:Page});
function Page(){return <EntityPage kind="opportunities"/>;}
