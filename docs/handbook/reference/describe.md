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

## Matching a request to its target

`matchTarget(describe, request)` from `@aotter/mantle/describe` returns the
`_meta` of the target that the generated routers select for a request, or
`null` when they serve none. It reads only the JSON this command prints: it
imports no application, opens no database and makes no network call, so a
gateway can compute `props.mantle.target` and `targetHash` before forwarding.

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
  public View's `GET` route; Admin and Procedure routes do not serve `HEAD`.
- REST precedence is the generated router's order (see
  [http Triggers](trigger.md#route-precedence)). Admin precedence is Admin's
  declared route order, so `/entries/export` wins over `/entries/:id`.
- Admin paths start with `/admin/api`, where Admin mounts its API. Admin ids
  are relative to it.
- MCP matches the `tools/call` name. Pass the `/mcp` or `/mcp/admin` path to
  limit the match to that endpoint's tools. Without a path, a name that the two
  endpoints map to different targets matches nothing.

Media tools (`admin:tool:<name>`) and the optional Admin developer and
statistics routes match even when the application does not mount them; the
application then answers `NOT_FOUND`. Routes and tools the application adds
itself, including Admin `routes` it passes to `admin()`, are not in describe and
return `null`. Web and site pages (pinned by `view:<name>`) and auth routes are
outside `matchTarget`.

Diff records contain `id`, `field`, `direction` and optional `before`/`after`.
Removing a scope or restrict term widens access; adding one narrows it.
Reading another Schema, dropping requirements, adding surfaces or Triggers,
removing `readOnly` or `trustedOnly`, or enabling `opaque` or `unscopedReads`
widens access. Variants are compared separately. Adding a target widens;
removing one narrows. Every input schema change is `changed`, as are other
behavior changes. Directions describe individual changes, not an overall
proof when several fields change.
