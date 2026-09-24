---
description: Build a versioned Mantle Cloud application artifact from manifests, tenant code and frontend assets.
---
# Build a Mantle Cloud project

`mantle build` produces the version 1 agent-built artifact. It
compiles the YAML manifests with the same Core compiler as `mantle generate`,
runs the project's `build:mantle` script, and writes one machine-readable
`.mantle/cloud-artifact.json` containing the exact YAML source bytes, a local
RuntimePlan, the bundled application module, static assets, SDK version, recipe version and lockfile
digest, and the actual local Node/pnpm versions. The command does not deploy
the artifact.

Add this to the application's `package.json`:

```json
{
  "packageManager": "pnpm@9.15.0",
  "dependencies": { "@aotter/mantle": "0.1.4" },
  "mantleCloud": {
    "version": 1,
    "manifests": "manifests",
    "module": "dist/app.mjs",
    "assets": "dist/public"
  },
  "scripts": { "build:mantle": "node scripts/build.mjs" }
}
```

The script owns only the user module and public assets. Bundle the module as
one Worker-compatible ESM file exporting `default.fetch(request, env,
executionCtx)` and, for `ref` procedures, a `handlers` object. Static assets
go in the configured directory with URL paths matching their relative paths.
The script may use a frontend framework, but server-side Node APIs and imports
unsupported by Cloudflare Workers are outside this recipe. `mantle build`
generates `.mantle/generated/mantle.ts` before the script runs, so the module
can import its typed binding. Cloud supplies the Admin UI; the app asset
directory cannot claim Cloud-owned `/admin`, `/api`, or `/_mantle` paths.

The coding agent builds locally and uploads the artifact. Cloud must independently
parse the included YAML with its pinned Core release, compare the local plan,
verify the module and assets, and smoke-test with disposable bindings before
it can become a candidate. A local artifact hash records local bytes; the
local plan and SDK labels are not Cloud validation evidence. The platform owns
the fixed runtime entry, production bindings, secrets, and candidate metadata.
Project code receives only the tenant bindings permitted
by the Cloud policy. Keep platform credentials and cross-tenant authority out
of the project module. Core projects can still use their own adapters and
deploy independently of Cloud.

For publicly indexed content, use the matching `@aotter/mantle-web` release
to render published pages and generate canonical metadata, sitemap, llms.txt
and Markdown representations from the same entries. Do not index private or
draft entries. See `docs/examples/host-chatgpt-sites/src/web.ts` for a working
SSR example; an interactive SPA can coexist with these public routes.

## Source

- [Cloud build command](../../../packages/mantle/src/cli/build.ts)
- [Manifest compiler](../../../packages/mantle-runtime/src/domain/service/RuntimePlanCompiler.ts)
- [Public web reference](../../examples/host-chatgpt-sites/src/web.ts)
