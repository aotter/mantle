# Generated Admin descriptors

`mantle generate` emits `admin-descriptors.ts`. Its exports are static data;
importing a query does not import them. Selecting only `collections` also drops
the developer snapshot and MCP catalogues from a bundle. No request-time parser,
RuntimePlan, SQL AST, storage access or execution observer is included.

- `collections` matches the 0.2 navigation projection: translation Schemas fold
  into their parents; composition, parent picker, media fields, indexed sorts,
  enum filters and list presentation retain their declared field names.
- `allCollections` includes translation and child editor descriptors by name.
  `fieldNames` maps storage column names to authored names; `viewNames` does the
  same for staff View outputs whose fields are read unchanged.
- `views` and `operations` preserve the 0.2 staff descriptor shapes. Generated
  publishing transitions stay out of Admin operations and WebMCP, preserving
  the SPA's native Publish/Unpublish buttons. Operation
  bindings use declared targets and version inputs; `requiredStates` contains
  necessary enum equalities from one row UPDATE, not an authorization rule.
- `authorizations` is a separate View/Procedure lookup for the generated Admin
  handler to filter descriptors by the resolved Caller. These constants do not
  authorize a request; session/staff gates and execution checks remain required.
- `developerConsole` is the 0.2 data-model, logic, interface, relationship and
  operations snapshot, derived once during generation. SQL logic is display
  data, not executable IR. Observations remain unavailable and run history empty.
- `mcpAppCatalogues` contains public/staff App catalogues. Row actions require
  the same single-table, unchanged-id provenance as 0.2. Publishing transitions
  use the actual `<schema>.<verb>` Procedures and canonical `<verb>_<schema>`
  staff tool names. A conflicting declared staff tool is refused.
- `webmcp` carries static tool declarations and Admin page routes. `bootstrap`
  combines `collections`, `operations`, `views` and `webmcp`; the handler adds
  request-owned `me`, `site` and any selected entries page.

Generation reuses the 0.2 projection and SQL-logic helpers. View columns come
from the compiled plan (Core's `viewOutputs` provenance, including aliases,
stars, CTEs and subqueries). Translation
metadata is supported by the emitter; execution support comes from the separate
translation kernel work.

Pass declarations with `mantle generate --admin-extensions ./admin-extensions.mjs`.
The module exports a named `adminExtensions` array or a default array; it should
contain plain declarations, without constructing runtime services:

```js
export const adminExtensions = [{ id: 'audit', contributes: {
  fields: [{ id: 'color', target: 'field.input/v1',
    optionsSchema: { type: 'object', properties: { palette: { type: 'string' } } }
  }]
}}];
```

The programmatic generation options accept the same declarations:

```ts
await generateFromSources({ target, sources,
  adminExtensions: [{ id: 'audit', contributes: {
    fields: [{ id: 'color', target: 'field.input/v1',
      optionsSchema: { type: 'object', properties: { palette: { type: 'string' } } }
    }]
  }}]
});
```

Only `id` and `contributes` are needed at generation. `extensionBindings` records
Schema/Procedure field widgets, Schema/staff View cells and sidebar panels.
Unknown contributions, wrong targets and invalid options fail generation with
`UI_EXTENSION_UNKNOWN`, `UI_EXTENSION_TARGET` or `UI_EXTENSION_OPTIONS`, retaining
0.2 paths. Serving extension modules and handling extension actions is separate.
