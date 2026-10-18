import { createFileRoute } from '@tanstack/react-router';
import { AssignmentRulesRoute } from '@/components/leadguard/assignment-rules-live';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/assignment-rules')({head:()=>pageHead('Assignment rules','Assignment rules for your LeadGuard business workspace.'),component:Page});
function Page(){return <AssignmentRulesRoute fallback={<SettingsPage section="assignment-rules"/>}/>;}
