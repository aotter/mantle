# Authorization requirements

Views and Procedures accept:

```yaml
requires:
  auth:
    all:
      - ctx.user
      - ctx.admin
      - { ctx.auth.scope: "exports:read" }
```

| Predicate | Holds when |
| --- | --- |
| `ctx.user`, `ctx.auth` | Caller is a verified user |
| `ctx.admin` | Caller is in the admin layer |
| `{ ctx.auth.scope: "scope" }` | User scopes include that scope |

Selected REST, MCP and Admin boundaries accept an optional `authorize(target, caller)` callback. `Target`, exported by `@aotter/mantle/contracts`, contains `kind` (`view`, `procedure` or `schema`) and the manifest `name`; Admin generic entry routes also supply `action` (`read`, `create`, `update` or `delete`). The callback runs after credentials and `requires` pass, before execution and row policy. A false result or rejected promise returns `AUTH_DENIED` (HTTP 403); a rejection with an `AUTH_DENIED` `ContractError` keeps its message (for example the role that may call the target), and a synchronous exception is an internal error. MCP tool lists and Admin navigation metadata hide denied targets. Omitting the callback preserves existing behavior; direct generated typed functions do not invoke it.

An impersonated session exposes `caller.impersonatedBy`, the real actor’s subject, only on the original branded Caller; applications decide impersonation policy in `authorize(target, caller)` ([caller conditions](#caller-conditions)).

All predicates must hold. Anonymous/system callers satisfy none of these predicates. Without `requires`, the invocation is ungated, while Schema row policy still applies. A Caller from the application's own credential (`resolveCredential`, an API key or personal token) is the exception: generated REST, MCP and web surfaces admit it only to a target whose `requires` names a `ctx.auth.scope`, and refuse it elsewhere with `AUTH_DENIED`, ungated targets included. Role lists such as `{ ctx.admin: [editor] }` are refused: decide per-target roles in application code. Role names match `^[a-z][a-zA-Z0-9_-]{0,62}$`; an invalid name in a verified user's role fails identity resolution and names the role. Better Auth’s admin plugin `adminRoles` (trimmed, default `["admin"]`) and `adminUserIds` determine the admin layer; Mantle has no role setting of its own.

`requires` accepts only `auth`; a `requires.guard` fails validation with `INVALID_MANIFEST_ENVELOPE`. Implement custom checks in app-owned handlers before executing queries, or for every target at once in `authorize` ([caller conditions](#caller-conditions); why `requires` stays closed: [Core's boundary](../concepts/core-boundary.md)). Generated TypeScript does not validate arbitrary external input; selected boundaries validate inputs, and direct callers must do so themselves.

Predicate failure is `UNAUTHENTICATED` for a non-user or `AUTH_DENIED` for a user. Scope, TTL and publishing independently limit rows; see [authorization](../concepts/authorization.md).

## Caller conditions

"Not while impersonating", "only with a verified email" and "only after a recent sign-in" are facts of the identity
system, which Core cannot verify for a gateway caller, so `requires` stays closed
([ADR-0002](../../adr/0002-closed-enums-for-bindings.md)) and the Caller gains no fields for them
([ADR-lite #1937](../../adr/adr-lite-1937-human-approval.md)). The application states them once, in the
`authorize(target, caller)` it passes to `rest`, `mcp`, `web` and `admin`:

```ts
// src/authorize.ts
import { ContractError, type Authorize } from "@aotter/mantle/contracts";

/** The part of Better Auth's `auth.$context` this reads. */
type AuthRecords = {
  internalAdapter: { findUserById(id: string): Promise<{ emailVerified: boolean } | null> };
  adapter: { findOne<T>(query: { model: string; where: { field: string; value: string }[] }): Promise<T | null> };
};
const RECENT_SIGN_IN_MS = 10 * 60 * 1000;
const SENSITIVE = new Set(["delete-workspace"]);

/** Pass `() => auth.$context` of the application's Better Auth instance. */
export function authorizeWith(context: () => Promise<AuthRecords>): Authorize {
  return async (target, caller) => {
    if (target.kind === "view" || target.action === "read") return true;
    const deny = (message: string) => new ContractError("AUTH_DENIED", message, `${target.kind}/${target.name}`);
    if ("impersonatedBy" in caller && caller.impersonatedBy) throw deny("Not while impersonating: sign in as yourself.");
    if (caller.kind !== "user") return true; // a gateway's host checks its callers before forwarding
    const { internalAdapter, adapter } = await context();
    if (!(await internalAdapter.findUserById(caller.subject))?.emailVerified)
      throw deny("Verify your email address first.");
    if (SENSITIVE.has(target.name)) {
      const session =
        caller.credential === "session" && caller.credentialId
          ? await adapter.findOne<{ createdAt: Date }>({ model: "session", where: [{ field: "id", value: caller.credentialId }] })
          : null;
      if (!session || Date.now() - new Date(session.createdAt).getTime() > RECENT_SIGN_IN_MS)
        throw deny("Sign in again to do this.");
    }
    return true;
  };
}
```

- **Impersonation.** `caller.impersonatedBy` is set only on the original Caller of an impersonated Better Auth session.
  Reads stay open, so an admin can see what the user sees; every write is refused.
- **Email verified.** The callback reads the current user record, as `resolveCaller` does; `userOf(caller)` is display
  data, not an authority. To filter rows by it instead, store it as a user field (`input: false`, kept in step by a
  `databaseHooks.user` hook) and use it in a `scope` or `restrict`.
- **Recent sign-in.** A session Caller's `credentialId` is the session id, and the session's `createdAt` is when the
  person signed in. An OAuth or service credential has no sign-in to check, so a sensitive target refuses it. Better
  Auth's own sensitive endpoints use `session.freshAge` instead.
- **Gateway callers** (`kind: "host"`) come with no Better Auth record: the host checks these facts before it forwards
  a request, and the callback lets them through.

`authorize` runs on the selected REST, MCP, web and Admin boundaries, after credentials and `requires`. A generated
function called directly (`run(db, caller, input)`, `ctx.store.procedures`) does not run it: that is application code,
trusted like the callback itself. The refusal keeps its message: REST answers 403 with
`{ "error": { "code": "AUTH_DENIED", "message": "Verify your email address first.", "path": "procedure/add-note" } }`;
MCP answers a `tools/call` with HTTP 403 and the same `error`, and leaves a refused target out of `tools/list`.

### Limits and authorize

A rejection from `authorize` that is not an `AUTH_DENIED` `ContractError` becomes `AUTH_DENIED` with the message
`Target is not authorized.`: a `ContractError` with `status: 429` thrown there reaches REST as 403 and MCP as 403, and
its `retryAfter` is dropped. Check a request-rate limit in the application's route, before the generated surface,
where the route owns the response: with Cloudflare's Workers Rate Limiting (a `ratelimits` binding), the route returns
`(await limited(env.LIMITER, key)) ?? api(request, env, ctx)`, keyed by the caller or the client address. A quota that
counts the caller's rows belongs in the Procedure
([per-caller quotas](../guides/sql-patterns.md#per-caller-quotas-a-handler-answers-429)). Answering a 429 from
`authorize` as 429 would be a small Core change; today it is a 403.

```ts
// src/rate-limit.ts
export async function limited(limiter: RateLimit, key: string): Promise<Response | undefined> {
  const { success } = await limiter.limit({ key });
  if (success) return undefined;
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", path: "" } },
    { status: 429, headers: { "retry-after": "60", "cache-control": "private, no-store" } },
  );
}
```

## User fields

A user field is a value the identity provider verified on the user, such as `region`. It limits rows in two places only:

- A Schema `scope` applies to every SQL relation, Store, REST/MCP and native Admin access: `scope: "region IN auth.user('region')"`. See [Schema](schema.md#field-scope).
- A View or Procedure `restrict` applies to one target: `restrict: { orders: "region IN auth.user('region')" }`. Its terms may be joined by `OR` as well as `AND`; `scope` stays AND-only. See [View](view.md#restrict).

Values come from the verified Better Auth user record. Declare stored fields with `input: false` in `user.additionalFields`, or produce derived fields through `customSession`. Session, OAuth and service credentials read roles, bans and stored fields from the same current database user record; customSession-only fields are refused on OAuth/service paths with `AUTH_CONFIGURATION_ERROR`. `input: false` protects only public endpoints. Anyone permitted to update users can change row-access field values through the admin API; control that authority with Better Auth access control (`user:update`, and `user:set-role` for roles). Store `{ all: true }` in a `json` additional field. Pass the generated `userFields` constant as `resolveCaller(request, auth, { fields: userFields })`.

SQL cannot reference caller values: `auth.user()` fails with `USER_REF_SCOPE_ONLY`, and `auth.hasRole()` / `auth.role()` with `AUTH_ROLE_REMOVED`. Put the term in a `scope` or `restrict` instead; memberships and roles reach them as user fields, never as reads of an auth plugin's tables ([organization members](#organization-members-and-invitations)). Names are literals; Better Auth core fields and names beginning `mantle` are reserved.

Values come from the original frozen Caller, which holds identity in a private WeakMap. Anonymous and copied/unbranded callers have no roles or user fields. Values are validated and frozen: finite numbers, integers when the field scopes an `integer` column; strings of 1–256 UTF-8 bytes without NUL or lone surrogates; arrays of at most 64 items with duplicates removed, only for multi-valued fields. `{ all: true }` is the typed "every value" state of one field; storing it requires a Better Auth additional field of type `json`. Unknown user fields are discarded. A missing or empty value is refused before SQL runs (`UNAUTHENTICATED` for anonymous callers, otherwise `AUTH_DENIED`); it never matches every row. Inside a restrict OR-clause it instead matches no row for that term, so the clause's other terms decide ([creator or organization owner](#creator-or-organization-owner)); a host caller's field that the host did not forward at all is still refused there (`HOST_CONTRACT`, 412), and only a forwarded empty array matches no row. Never mint verified users from request data. Resolve credentials before constructing an identity, and pass the original Caller to generated operations.

### Creator or organization owner

Membership and roles reach row policy as user fields the application maintains; Mantle reads no auth plugin's tables. For "a document is visible to its creator or to an owner of its organization", keep an `ownerOrgIds` field beside the organizations a user belongs to, and OR the two terms:

```yaml
kind: Schema
metadata: { name: documents }
spec:
  title: Documents
  lifecycle: operational
  indexes: [[title, id]]
  schema:
    type: object
    required: [org, title]
    properties: { org: { type: string }, title: { type: string } }
---
kind: View
metadata: { name: my-docs }
spec:
  surface: public
  restrict: { documents: "author_id = auth.uid() OR org IN auth.user('ownerOrgIds')" }
  sql: SELECT id, title, org FROM documents ORDER BY title, id
```

```ts
// auth.ts: a derived field, recomputed on each session read (or a stored additionalFields entry with input: false)
customSession(async ({ user, session }) => ({
  user: { ...user, ownerOrgIds: await ownedOrganizations(user.id) },
  session,
}));
// A handler (or server code) creates a document through the Store, which stamps author_id from the caller.
await store(db, caller).collection("documents").insert({ org, title });
```

- `ownedOrganizations` is the application's own query, for example over the organization plugin's member rows with role `owner`. Which organization a caller may create a document in is the application's check before the insert; a Schema without a field scope does not check `org`.
- Insert through the Store, not an `INSERT` Procedure carrying this `restrict`: on a Schema without a field scope such a Procedure is refused at generation (`USER_FIELD_POSITION`), and with one (`scope: "org IN auth.user('orgIds')"`, which also makes the Store refuse an `org` outside the caller's organizations) it runs only for system callers.
- A creator with an empty `ownerOrgIds` still sees their documents, and so does one whose session has no `ownerOrgIds` at all; a caller who is neither sees none. Under [gateway mode](#gateway-mode) the host forwards `ownerOrgIds: []` for a user who owns nothing: a host that does not forward the field is refused with `HOST_CONTRACT` (412). `{ all: true }` for `ownerOrgIds` is refused with `AUTH_DENIED`: it never lifts a restrict term.
- Put the same `restrict` on the update and delete Procedures: their `UPDATE`/`DELETE` then change only rows the caller may see, and `org` and `author_id` can never be `SET` through them.
- A paged View needs an index on its ordered columns (`[title, id]` here): an OR fixes no index prefix ([index prefixes](schema.md#index-prefixes-for-paged-views)).
- The example is the `documents` part of the SDK's user-fields test application, run on all four targets.

### Organization members and invitations

View SQL reads declared Schemas only, never an auth plugin's tables: those tables belong to one plugin's schema, and an
application behind a gateway has none ([ADR-0046](../../adr/0046-roles-and-user-fields.md#amendment-enforcement-only-2026-10-14):
Mantle enforces rows and does not decide who holds what). To list "members of my organization" with paging, `describe`,
REST and MCP, mirror the membership into a declared Schema scoped by the same user field that carries the caller's
organizations, and keep both current from Better Auth's organization hooks.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: org_members }
spec:
  title: Organization members
  lifecycle: operational
  scope: "orgId IN auth.user('orgIds')"
  uniqueIndexes: [[orgId, entry]]
  indexes: [[orgId, email, id]]
  schema:
    type: object
    required: [orgId, entry, kind, email, role]
    properties:
      orgId: { type: string }
      entry: { type: string }
      kind: { type: string, enum: [member, invitation] }
      email: { type: string }
      name: { type: string }
      role: { type: string }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: organization-members }
spec:
  description: Members and pending invitations of one of your organizations, by email.
  surface: public
  requires: { auth: { all: [ctx.user] } }
  input:
    type: object
    additionalProperties: false
    required: [orgId]
    properties:
      orgId: { type: string }
  sql: |
    SELECT id, kind, email, name, role FROM org_members WHERE orgId = input.orgId ORDER BY email, id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: put-org-entry }
spec:
  description: Mirror one member or invitation. Called by the organization hooks as the system caller.
  input:
    type: object
    additionalProperties: false
    required: [orgId, entry, kind, email, role]
    properties:
      orgId: { type: string }
      entry: { type: string }
      kind: { type: string, enum: [member, invitation] }
      email: { type: string }
      name: { type: string }
      role: { type: string }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO org_members (orgId, entry, kind, email, name, role)
        VALUES (input.orgId, input.entry, input.kind, input.email, input.name, input.role)
        ON CONFLICT (orgId, entry) DO UPDATE SET email = excluded.email, name = excluded.name, role = excluded.role
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: drop-org-entry }
spec:
  description: Remove one mirrored member or invitation. Called by the organization hooks as the system caller.
  input:
    type: object
    additionalProperties: false
    required: [orgId, entry]
    properties:
      orgId: { type: string }
      entry: { type: string }
  output: { type: object }
  handler:
    sql: DELETE FROM org_members WHERE orgId = input.orgId AND entry = input.entry
```

The two Procedures have no `requires` and no Trigger: only application code holding a system Caller calls them. Every
hook rebuilds the organization's rows from the auth tables and recomputes `orgIds` for the users it touched, so the same
function is also the repair:

```ts
// src/org-mirror.ts
import type { OrganizationOptions } from "better-auth/plugins";
import { store } from "../generated/generated.js";
import putEntry from "../generated/procedures/put-org-entry.js";
import dropEntry from "../generated/procedures/drop-org-entry.js";

type Db = Parameters<typeof putEntry>[0];
/** The part of Better Auth's `auth.$context` this reads and writes. */
type AuthTables = {
  adapter: {
    findMany<T>(query: { model: string; where: { field: string; value: string | string[]; operator?: "in" }[] }): Promise<T[]>;
  };
  internalAdapter: { updateUser(id: string, data: { orgIds: string[] }): Promise<unknown> };
};
const system = { kind: "system", reason: "organization mirror" } as const;

export function organizationMirror(db: () => Db, context: () => Promise<AuthTables>) {
  /** Rebuild one organization's `org_members` rows, then the `orgIds` of the users it touched. */
  async function syncOrganization(orgId: string, userIds: readonly string[] = []) {
    const { adapter, internalAdapter } = await context();
    const members = await adapter.findMany<{ userId: string; role: string }>({
      model: "member",
      where: [{ field: "organizationId", value: orgId }],
    });
    const users = members.length
      ? await adapter.findMany<{ id: string; email: string; name: string }>({
          model: "user",
          where: [{ field: "id", operator: "in", value: members.map(member => member.userId) }],
        })
      : [];
    const invitations = await adapter.findMany<{ id: string; email: string; role: string }>({
      model: "invitation",
      where: [
        { field: "organizationId", value: orgId },
        { field: "status", value: "pending" },
      ],
    });
    const entries = [
      ...members.flatMap(member => {
        const user = users.find(user => user.id === member.userId);
        return user ? [{ entry: `member:${user.id}`, kind: "member" as const, email: user.email, name: user.name, role: member.role }] : [];
      }),
      ...invitations.map(invitation => ({
        entry: `invitation:${invitation.id}`, kind: "invitation" as const, email: invitation.email, name: "", role: invitation.role,
      })),
    ];
    for (const entry of entries) await putEntry(db(), system, { orgId, ...entry });
    const { rows } = await store(db(), system).collection("org_members").find({ where: { orgid: orgId }, limit: 500 });
    for (const row of rows)
      if (!entries.some(entry => entry.entry === row.entry)) await dropEntry(db(), system, { orgId, entry: row.entry });
    for (const userId of userIds) {
      const memberships = await adapter.findMany<{ organizationId: string }>({
        model: "member",
        where: [{ field: "userId", value: userId }],
      });
      await internalAdapter.updateUser(userId, { orgIds: memberships.map(member => member.organizationId) });
    }
  }
  const leaving = new Map<string, string[]>();
  const hooks: OrganizationOptions["organizationHooks"] = {
    afterAddMember: ({ organization, user }) => syncOrganization(organization.id, [user.id]),
    afterRemoveMember: ({ organization, user }) => syncOrganization(organization.id, [user.id]),
    afterUpdateMemberRole: ({ organization }) => syncOrganization(organization.id),
    afterCreateInvitation: ({ organization }) => syncOrganization(organization.id),
    afterAcceptInvitation: ({ organization, user }) => syncOrganization(organization.id, [user.id]),
    afterRejectInvitation: ({ organization }) => syncOrganization(organization.id),
    afterCancelInvitation: ({ organization }) => syncOrganization(organization.id),
    beforeDeleteOrganization: async ({ organization }) => {
      const { adapter } = await context();
      const members = await adapter.findMany<{ userId: string }>({
        model: "member",
        where: [{ field: "organizationId", value: organization.id }],
      });
      leaving.set(organization.id, members.map(member => member.userId));
    },
    afterDeleteOrganization: async ({ organization }) => {
      await syncOrganization(organization.id, leaving.get(organization.id));
      leaving.delete(organization.id);
    },
  };
  return { hooks, syncOrganization };
}
```

```ts
// src/auth.ts (the parts this adds)
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { d1Adapter } from "@aotter/mantle/auth/adapter";
import { organizationMirror } from "./org-mirror.js";

export function createAuth(env: { DB: D1Database }) {
  const mirror = organizationMirror(() => env.DB, () => auth.$context);
  const auth = betterAuth({
    database: d1Adapter(env.DB),
    user: { additionalFields: { orgIds: { type: "string[]", required: false, input: false } } },
    plugins: [organization({ organizationHooks: mirror.hooks })],
  });
  return auth;
}
```

`orgIds` is a stored user field (`input: false`), so `resolveCaller(request, auth, { fields: userFields })` reads it from
the current user record on every request, for sessions and OAuth alike: a member removed from an organization stops
seeing its rows on their next request. A user in no organization has an empty `orgIds`, which is refused
(`AUTH_DENIED`) before SQL runs. `GET /api/views/organization-members?orgId=…` pages by `(email, id)`; an `orgId` the
caller does not belong to returns no rows.

**Consistency.** Better Auth writes its tables first and calls the hook after; the two are not one transaction. When the
mirror write fails, the hook rejects, the auth endpoint answers 500, and the membership change stays committed while the
mirror and `orgIds` keep their previous state. The next hook for that organization rebuilds it; to repair without
waiting, run `syncOrganization(orgId, userIds)` from a scheduled job or an admin action. Email and name are copies,
current as of the last sync. Each sync costs one write per member and invitation, bounded by the plugin's
`membershipLimit` and `invitationLimit` (and the single page of 500 above).

For one or two listings, a ref Procedure with `spec.db: native` can read the plugin's tables with the native handle
instead, filtering by `caller.subject` itself: no mirror and no lag, but no row policy either, and it works only where
those tables exist (not behind a gateway).

## Gateway mode

Selected `rest`, `mcp`, `admin` and `web` boundaries accept `gateway: { tenant: "example" }`. Forward the execution context: `api(request, env, ctx)` from `fetch(request, env, ctx)`. Set gateway mode on every boundary of the application, including web output (`web.fetch(request, env, ctx)` and `web.head(request, env, ctx)`). Only `ctx.props.mantle` supplies identity; absent props are anonymous. Application cookies and bearer tokens are ignored, and the application's auth instance is never loaded. Present `props.mantle` prevents falling back to application credentials. `props.mantle` on an entry without gateway mode fails with `HOST_CONTRACT` (412); the string-returning `web.head` throws this contract error. `web.head(request, env, ctx, { row })` formats the row the application already read: it reads no View and makes no caller or gateway decision, so it does not refuse.

The v1 props contain `v: 1`, the configured `tenant`, `layer` (`admin` or `member`), `user` (`id`, optional `role` and declared user fields), `authenticatedAs` (`snapshot` or `fresh`), `credential` (`session` or `oauth`) and `requestId`. `target` and `targetHash` are required for admin callers and optional for members. The boolean `dryRun` is an optional forwarding control. `hostCaller(props, { tenant, fields })` from `@aotter/mantle/host-caller` validates and brands this shape. Generated boundaries supply inferred field types; manually composed boundaries may pass `fields`. Tests call `hostCaller(props, { tenant, fields })` with the same JSON.

Admin-layer callers have kind `host`, subject `host:<id>` and the admin layer. Member-layer callers have kind `user`, subject `<id>` and no admin privilege, regardless of role names. Both retain ordinary scope checks and expose freshness, credential and request id to application code. Admin-layer callers see drafts; member management refuses host-built callers with 403 because gateway-mode applications load no Better Auth instance. Copies lose identity authority.

Snapshots may read only: SQL writes, Store/Admin mutations, publishing transitions and ref handlers fail before execution with `STALE_CALLER` (403). Boundary read classification comes from describe’s generated `_meta.readOnly`; generated SQL and Store writes retain their own freshness checks. Session writes keep origin checks. Both layers receive `{ error: { code, field?, target? } }`: 412 for invalid contracts, tenant mismatches or missing/empty required fields (naming the field; inside a restrict OR-clause only a field the host did not forward, since a forwarded `[]` there matches no row), 403 for denials, and 400 for malformed bodies; never 401. MCP tool failures use the SDK error result with the same error fields.

Pins use [describe](describe.md)'s `_meta.id`: `rest:<METHOD> <path>`, `admin:<METHOD> <path template>`, or the View/Procedure target for MCP and web. The route checks `target` and the generated target hash before execution: mismatches return 412 `TARGET_MISMATCH` or `TARGET_HASH_MISMATCH`. The generated `access-targets.ts` map loads only for gateway requests. Manually composed boundaries can supply an `accessTargets` loader returning the same metadata.

A gateway computes the pin from the request with [`matchTarget(describe, request)`](describe.md#matching-a-request-to-its-target), which applies the routers' own path normalisation, `HEAD` handling, Admin mount and precedence to the saved `mantle describe` JSON. It returns the target's `_meta`, including `targetHash` and the `readOnly` flag that the freshness rule reads, or `null` when the application serves no such route or tool.

MCP host callers forward one request in protocol revision 2026-07-28: `server/discover` (pinned to a mounted tool) or `tools/call` of their pinned tool. Batches stay refused, `tools/list` and `resources/*` return 403 because the host provides its catalogue, and a 2025-era message (an `initialize`, or one without the `_meta` envelope) is answered with HTTP 400 and JSON-RPC `-32022`. See [Forwarding MCP requests](#forwarding-mcp-requests).

### Forwarding MCP requests

Core serves MCP protocol revision 2026-07-28 only. A forwarded MCP request is one JSON-RPC message, not a batch,
whose `params._meta` carries `io.modelcontextprotocol/protocolVersion` (`"2026-07-28"`),
`io.modelcontextprotocol/clientCapabilities` (the capabilities the host declares; include
`extensions["io.modelcontextprotocol/ui"].mimeTypes: ["text/html;profile=mcp-app"]` for MCP App metadata) and,
optionally, `io.modelcontextprotocol/clientInfo`, with headers that state the same: `MCP-Protocol-Version`,
`Mcp-Method` and, for `tools/call`, `Mcp-Name` (the tool name). There is no `initialize` and no session: send
`tools/call` directly, or `server/discover` for the server's capabilities. A host that forwarded the 2025-era form
before must change it; Core answers that form with HTTP 400 and JSON-RPC `-32022` whose `data.supported` is
`["2026-07-28"]`, and records the request as refused (`INPUT_VALIDATION_FAILED`, status 400) in its access event.

Before (2025-era, refused now):

```http
POST /mcp/admin HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"approve_request","arguments":{"id":"r1"}}}
```

After (2026-07-28):

```http
POST /mcp/admin HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: approve_request

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"approve_request","arguments":{"id":"r1"},
 "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
```

`ctx.props.mantle` is unchanged. A result is answered as JSON, or as an SSE stream once the call sends progress;
it carries `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`. A `tools/call` of an App-only
tool (`_meta.ui.visibility` without `"model"`), such as an MCP App's own call the host forwards, runs with the
`clientCapabilities: {}` above: visibility hides a tool only from `tools/list`, and the tool's own authorization
decides the call. Declare the `io.modelcontextprotocol/ui` extension when the result should carry App metadata. A
call whose host request ends before the tool settles records `outcome: "error"` with reason `REQUEST_CANCELLED` in
its access event at that moment, also on Workers; a tool that ignores the signal and finishes later does not change
it.

`dryRun: true` runs target/hash checks, input validation, generated caller checks, `authorize` and freshness, without SQL or side effects. It returns 200 `{ dryRun: true, event }`; MCP carries this result in the SDK tool response. Ref handlers, custom guards, uploads and opaque work return 412 `DRY_RUN_UNSUPPORTED`. Dry runs validate authority and input; they do not verify database state, row existence or OCC conflicts.

Each boundary accepts `onAccess(event)`. Every forwarded request, including malformed contracts and denied requests in either layer, produces one event after its decision. Responses never await the hook; listener failures are swallowed and logged once per listener. Ordinary applications do not invoke it. The event is:

```ts
{ v: 1, requestId, target, targetHash,
  caller: { kind, subject, layer },
  outcome: "allow" | "deny" | "error", reason?, field?,
  dryRun }
```

`reason` is the error code. A successful dry run returns the same event the hook receives.
