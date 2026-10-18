import { createFileRoute } from '@tanstack/react-router';
import { DetailPage } from '@/components/leadguard/entity-pages';
import { LeadDetailRoute } from '@/components/leadguard/lead-detail-live';
import { pageHead } from '@/lib/page-head';
// Un-nested filename (leads_.$id) so the detail page is not rendered inside the leads list route.
export const Route = createFileRoute('/leads_/$id')({head:()=>pageHead('Leads details','Relationship information and activity in LeadGuard.'),component:Page});
function Page(){const {id}=Route.useParams();return <LeadDetailRoute id={id} fallback={<DetailPage kind="leads" id={id}/>}/>;}
