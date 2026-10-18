import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/settings')({head:()=>pageHead('Workspace settings','Workspace settings for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="settings"/>;}
