# @aotter/mantle-web

Optional public document composition for Mantle. It turns a headless
`MantleRuntime` into HTML, Markdown, `llms.txt`, sitemap, SEO, and preview
operations without owning routes, sessions, cache policy, or application UI.

```ts
import { createMantleWeb, TemplateRegistry } from "@aotter/mantle-web";

const templates = new TemplateRegistry();
templates.registerEntryTemplate("posts", ({ entry }) =>
  `<main><h1>${entry.data.title}</h1></main>`,
);

const web = createMantleWeb(runtime, { templates });
const html = await web.renderEntryLive.execute({
  collection: "posts",
  slug: "hello",
  locale: "en",
  site,
});
```

Omit this package when an application only needs Mantle parsing, planning, or
headless runtime operations.

## Public content pages

`renderListLive.execute` returns `{ html, nextCursor? } | null`.
`composeLlmsTxt.execute` returns `{ body, nextCursor? } | null`, where `body`
can be null for a page without serializable public documents.
`composeSitemap.execute` returns `{ body, nextCursor? }` for one sitemap part.
These alpha APIs now return explicit pages: a custom adapter must expose or
follow `nextCursor`, including when the current llms page has no body.

Lists and llms default to 50 entries. Pass `cursor` from the previous result and
optionally `limit` to change page size. Ordering is `updatedAt DESC, id DESC`;
these are live forward pages, not a snapshot during concurrent publication.
The reader limits each page to 2,000 rows and 1 MiB of data JSON, except a single
oversized entry is returned alone so iteration can advance.

For root llms, omit `locale`, pass `locales: site.locales`, and provide
`pathFor(entry, locale)` to expand shared entries without repeated database reads.
For a sitemap, `maxUrls` is entries per part (default 2,000). Serve an index with
`composeSitemap.index(request, cursor => partUrl(cursor))`; every part must use
the same request projection and limit. Parts have the standard 50,000-URL /
50-MiB protocol ceilings and fail explicitly if custom expansion exceeds them.
The index walks bounded metadata pages, so its database work is proportional
to site size. `additionalPaths` appears only in the first part.

A custom sitemap `pathFor` receives full bounded data unless `dataFields` names
its required top-level fields. Built-in path resolution projects only `slug`.
Custom `PublicPathResolver` implementations can declare `dataFields` for the
Cloudflare mount to use; omission retains full data. Missing projected keys
are null and envelope fields, including locale, remain available.

Cloudflare's public mount supplies `nextPageUrl` to list templates and publishes
HTTP continuation links. Templates must render their own accessible navigation
when this URL is present (escape it like any other attribute). This replaces
the adapter's injected English Next link; update existing list templates when
adopting this version. For example, with Hono's escaping `html` tagged template:

```ts
import { html } from "hono/html";

templates.registerListTemplate("posts", ({ entries, nextPageUrl }) =>
  html`<main>${entries.map(entry => html`<article>${entry.data.title}</article>`)}
    ${nextPageUrl ? html`<nav aria-label="Pagination"><a rel="next" href="${nextPageUrl}">Next</a></nav>` : ""}
  </main>`.toString(),
);
```

Custom adapters pass `pathForPage(cursor)` to `renderListLive.execute` to provide
their own URL mapping. Cloudflare serves `/sitemap.xml?part=1&cursor=...` parts
automatically. Preview authorization and public-response cache policy still apply.

## WebMCP (opt in)

Browsers implementing the draft imperative WebMCP API can expose public Mantle
capabilities as tools. Importing the subpath has no registration side effect;
registration begins only when `bindWebMcp` is called.

### Fresh server-backed site

Declare a public View; the Cloudflare adapter publishes its safe tool descriptor
at `/api/views` and keeps the manifest server-side.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: recent-posts
spec:
  surface: public
  from: posts
  limit: 20
```

The default binding discovers and invokes those same-origin View routes:

```ts
import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const binding = await bindWebMcp();
```

### Fresh browser-local SPA

Project the active plan and dispatch through the active local Runtime. Keeping
Runtime lookup inside `invoke` lets the SPA switch bundles without stale
closures.

```ts
import { projectCallableCapabilities } from "@aotter/mantle-runtime";
import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const capabilities = projectCallableCapabilities(plan, { surface: "public" });
async function invokeMantle(capability, input, signal) {
  signal.throwIfAborted();
  const runtime = await getRuntime();
  if (capability.kind === "procedure") {
    const result = await runtime.invokeTrigger({
      trigger: capability.trigger,
      input,
      ctx: getContext(),
    });
    if (!result.ok) throw result.diagnostic;
    return result.data;
  }
  const { page, show, ...params } = input;
  const result = await runtime.executeView({
    view: capability.ownerName,
    options: {
      params,
      page: typeof page === "number" ? page : undefined,
      show: typeof show === "number" ? show : undefined,
    },
    ctx: getContext(),
  });
  if (!result.ok) throw result.diagnostic;
  return result.result;
}

const binding = await bindWebMcp({ capabilities, invoke: invokeMantle });

// Unregister when the page/app scope ends.
binding.dispose();
```

### Existing WebMCP site

Pass the host's current registry and optional hooks. Mantle inspects and skips
existing names; it does not replace host registrations.

```ts
const binding = await bindWebMcp({
  capabilities,
  invoke: invokeMantle,
  modelContext: document.modelContext,
  before(call) {
    analytics.track("webmcp:start", call);
  },
  after({ target }, result) {
    if (result.status === "fulfilled") refreshUi(target);
  },
});
```

Unsupported browsers return `{ supported: false }`. Only public capabilities
are registered. Procedure tools must originate from explicit public MCP
Triggers, and execution must enter Runtime through that Trigger. `after` is
observational: its failure never replaces the invocation result.
