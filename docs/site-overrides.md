# Site overrides and source ejection

Mantle's generated site is small by default, not closed. The normal project
owns its manifests, Worker entry, handlers, business services, Wrangler config,
and visible UI. Core owns the standard D1/KV/Auth/OAuth/MCP/cache assembly and
the reproducible files under `.mantle/generated/`.

Use the narrowest override that gives the application the control it needs.
Nothing in this guide is a protected extension point: copied or newly written
source belongs to the application and normal version control owns its history.

## Replace the former `src/mantle/config.ts`

Keep the conventional Worker and add only the application-owned seam:

```ts
import {
  createMantleWorker,
  runMantleUseCase,
} from "@aotter/mantle/cloudflare";
import { bindMantleSite, manifest } from "../.mantle/generated/site.js";
import { createHandlers } from "./handlers.js";

type SiteEnv = Env & {
  readonly AUDIT_QUEUE: Queue<{ readonly entryId: string }>;
};

export default createMantleWorker<SiteEnv>({
  manifest,
  extend: ({ env }) => ({
    handlers: createHandlers(env),
    mount: ({ app, getRuntime }) => {
      app.get("/api/site-summary", () => runMantleUseCase(
        "GET /api/site-summary",
        async () => {
          const site = bindMantleSite(await getRuntime());
          const result = await site.views["published-notes"]();
          if (!result.ok) return result;
          return { ok: true, count: result.result.rows.length };
        },
      ));
    },
  }),
});
```

Façade options cover custom handlers, defaults, templates, paths, Auth,
bindings, routes, middleware, services, and OAuth scopes. Use the
real `Env`, Hono app, Auth, runtime, and `ExecutionContext.waitUntil`; do not
invent parallel wrappers for them.

When the façade is genuinely the wrong architecture, replace `src/index.ts`
with version-matched low-level composition using the public exports from
`@aotter/mantle/cloudflare` and `@aotter/mantle/runtime`. Copy
`node_modules/@aotter/mantle/fixtures/low-level-worker` from the installed
package. That version-matched recipe shows the complete D1/KV/assets, Auth,
runtime, route, OAuth, MCP, cache, and private error-boundary assembly. The
copied recipe is project-owned.

The replacement does not have to keep the old `src/mantle/config.ts` pathname.
If that module boundary is useful to the application, create it, import it from
`src/index.ts`, and own it like any other source file. Mantle generation and
updates do not reserve or overwrite it.

## Reclaim UI source without restoring all of Kiwa

When present, `public/index.html` is already project-owned source. A headless
blank has no page until the product needs one. Edit or replace an existing page
directly; if one upstream recipe or component is useful:

1. Read `starter_ref` and `archetype` from `.mantle/launch-state.json`.
2. Fetch that exact `aotter/mantle-starters` tag, never a floating branch.
3. Copy only the selected file or block into a project-owned path.
4. Record the source repository, path, ref, and license next to the copy.
5. Import it normally and change it freely.

That is the shadcn-style contract: copied source belongs to the application.
Kiwa is not a hidden runtime dependency or a required layout API. For a checked
zero-dependency UI eject, copy the self-contained minimal page and enable the
native Workers assets binding:

```bash
mkdir -p public
STARTER_REF="$(node -p 'require("./.mantle/launch-state.json").starter_ref')"
curl --fail --location --output public/index.html \
  "https://raw.githubusercontent.com/aotter/mantle-starters/${STARTER_REF}/recipes/minimal-page.html"
```

```jsonc
// Add to wrangler.jsonc
{ "assets": { "directory": "./public" } }
```

The packed starter harness copies this exact recipe into a blank site,
typechecks it, boots Wrangler, and fetches `/`. After copying, the HTML is
application code and may be changed or replaced freely.

The last starter release containing the full historical Kiwa catalog is
`v0.0.11-alpha.63`. Its TSX files are source references, not drop-in files for
the minimal HTML starter: for example, the old button also needs `hono/jsx`,
`@/lib/utils`, JSX/alias configuration, and the matching Tailwind tokens. Port
only the markup/behavior you need into project source, or deliberately bring
those explicit dependencies and configuration with the selected component.
Keep the historical `kiwa/LICENSE` with copied Kiwa code. Do not restore the
whole catalog to change one page.

## Replace overlay seed behavior

There is no hidden production seed runner. The durable product contract is the
manifest plus project-owned business/UI source. Create real content through
Admin, Staff MCP, a declared Procedure, or a typed runtime use case. Keep test
data in test fixtures and load it only into local or isolated test databases.

If an old seed prompt contains useful product intent, recover it from the
last legacy starter tag, for example
`overlays/presence/seed.json` or `seed-prompt.md` at
`v0.0.11-alpha.63`, and port only the useful decisions into manifests,
content, or `.mantle/handoff.md`. A project may keep its own explicit local or
test seed command; do not make an old prompt a second production source of
truth.

## Replace the repo-local updater

The installed umbrella package owns the updater:

```json
{
  "scripts": {
    "mantle:update": "mantle update"
  }
}
```

`pnpm mantle:update -- --ref <immutable-ref>` compares the recorded source,
target bundle, and local project, then writes a report. It does not overwrite
authored files. Review and port selected upstream changes, apply only the
report's typed metadata migration, regenerate, and run the project checks. A
repository may wrap this command for policy or CI. If its requirements
genuinely differ, it may replace the command with project-owned tooling; Core
will not overwrite it, and the project owns its maintenance. Do not blindly
restore the old generated updater as a new default.

For example, a repo-local policy alias remains one line:

```json
{
  "scripts": {
    "mantle:update": "mantle update",
    "mantle:update:strict": "mantle update --strict"
  }
}
```

`v0.0.11-alpha.63` is the final bundle with the generated config/Kiwa/seed and
repo-local updater surfaces. `v0.0.11-alpha.64` is the first minimal façade
bundle and the Core-CLI bridge target. Landing-created alpha.63 sites recorded
the bundle version without the Git tag's `v`, which the old repo-local updater
cannot resolve on GitHub. Bootstrap that one transition with the released Core
CLI instead of copying or patching the old updater:

```bash
pnpm dlx @aotter/mantle@0.0.11-alpha.64 update \
  --ref v0.0.11-alpha.64 \
  --bundle-base-url \
  'https://raw.githubusercontent.com/aotter/mantle-starters/{ref}/provision-bundles'
```

The CLI accepts the historical no-`v` source metadata, reports the reviewed
port, and does not mutate authored files. After the port and metadata migration,
install the new SDK normally; subsequent comparisons use the installed CLI.

## Ownership boundary

- Edit freely: `manifests/`, `src/`, `public/`, custom UI, `wrangler.jsonc`,
  tests, and application scripts.
- Regenerate: `.mantle/generated/` and projected Core-owned Mantle skills.
- Configure secrets with Cloudflare, not committed vars.
- Prefer Core runtime repositories and use cases over direct Mantle-table SQL.
  If the public SDK cannot express a required operation, treat it as a Core API
  gap; low-level Cloudflare composition remains available for deployment-level
  control.
