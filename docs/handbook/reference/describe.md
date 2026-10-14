# Describe

`mantle describe [<target>] <manifest>...` compiles manifests and prints the
access report. The default target is `bun-sqlite`; use the generation target
for dialect-specific hashes. The command writes no project files.

`--json` prints the same schemaVersion 1 object as
`await describeApp(plan)` from `@aotter/mantle/describe`.
The JSON Schema is shipped as `@aotter/mantle/describe/schema.json`.
`await targetHash(plan, id)` is also available through the independent
`@aotter/mantle/target-hash` export. Neither export loads a SQL parser or uses
Node APIs. Applications that do not import them load no report code.

- `planHash` hashes canonical plan content, excluding the stored fingerprint.
- `access` maps each used user field to its type, enum when present, operator,
  Schema scope bindings and target restrict bindings. `id` represents
  `auth.uid()` with operator `eq`; value fields use `in`.
- `targets` contains MCP Tool objects for Views, Procedures, REST routes and
  built-in Admin API templates. View and Procedure names follow MCP naming.
  Route names encode their ids as MCP-compatible names. `_meta.id` is the
  stable identity: `view:<name>`, `procedure:<name>`,
  `rest:<METHOD> <path>` or `admin:<METHOD> <path>`. Path parameters use `:name`;
  Admin paths are relative to the configured Admin API base.
- `_meta.scope` and `_meta.restrict` contain per-Schema owner and value terms.
  `_meta.userFields` summarizes their bindings. `via: restrict` takes
  precedence when a field participates in both. `allAllowed` is false for
  owner equality and whenever any restrict term uses the field.
- `readOnly` is true only when all reachable compiled statements are reads.
  Ref handlers are always false, regardless of authored MCP annotations.
  `opaque` identifies ref handlers (including custom guards). Their
  field summaries conservatively include every Schema available to `ctx.store`;
  read flags describe only statically known reads. `ownerScoped` identifies owner-scoped
  Schema reads. `unscopedReads` identifies Schema reads without row scope.
  `hostCallable` excludes trusted-only Procedures and routes invoking them.
- `requires.all` records credential/admin predicates and required scopes;
  it contains no role list. `requires.guard`, when present, names a custom
  guard. Admin routes include the admin gate.
- `targetHash` includes compiled behavior, input, requirements, restrictions
  and the Schema policies and definitions the target touches. Hashes include
  ref registration keys, not app-owned handler implementations.

A plan describes declarations, not application-owned router configuration.
Admin templates list built-in routes; optional site, media, identity and
entry modules must still be mounted by the application. Generic routes
summarize every selectable declaration or Schema. `variants` retains the exact
requirements and row policies of each selectable View or Procedure; the route
summary unions their field bindings and does not imply all variants run together.
Route inputs flatten path/query selectors; selectable Views and Procedures
use an `input` property for their arguments. Application-owned extension
handlers and router additions are outside the plan. Opaque code and custom
router behavior require a separate review. Reports contain no SQL or row data.

`mantle describe <manifest>... --diff <old.json>` compares a saved report with
the current report. Add `--json` for an array of changes. `diffApp(a, b)` compares
reports with the same schema version. Each change names a target, field and
`widened`, `narrowed` or `changed` direction. Removing a conjunctive scope or
restrict term widens access; adding one narrows it. Adding a target widens,
removing one narrows. Dropping requirements or permitting writes widens.
Incomparable terms, guards and other behavior changes are `changed`.
Diff directions describe individual changes, not a proof of overall access
when a target changes in several ways.
