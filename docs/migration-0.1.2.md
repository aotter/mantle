# Leaving the legacy alpha.17 launch line

0.1.0-alpha.17 remains immutable and is the final version for existing Landing
and Starters. Those repositories/tags/bundle URLs remain available. Staying on
that version requires no migration. No stable 0.1.0 release is planned.

The new line removes `mantle create`, the Starter bundle `mantle update`
command, and `@aotter/mantle/provision`. There are no aliases or replacement
scaffold commands. `generate`, `validate`, `emit-openapi` and `skills` remain.
Generation and runtime Web rendering retain their existing responsibilities.

To upgrade an existing application:

1. Read its installed version, lockfile, entry, scripts and provider bindings;
   keep unrelated work safe in the normal git workflow.
2. Pin the selected SDK packages to the intended exact new release and update
   the lockfile through the package manager. Review required peer upgrades.
3. Remove scripts invoking the retired scaffolder/bundle updater. If application
   code imports the provision renderer, remain on alpha.17 until that host's
   provisioning design is migrated explicitly; do not replace it with a
   handwritten remote-code loader.
4. Retain application source and all Worker/D1/KV identity, origins, auth mode,
   secrets and legacy `.mantle` metadata. Those files are not templates to
   replace or evidence that new Starter tags must exist.
5. Run the installed `mantle generate`, `generate --check`, `skills`,
   `skills --check`, `validate`, and the project's TypeScript/tests. Test local
   routes and configured authorization before considering deployment.

## Native Schema-table storage reset

The 0.1.2 pre-beta line replaces the generic `entries` JSON table with one
native SQLite/D1 table per Manifest Schema. Mantle's row envelope uses
`_mantle_id`, `_mantle_status`, `_mantle_version`, `_mantle_author_id`,
`_mantle_created_at`, and `_mantle_updated_at`; authored fields keep their exact
names as native columns. The old generated columns, projection views and
compatibility repository were removed.

This is intentionally a storage-format break before beta. Reset and
re-bootstrap development or internal-alpha content databases that contain the
old `entries` layout. Move required data manually outside Mantle and Control;
there is no product migration workflow for this unreleased format. Automatic
artifacts cover initial and additive changes only. Removed columns and tables
remain physically present so the previous Worker can still run. Renames, type
changes, data transforms, and any `uniqueIndexes` tuple change require the same
manual rebuild. The pre-beta Cloud
path does not accept or execute destructive SQL.

Row APIs are now Schema-qualified. `EntryRepository.get` and
`EntryReader.readById` accept `{ collection, id }`; Admin entry detail and
mutation routes require `?collection=<schema>`, and generic MCP entry tools
require `collection`. Generated `entries.<schema>` bindings supply it for you.

A new project follows [direct authoring](direct-authoring.md). Templates and
provider setup are not hidden inside `generate`. Future Builder/landing-next
provisioning is a separate decision; this change does not migrate those hosts.

## Site chrome: GA4 and Meta Pixel leave siteConfig

`SiteConfig.ga4MeasurementId`, `SiteConfig.facebookPixelId`, and their
`SiteDefaults` seed equivalents are removed. The Admin UI no longer has
Analytics fields for them, the Runtime site-settings use case no longer
accepts them, and the Web HTML renderer no longer injects the gtag or Pixel
base snippet into rendered storefront HTML. This applies to every 0.1.2
prerelease; it is not staged behind a flag.

Core's `siteConfig` remains deployment identity only (locales, brand, title,
description, origin, icons, media); tracking and verification tags are host
chrome because frontends are plural and Core cannot assume one `</head>` to
rewrite. See [Why Core does not inject](handbook/cloudflare/site-chrome.md#why-core-does-not-inject).

To keep GA4 or Meta Pixel across the upgrade:

1. Read the existing `ga4MeasurementId` / `facebookPixelId` values from the
   pre-upgrade site settings (Admin API or KV/D1 `SiteConfigRepository`
   directly) before removing the old columns/fields.
2. Move the tag injection into host chrome following
   [Cloudflare-first install > Analytics](handbook/cloudflare/site-chrome.md#analytics):
   render the snippet in the host's own document/layout, not through Core.
3. Drop the old fields from any locally stored site-settings payloads; the
   Runtime `SiteConfig` type no longer declares them, so a TypeScript build
   against the new types is what surfaces a leftover reference.

## Earlier alpha.7 compatibility changes


0.1.2 removes the temporary full-site compatibility stack. Mantle Core is now
an embeddable parse → link → compile → prepare → bind pipeline; Web, Admin,
Admin UI, Bun, Vercel, and Cloudflare are selected separately.

| alpha.7 | 0.1.2 |
|---|---|
| `parseManifests*` | `parseManifestSources({ sources })` |
| raw `Manifest[]` validation/runtime input | `ParsedManifestSet` → `LinkedManifestSet` → `RuntimePlan` |
| `createCmsRuntime({ manifests, db })` | `bootMantleRuntime({ plan, storage })`, or explicit prepare then `createMantleRuntime({ prepared })` |
| `CmsRuntime.db` / `entryReader` | keep the application DB handle; use `runtime.entries` for Mantle reads |
| generated `manifest`, `site.ts`, `types.d.ts` | generated `plan`, `createMantle`, `bindMantle`, and types in `mantle.ts` |
| `mantle introspect` | install `@aotter/mantle-spec` directly and run `mantle-spec introspect` |
| `mantle emit-types` | use `mantle generate`; for raw declarations, run `mantle-spec emit-types` |
| generated `.agent/skills/` | generated `.agents/skills/`; legacy user files are left untouched |
| `bindMantleSite` / string-keyed Views | `bindMantle(runtime)` and generated lower-camel properties |
| `createCmsRef` / `CmsConfig` | `createMantleRuntimeRef` / `MantleCloudflareConfig` |
| `mountServerEndpoints` | explicitly compose `mountRuntimeEndpoints` and optional `mountAdmin` |

Delete stale generated `site.ts` and `types.d.ts` files once, then run
`mantle generate`. Install only the optional package used by the host;
installing the umbrella alone now pulls only Spec and Runtime.

Intentional behavior changes:

- Generated-plan fingerprint or version mismatches fail immediately and ask
  the developer to regenerate.
- Runtime HTTP trigger JSON bodies must be objects. Arrays and primitives are
  rejected at the request boundary.
- Malformed percent-encoded paths are routing misses (`404`), not claimed
  Mantle routes.
- Better Auth and every `@better-auth/*` package move together to 1.7.
  `oauthProvider.validAudiences` becomes protected `resources`; MCP uses one
  canonical `${PUBLIC_ORIGIN}/mcp` resource and CIMD client discovery.
- The Cloudflare adapter no longer requires `OAUTH_KV` or
  `@cloudflare/workers-oauth-provider`. Old opaque tokens and KV registrations
  cannot be migrated safely and must reconnect.
- Canonical plan ordering may change stable field/export order (including
  Admin CSV columns) without changing field values.

This alpha changes the Better Auth D1 schema, including required account
issuer identity and OAuth resource/client tables. Reset and re-bootstrap a
pre-1.7 alpha auth database; do not guess an issuer backfill. Reset old generic
content storage as described above and move required data manually outside
Mantle.
