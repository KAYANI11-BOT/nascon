import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/team')({head:()=>pageHead('Team members','Your LeadGuard team and base workspace roles.'),component:Page});
function Page(){return <TeamPage/>;}
