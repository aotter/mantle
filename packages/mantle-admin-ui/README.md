# @aotter/mantle-admin-ui

Admin SPA shell for mantle.

This package builds a React/Tailwind static bundle. When it is installed,
`mantle generate` copies that bundle to `public/_mantle/admin/` (excluding
`server.*` exports). Core-only projects that omit this package skip the copy.
It currently provides the system admin shell, preference UI, site overview
surfaces, and Mantle-branded system pages.

## Mantle UI kit (moved)

The domain-neutral kit now lives in `@aotter/mantle-ui/kit`, with
`@aotter/mantle-ui/kit.css` and `@aotter/mantle-ui/tokens.css` (ADR-0029).
`@aotter/mantle-admin-ui/kit`, `kit.css` and `tokens.css` still work for one
minor release and re-export the same components; move imports to
`@aotter/mantle-ui`.

`dist/r/auth-page.json` is a shadcn registry item for a working email OTP page,
built on `@aotter/mantle-ui/kit`.
It is copied into the consuming application, so its agent or author can change
the markup and flow without forking this package. The recipe accepts optional
Privacy Policy and Terms of Use links; their discovery and enforcement remain
the application's responsibility.

`0.1.2` is this package's first stable release. Its `package.json` is the
exact version installed.

## Same-origin sandbox preview

Use the separate `dist/preview.html` document for a Builder preview. Copy its
assets unchanged; replace the `/_mantle/admin/` asset prefix if mounting the copy
elsewhere. Serve the preview document at your own preview route. Do not patch the
JavaScript bundle or change the canonical Admin document.

Before its module script boots, install your sandbox transport as `window.fetch`
and set `window.__MANTLE_ADMIN_PREVIEW__ = { fetch: window.fetch }`. The transport
must intercept `/admin/api/*` requests and reject failures; never fall back
to live Admin API requests. Preview permits only this same-origin fetch surface,
with native connections and form submissions disabled by document CSP. Use an
in-memory implementation or delegate with `postMessage` to the parent; a bridge
that performs native fetch inside the iframe is blocked. The preview refuses to render without this explicit
bridge, outside an iframe, in nested frames, or with a foreign-origin parent.
Only a same-origin top-level parent is supported. The ordinary `index.html`
continues to refuse all iframe rendering.

Sign-in, OAuth consent, connected apps and sign-out are unavailable in preview.
An unauthorized bridge response stays an error instead of navigating to live
sign-in. Internal edits/search/pagination use the Admin router; CSV downloads use
the bridge and a local blob. Canonical Admin retains its normal account flows
and browser-streamed downloads, without buffering large exports in the SPA.

This is a consumer-owned sandbox contract, not a way to embed authenticated
production Admin. Do not mount it in an untrusted same-origin application.

## Staff operations

The Operations navigation item (`/admin/operations`) lists authorized staff
Procedures without a row binding or `uiSchema.collectionAction`. It works on a
site with no collections. Bound operations stay in their collection and row
menus. All use the existing Admin operations API and schema form.

Successful output stays in the dialog until closed. Failed input, diagnostics,
and generated idempotency keys remain available for retry. Close and reopen a
successful operation to start a new invocation. API authorization and Procedure
validation remain authoritative.
