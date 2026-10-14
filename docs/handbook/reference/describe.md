# Describe

`mantle describe <target> <manifest>...` compiles manifests and prints JSON.
An explicit target is required; use the generation target because hashes
include the dialect. The command writes no project files. `--diff <old.json>` prints a JSON
array of changes against a saved report.

`describeApp(plan)` and `diffApp(a, b)` are exported by
`@aotter/mantle/describe`. The `AppDescription` TypeScript type is the contract.
`targetHash(plan, id)` is also exported by `@aotter/mantle/target-hash`.
These exports use no Node APIs and load no SQL parser.

The schemaVersion 1 report contains:

- `access`: `plan.access.userFields`, mapping declared user fields to their
  type, multiplicity and optional enum.
- `targets`: MCP Tool-shaped objects with `name`, `title`, `description`,
  `inputSchema`, `annotations` and `_meta`. View and Procedure names follow
  MCP naming. Route inputs are plain objects with a name selector for known
  dispatcher variants; their `variants` retain the selected input schemas.

Each target’s `_meta` contains:

- `id`: `view:<name>`, `procedure:<name>`, `rest:<METHOD> <path>` or
  `admin:<METHOD> <path template>`. Parameters use `:name`; Admin paths are
  relative to the API base. Publishing ids use `procedure:<schema>.<verb>`;
  media tool ids use `admin:tool:<name>`.
- `targetHash`: a hash of behavior, inputs, requirements, restrictions,
  related Schema definitions, surfaces, Triggers and reachable hooks.
  Optional lowering caches do not affect it. Ref registration keys are
  included; application-owned handler implementations are not.
- `scope` and `restrict`: per-Schema owner and user-field terms. Owner terms
  use `owner`; user-field terms name their `column`, `field` and `type`.
- `readOnly`: true only when all reachable statements are reads. Ref handlers
  and routes without known dependencies are false.
- `trustedOnly`, `opaque`, `unscopedReads`: trusted-only execution, ref-handler
  opacity and reads of Schemas without row scope. Opaque code conservatively
  includes every Schema available to its Store.
- `surfaces` and `triggers`: every declared exposure and each Trigger’s id
  and source. Views include `admin` for developer previews.
- `requires`: conjunctive predicates in `all` and an optional `guard` name.
  Admin-only targets include the admin gate.
- `variants`: each selectable target’s id, input schema, requirements, flags
  and row policies. Route restrictions contain terms common to all variants.

Descriptions contain no SQL or rows. They describe declarations; application
router additions and optional module mounting remain application-owned.

Diff records contain `id`, `field`, `direction` and optional `before`/`after`.
Removing a scope or restrict term widens access; adding one narrows it.
Reading another Schema, dropping requirements, adding surfaces or Triggers,
removing `readOnly` or `trustedOnly`, or enabling `opaque` or `unscopedReads`
widens access. Variants are compared separately. Adding a target widens;
removing one narrows. Every input schema change is `changed`, as are other
behavior changes. Directions describe individual changes, not an overall
proof when several fields change.
