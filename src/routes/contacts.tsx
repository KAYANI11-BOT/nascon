import { createFileRoute } from '@tanstack/react-router';
import { ContactsPage } from '@/components/leadguard/crm/contacts-page';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/contacts')({head:()=>pageHead('Contacts','Manage your customer relationships and contacts with LeadGuard.'),component:Page});
function Page(){return <ContactsPage/>;}
