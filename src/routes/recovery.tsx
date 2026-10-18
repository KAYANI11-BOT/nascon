import { createFileRoute } from '@tanstack/react-router';
import { RecoveryPage } from '@/components/leadguard/entity-pages';
import { RecoveryRoute } from '@/components/leadguard/recovery-live';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/recovery')({head:()=>pageHead('Recovery queue','Review missed acknowledgements and at-risk lead deadlines.'),component:Page});
function Page(){return <RecoveryRoute fallback={<RecoveryPage/>}/>;}
