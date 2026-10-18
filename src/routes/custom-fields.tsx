import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/custom-fields')({head:()=>pageHead('Custom fields','Custom fields for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="custom-fields"/>;}
