import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/pipeline-settings')({head:()=>pageHead('Pipeline configuration','Pipeline configuration for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="pipeline-settings"/>;}
