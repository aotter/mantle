---
description: Choose between publishing and operational Schemas, and understand how site locales, localized Schemas and translation children fit together.
---
# Lifecycle and locales

Two per-Schema decisions shape how an entry behaves for its whole life: which state machine it follows, and whether it carries a locale. Both are declared on the [Schema](../reference/schema.md); neither is a site-wide setting.

## Publishing versus operational

`spec.lifecycle` is `publishing` (the default) or `operational`. The modes mix freely inside one site.

**`publishing`** is for content a person stages and then releases: posts, pages, announcements, product copy. The point of the mode is that a draft exists and is not readable by the public until someone publishes it.

**`operational`** is for records written as a side effect rather than drafted: submissions, inquiries, orders, inventory snapshots, grant and audit rows. The point of the mode is that the row is real the moment it is created. Declare it on any Schema whose rows a human should inspect and correct, never stage and publish.

| `publishing` — from | To |
|---|---|
| `draft` | `published`, `archived` |
| `published` | `archived`, `draft` |
| `archived` | `draft` |

| `operational` | Behavior |
|---|---|
| On create | `status: published` immediately |
| Editing | In place, in any status |
| Transitions | None. Publish, unpublish and archive all reject. |

Any transition the machine does not allow returns `CONFLICT` (HTTP 409). That includes every transition request against an operational Schema, and deleting a `published` entry of a publishing Schema — unpublish it first. Operational entries can be deleted in any status. A builtin `archive` Procedure may only target a publishing Schema.

`status: published` on an operational row is not a grant of public read access. Reads are still authorized by the [View](./views.md) that exposes them.

### What each surface shows

| Surface | `publishing` | `operational` |
|---|---|---|
| Admin | Draft and published buckets, publish and unpublish controls, archive | Flat list, no lifecycle chrome; `uiSchema.list` supplies the columns |
| Staff MCP | `create_draft_<schema>`, `update_draft_<schema>` | `create_record_<schema>`, `update_record_<schema>` |
| Staff MCP, both modes | `list_entries`, `get_entry`, `request_publish`, `unpublish_entry`, `archive_entry`, `delete_entry` | same generic tools |

### Procedure-managed collections

Root `schema.readOnly: true` marks a collection whose authority lives in its declared Procedures, not in generic authoring. Staff MCP emits no `create_*` or `update_*` tool for it, and Admin's generic create, update, status change and delete return `CONFLICT` with a message saying the Schema is read-only on generic authoring surfaces. List and detail access, and every declared Procedure, keep working. Use it for operational mirrors, projections and audit rows.

## Locales in three layers

Localization is not one switch. Three independent layers have to agree.

| Layer | Where | What it decides |
|---|---|---|
| `Schema.spec.localized` | Manifest | Whether rows of this collection may carry `data.locale` |
| `site_config.locales` | Adapter `siteDefaults.locales`, boot-synced into the `site_config` row | Which locale tags exist for this deployment; the first entry is the canonical locale |
| `data.locale` | The entry | Which locale this particular row is |

`siteDefaults.locales` is code-owned: Core rewrites the stored row at boot whenever the declared list differs, so the code stays canonical. Brand, title and description seed once and are then edited through site settings. See [Site defaults and site_config](../reference/site-config.md).

### Canonical tags

Mantle accepts a deliberately narrow subset of BCP 47: a two- or three-letter language, plus an optional two-letter region. Mixed spellings are canonicalized, so `zh-tw`, `ZH_TW` and `zhTW` all become `zh-TW`, and the list is deduplicated in place. Anything else fails at boot with `InvalidSiteDefaultsError`.

> **Script subtags are unsupported**
> `zh-Hant`, `zh-Hans`, `sr-Latn` and `sr-Cyrl` are valid BCP 47 but rejected in this version. Use region tags: `zh-TW` for Traditional Chinese, `zh-CN` for Simplified.

### The write-time gate

Every authoring path — Admin, Staff MCP and builtin Procedures — runs the same guard, per request, against the current site locales.

| Condition | Result |
|---|---|
| Non-localized Schema, `data.locale` present | `INPUT_VALIDATION_FAILED` |
| Localized Schema, `data.locale` missing or empty | `INPUT_VALIDATION_FAILED`, skipped for partial draft saves |
| Localized Schema, `data.locale` not in the site locales | `INPUT_VALIDATION_FAILED`, with the enabled locales as candidates |
| Site locales list is empty | Membership is not checked |

`locale` is a reserved data field. A non-localized Schema that declares it is rejected outright; when such a Schema genuinely needs a language value, name it after its domain meaning — `replyLocale` on a support ticket, `orderLocale` on an order — and validate it with an `enum` like any other field.

### Boot checks versus per-request resolution

Boot validates shape only: the locale tags canonicalize, every `translates` reference resolves, and a `localized: true` Schema has at least one site locale (`SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES`). The active locale set is read from `site_config` per request, so changing the list does not require a redeploy of the manifest — but it does require the code-owned `siteDefaults` to agree, because boot resynchronizes the row.

## Versions of one entity versus independent rows

Two shapes are legal, and the choice is about identity, not about language count.

**A standalone localized Schema** treats each locale row as an independent record. Use it when nothing is shared between languages except a naming convention. A blog whose translations are independent posts does this: one localized `posts` Schema with `uniqueIndexes: [[slug, locale]]`.

**A non-localized parent plus a localized `translates` child** treats locale rows as versions of one entity. Use it when several rows describe the same thing and editors need to see which languages are missing. Only this shape powers Admin's translation grouping and completeness; Admin renders the child as locale tabs inside the parent's editor rather than as its own collection.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: products
spec:
  title: Products
  localized: false
  lifecycle: publishing
  uniqueIndexes: [[sku]]
  schema:
    type: object
    additionalProperties: false
    required: [sku, priceMinor]
    properties:
      sku: { type: string, pattern: "^[A-Z0-9-]+$" }
      priceMinor: { type: integer, x-mcp-hint: money-minor }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: product-translations
spec:
  title: Product translations
  localized: true
  translates: { parent: products, on: sku }
  lifecycle: publishing
  uniqueIndexes: [[sku, locale]]
  indexes: [[locale, sku]]
  schema:
    type: object
    additionalProperties: false
    required: [sku, name]
    properties:
      sku: { type: string, pattern: "^[A-Z0-9-]+$" }
      locale: { type: string }
      name: { type: string, minLength: 1 }
      summary: { type: string, x-mcp-hint: markdown }
```

The parent holds what every language shares and stays non-localized. The child sets `localized: true`, declares `locale` without listing it in `required` — the write-time gate enforces presence — and owns at least one content field besides the join field and `locale`. A parent that is itself localized, a missing join field on either side, or a child with no content field are all rejected at parse or validate time; the codes are listed in the [Schema reference](../reference/schema.md#translates).

When you keep parallel locale rows in step, translate display strings only. Field names, option values, step identifiers and result keys must stay identical across locales, or the same View and the same MCP tool stop describing the same thing.

The full worked version of this pattern, with a locale-parameterized public View and its REST response, is [Publication](../examples/publication.md).

## Source

- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
- [`packages/mantle-spec/src/domain/service/LifecycleStateMachine.ts`](../../../packages/mantle-spec/src/domain/service/LifecycleStateMachine.ts)
- [`packages/mantle-spec/src/domain/service/LocaleCanonicalizer.ts`](../../../packages/mantle-spec/src/domain/service/LocaleCanonicalizer.ts)
- [`packages/mantle-spec/src/domain/service/SiteDefaultsValidator.ts`](../../../packages/mantle-spec/src/domain/service/SiteDefaultsValidator.ts)
- [`packages/mantle-spec/src/domain/model/SiteConfig.ts`](../../../packages/mantle-spec/src/domain/model/SiteConfig.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts)
- [`packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts`](../../../packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts)
- [`skills/develop/SKILL.md`](../../../skills/develop/SKILL.md)
