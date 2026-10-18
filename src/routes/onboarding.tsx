import { createFileRoute } from '@tanstack/react-router';
import { Onboarding } from '@/components/leadguard/auth';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/onboarding')({head:()=>pageHead('Workspace onboarding','Set up a preview of your new LeadGuard workspace.'),component:Page});
function Page(){return <Onboarding/>;}
