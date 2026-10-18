import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/permissions')({head:()=>pageHead('Roles and permissions','Roles and permissions for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="permissions"/>;}
