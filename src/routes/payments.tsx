import { createFileRoute } from '@tanstack/react-router';
import { Payments } from '@/components/leadguard/engagement';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/payments')({head:()=>pageHead('Payments','Review illustrative invoices and payment statuses.'),component:Page});
function Page(){return <Payments/>;}
