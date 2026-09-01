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
