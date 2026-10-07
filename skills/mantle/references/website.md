# Complete website defaults

These are default generation and acceptance requirements for a complete website,
unless the user explicitly changes the scope. They do not add Manifest keys or
change Core's optional composition. Read the installed version's docs and the
selected host's frontend kit before choosing APIs.

- Reuse Mantle Admin UI and configured tenant OTP. Add visitor sign-in only where
  needed. Do not build a second identity store or configure another mail provider
  when the host already supplies one. Backend permissions enforce roles and data
  access; Cloud membership is not tenant staff access.
- Integrate image selection/upload into content editing through the existing
  Admin media library and host storage. Follow the pinned Core upload/PUT/commit
  contract and supported media field hints. Upload capability URLs are temporary,
  not committed public images; anonymous visitors must not gain staff media access.
- Generate an accessible, responsive public frontend using the installed
  `@aotter/mantle/web` capabilities. Do not install the historical standalone
  `@aotter/mantle-web` or invent an HTML renderer. A REST-only version does not
  provide server-rendered pages. Follow the host's static/template restrictions.
- Public content needs real per-URL HTML with semantic body text, title,
  description, canonical, Open Graph, sitemap.xml, robots.txt and appropriate
  JSON-LD. Include authorship and publication/update dates where applicable.
  Client-side-only metadata or an SPA shell is not sufficient for SEO/AEO/GEO.
  Structured data must match visible content; do not fabricate facts or promise
  ranking or AI citation.
- Verify that content publication, edits and deletion update the crawlable page
  and sitemap. If static generation requires a rebuild, explain the publishing
  dependency; a dynamic blog is blocked until that path exists. Do not silently
  substitute build-time sample content for live tenant content.

Before reporting completion, inspect HTML with JavaScript disabled, check
metadata/sitemap and anonymous draft/permission refusal, and exercise OTP,
content editing and media upload/commit with authorized synthetic accounts.
Read the host's preview capability limits: disabled mail/media checks stay
pending, not passed. Test them on a live tenant only when explicitly authorized.
Do not weaken preview isolation, fake success or grant staff privileges to make
checks pass. Provenance/pairing review does not certify website quality; report
passed, failed and blocked checks separately.
