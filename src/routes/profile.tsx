import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/leadguard/settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/profile')({head:()=>pageHead('My profile','My profile for your LeadGuard business workspace.'),component:Page});
function Page(){return <SettingsPage section="profile"/>;}
