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

```ts
import { projectCallableCapabilities } from "@aotter/mantle-runtime";
import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const capabilities = projectCallableCapabilities(plan, { surface: "public" });
const binding = await bindWebMcp({
  capabilities,
  async invoke(capability, input, signal) {
    signal.throwIfAborted();
    if (capability.kind !== "procedure") {
      throw new Error(`Unsupported local capability: ${capability.name}`);
    }
    const result = await (await getRuntime()).invokeTrigger({
      trigger: capability.trigger,
      input,
      ctx: getContext(),
    });
    if (!result.ok) throw result.diagnostic;
    return result.data;
  },
  after({ target }, result) {
    if (result.status === "fulfilled") refreshUi(target);
  },
});

// Unregister when the page/app scope ends.
binding.dispose();
```

An existing WebMCP site may pass its current `modelContext`; Mantle inspects and
skips existing tool names without replacing host registrations. Unsupported
browsers return `{ supported: false }`. Only public capabilities are registered.
Procedure tools must originate from explicit public MCP Triggers, and execution
must enter Runtime through that Trigger. Runtime selection stays inside
`invoke`, so an SPA can switch active bundles without keeping stale closures.
