# Migrating from 0.1.0-alpha.7 to 0.1.2

0.1.2 removes the temporary full-site compatibility stack. Mantle Core is now
an embeddable parse → link → compile → prepare → bind pipeline; Web, Admin,
Admin UI, Bun, Vercel, and Cloudflare are selected separately.

| alpha.7 | 0.1.2 |
|---|---|
| `parseManifests*` | `parseManifestSources({ sources })` |
| raw `Manifest[]` validation/runtime input | `ParsedManifestSet` → `LinkedManifestSet` → `RuntimePlan` |
| `createCmsRuntime({ manifests, db })` | `prepareDeployment(plan, storage)` then `createMantleRuntime({ plan, prepared })` |
| `CmsRuntime.db` / `entryReader` | keep the application DB handle; use `runtime.entries` for Mantle reads |
| generated `manifest`, `site.ts`, `types.d.ts` | generated `plan`, `bindMantle`, and types in `mantle.ts` |
| `bindMantleSite` / string-keyed Views | `bindMantle(runtime)` and generated lower-camel properties |
| `createCmsRef` / `CmsConfig` | `createMantleRuntimeRef` / `MantleCloudflareConfig` |
| `mountServerEndpoints` | explicitly compose `mountRuntimeEndpoints` and optional `mountAdmin` |

`mantle generate` deletes stale generated `site.ts` and `types.d.ts`. Install
only the optional package used by the host; installing the umbrella alone now
pulls only Spec and Runtime.

Intentional behavior changes:

- Generated-plan fingerprint or version mismatches fail immediately and ask
  the developer to regenerate.
- Runtime HTTP trigger JSON bodies must be objects. Arrays and primitives are
  rejected at the request boundary.
- Malformed percent-encoded paths are routing misses (`404`), not claimed
  Mantle routes.
- Canonical plan ordering may change stable field/export order (including
  Admin CSV columns) without changing field values.

No database migration is required solely for this API deletion. Existing
SQLite/D1 data remains compatible when the same official storage adapter is
prepared with the generated plan.
