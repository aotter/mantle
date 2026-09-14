---
name: develop
description: Work on any Mantle project using the Core SDK contract. Use for manifest, runtime, content model, handler, adapter, validation, and MCP work after a project already exists.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/develop/SKILL.md
  applies_to: mantle grammar v0.1
  projection: project, plugin
---

# Mantle Develop

This is the Core workflow skill for an existing Mantle project. Repo-local
copies are byte-for-byte projections from the installed package; its embedded
docs govern runtime/API behavior.

## First Read

1. `package.json` for the installed `@aotter/mantle*` versions.
2. `manifests/site.yaml`, the active adapter config, and `src/auth.ts` when present. If the project is older, check `src/mantleConfig.ts`.
3. The active `.mantle/overlays/<type>/seed.json`, when present; generated
   homepages commonly import visible copy and form structure from it.
4. Optional local context: `.mantle/launch-state.json`, `.mantle/handoff.md`,
   `.mantle/plugins.json`, `.mantle/plugins.lock.json`, and `.mantle/recipes/`.
5. Installed Core docs in `node_modules/@aotter/mantle/docs/`.

If `node_modules/` is missing, run `pnpm install --frozen-lockfile` before
falling back to remote docs. Remote docs must use a tag matching the installed
version; never use `develop` branch docs for a versioned consumer project.

## Existing Examples

Read installed `docs/handbook/start/project-and-cli.md`, `docs/examples/minimal-worker/`
and `docs/handbook/examples/commerce-transaction.md` before inventing a pattern. The reference
consumer is test/documentation, not a Starter or a fixed application shape.

Public rendering is opt-in consumer wiring: `mountPublicRoutes`, a
`TemplateRegistry`, and a matching `publicPathResolver` must agree on the
exposed collections. Do not auto-publish every Schema. Applications document their mounted URL surface in their own README.
Import the registry and resolver from `@aotter/mantle/web`; Core runtime does
not install public rendering by itself.

## Authoring CLI

Use the project's scripts first; applications use the shipping
`mantle` authoring CLI from `@aotter/mantle`. Ask the installed CLI for its
command list instead of trusting one copied into prose — the surface is
version-matched and changes between releases:

```bash
pnpm exec mantle --help
pnpm validate
```

This CLI validates and derives artifacts from application-authored manifests.
It does not create projects, business schemas or a visitor homepage.

## Core Model

Mantle exposes exactly four declarative atoms:

| Atom | Purpose |
|---|---|
| `Schema` | Stored entity/table shape. |
| `View` | Read/query surface. |
| `Procedure` | Typed mutation or operation. |
| `Trigger` | HTTP/lifecycle/MCP invocation binding. |

Do not invent manifest kinds such as `Form`, `Feature`, `Workflow`, or
`Membership`. Compose those from the four atoms plus TypeScript only where
the atoms cannot express the behavior.

## Content Edits

- If a legacy homepage imports a repo seed, edit it for local/static copy.
  Otherwise follow the actual frontend content source. Use Admin or Staff MCP
  for runtime-backed content.
- For a new submitted field, update the stored `Schema` and the public
  `Procedure.spec.input` before the seed/form. Keep public mutation inputs
  `additionalProperties: false`; otherwise JSON Schema's default may strip an
  undeclared field while returning success.
- Use `lifecycle: operational` for submissions, inquiries, orders, and other
  Procedure-created operational records that staff inspect or correct. Reserve
  `publishing` for content a person stages and publishes.
- Lifecycle `before_update` / `after_update` hooks also fire for unpublish,
  archive, and every other status transition whose target is not `published`;
  do not use them for edit-only work.
- When a form's fixed option values change, update the stored Schema and public
  Procedure input `enum` together. Keep translated labels in the frontend content source;
  Admin and Staff MCP derive their typed controls from the manifest values.
- If the application has a `page` Schema with sections, update its declared
  section properties when adding display fields; an undeclared property has no
  runtime-backed Admin or Staff MCP path.
- Update notification handlers when they need the new field. Test the stored
  entry, not only the HTTP `{ "ok": true }` response.

## Locales

- `data.locale` is reserved for `localized: true` Schemas. A non-localized
  Schema must use a domain field such as `replyLocale`.
- Use a standalone localized Schema only for independent locale rows. For
  versions of one entity, use a non-localized parent plus a localized child
  with `translates: { parent, on }`. The child must own at least one field
  besides `locale` and the join field.
- Parallel locale blocks must keep field names, option values, step IDs, and
  result keys identical; translate display strings only.
- `siteDefaults.origin`, `siteDefaults.locales`, and `siteDefaults.icons` are
  code-owned and boot-synced. The icon list is shared by browser favicons,
  Admin chrome, and MCP `serverInfo.icons`; keep its static files under
  `public/`. Brand, title, and description seed once, then change through site
  settings.
- When changing an existing collection from `[slug]` to `[slug, locale]`,
  boot with a Mantle version that reconciles obsolete unique indexes and test
  the same slug in two locales. Do not patch D1 manually.

## Adapter Boundary

The runtime is adapter-neutral. A `MantleStorageAdapter` prepares the compiled
plan into semantic storage ports; `createMantleRuntime` binds that prepared
storage and selected capabilities. Database drivers and asset serving belong
to the host/optional composition. Follow the installed adapter guide.

Do not assume Cloudflare unless the project imports `@aotter/mantle/cloudflare`
or its adapter config is visible. A future Netlify adapter should satisfy the
same Core workflow through its own ports and provider setup.

Site code is a consumer of this abstraction. Use Manifests, runtime use cases,
`runtime.entries`, and optional `runtime.siteConfig`; do not query Mantle-owned `entries` or
`site_config`, reach through deprecated `runtime.db`, copy generated-column
names, or construct SDK KV keys. Cloudflare bindings belong only at the
composition root. If a normal feature cannot be expressed through a
purpose-shaped surface, treat that as a Core abstraction gap instead of
teaching the project Mantle internals.

## Auth Composition

Conventional Cloudflare projects declare `MANTLE_AUTH_MODE=hosted` or
`self-managed`; Core owns that standard Auth composition and rejects partial
or mixed bindings. Preserve the explicit mode recorded in Worker config
and any legacy launch state, keep provider secrets out of source, and do not infer a mode
from whichever credentials happen to be present. A repo with an explicit
`createMantleWorker({ auth })` override owns that custom composition; follow
its handoff instead of replacing it with the conventional factory.

## Performance Loop

After changing a Schema index, View filter/order, public API, or rendered page,
run the project's index check when present. Otherwise run the installed
harness directly:

```bash
pnpm exec mantle-harness indexes --require-public --format text
```

The check uses crowded real SQLite and the shipped compiler. It complements
`pnpm validate`; it does not replace correctness validation. Declare the
smallest ordered index justified by the measured path and respect SQLite's
leftmost-prefix rule. Do not change user-visible filter or ordering semantics
just to make the gate pass. Do not add every permutation or cache every read.

For relevant Cloudflare serving changes, start the project and sample the
actual routes:

```bash
pnpm exec mantle-harness http \
  --base-url http://127.0.0.1:8787 \
  --route page=/en/example \
  --rounds 20 --warmup 2 --format text
```

Prefer query plan, query count, `rows_read` scaling, and cache MISS/HIT
evidence. Do not create CI gates from absolute local milliseconds.

## Loop

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm check:indexes # when the project provides it
pnpm typecheck
pnpm check
```

Use `pnpm dev` for local preview when the project provides it.

## Connect a Local MCP Client

Start the project with `pnpm dev`, then use the exact local origin it prints.
The conventional Cloudflare adapter exposes:

- `http://localhost:8787/mcp` for public tools;
- `http://localhost:8787/mcp/staff` for authenticated authoring tools.

Prefer the client's native remote HTTP + OAuth support. Use a standard
HTTP-to-stdio bridge such as `npx -y mcp-remote <url>` only when the client
accepts stdio MCP servers but cannot connect to remote HTTP directly. Mantle
does not own a separate local proxy or an auth-bypass mode.

Before changing client config, confirm the Worker is reachable:

```bash
curl -i http://localhost:8787/mcp
```

An OAuth-protected endpoint should respond with `401` and a
`WWW-Authenticate` resource-metadata challenge before sign-in. After
connecting, inspect `tools/list`; make one read-only `query_view_*` call when
available before invoking any mutation. Use project-scoped client config when
the client offers it, and never commit OAuth tokens or the bridge's token
cache.

## Rules

- Keep content models in the configured manifest directory; its immediate
  `.yaml` and `.yml` files are loaded together.
- Use a generated overlay `seed.json` for the auth-free local first page when
  it is already imported by `src/web/content/*`.
- Add TypeScript only for handlers, rendering, adapter wiring, or real behavior.
- Do not write directly to D1, KV, Postgres, or object storage for content
  authoring. Use runtime use cases, admin APIs, or Staff MCP.
- Do not commit provider secrets.
- If the work is an installable capability, switch to `mantle:plugin`.
