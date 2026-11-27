# Describe

`mantle describe <target> <manifest>...` compiles manifests and prints JSON.
An explicit target is required; use the generation target because hashes
include the dialect. The command writes no project files. `--diff <old.json>` prints a JSON
array of changes against a saved report.

This command's output is the supported way to get a description outside the
CLI. Run it in Node.js or Bun, for example in a deploy step, from the
committed manifests, and give the saved JSON to whatever needs it. A Worker
cannot compile manifests that contain SQL, because the SQL parser's WASM needs
the whole isolate memory (ADR-0034); do not import compiler files from `dist`.

```sh
mantle describe cloudflare-d1 manifests/*.yaml > describe.json
```

`@aotter/mantle/describe` exports `matchTarget` and the `AppDescription`,
`DescribeTarget` and `TargetRequest` types; `AppDescription` is the contract.
It loads no compiler, SQL parser or Node API.

The schemaVersion 1 report contains:

- `targetHashVersion`: the `targetHash` formula, `2` since ADR-0047. A saved
  report without it used formula 1.
- `access`: `plan.access.userFields`, mapping declared user fields to their
  type, multiplicity and optional enum.
- `targets`: MCP Tool-shaped objects with `name`, `title`, `description`,
  `inputSchema`, `annotations` and `_meta`. View and Procedure names follow
  MCP naming. Route inputs are plain objects with a name selector for known
  dispatcher variants; their `variants` retain the selected input schemas.
  Like `title` and `description`, localized `title` and `description`
  keywords inside these input schemas are resolved to English (else the first
  locale), so a host can list a target as an MCP tool unchanged; `targetHash`
  still covers every locale. A label-only edit in another locale therefore
  shows in `diffApp` as `{ field: "behavior", direction: "changed" }`, without
  before and after values. A target's own `title` or `description` edited in
  another locale shows as `{ field: "exposure", direction: "changed" }`.

Each target’s `_meta` contains:

- The tool's own metadata, including `openai/fileParams` for attachment inputs on `upload_media`.
  Describe's reserved access fields below take precedence. Built-in media tools use their real tool titles and descriptions.

- `id`: `view:<name>`, `procedure:<name>`, `rest:<METHOD> <path>` or
  `admin:<METHOD> <path template>`. Parameters use `:name`; Admin paths are
  relative to the API base. Publishing ids use `procedure:<schema>.<verb>`;
  media tool ids use `admin:tool:<name>`. A [GET Trigger](trigger.md#get-triggers-for-a-view)
  on a View adds a `rest:GET <path>` target, such as `rest:GET /api/orders/:id`,
  whose one variant is `view:<name>`.
- `behaviorHash`: what the operation does: its declaration without
  presentation (`title`, `description`, MCP annotations and tool display
  fields, and `uiSchema` other than a View list's `filterFields` and
  `searchFields`, which decide what its Admin routes accept and run),
  effective requirements, restrictions, related Schema
  definitions, user fields and flags. Authored SQL is included, so a
  whitespace-only SQL edit changes it. A `rest:` or `admin:` target with one
  variant and nothing of its own has that variant's `behaviorHash`.
- `exposureHash`: where and how the operation is reachable: surfaces other than
  REST, non-http Triggers, input schema, requirements, flags and presentation;
  for a `rest:` or `admin:` target, its variant ids and, on `rest:`, its
  binding. An http
  Trigger counts toward the hashes of its own `rest:` target only, although
  `triggers` still lists it on the targets it reaches.
- `targetHash`: the runtime pin, a hash of `behaviorHash` and `exposureHash`.
  Moving an http Trigger to another path changes only that Trigger's `rest:`
  target id and pin; `procedure:<name>`, `view:<name>` and the other targets
  keep theirs. Optional lowering caches do not affect it. Ref registration keys
  are included; application-owned handler implementations are not.
- `targetHashV1`: the formula-1 `targetHash`, so a report can be compared with
  one saved before formula 2. It is carried through the 0.2.x line.
- `exposure` (`rest:` targets): how the route binds a request:
  `{ path, input, strict, head, response }`, where `path` maps each path
  parameter to its type, `input` is `query` or `body`, `strict` is true for a
  GET Trigger's route, `head` says whether `HEAD` is served and `response` is
  `page` or `result`.
- `scope` and `restrict`: per-Schema owner and user-field terms. Owner terms
  use `owner`; user-field terms name their `column`, `field` and `type`. A
  restrict's OR-clauses are listed under `or`, each a list of such terms of
  which one must hold; the single terms stay in `owner` and `terms`.
- `readOnly`: true only when all reachable statements are reads. Ref handlers
  and routes without known dependencies are false.
- `trustedOnly`, `opaque`, `unscopedReads`: trusted-only execution, ref-handler
  opacity and reads of Schemas without row scope. Opaque code conservatively
  includes every Schema available to its Store.
- `nativeDatabase`: whether the Procedure declares `spec.db: native`; routes summarize their variants. A warning-phase deployment can report false and still provide a native handle. Ref calls through `store.procedures` are not statically summarized.
- `surfaces` and `triggers`: every declared exposure and each Trigger’s id
  and source, including a View's GET Triggers. Views include `admin` for
  developer previews.
- `requires`: conjunctive predicates in `all`.
  Admin-only targets include the admin gate.
- `variants`: each selectable target’s id, input schema, requirements, flags
  and row policies. Route restrictions contain terms common to all variants.

Descriptions contain no SQL or rows. They describe declarations; application
router additions and optional module mounting remain application-owned.

## Matching a request to its target

`matchTarget(describe, request)` from `@aotter/mantle/describe` returns the
`_meta` of the target that the generated routers select for a request, or
`null` when they serve none. It reads only the JSON this command prints: it
imports no application, opens no database and makes no network call, so a
gateway can compute `props.mantle.target` and `targetHash` before forwarding.

A gateway can keep a trimmed description. The matcher reads the target's
`name`, `_meta.id`, `_meta.surfaces`, and `_meta.variants[0]?.id`, and preserves
the caller's metadata type on return. Without surfaces a target has no MCP
endpoint, and a REST target without variants has no implicit `HEAD` match.

```ts
import { matchTarget, type AppDescription } from "@aotter/mantle/describe";
import saved from "./describe.json";
const describe = saved as AppDescription, url = new URL(request.url);
matchTarget(describe, { surface: "rest", method: request.method, path: url.pathname });   // rest:GET /api/views/orders
matchTarget(describe, { surface: "admin", method: request.method, path: url.pathname });  // admin:GET /entries/:id
matchTarget(describe, { surface: "mcp", tool: params.name, path: url.pathname });         // view:orders, admin:tool:<name>
```

The matcher compiles describe ids with the routers' own pattern grammar and
precedence, and a conformance test checks it against the generated REST, MCP
and Admin routers for every route of the example apps:

- Paths are the URL pathname. Each segment is percent-decoded and re-encoded,
  so `/api/views/%6Frders` matches `/api/views/orders`; a malformed escape
  matches nothing. One trailing slash is optional. Repeated slashes and a
  different letter case do not match.
- Methods are compared as `Request.method` reports them. `HEAD` selects a
  public View's `GET /api/views/<name>` route; a View's GET Trigger route,
  Admin and Procedure routes do not serve `HEAD`.
- REST precedence is the generated router's order (see
  [http Triggers](trigger.md#route-precedence)). Admin precedence is Admin's
  declared route order, so `/entries/export` wins over `/entries/:id`.
- Admin paths start with `/admin/api`, where Admin mounts its API. Admin ids
  are relative to it.
- MCP matches the `tools/call` name. Pass the `/mcp` or `/mcp/admin` path to
  limit the match to that endpoint's tools. Without a path, a name that the two
  endpoints map to different targets matches nothing.

Upgrade the gateway's `@aotter/mantle/describe` together with Core before an
application declares GET Triggers. An older matcher matches `HEAD`
on a GET Trigger's path to its target, while Core answers that request 405; it
fails closed, since Core serves no data for it.

A host rule keyed on a request (for example "these targets need a step-up")
must key on the target `matchTarget` returns, or apply the same normalisation
itself. A rule on the raw pathname can be bypassed by an equivalent spelling
such as `/api/views/%6Frders` or a trailing slash.

Media tools (`admin:tool:<name>`) and the optional Admin developer and
statistics routes match even when the application does not mount them; the
application then answers `NOT_FOUND`. Routes and tools the application adds
itself, including Admin `routes` it passes to `admin()`, are not in describe and
return `null`. Web and site pages (pinned by `view:<name>`) and auth routes are
outside `matchTarget`.

Diff records contain `id`, `field`, `direction` and optional `before`/`after`.
Removing a scope or restrict term widens access; adding one narrows it. A restrict is an AND of
OR-clauses; a single term is a clause of one, so a clause left with one term, which moves from `or`
to the single terms, is compared as the same rule. Each Schema's direction is decided in two steps:

1. Rows. If a clause of the old policy follows from no clause of the new one (a clause follows from
   another whose disjuncts are a subset of its own), rows may be added: `widened`, whatever else
   changed. Adding a disjunct, removing a clause and swapping a term are widenings. Otherwise, if a
   new clause follows from no old one, rows are removed; otherwise the rows are the same.
2. Callers refused before SQL. A user-field term (`IN auth.user(...)`) refuses a caller holding
   `{ all: true }` for its field (`AUTH_DENIED`) and, under gateway mode, a host that did not
   forward the field (`HOST_CONTRACT`), also inside an OR-clause (where an application caller's
   missing or empty field only makes the term false). When rows are removed, the direction is
   `narrowed`, unless a user-field term of the old policy appears nowhere in the new one: those
   callers are now admitted, so it is `changed`. When the rows are the same, a user-field term that
   disappears makes it `widened`, one that appears `narrowed`, both or neither `changed`.

So dropping the `= auth.uid()` disjunct of `author_id = auth.uid() OR org IN auth.user('ownerOrgIds')`
narrows, and dropping the `org` one is `changed`. A target's restrict, scope or variants are
`narrowed` only when every Schema's direction is, and `widened` when any is. `changed` does not mean
"no effect": it means neither direction can be stated, and some callers may now reach rows they could
not; review it as you would a widening.
Reading another Schema, dropping requirements, adding surfaces or Triggers,
removing `readOnly` or `trustedOnly`, or enabling `opaque` or `unscopedReads`
widens access. Variants are compared separately. Adding a target widens;
removing one narrows. Every input schema change is `changed`, as are other
behavior changes. Directions describe individual changes, not an overall
proof when several fields change.

When both reports carry the fingerprints:

- A different `behaviorHash` is `{ field: "behavior", direction: "changed" }`,
  even when other fields of the target were also reported.
- A different `exposure` on a `rest:` target is `changed`, with before and after.
  A different `exposureHash` with nothing else reported is
  `{ field: "exposure", direction: "changed" }`.
- An http Trigger whose path alone changed is `changed` in `triggers`, not
  widened.
- A `rest:` target that only moved to another path (same method, behavior,
  binding, requirements, row policies, input schema, variants and flags) is one record
  `{ id: <new id>, field: "exposure", direction: "changed", before: <old id>, after: <new id> }`
  instead of one removed and one added target.

Comparing a formula-1 report with a formula-2 one adds
`{ id: "*", field: "targetHashVersion", direction: "changed", before: 1, after: 2 }`
and, for every target, even one with other fields reported, compares its
formula-1 value (`targetHash` in the older report, `targetHashV1` in the newer),
reporting `behavior` `changed` when they differ, so a SQL change shipped with
the upgrade always shows. When the newer report lacks `targetHashV1`, the target gets
`{ field: "behavior", direction: "changed", unverified: true }`.
