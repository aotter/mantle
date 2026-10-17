# Complete website defaults

These are default generation and acceptance requirements for a complete website,
unless the user explicitly changes the scope. They do not add Manifest keys or
change Core's optional composition. Read the installed version's docs and the
selected host's frontend kit before choosing APIs. Native applications use
their installed `docs/handbook/guides/native-admin.md` and the
[web contract](web.md).

- For self-hosted applications, build Admin with `mantle bundle` and serve it as
  the installed `docs/handbook/guides/native-admin.md` describes. The application
  owns auth, OTP delivery and verified Caller wiring; use a console/test sender
  locally and configure production email for deployment. If a host already
  supplies identity/Admin, reuse its explicit contract and reserved routes.
  Add visitor sign-in where needed. Backend permissions enforce roles and data
  access; host membership alone is not application admin authority.
- Integrate image selection/upload into content editing through the existing
  Admin media library and the application's selected storage. Follow the pinned Core upload/PUT/commit
  contract and `x-mantle-ref: media_assets` plus `x-mcp-hint: media-image`; store committed asset IDs, resolve permanent variants in the frontend, never use an ID as an image URL. The application's `/mcp/admin` supplies `get_media_upload_policy` → `create_media_upload` → direct HTTP PUT → `commit_media_upload` when its shared media adapter is wired. Follow the installed media authentication contract; host project credentials are not application credentials. Upload capability URLs are temporary,
  not committed public images; anonymous visitors must not gain admin media access.
- Generate an accessible, responsive public frontend by reading the installed
  generated `web.ts` and REST contracts; browser code on static hosts uses
  same-origin fetch, not a server surface imported into the browser. Do not install the historical standalone
  `@aotter/mantle-web` or claim Core supplies an HTML renderer. The application-owned Fetch entry renders HTML; follow the selected host's static/template restrictions.
- Public content follows the installed `docs/handbook/guides/public-pages.md`
  (the one list of head tags, JSON-LD, languages, Markdown, sitemap, robots and
  `llms.txt`). For public content on static hosts disable SPA fallback and check unknown URLs
  return 404. Follow the selected host's permanent origin contract. Missing
  final origin blocks origin-dependent checks.
  Structured data must match visible content; do not fabricate facts or promise
  ranking or AI citation.
- Verify that content publication, edits and deletion update the crawlable page
  and sitemap. If static generation requires a rebuild, explain the publishing
  dependency; a dynamic blog is blocked until that path exists. Do not silently
  substitute build-time sample content for live tenant content.

Follow the [local HTTP acceptance](local-testing.md) before reporting local
readiness: inspect HTML without JavaScript, check metadata/sitemap and anonymous
draft/permission refusal, and exercise OTP and editing with isolated synthetic
accounts. Local readiness does not require publication, a hosted tenant or a
candidate preview. Report production email, public origin and real object-store
upload/commit checks separately when local capabilities cannot exercise them.

For an explicitly requested deployment, use the selected host's native workflow
and any preview it provides. Verify disabled preview capabilities on an already
authorized live target; synthetic writes and cleanup stay within that scope.
Pending production checks block a production-readiness claim, not an otherwise
passing local-development handoff. Preserve preview isolation and permissions;
report passed, failed and blocked checks for each environment separately.
