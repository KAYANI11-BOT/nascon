import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/assignment-rules')({head:()=>pageHead('Assignment rules','Assignment rules for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="assignment-rules"/>;}
