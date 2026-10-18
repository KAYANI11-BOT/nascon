import { createFileRoute } from '@tanstack/react-router';
import { DetailPage } from '@/components/leadguard/entity-pages';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/contacts/$id')({head:()=>pageHead('Contacts details','Relationship information and activity in LeadGuard.'),component:Page});
function Page(){const {id}=Route.useParams();return <DetailPage kind="contacts" id={id}/>;}
