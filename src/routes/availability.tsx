import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/availability')({head:()=>pageHead('Employee availability','Preview team availability and assigned lead workloads.'),component:Page});
function Page(){return <TeamPage availability/>;}
