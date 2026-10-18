import { createFileRoute } from '@tanstack/react-router';
import { Conversations } from '@/components/leadguard/engagement';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/conversations')({head:()=>pageHead('Conversations','A unified customer conversation inbox preview.'),component:Page});
function Page(){return <Conversations/>;}
