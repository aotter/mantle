---
description: Schema, View, Procedure and Trigger — what each atom owns, why reads and writes are asymmetric, and how to compose everything else from four kinds.
---
# The four atoms

A Mantle Manifest declares exactly four resource kinds under the `cms.mantle.aotter.net/v1` API group. This page explains what each atom owns, how they compose, and how to decide where a new feature belongs. Field-level rules live in the [Reference](../reference/manifest.md) section.

## The four kinds

They map one-to-one onto the primitives Postgres has shipped for thirty years.

| Atom | Postgres equivalent | Externally exposed by itself? | Has user code? |
|---|---|---|---|
| `Schema` | `CREATE TABLE` | No. Reached only through a View or a Procedure. | No |
| `View` | `CREATE VIEW` | Yes. Auto-mounted on its declared `public` or `staff` REST and MCP surface. | No |
| `Procedure` | `CREATE FUNCTION` | No. Transport-agnostic; needs a Trigger to gain a surface. | Yes — a handler in your project's registry. |
| `Trigger` | `CREATE TRIGGER` plus route and tool binding | Yes. It is the binding atom. | No |

A four-word gloss covers most questions: Schema is state, View is the read API, Procedure is the write API, Trigger is the binding.

## Reads and writes are asymmetric on purpose

Views mount themselves; Procedures do not. That asymmetry matches HTTP safe-versus-unsafe semantics. A View is a named, read-only query: idempotent, cacheable, and safe to expose the moment its `surface` is declared. A Procedure changes state, so its path, method, tool name and authorization are decisions an author must make explicitly, one Trigger at a time. There is no `Schema.spec.expose.rest` switch and no `/api/<collection>` shortcut; exposing collections directly was considered and rejected, because a Schema stores drafts, server-stamped fields and rows the author never meant to publish.

The consequence for authors: a Procedure that has no Trigger is unreachable from outside the runtime, and calling its name as a URL returns `404`.

## The composition rule

Anything more domain-shaped than these four is not an atom. A Form, Membership, Email, Webhook, Workflow or ScheduledJob is a composition of Schemas, Views, Procedures and Triggers plus your own TypeScript. An earlier iteration of this grammar shipped eleven domain-shaped kinds; authors could not decide whether a contact form was a Form, a Workflow or an Email, and each kind grew to subsume its neighbors.

If you find yourself wanting a fifth kind, sketch the same thing as a composition of the four first. Almost always it works.

## The Manifest envelope

Every document carries the same four top-level keys. Unknown keys at any known level are rejected with `INVALID_MANIFEST_ENVELOPE`.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema | View | Procedure | Trigger
metadata:
  name: posts
spec: {}
```

There is no `namespace` field. Names are unique within a kind, so a Schema and a View may share a name; two Schemas may not. Multi-tenancy belongs in your application layer, not in manifest metadata.

One feature usually needs several atoms, so YAML's `---` separator keeps the file count down. Core reads every immediate `.yaml` and `.yml` file in the manifest directory and parses each document independently:

```yaml
# manifests/contact.yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: send-contact-message
spec:
  input:
    type: object
    additionalProperties: false
    required: [name, message]
    properties:
      name: { type: string, minLength: 1, maxLength: 80 }
      message: { type: string, minLength: 1, maxLength: 4000 }
  output: { type: object }
  handler: { kind: ref, ref: send-contact-message }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: contact-http
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: send-contact-message }
```

Parsing is all-or-nothing: one error in one document means no `ParsedManifestSet` at all.

## Schema — the entity

A Schema declares one collection: the JSON Schema for each entry's `data`, its indexes, its Admin presentation and its [lifecycle mode](./lifecycle-and-locales.md). Entries also carry the native columns `id`, `status`, `version`, `createdAt`, `updatedAt` and `authorId` outside `data`.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: notes
spec:
  title: Notes
  lifecycle: publishing
  schema:
    type: object
    additionalProperties: false
    required: [title, body]
    properties:
      title: { type: string, minLength: 1, maxLength: 200 }
      body: { type: string, x-mcp-hint: markdown }
  searchableFields: [title]
```

Full field rules, the JSON Schema subset and the `x-mantle-bind` / `x-mantle-ref` / `x-mcp-hint` keywords are in the [Schema reference](../reference/schema.md).

## View — the read surface

A View is a named read-only query over Schemas, mounted on exactly one surface. No Trigger is involved.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: published-notes
spec:
  title: Published notes
  surface: public
  from: notes
  fields: [id, title, updatedAt]
  filter:
    eq: { field: status, value: published }
  orderBy:
    - { field: updatedAt, direction: desc }
  limit: 20
```

`surface: public` serves `GET /api/views/published-notes` and the `query_view_published_notes` MCP tool on `/mcp`; `surface: staff` moves both behind the staff gate. See [Reads: Views, REST and MCP](./views.md) and the [View reference](../reference/view.md).

## Procedure — the typed callable

A Procedure declares typed `input`, typed `output`, optional `requires`, and one `handler`. It is the only atom with a code seam. The handler is either `kind: builtin` — a CRUD shortcut over one Schema — or `kind: ref`, an opaque key into the `handlers` map your project registers.

```yaml
spec:
  handler: { kind: builtin, op: create, schema: notes }
```

Builtin ops are `create`, `update`, `upsert`, `delete` and `archive`. `request_publish` and `publish` are deliberately absent: they are lifecycle operations, not CRUD primitives. See [Writes: Procedures, Triggers and lifecycle hooks](./procedures-and-triggers.md) and the [Procedure reference](../reference/procedure.md).

## Trigger — the binding

A Trigger says "when X happens, run Procedure Y". Its `source` is one of three kinds, and its `target.procedure` names a declared Procedure.

```yaml
spec:
  source: { kind: http, method: POST, path: /api/contact }
  # or: { kind: mcp, surface: public }
  # or: { kind: lifecycle, schema: notes, on: [before_create] }
  target: { procedure: send-contact-message }
```

Several Triggers may target one Procedure, which is how the same handler becomes an HTTP endpoint, an MCP tool and a lifecycle hook without duplicated logic. Adding a transport is additive; the Procedure never changes. See the [Trigger reference](../reference/trigger.md).

## How to think when extending

1. **What entities does the feature need?** One `Schema` each.
2. **What named queries?** One `View` each. Ad-hoc reads stay inside handler code; only sanctioned queries become Views, because a View is an external read endpoint.
3. **What operations?** One `Procedure` each. One Procedure equals one typed function call. Compose in handler code, not in YAML.
4. **What invokes them?** One `Trigger` per declared HTTP, MCP or lifecycle source.
5. **Who is allowed?** `requires.auth` for static identity and scope, plus one optional `requires.guard.procedure` for a live business check. See [Authorization](./authorization.md).

## The Postgres heuristic

When you are unsure whether something deserves to be an atom, ask what it would be in Postgres.

- If it is a `CREATE X` an **application developer** writes — `TABLE`, `VIEW`, `FUNCTION`, `TRIGGER` — it maps to one of the four.
- If it is a `CREATE X` Postgres only needs because it is a database engine — `INDEX`, `MATERIALIZED VIEW`, `TABLESPACE`, `STATISTICS`, `EVENT TRIGGER`, `EXTENSION`, `LANGUAGE`, `PUBLICATION`, `FOREIGN TABLE`, `RULE` — it does not map, and it belongs behind the storage adapter.
- If it is a type-system extension — `TYPE`, `DOMAIN`, `SEQUENCE`, `COLLATION`, `CAST`, `AGGREGATE`, `OPERATOR` — it folds into the JSON Schema inside a `Schema`.

Postgres exposes roughly twenty-five object kinds; an application developer writes four to six of them. That is the same ratio Mantle ships.

## Source

- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
- [`docs/adr/0001-four-atom-manifest-model.md`](../../../docs/adr/0001-four-atom-manifest-model.md)
- [`docs/adr/0012-views-as-public-rest.md`](../../../docs/adr/0012-views-as-public-rest.md)
- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`skills/develop/SKILL.md`](../../../skills/develop/SKILL.md)
