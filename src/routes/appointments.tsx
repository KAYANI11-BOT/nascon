import { createFileRoute } from '@tanstack/react-router';
import { Appointments } from '@/components/leadguard/engagement';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/appointments')({head:()=>pageHead('Appointments','Plan your customer conversations with a calendar and agenda.'),component:Page});
function Page(){return <Appointments/>;}
