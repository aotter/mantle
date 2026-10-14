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
  Schema scope bindings and target restrict bindings. Value fields use `in`.
  The owner `= auth.uid()` term appears as `scope.<schema>.owner` or
  `restrict.<schema>.owner`; it is not a user field and adds no `id` to `access`.
- `targets` contains MCP Tool objects for Views, Procedures, REST routes and
  built-in Admin API templates. View and Procedure names follow MCP naming.
  Route names encode their ids as MCP-compatible names. `_meta.id` is the
  stable identity: `view:<name>`, `procedure:<name>`,
  `rest:<METHOD> <path>` or `admin:<METHOD> <path>`. Generated publishing tools
  use `procedure:<schema>.<verb>`; media tools use `admin:tool:<name>`.
  Path parameters use `:name`; Admin paths are relative to the configured Admin API base.
- `_meta.scope` and `_meta.restrict` contain per-Schema owner and value terms.
  `_meta.userFields` summarizes their bindings. `via: restrict` takes
  precedence when a field participates in both. `allAllowed` is false whenever
  any restrict term, including a guard's own terms, uses the field. Owner
  equality always applies independently of user fields.
- `readOnly` is true only when all reachable compiled statements are reads.
  Ref handlers are always false, regardless of authored MCP annotations.
  Routes without known dependencies are false, including empty dispatchers.
  `opaque` identifies ref handlers (including custom guards). Their
  field summaries and read flags conservatively include every Schema available
  to `ctx.store`. `ownerScoped` identifies owner-scoped
  Schema reads. `unscopedReads` identifies Schema reads without row scope.
  `hostCallable` excludes trusted-only Procedures and routes invoking them;
  `trustedOnly` records that restriction explicitly.
- `surfaces` lists every declared exposure: `public` and `admin` MCP, `rest`,
  `lifecycle`, `schedule`, or `internal`. Views also list `admin` because the
  developer View dispatcher can invoke them. `surface` is the least gated
  summary (`public` takes precedence). `triggers` retains each Trigger id and
  source.
- `requires.all` records credential/admin predicates and required scopes;
  it contains no role list. `requires.guard`, when present, names a custom
  guard. `requiresBySurface` records the requirements for each surface. The
  admin gate is added only to admin paths. The summary `requires` describes
  the summary surface; each dispatcher variant includes its own requirements.
- `targetHash` includes compiled behavior, input, requirements, restrictions
  and the Schema policies and definitions the target touches, all exposure
  paths and Triggers, guards, and lifecycle/publishing hooks reached by writes.
  Optional `lowered` cache data does not affect `targetHash`. Hashes include
  ref registration keys, not app-owned handler implementations.

A plan describes declarations, not application-owned router configuration.
Admin templates list built-in routes; optional site, media, identity and
entry modules must still be mounted by the application. Generic routes
summarize every selectable declaration or Schema. `variants` retains the exact
requirements, input schema, safety flags and row policies of each selectable target; the
route restrict summary contains only terms common to every variant.
The WebMCP dispatcher includes generated publishing transitions and all
optional media tools conservatively, since mount configuration is not in the plan.
Route inputs flatten path/query selectors; selectable Views and Procedures
use an `input` property for their arguments. Application-owned extension
handlers and router additions are outside the plan. Opaque code and custom
router behavior require a separate review. Reports contain no SQL or row data.

`mantle describe <manifest>... --diff <old.json>` compares a saved report with
the current report. Add `--json` for an array of changes. `diffApp(a, b)` compares
reports with the same schema version. Each change names a target, field and
`widened`, `narrowed` or `changed` direction. Removing a conjunctive scope or
restrict term on an already-read Schema widens access; adding one narrows it.
Reading an additional Schema widens access, even when it has scope terms.
Variants are compared separately: removing a term from any variant widens.
Adding a target widens, removing one narrows. Dropping requirements or a
guard, adding an exposure path or Trigger,
removing trusted-only status, permitting host calls or writes, or enabling
opacity or unscoped reads widens. Provable input-schema loosening widens;
uncertain input changes, replacement guards and incomparable terms remain
`changed`. Other behavior changes are `changed`.
Diff directions describe individual changes, not a proof of overall access
when a target changes in several ways.
