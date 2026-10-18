import { createFileRoute } from '@tanstack/react-router';
import { AuthPage } from '@/components/leadguard/auth';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/signup')({head:()=>pageHead('Create an account','Create your LeadGuard account and workspace.'),component:Page});
function Page(){return <AuthPage signup/>;}
