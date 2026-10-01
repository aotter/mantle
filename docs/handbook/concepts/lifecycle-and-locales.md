---
description: Publishing and operational Schemas, the draft-publish-archive rules Store enforces, TTL expiry, and localized Schemas in Mantle 0.2.0.
---
# Lifecycle and locales

## Two lifecycles

A Schema's `lifecycle` decides how its rows move. The default is
`publishing`.

| | `publishing` | `operational` |
|---|---|---|
| For | authored content: posts, products, legal text | records written by Procedures: orders, requests, audit rows |
| A new row | is a `draft`, saved even when incomplete | is `published` (live) at once, validated in full |
| Editing | only drafts are editable; a published row is protected | rows edit in place |
| Statuses | `draft` → `published` → `archived`, `published` → `draft` (unpublish), `archived` → `draft` | always `published` |
| Public Views | see published rows only | see every row |
| Set ops | refused (every write pins one row) | allowed |

One domain service, the lifecycle state machine inside Store, enforces these
rules for every path: SQL Procedures, `ctx.store`, Admin and imports.
Publishing a row needs its required fields complete, and publishing a
translation needs its parent published first.

**SQL cannot set `status`.** A write that names it is refused. Status moves
through:

- Admin's API: `POST /admin/api/entries/{id}/publish` and `/unpublish`;
- a `ref` handler: `ctx.store.write([{ update: "posts", set: { status: "archived" }, where: { id }, lock }])`.

## TTL

```yaml
spec:
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    properties:
      expiresAt: { type: string, format: date-time }
```

A row expires `expireAfterSeconds` after the time in `field`, a top-level
`date-time` field. Expiry is logical: every read and write, `runtime.store`
included, treats an expired row as absent. Removing the rows is a separate,
host-only step:

```ts
await runtime.store.sweepExpired({ collection: "sessions", limit: 500 }); // { scanned, removed, nextCursor? }
```

Run it from a schedule Trigger's `ref` handler, or from your own maintenance
code. `delete: false` counts without deleting. A translation Schema may not
declare `ttl`.

## Localized Schemas

`localized: true` marks a Schema whose rows carry a `locale` field; a
non-localized Schema may not declare a field named `locale`.

```yaml
kind: Schema
metadata: { name: post-translations }
spec:
  localized: true
  translates: { parent: posts, on: slug }
  uniqueIndexes: [[slug, locale]]
```

`translates` makes the Schema the localized child of a non-localized parent,
joined on a field both declare. It needs `localized: true`, at least one
content field besides the join field and `locale`, and a parent that exists
and is not localized. Admin groups translations under their parent, and
publishing a translation needs its parent published.

In 0.2.0, `locale` is a plain string field: Store does not check it against the
site's locales, and no surface resolves a request's locale or falls back to a
default one. A View takes the locale as `input` (see
[Publication](../../examples/publication.md)); fallback is the reader's code.

Manifest text (`title`, `description`) may be a locale map,
`{ en: Products, zh-TW: 商品 }`. Admin and MCP pick the viewer's locale, then
`en`, then the first entry.

## Further reading

- [Schema reference](../reference/schema.md)
- [Site defaults and site_config](../reference/site-config.md): the site's
  `locales` list
