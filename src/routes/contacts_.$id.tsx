import { createFileRoute } from '@tanstack/react-router';
import { ContactDetailPage } from '@/components/leadguard/crm/contact-detail-page';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/contacts_/$id')({head:()=>pageHead('Contacts details','Relationship information and activity in LeadGuard.'),component:Page});
function Page(){const {id}=Route.useParams();return <ContactDetailPage id={id}/>;}
