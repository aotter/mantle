# Migrating from 0.1.0-alpha.7 to 0.1.2

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
pre-1.7 alpha auth database; do not guess an issuer backfill. Content tables
remain portable through the normal application migration/export path.
