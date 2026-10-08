# Complete website defaults

These are default generation and acceptance requirements for a complete website,
unless the user explicitly changes the scope. They do not add Manifest keys or
change Core's optional composition. Read the installed version's docs and the
selected host's frontend kit before choosing APIs.

- Link to host-provided Mantle Admin UI and configured tenant OTP; do not emit frontend assets under host-owned /admin routes. Add visitor sign-in only where
  needed. Do not build a second identity store or configure another mail provider
  when the host already supplies one. Backend permissions enforce roles and data
  access; Cloud membership is not tenant staff access.
- Integrate image selection/upload into content editing through the existing
  Admin media library and host storage. Follow the pinned Core upload/PUT/commit
  contract and `x-mantle-ref: media_assets` plus `x-mcp-hint: media-image`; store committed asset IDs, resolve permanent variants in the frontend, never use an ID as an image URL. Tenant `/mcp/staff` supplies `get_media_upload_policy` → `create_media_upload` → direct HTTP PUT → `commit_media_upload` when its shared media adapter is wired. Follow the pinned media docs for tenant editor/owner authentication; Cloud project credentials are not tenant credentials. Upload capability URLs are temporary,
  not committed public images; anonymous visitors must not gain staff media access.
- Generate an accessible, responsive public frontend by reading the installed
  `@aotter/mantle/web` REST contract; browser code on static hosts uses
  same-origin fetch, not a server surface imported into the browser. Do not install the historical standalone
  `@aotter/mantle-web` or claim Core supplies an HTML renderer. Application-owned `service.fetch` may render HTML; follow the selected host's static/template and pairing restrictions.
- Public content needs real per-URL HTML with semantic body text, title,
  description, canonical, Open Graph, sitemap.xml, robots.txt and appropriate
  JSON-LD. Include authorship and publication/update dates where applicable.
  Client-side-only metadata or an SPA shell is not sufficient for SEO/AEO/GEO.
  For public content on static hosts disable SPA fallback and check unknown URLs
  return 404. For Mantle Cloud protocol 5, use only the permanent managed `.mantle.tools` origin accepted by the host gate, never a custom domain or candidate preview origin. Other hosts follow their own domain contract. Missing
  final origin blocks origin-dependent checks.
  Structured data must match visible content; do not fabricate facts or promise
  ranking or AI citation.
- Verify that content publication, edits and deletion update the crawlable page
  and sitemap. If static generation requires a rebuild, explain the publishing
  dependency; a dynamic blog is blocked until that path exists. Do not silently
  substitute build-time sample content for live tenant content.

Before upload, follow the [local HTTP acceptance](cloud.md#local-http-acceptance-before-source-upload): native HTTP HTML responses need no browser or deployment. Before reporting completion, inspect HTML without executing JavaScript, check
metadata/sitemap and anonymous draft/permission refusal, and exercise OTP,
content editing and media upload/commit with authorized synthetic accounts.
Read the host's preview capability limits: disabled mail/media checks stay
pending, not passed. Use candidate preview first, then an existing explicitly authorized live test
tenant with authorized staff accounts for disabled services. Do not create or
publish a test tenant without authorization. Live tests require
explicit authorization for synthetic writes and cleanup. Without a published
test tenant or that authorization, report them pending.
Do not weaken preview isolation, fake success or grant staff privileges outside the authorized test scope to make
checks pass. Provenance/pairing review does not certify website quality; report
passed, failed and blocked checks separately. Pending required checks also
block completion.
