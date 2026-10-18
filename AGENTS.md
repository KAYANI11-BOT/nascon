<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## LeadGuard architecture
- Keep TanStack Start file routing and React 19; use the existing Vite bootstrap because the preview requires it.
- Isolate development fixtures in src/data/demo.ts and session-only state in DemoProvider; production service adapters must never import fixtures.
- Keep src/lib/supabase.ts as a configuration boundary; credentials alone must not imply working services. Authentication and workspace onboarding are connected (see docs/supabase-foundation.md); CRM entity services stay typed unavailable adapters until that work is explicitly requested.
- Server code creates a request-scoped client with createSupabaseServerClient() (src/lib/supabase.server.ts); never cache it in module scope. Components read the user and active workspace via useAuth().
- Use separate route files with per-page metadata and small reusable feature modules; detail URLs use un-nested route filenames to avoid parent-page rendering conflicts.
- Keep all role values outside profiles and all future business data workspace-scoped; migrations are manual-review artifacts, never applied automatically.
- Local frontend interactions may update in-memory previews but must never report database, authentication, messaging or payment success.
- External API handlers and privileged application operations must use authenticated TanStack server boundaries when implemented; do not add Supabase Edge Functions to this project.
