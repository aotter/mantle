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
