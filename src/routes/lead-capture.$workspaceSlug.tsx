import { createFileRoute } from '@tanstack/react-router';
import { PublicLeadForm } from '@/components/leadguard/public-lead-form';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/lead-capture/$workspaceSlug')({head:()=>pageHead('Contact us','Send us a message and our team will reply shortly.'),component:Page});
function Page(){const {workspaceSlug}=Route.useParams();return <PublicLeadForm slug={workspaceSlug}/>;}
