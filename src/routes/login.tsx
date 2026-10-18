import { createFileRoute } from '@tanstack/react-router';
import { AuthPage } from '@/components/leadguard/auth';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/login')({head:()=>pageHead('Sign in','Sign in screen for the LeadGuard business workspace.'),component:Page});
function Page(){return <AuthPage/>;}
