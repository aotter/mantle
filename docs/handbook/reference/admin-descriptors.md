# Generated Admin descriptors

Experimental native preview; use the matching installed SDK/Admin versions.
[Native Admin](../guides/native-admin.md) explains execution and mounting
with `entries(bindings.schemas, bindings.adapter)`. Descriptors remain static
data, not runtime authorization or a storage interpreter.

`mantle generate` emits `admin-descriptors.ts`. Its exports are static data;
importing a query does not import them. Selecting only `collections` also drops
the developer snapshot and MCP catalogues from a bundle. No request-time parser,
execution plan or SQL AST, storage access or execution observer is included.

- `collections` matches the 0.2 navigation projection: translation Schemas fold
  into their parents; composition, parent picker, media fields, indexed sorts,
  enum filters and list presentation retain their declared field names.
- `allCollections` includes translation and child editor descriptors by name.
  `scopeField` identifies the private scope field; `exportFields` lists only
  declared, exportable data fields (excluding scope/geo). CSV uses these facts
  instead of guessing from row keys. `fieldNames` maps storage column names to authored names; `viewNames` does the
  same for admin View outputs whose fields are read unchanged.
- `views` and `operations` preserve the 0.2 admin descriptor shapes. Generated
  publishing transitions stay out of Admin operations and WebMCP, preserving
  the SPA's native Publish/Unpublish buttons. Operation
  bindings use declared targets and version inputs; `preconditions` contains
  necessary string (including enum) and boolean equality/IN predicates from one
  target-row write. Numeric, temporal and JSON fields are skipped; these hints
  do not authorize execution.
- `authorizations` is a separate View/Procedure lookup for the generated Admin
  handler to filter descriptors by the resolved Caller. These constants do not
  authorize a request; session/admin gates and execution checks remain required.
- `developerConsole` is the 0.2 data-model, logic, interface, relationship and
  operations snapshot, derived once during generation. SQL logic is display
  data, not executable IR. Observations remain unavailable and run history empty.
- `mcpAppCatalogues` contains public/admin App catalogues. Row actions require
  the same single-table, unchanged-id provenance as 0.2. Publishing transitions
  use the actual `<schema>.<verb>` Procedures and canonical `<verb>_<schema>`
  admin tool names. A conflicting declared admin tool is refused.
- `webmcp` carries static tool declarations and Admin page routes. `bootstrap`
  combines `collections`, `operations`, `views` and `webmcp`; the handler adds
  request-owned `me`, `site` and any selected entries page. Its
  `developerConsole` is a loader for the same snapshot, generated again in
  `admin-developer-console.ts`, so Admin imports it on a developer-console
  request instead of at Worker startup.

Generation reuses the 0.2 projection and SQL-logic helpers. View columns come
from the compiled plan (Core's `viewOutputs` provenance, including aliases,
stars, CTEs and subqueries). Translation
metadata and selected execution share the generated translation policy. Child
fields win; private scope fields cannot be overlaid by inherited parent fields.

`adminBindings()` provides the selected adapter and checked entry/View/operation
bindings. The server shares native read templates across collections; descriptors
carry compiler-verified policy/field fragments and generated validators, not a
copy of full SQL for every order/direction. Metadata endpoints perform no storage
read of their own; caller resolution and optional site/user enrichment may query.
Statistics capability is advertised only when its native route is mounted.
