---
description: Add your own pages, settings, actions, record panels and field widgets to Admin in 0.2.0, bind them from manifest uiSchema, and verify them.
---
# Extend Admin

Manifests decide most of what Admin shows ([Customize Admin from
manifests](admin-ui.md)). When a project needs UI of its own, it adds an
**Admin extension**: a declaration that is plain data, server handlers, and
optionally one ES module with renderers. The contract is
[ADR-lite 1376](../../adr/adr-lite-1376-admin-extensions.md).

With feature `admin`, `mantle generate` writes `src/admin-extensions.ts`
(yours to edit) and passes its `adminExtensions` to `createAdminSurface`.

## What you can add

| Contribution | Where it appears | Client code |
|---|---|---|
| `pages` | `/admin/x/{extension}/{page}`; in **More** when it declares `nav` | a renderer |
| `settings` | `/admin/x/{extension}/{id}`, always in **More** | none: Admin renders a form from `schema` |
| `actions` | `record/v1` (a record's header), `list.selection/v1` (the bulk bar), `list.toolbar/v1` (a list's toolbar) | none for `run` and `confirm` (a server `run`); a renderer for `dialog` |
| `panels` | `record.sidebar/v1` (a record's side column), `home/v1` (the home page) | a renderer |
| `fields` | `field.input/v1` (a form control), `field.cell/v1` (a list cell) | a renderer |

Every contribution has a minimum staff `role`. The server sends each staff
member only the contributions their role reaches, and checks the session and
role again on every extension route: hiding a button is never the only guard.
Finer rules belong in your handlers, which receive the caller.

## A complete extension

```ts
// src/admin-extensions.ts
import type { AdminExtension } from "@aotter/mantle/admin";

const brand: AdminExtension = {
  apiVersion: 1,
  id: "brand",
  title: { en: "Brand", "zh-TW": "品牌" },
  // Admin serves this at /admin/extensions/brand.js, with its integrity computed
  source: BRAND_MODULE,
  contributes: {
    pages: [{ id: "palette", title: "Palette", role: "editor", nav: { group: "more" } }],
    settings: [{ id: "defaults", title: "Brand defaults", role: "owner", schema: {
      type: "object", required: ["accent"],
      properties: { accent: { type: "string", title: "Accent", enum: ["teal", "navy"] }, limit: { type: "integer", minimum: 1, maximum: 20 } },
    } }],
    actions: [{ id: "reindex", title: "Re-index colors", role: "editor", target: "record/v1", presentation: "confirm", when: { schema: ["products"] } }],
    panels: [{ id: "usage", title: "Where it is used", role: "contributor", target: "record.sidebar/v1", when: { schema: ["products"] } }],
    fields: [
      { id: "color", target: "field.input/v1", optionsSchema: { type: "object", properties: { palette: { type: "string", enum: ["brand", "web"] } } } },
      { id: "swatch", target: "field.cell/v1" },
    ],
  },
  handlers: {
    settings: { defaults: { load: async () => ({ accent: "teal" }), save: async (_caller, value) => value } },
    actions: { reindex: { run: async (caller, { record }) => ({ message: `Re-indexed ${record!.id}` }) } },
    // GET/POST /admin/api/x/brand/api/{path}; null answers 404
    api: async (request, { caller, path }) => (path === "usage" ? Response.json({ count: 3 }) : null),
  },
};

export const adminExtensions: readonly AdminExtension[] = [brand];
```

`source` is the module's code (or a function returning it). How you load the
text is up to your host: a string constant, a Wrangler `Text` module rule, or
Bun's `with { type: "text" }` import. A host that serves the file itself sets
`module: "/path.js"` (same-origin) and optionally `integrity` instead.

## The module

The module needs no build step. Admin's import map provides `react`,
`react/jsx-runtime`, `react-dom`, `react-dom/client`,
`@aotter/mantle-ui/kit` and `@aotter/mantle-ui/extension`, so the module
uses Admin's own React and kit and looks like the rest of Admin. If you do
bundle it, mark those specifiers external.

```js
import { jsx } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge, Input } from "@aotter/mantle-ui/kit";
import { defineAdminExtension } from "@aotter/mantle-ui/extension";

// a renderer gets an element and a context; it may return a cleanup or { update, unmount }
const react = (Component) => (element, context) => {
  const root = createRoot(element);
  root.render(jsx(Component, { context }));
  return { update: (next) => root.render(jsx(Component, { context: next })), unmount: () => root.unmount() };
};

function Usage({ context }) {
  const [count, setCount] = useState(null);
  useEffect(() => { fetch(`${context.apiBase}/usage`).then((r) => r.json()).then((b) => setCount(b.count)); }, [context.apiBase]);
  return jsx(Badge, { children: count === null ? "…" : `${count} pages` });
}
function Color({ context }) {
  return jsx(Input, { "aria-label": context.field.name, value: String(context.field.value ?? ""), onChange: (e) => context.onChange(e.target.value) });
}

export default defineAdminExtension({
  pages: { palette: react(() => jsx("p", { children: "Palette" })) },
  panels: { usage: react(Usage) },
  fields: {
    color: react(Color),
    swatch: (element, context) => { element.textContent = `■ ${context.field.value ?? ""}`; },
  },
});
```

The context holds `extension`, `contribution`, `apiBase` (your `api`
handler), `language`, `theme`, `caller.role`, and where it applies `record`
(`{ schema, id, version }`), `selection`, `schema`, `field`, `options` and,
for `field.input/v1`, `onChange`. `host.navigate(path)`, `host.notify(text)`
and `host.close()` (a dialog action) are the only ways into the console.

## Bind contributions from manifests

A manifest's `uiSchema` can name a project contribution as
`<extension>/<contribution>`. The binding sits next to the field it changes,
so one change (and one review) covers both:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: products }
spec:
  title: Products
  lifecycle: operational
  uiSchema:
    fields:
      color: { widget: brand/color, options: { palette: brand } }
    list:
      columns: [color]
      cells: { color: brand/swatch }
    panels: [brand/usage]
  schema:
    type: object
    required: [name]
    properties:
      name: { type: string }
      color: { type: string }
```

- `fields.<name>.widget` names a `field.input/v1` contribution (any field type);
  `options` must satisfy its `optionsSchema`.
- `list.cells.<field>` (Schemas, and staff Views by output name) names a
  `field.cell/v1` contribution.
- `panels` (Schemas) names `record.sidebar/v1` contributions.
- Procedure `uiSchema.fields.<name>.widget` works like a Schema's.

`mantle generate` checks the shape of the names. `createAdminSurface` checks
that each named contribution exists, has the right target and accepts its
`options`, and refuses to start otherwise (`UI_EXTENSION_UNKNOWN`,
`UI_EXTENSION_TARGET`, `UI_EXTENSION_OPTIONS`). A manifest names only the
project's own extensions, so it renders the same locally and deployed; a host
that adds extensions attaches them with `when`. When both apply to one place,
the manifest wins. `uiSchema` stays presentation only: the field's JSON Schema
still validates whatever a widget sends.

## Trust

An extension's module runs in Admin's origin with the viewer's session. It
has no more power than the project already has: whoever deploys the project
already controls its handlers and storage. Keep host routes that act beyond
this project (an organization console, other projects) on another origin.

## Verify

- `createAdminSurface` validates every declaration at start
  (`UI_EXTENSION_INVALID` names the first problem).
- `ADMIN_EXTENSION_JSON_SCHEMA` (from `@aotter/mantle/admin`) describes a
  declaration for tooling; `diffAdminExtensions(before, after)` lists added,
  removed and changed contributions for review.
- Sign in as each role and check what appears; call
  `/admin/api/x/{extension}/...` as a lower role and expect 403.
