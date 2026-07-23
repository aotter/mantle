---
name: extend
description: Add new functionality to an existing mantle project — a new Schema, View, Procedure, or Trigger; or wire a feature like a contact form, newsletter signup, comment thread, or filtered list page. Use when the user already has a mantle project and wants to grow it.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/extend/SKILL.md
  applies_to: mantle@v0.1.0
---

# Extend a mantle project

The 4-atom manifest model:

- **Schema** — the entity (table)
- **View** — the read API
- **Procedure** — the typed callable
- **Trigger** — the event binding (HTTP / lifecycle / cron)

Closed enums (`x-mantle-bind` values, `ctx.*` predicates, `Trigger.source.kind`, `Procedure.handler.kind`) are checked by `pnpm validate` — diagnostics return `code` + `suggestion`. If grammar is unclear, run `pnpm introspect` against the current project to see what the manifest compiler accepts, or read the shipped full grammar reference at `node_modules/@aotter/mantle/docs/design-atoms.md`.

## Match the user's request to atoms

| User says                                  | Add                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------- |
| "I want to publish blog posts"             | Schema (`posts`) + per-locale child Schema (translates) + 2 templates |
| "I want a contact form"                    | Schema (write target) + Procedure (handler.kind: builtin op:create) + Trigger (http POST /api/contact) |
| "I want CAPTCHA / Slack notify on submit"  | + Procedure (handler.kind: ref) + Trigger (lifecycle before_/after_create) |
| "I want a /search page filtered by tag"    | View with params: { tag } |
| "I want a public prompt-generator / calculator / configurator page" | A consumer-side `app.get(...)` route in `src/index.ts` — see § Custom public routes |
| "I want an API key / personal token / paid API / scoped MCP tool" | Procedure/View `requires.auth` plus optional `guard.procedure`; site-owned resolver/handler — see § API and MCP authorization |
| "I want a /docs/<slug>/edit-history page"  | Defer — v0.1 ships `simple` lifecycle only; `editorial` is v0.1.x |
| "I want comments"                          | v0.1: anonymous-with-email pattern (Schema + write Procedure). End-user member system is v0.2. |

If the user wants something not in the table, ask before guessing.

## Step-by-step (the canonical loop)

### 1. Write the manifest YAML

Schemas / Views / Procedures / Triggers live under `manifests/`. One feature per file is fine; multi-doc YAML (`---` separators) for related atoms is also fine.

Example for "newsletter signup":

```yaml
# manifests/newsletter.yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: newsletter-signups }
spec:
  title: Newsletter signups
  schema:
    type: object
    required: [email]
    properties:
      email: { type: string, format: email }
      createdAt: { type: number, x-mantle-bind: now }
  uniqueIndexes: [[email]]
  lifecycle: simple
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: subscribe }
spec:
  input:
    type: object
    required: [email]
    properties:
      email: { type: string, format: email }
  output: { type: object }
  handler:
    kind: builtin
    op: create
    schema: newsletter-signups
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: subscribe-http }
spec:
  source: { kind: http, method: POST, path: /api/subscribe }
  target: { procedure: subscribe }
```

### 2. Validate immediately

```bash
pnpm validate
```

Common diagnostics:

- `DRAFT_KEY_USED` — you wrote a v0.2+ key (e.g. `Trigger.source.kind: cron`); remove it.
- `LIFECYCLE_NOT_IN_V010` — you wrote `Schema.spec.lifecycle: editorial`; v0.1.0 only ships `simple`.
- `VIEW_FILTER_PARAM_REF_NOT_REQUIRED` — you reference `{ $param: x }` but `x` is optional; add to `params.required`.
- `VIEW_PARAMS_RESERVED_NAME` — you declared `params.page` / `.show` / `.cursor`; rename — runtime owns those.
- `TRIGGER_TARGET_PROCEDURE_UNKNOWN` — typo in `target.procedure`.
- `HANDLER_NOT_REGISTERED` — Procedure declares `handler.kind: ref` but no `registerHandler('<ref>', fn)` call exists in `src/`.

### 3. Wire any handler refs

For `Procedure.handler.kind: ref`:

```ts
// src/handlers.ts
export const handlers = {
  subscribe: async (input) => { /* ... */ return { ok: true }; },
};
```

The CLI greps `src/` for the literal string `'<ref>'` — keep registration somewhere greppable (object literal or `registerHandler('subscribe', fn)` call).

### 4. Register a template if the Schema needs HTML output

```ts
// src/templates/index.ts
import { newsletterTemplate } from "./newsletter.js";
registry.registerEntryTemplate("newsletter-signups", newsletterTemplate);
```

Skip this if the Schema is internal-only (raw form submissions don't need HTML pages).

### 5. Re-emit types + OpenAPI (optional)

```bash
pnpm emit-types        # adds ProcInput_subscribe / ProcOutput_subscribe / Entry_newsletter_signups
pnpm emit-openapi      # adds POST /api/subscribe operation
```

Commit both alongside the manifest changes if you keep artifacts under version control.

### 6. Try it locally

```bash
pnpm fixture           # only if you added new fixture data
pnpm dev               # restart wrangler
curl -X POST http://localhost:8787/api/subscribe \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com"}'
```

Use `?preview=1` on any `/posts/` or `/pages/` URL to render an in-progress draft via the registered template instead of pre-rendered KV HTML.

### 7. Run the integration smokes

```bash
pnpm view-smoke        # 10 cases against /api/views/*
pnpm mcp-smoke         # 12 cases against /mcp
```

If you added a new MCP-relevant Schema, the per-collection authoring tools (`create_draft_<segment>`, `update_draft_<segment>`) auto-emit; verify with `tools/list`.

## API and MCP authorization

Read the shipped canonical guide before adding an authenticated public API:
`node_modules/@aotter/mantle/docs/api-mcp-authorization.md`.

Use only the closed grammar:

```yaml
requires:
  auth:
    all:
      - ctx.auth
      - { "ctx.auth.scope": "orders:read" }
  guard:
    procedure: require-active-access
```

- `ctx.auth` means any adapter-verified credential; it is not API-key-only.
- Repeat `ctx.auth.scope` to require multiple site-owned scopes.
- Use `ctx.user` as well when a user subject is required.
- Put current payment, transaction, membership, ownership, or other business
  state in one site-owned `handler.kind: ref` guard Procedure. It receives the
  validated target input/params and the same `HandlerContext`.
- Put API-key/PAT recognition, hashing, revocation, and normalization in the
  Cloudflare `credentialResolver`. Do not add Core tables, repositories, or a
  generic entitlement layer.
- Bind the same Procedure to HTTP and MCP Triggers when both transports should
  expose it. Standard remote MCP uses OAuth; it does not promise to send a raw
  REST API key/PAT. Runtime predicates and the guard are shared after caller
  normalization.

Expected diagnostics are `UNAUTHENTICATED`/401 for no valid credential,
`AUTH_DENIED`/403 for a verified caller missing role/scope, and
`ENTITLEMENT_REQUIRED`/402 when a site guard denies current access. Re-run the
guide's focused integration command after changing manifests or auth wiring.

## Custom public routes (consumer-app freedom)

The starter owns its `Hono` app instance. If the user wants a public surface that doesn't fit the 4-atom model — a prompt generator, calculator, configurator, starter directory browser, small interactive widget — add a route directly in `src/index.ts`:

```ts
// src/index.ts
import { runtimeRef } from "./bootstrap.js";

app.get("/:locale/tools/prompt-generator", async (c) => {
  const runtime = await runtimeRef.get();
  const profiles = await runtime.executeView.execute({
    view: runtime.viewsByName.get("starter_profiles_active")!,
  });
  return c.html(renderPromptGenerator(profiles, c.req.param("locale")));
});
```

This is consumer-app territory, NOT an SDK feature. The SDK doesn't ship a `customRoutes.ts` declarative API or a type-safe context wrapper — the starter's `Hono` app + `runtime` access via `ref.get()` is enough.

SDK mounts (`mountServerEndpoints`, `mountPublicRoutes`, `mountAuthorize`) register their routes early on the Hono `defaultHandler`; consumer `app.get(...)` calls register on the same Hono instance. MCP endpoints are NOT mounted into Hono — they live as `apiHandlers` on the top-level `createOAuthProvider({...})` instance (`/mcp/staff`, `/mcp`), so they share no route table with public Hono routes and can't collide with consumer paths. The `/:locale` param route in `mountPublicRoutes` 404s on unknown locales, so paths under `/tools/...`, `/api/foo`, `/calc`, etc. won't collide as long as your prefix isn't a declared site locale.

Right tool when: the user wants ONE public page that doesn't read entries or carry workflow. Wrong tool when: you find yourself reimplementing CRUD, list pagination, or auth gating — those are atom-shaped.

Don't fork core templates (post, postList, page, home, contact, notFound) just to add an unrelated public page. Add the route, leave the templates untouched.

## Diagnostic recipes

| Symptom                                                           | Likely cause                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `INPUT_VALIDATION_FAILED` on a Trigger POST                       | Body doesn't match `Procedure.spec.input`. Check `pnpm introspect` for the schema.                   |
| `AUTH_DENIED` (403) on a contact-form-shaped POST                 | A `before_create` lifecycle Trigger threw. The diagnostic's `path` names the Procedure.              |
| MCP `tools/list` doesn't show your new collection                 | Added a Schema but didn't restart wrangler dev. The mount layer caches per-isolate.                  |
| New View doesn't appear at `/api/views/<name>`                    | Same as above — restart. Or: name has uppercase / non-URL-safe chars (use kebab-case).               |
| `VIEW_FILTER_FIELD_NOT_IN_SCHEMA` for a real field                | The Schema is referenced via `View.spec.from`; field must be in that Schema's `properties`.          |

## Live-render dev mode

Set `MANTLE_LOCAL_DEV=1` in `.dev.vars` (the starter ships this on by default). The worker bypasses the KV cache for `post` / `postList` / `page` routes and re-renders via the registered templates against current D1 state on every request. Edit `Header.tsx` / `Layout.tsx` / `styles.ts` / `i18n/*.json` and reload — every page reflects the change immediately, no `pnpm fixture` rebake.

Production / CI: leave `MANTLE_LOCAL_DEV` unset so the publish-pipeline path is exercised.

## Stale-KV gotcha (when you change shared chrome)

The starter renders **registered templates** (post / postList / page) at publish time and caches the HTML in KV. **Request-time templates** (home / contact / notFound) compose fresh on each request.

If you change any module-init resolved chrome — `src/theme.default/components/Layout.tsx`, `PageShell.tsx`, `Header.tsx`, `Footer.tsx`, `styles.ts`, or `src/i18n/*.json` — or fork any of those into `src/theme/` — the new chrome shows on home / contact / notFound immediately, but post / postList / page keep serving the OLD chrome from KV until re-publish. PageShell is on the same module-init slot-resolution path as Header/Footer, so a forked PageShell triggers the same behavior even though the override lives at a different layer.

Local dev fix: `pnpm fixture` rebakes everything from seed data.

Production fix: iterate every published entry and call `runtime.requestPublish.execute({ id })`. A `mantle republish-all` CLI is on the v0.1.x roadmap; until then, a one-shot script that pulls `runtime.listEntries` for every collection and re-publishes each row is the right pattern.

## Don't

- Don't add a Schema-level public-read flag (`Schema.spec.expose.rest` etc) — public reads always go through Views.
- Don't add a non-`$param` filter sentinel (`{ $env: ... }`, `{ $cookie: ... }`, `{ $now }`) — none are in v0.1.
- Don't bypass the chokepoint by writing to D1 directly — every mutation MUST go through `runtime.entries` (lifecycle hooks fire there).
- Don't use `Trigger.source.kind: cron / queue` — DRAFT, parser rejects. MCP is
  shipped; declare `source: { kind: mcp, surface: public | staff }` and bind it
  to a declared Procedure.
- Don't use `Procedure.spec.requires.window` / `.quota` — DRAFT.
- Don't write a Procedure with `handler.kind: builtin` and `op: archive` on a `lifecycle: simple` Schema — boot rejects (archive is editorial-only).
- Don't paste secrets into a manifest (`requires.auth.all` carries predicates only). Secrets go in `wrangler secret put`.

## When you're done

1. Show the user the new endpoint(s) — `curl` example for each.
2. Show the diff of `openapi.json` if you re-emitted it (number of new operationIds).
3. If the new feature has a UI dimension (template, post page, list page) — visually verify in the dev server before claiming done. UI changes can't be type-checked.
