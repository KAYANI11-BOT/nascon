import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/audit')({head:()=>pageHead('Audit history','Audit history for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="audit"/>;}
