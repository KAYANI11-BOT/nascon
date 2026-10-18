import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/components/leadguard/dashboard';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/')({head:()=>pageHead('Operational dashboard','LeadGuard workspace overview, lead activity, pipeline and team availability.'),component:Dashboard});
