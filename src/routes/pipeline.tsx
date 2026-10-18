import { createFileRoute } from '@tanstack/react-router';
import { PipelinePage } from '@/components/leadguard/pipeline';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/pipeline')({head:()=>pageHead('Sales pipeline','A visual sales pipeline from discovery to closed opportunities.'),component:Page});
function Page(){return <PipelinePage/>;}
