# Complete website defaults

These are default generation and acceptance requirements for a complete website,
unless the user explicitly changes the scope. They do not add Manifest keys or
change Core's optional composition. Read the installed version's docs and the
selected host's frontend kit before choosing APIs. Native applications use
their installed `docs/handbook/guides/native-admin.md` and the
[web contract](web.md).

- Link to host-provided Mantle Admin UI and configured tenant OTP; do not emit frontend assets under host-owned /admin routes. Add visitor sign-in only where
  needed. Do not build a second identity store or configure another mail provider
  when the host already supplies one. Backend permissions enforce roles and data
  access; Host membership is not application admin access.
- Integrate image selection/upload into content editing through the existing
  Admin media library and host storage. Follow the pinned Core upload/PUT/commit
  contract and `x-mantle-ref: media_assets` plus `x-mcp-hint: media-image`; store committed asset IDs, resolve permanent variants in the frontend, never use an ID as an image URL. Tenant `/mcp/admin` supplies `get_media_upload_policy` → `create_media_upload` → direct HTTP PUT → `commit_media_upload` when its shared media adapter is wired. Follow the pinned media docs for tenant admin authentication (historical Core
uses admin); host project credentials are not application credentials. Upload capability URLs are temporary,
  not committed public images; anonymous visitors must not gain admin media access.
- Generate an accessible, responsive public frontend by reading the installed
  `@aotter/mantle/web` REST contract; browser code on static hosts uses
  same-origin fetch, not a server surface imported into the browser. Do not install the historical standalone
  `@aotter/mantle-web` or claim Core supplies an HTML renderer. Application-owned `service.fetch` may render HTML; follow the selected host's static/template and pairing restrictions.
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

Before upload, follow the [local HTTP acceptance](local-testing.md): native HTTP HTML responses need no browser or deployment. Before reporting completion, inspect HTML without executing JavaScript, check
metadata/sitemap and anonymous draft/permission refusal, and exercise OTP,
content editing and media upload/commit with authorized synthetic accounts.
Read the host's preview capability limits: disabled mail/media checks stay
pending, not passed. Use candidate preview first, then an existing explicitly authorized live test
tenant with authorized admin accounts for disabled services. Do not create or
publish a test tenant without authorization. Live tests require
explicit authorization for synthetic writes and cleanup. Without a published
test tenant or that authorization, report them pending.
Do not weaken preview isolation, fake success or grant admin privileges outside the authorized test scope to make
checks pass. Provenance/pairing review does not certify website quality; report
passed, failed and blocked checks separately. Pending required checks also
block completion.
