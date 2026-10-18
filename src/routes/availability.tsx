import { createFileRoute } from '@tanstack/react-router';
import { AvailabilityRoute } from '@/components/leadguard/availability-live';
import { TeamPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/availability')({head:()=>pageHead('Employee availability','Preview team availability and assigned lead workloads.'),component:Page});
function Page(){return <AvailabilityRoute fallback={<TeamPage availability/>}/>;}
