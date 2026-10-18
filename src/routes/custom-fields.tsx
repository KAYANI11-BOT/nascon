import { createFileRoute } from '@tanstack/react-router';
import { CustomFieldSettings } from '@/components/leadguard/crm/custom-field-settings';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/custom-fields')({head:()=>pageHead('Custom fields','Custom fields for your LeadGuard business workspace.'),component:Page});
function Page(){return <CustomFieldSettings/>;}
