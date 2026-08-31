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

Browsers implementing the draft imperative WebMCP API can expose public Views
as read-only tools. Importing the subpath has no registration side effect;
registration begins only when `bindWebMcp` is called.

```ts
import { projectCallableCapabilities } from "@aotter/mantle-runtime";
import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const binding = await bindWebMcp(
  projectCallableCapabilities(plan, { surface: "public" }),
);

// Unregister when the page/app scope ends.
binding.dispose();
```

Unsupported browsers return `{ supported: false }`. Only public View
capabilities are registered; staff Views and Procedure mutations are excluded.
Calls use the same-origin `/api/views/<name>` route, forward browser
cancellation, and declare both `readOnlyHint` and `untrustedContentHint`.
