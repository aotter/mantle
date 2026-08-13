# ADR-0010: Locale three-layer model and parent/child translates pattern

**Status:** Carried over from POC v0.0.x; refreshed for v0.1.0.

**Date**: 2026-05-01 (POC) / refreshed 2026-05-03 (v0.1.0 rebuild)

**Deciders**: phsu

**Related**: [ADR-0001](0001-four-atom-manifest-model.md) (the Schema atom this extends; §"Future grammar discipline" covers the v0.1-vs-DRAFT window this lands in).

---

## Context

Pre-v0.1 prototypes shipped with `entries.locale TEXT NOT NULL` as a
top-level column in the D1 schema, and `locale` as a required argument
across the MCP handler API (`createDraft`, `updateDraft`, `listEntries`,
`getEntry`). Every entry in every collection had to declare a locale.

This is wrong by overspecification. The data sorts into three buckets:

| Type | Examples | Should require locale? |
|---|---|---|
| Language-independent | tags, categories, settings, asset metadata, numeric config | No — forced locale tagging is a semantic error |
| Language-dependent | blog posts, product descriptions, UI strings | Yes |
| Mixed | e-commerce items where price/SKU don't translate but title/description do | Neither single-locale nor full-locale; needs decomposition |

The legacy model forced bucket-1 content to either pretend to be in
the site's primary language or to invent a sentinel ("und"). It
forced bucket-3 content into either a single bloated Schema with
field-level translation flags, or a dual-write hack where translatable
fields got duplicated per locale inside the same row. Neither path is
clean, neither scales to "AI agent writes the manifest from a
description."

A second wrong default lived in the install brief: it pre-filled
`'en'` as the default locale. This biases the SDK toward "an
English-first product translated to other languages," which is
incompatible with the stated positioning of "MCP-native CMS for
multi-locale content serving worldwide." A user whose primary content
is in `zh-TW` shouldn't have to override an `en` default that's there
because of unconscious template bias.

A third wrong default: locale concerns were baked into the SDK
whether or not the consumer needed them. A single-author single-language
site shouldn't have a `locale` column it must populate, a `locale`
MCP arg it must pass, or a locale picker in the admin UI it never
uses. Locale should be opt-in at every layer.

## Decision

Locale is modeled in three explicit layers. Each layer is opt-in;
when no layer opts in, the entire locale subsystem is invisible.

### Layer 1 — Manifest declaration (`Schema.spec.localized`)

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  localized: true    # this collection's entries carry a locale
  schema: { ... }
```

`Schema.spec.localized?: boolean` (default `false`) is the per-Schema
opt-in. Default false is deliberate — if the author doesn't say
"localized," the Schema is treated as language-independent. This
matches the principle that locale is opt-in.

The boot validator only inspects the manifest at this layer. It
checks shape (every `localized: true` Schema is well-formed, every
`translates:` block resolves) and rejects DRAFT keys; it does **not**
read D1 to confirm that the site actually has any locales configured.
That cross-check is deferred to runtime (Layer 3).

### Layer 2 — Per-site D1 row (`site_config.locales`)

```jsonc
// site_config row
{ "key": "locales", "value": "zh-TW,en,ja" }   // ordered; first is canonical
```

- Stored in `site_config` keyed by `locales` (small key/value table,
  not a separate locales table).
- Empty / absent = locale subsystem off site-wide. Any localized read
  or write fails with a structured `INVALID_LOCALE` diagnostic
  pointing at `site_config.locales`.
- `locales[0]` is the canonical/preferred locale, used as the
  fallback hint when a localized lookup misses. Whether the runtime
  *automatically* falls back is up to the View executor; v0.1.x ships
  strict (no auto-fallback) and exposes the canonical hint via the
  site-config accessor for application code to use.

#### Seeding via `CmsConfig.siteDefaults` (v0.1.0)

The v0.1.0 way to populate `site_config.locales` on first deploy is
the `CmsConfig.siteDefaults` declarative seed. The consumer's
`CmsConfig` carries an optional block:

```ts
{
  siteDefaults: {
    locales: ['zh-TW', 'en'],
    brand:   'My Site',
    title:   'My Site — blog',
  }
}
```

`createCmsRuntime(...).bootInit()` calls the site-config repository's
seed path. That path runs `assertSiteDefaultsCanonical(siteDefaults)`
(BCP 47 canonicalization of every declared locale; throws
`InvalidSiteDefaultsError` if any tag is malformed) and writes the seed via
`INSERT INTO site_config (...) VALUES (...) ON CONFLICT(key) DO NOTHING`
— idempotent, so re-deploys never clobber values an operator has
edited via the admin Settings page.

This replaces an earlier prototype where the install brief had to
prompt for locales and write them imperatively; declarative seed +
canonicalize-on-write keeps the cold-start path free of ceremony and
lets the manifest, the CmsConfig, and the D1 row drift apart safely
(the runtime gate in Layer 3 is what reconciles them).

### Layer 3 — Per-entry data (`data.locale`)

```jsonc
// entries.data for a localized Schema
{ "title": "...", "body": "...", "locale": "zh-TW" }

// entries.data for a non-localized Schema
{ "name": "...", "color": "..." }   // no locale field
```

- There is no top-level `entries.locale` column. Locale lives inside
  the `data` JSON.
- The runtime locale gate (in `mantle-runtime`'s content-ops
  `helpers.ts`) is the **authoritative per-request check**. On every
  read and write the gate validates:
  - `localized: true` Schema → `data.locale` MUST be present, MUST
    canonicalize via the BCP 47 helper, AND MUST be a member of
    `site_config.locales`. Any failure surfaces as
    `INPUT_VALIDATION_FAILED` (or `INVALID_LOCALE` for canonicalization
    failure) with a path of `data.locale`.
  - `localized: false` Schema → `data.locale` MUST be absent
    (`null` is treated as absent and stripped on the read path; any
    other value is rejected to catch typos like `locaIe: en`).
- Indexed via virtual generated column + partial unique index on
  `json_extract(data, '$.locale')`, scoped to the Schema's
  `collection`. Same pattern as `Schema.spec.unique`. Created only
  for localized Schemas; non-localized Schemas have no locale index.

The boot/runtime split is the load-bearing change carried over from
the POC's issue #60 fix (POC PR #71, plus the canonicalize follow-up
from that PR's code review). Boot is for **manifest shape**, runtime
is for **D1 state**. `bootInit` no longer reads `site_config` to
gate manifest acceptance; that coupling caused a chicken-and-egg
problem on first deploy where a manifest declaring `localized: true`
couldn't be loaded until D1 was already seeded, but seeding required
the SDK to be running. The runtime gate in `helpers.ts` does the
real work — it sees both the manifest and the live D1 row at every
request — and the `siteDefaults` seed pre-populates D1 without
requiring the operator to do it manually.

### Canonicalization

Mantle v0.1 accepts a narrow locale subset: **2/3-letter language,
optionally followed by a 2-letter region**. Canonical form is language
case-folded, region uppercased: `en-US`, `zh-TW`, `pt-BR`. The runtime
accepts any case on input (`en-us`, `EN-US`, `en-US` all match) but
stores and compares canonically.

Script subtags are intentionally out of scope for v0.1 even though they
are valid BCP 47. Do not configure `zh-Hant`, `zh-Hans`, `sr-Latn`, or
`sr-Cyrl`; use the region form instead (`zh-TW` for Traditional
Chinese, `zh-CN` for Simplified Chinese, and the relevant region tag for
other languages). Widening to full BCP 47 requires URL routing,
locale-negotiation, and matching semantics to grow together.

- The URL-form locale (e.g. on a `/zh-tw/posts/...` path) is lowercased
  for cosmetics; the canonical storage form is `zh-TW`. Render-side
  helpers convert between the two. Manifest, CmsConfig, and D1 storage
  always use the canonical form.
- `data.locale: 'en-US'` when the site declares `'en'` is a strict
  miss — `en-US` ≠ `en`. A site author who wants both writes both
  into `siteDefaults.locales` (and therefore `site_config.locales`).
  No magic broadening.
- Locale lives **inside `data`** rather than as a top-level column
  precisely because canonicalization is a runtime concern. A column
  would either need a CHECK constraint (which D1 can't enforce
  against a moving target like a `site_config` row) or trust the
  writer to canonicalize, which gets out of sync the moment a
  non-SDK writer touches the table. Inside `data`, the gate
  re-canonicalizes on every read/write and the storage shape stays
  honest about who owns the invariant.

### Parent/child translates pattern

When a domain has both translatable and non-translatable fields
(e.g., a product with non-translatable SKU/price and translatable
title/description), the model is **two Schemas joined by a shared
key**, not a single Schema with field-level translation flags.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec:
  title: Products
  localized: false
  schema:
    type: object
    properties:
      slug: { type: string }
      sku:  { type: string }
      price: { type: number }
    required: [slug, sku, price]
  uniqueIndexes: [[slug]]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: product-translations }
spec:
  title: Product translations
  localized: true
  translates:
    parent: products
    on: slug
  schema:
    type: object
    properties:
      slug: { type: string }
      locale: { type: string }
      title: { type: string }
      description: { type: string }
    required: [slug, locale, title]
  uniqueIndexes: [[slug, locale]]
```

`Schema.spec.translates` declares the parent/child relationship as
first-class grammar. The runtime, admin UI, and View executor can
all treat the relation as known structure rather than convention:

- The parent (`products`) is **non-localized**: SKU and price are
  language-independent facts.
- The child (`product-translations`) is **localized**: title and
  description carry one row per (slug, locale) pair.
- `translates.parent` resolves the parent Schema by `metadata.name`;
  `translates.on` names the join field present in both parent and
  child JSON Schemas.
- Admin UI groups parent + per-locale translation entries together.
- Boot validate enforces parent existence and join-field presence in
  both parent and child JSON Schemas (manifest shape, no D1 reads).
- View executor (when `View.join` lands per the future-grammar
  appendix) can auto-join parent + child without per-View
  configuration.
- AI authoring an entry against the child knows from the manifest
  that there's a parent it must reference by `slug`.

Validation rules introduced:

- `TRANSLATES_PARENT_UNKNOWN` — `translates.parent` doesn't resolve
  to a declared Schema name.
- `TRANSLATES_FIELD_NOT_IN_PARENT` — `translates.on` isn't a property
  of parent's `spec.schema.properties`.
- `TRANSLATES_FIELD_NOT_IN_CHILD` — `translates.on` isn't a property
  of the child's own `spec.schema.properties`.
- `TRANSLATES_REQUIRES_LOCALIZED` — `translates: ...` declared on a
  Schema where `localized` isn't `true`. (A non-localized translation
  table makes no sense.)
- `TRANSLATES_REQUIRES_CONTENT_FIELD` — the child declares only its join
  field and `locale`, with no locale-specific payload to translate.

## Consequences

### Pros

- **Single-language and zero-locale sites pay nothing.** Empty
  `site_config.locales` makes the subsystem invisible: no MCP arg,
  no admin picker, no validation rules to fail against.
- **No more semantic error of forced locale tagging.** Tags,
  settings, configs declare `localized: false` (or omit it) and live
  without locale ceremony.
- **Mixed-locale domains decompose cleanly.** Products + product
  translations is two Schemas joined by `slug` — no per-field
  translation flags, no row duplication, no bloated single-Schema
  YAML.
- **AI authoring is more predictable.** When an AI agent reads a
  Schema with `translates: { parent: products, on: slug }`, it knows
  to look up the parent's `slug` field before drafting a translation
  row. The manifest contract surfaces the relation; the agent doesn't
  have to infer it from naming convention.
- **Storage matches semantics.** With locale inside `data`, the
  column structure stops claiming locale is universal. Locale is
  per-Schema-optional alongside every other field, and the
  canonicalization invariant lives next to the gate that enforces it.
- **The locale field on non-localized Schemas is rejected, not
  ignored.** Catches author mistakes (typo'd `locaIe: en` would
  otherwise silently survive) at the validate boundary.
- **Boot is decoupled from D1 state.** First deploy works without
  the operator pre-seeding D1; the `siteDefaults` declarative seed
  + the runtime gate together replace the old fragile read-D1-at-boot
  path.

### Costs

- **MCP API surface is `data`-shaped.** `createDraft({ collection,
  locale, data })` is `createDraft({ collection, data })` with locale
  inside `data`. Consumer AI agents written against pre-v0.1
  prototypes need to pass locale differently. Diagnostic codes stay
  stable.
- **Cross-Schema validation needs ordering.** The boot validator
  must resolve all Schema names before checking `translates.parent`
  references. The two-pass pattern (collect names → check references)
  handles this; it's just one more reference type.
- **Index pattern adds DDL complexity.** Virtual generated columns +
  partial unique indexes per Schema means the migration emitter
  generates more SQL than before. Acceptable given the pattern is
  already used by `Schema.spec.unique`.
- **Two places define "what locales exist."** Manifest declares
  `localized: true`; D1 declares which actual locales the site
  serves. The runtime gate reconciles them; if they drift, the gate
  produces a structured diagnostic but doesn't auto-repair.

### Risks

- **`site_config.locales` empty vs absent.** Both mean "subsystem
  off." Reduces test surface; matches what authors expect.
- **Locale value drift.** `data.locale: 'en-US'` when the site declares
  `'en'` — strict equality after canonicalization. `en-us` and
  `en-US` both match `en-US`, but `en-US` ≠ `en`. A site author
  who wants both writes both into `siteDefaults.locales`.
- **Translation row orphaning.** A `product-translations` row with a
  slug that doesn't match any `products` row — should this be
  rejected? Not at write time. Cross-row referential integrity isn't
  D1's strength; runtime does best-effort, View can filter orphans
  on read. Boot validate only checks that the join field *exists* in
  both Schemas, not that data is consistent.
- **Locale fallback is application logic, not SDK.** A request for
  `zh-TW` that finds nothing returns nothing; the application chooses
  whether to retry with `locales[0]` or 404. v0.2 may introduce a
  View-level `fallbackChain` grammar; v0.1.x ships strict.

## Alternatives considered

**(A) Keep `entries.locale` as a top-level column.** Rejected: forces
locale tagging on language-independent content, blocks zero-locale
sites from existing without ceremony, and bakes the canonicalization
invariant into a place the gate can't keep honest.

**(B) `translation_of: <uuid>` field linking translated rows.** Each
language variant is an independent entry; the second-and-later
versions point at the first via a UUID column. Rejected: requires
the author to know which row is "first" (artificial), creates an
ordering asymmetry between identical-status translations, and doesn't
compose with the parent/child pattern when the parent has
non-translatable fields. Slug-as-join is symmetric and natural.

**(C) Single Schema with field-level localized flags.** e.g.
`properties.title: { type: string, localized: true }`. Each row's
`data.title` becomes a map keyed by locale. Rejected: row layout
forces every read to deserialize all locales even when one is
needed; row size grows with locale count instead of with content
count; the storage shape no longer matches the author-facing shape;
AI agents writing one-locale-at-a-time face a more complex write
API; no clean way to declare "this Schema is fully non-translatable."
The two-Schema decomposition is more verbose in the small case but
composes correctly.

**(D) Auto-detect `localized` from JSON Schema content.** If the
JSON Schema has a `locale` property, treat the Schema as localized.
Rejected: magic. The Schema author should declare locale intent
explicitly on the Schema atom, not bury it as a property name
convention.

**(E) Default `siteDefaults.locales: ['en']`.** Rejected per the
stated positioning ("multi-locale serving worldwide"). Pre-filling
English biases the SDK toward English-first products; a `zh-TW`-primary
site shouldn't have to override a default that's there from
unconscious template bias. `siteDefaults.locales` is **omitted by
default** in the starter's CmsConfig, so a single-language consumer
who doesn't care about locale never types the word.

**(F) Default `Schema.spec.localized: true`.** Rejected: makes the
common simple case (tags, settings, single-language blog) require
explicit opt-out. Default false matches the principle that locale
ceremony is opt-in.

**(G) Read `site_config.locales` at boot to gate manifest
acceptance.** This is what the POC originally did, and what issue
#60 fixed. Rejected because it creates a chicken-and-egg on first
deploy (manifest can't load until D1 is seeded; D1 can't be seeded
until SDK is running). The runtime gate + `siteDefaults` declarative
seed replaces it cleanly.

## How to apply

When designing a new Schema:

1. Default to **non-localized**. If the content can carry the same
   meaning across all the site's locales, leave `localized` off.
2. Set `localized: true` only when the entry's *meaning* changes per
   locale (an article translated; a product description localized).
3. If some fields translate and others don't, **decompose into two
   Schemas**: a parent (non-localized facts) and a child with
   `translates: { parent: <name>, on: <field> }` and
   `localized: true`. Choose the join field by what the application
   already uses as a stable identifier — usually `slug`, sometimes a
   numeric id.

When implementing SDK features that depend on Schema-level locale
intent:

1. Read `Schema.spec.localized` directly. Don't sniff the JSON
   Schema's properties for a `locale` field.
2. Read the site-config accessor for the site's locale list. Empty
   array means locale subsystem off; treat any localized Schema as
   misconfigured (the runtime gate already produces a structured
   diagnostic).
3. When writing: validate `data.locale` presence/absence against the
   Schema's `localized` flag and value membership in the site locale
   list before delegating to the handler.

When configuring a new consumer:

1. If the site has any locales, declare them in
   `CmsConfig.siteDefaults.locales` in Mantle's canonical locale form
   (`'en'`, `'zh-TW'`, never `'en-US'` if you mean `'en'`; never
   `'zh-Hant'` if you mean Traditional Chinese — use `'zh-TW'`). The
   boot check rejects malformed or unsupported tags synchronously.
2. If the site has no locales, omit `siteDefaults.locales` entirely.
   The whole subsystem stays off.
3. Don't write `site_config` rows manually for the seed —
   `bootInit()` seeds through `DatabaseSiteConfigRepository` and is idempotent.
   Operators who later edit values via the admin Settings page win
   over the seed (the `ON CONFLICT(key) DO NOTHING` clause is what
   makes that safe).

## Implementation status

Accepted for v0.1.0. The POC shipped the grammar, runtime gate, and
`siteDefaults` seed; the v0.1.0 rebuild ports the same shapes into
the new package layout (`@aotter/mantle-spec` for the manifest
grammar, `@aotter/mantle-runtime` for the gate, the CF adapter
for `createCmsRuntime().bootInit()` + `DatabaseSiteConfigRepository.seed`):

- Grammar in `packages/mantle-spec/src/domain/model/ManifestGrammar.ts`
  + the manifest parser.
- Cross-Schema validation in the validate + boot phases.
- D1 schema: no `entries.locale` column; `data.locale` is the
  authoritative storage; partial unique index per localized Schema.
- `site_config` key/value table with the `locales` key.
- Runtime locale gate in `packages/mantle-runtime/src/domain/service/ContentLocaleGate.ts`.
- `CmsConfig.siteDefaults` consumed by runtime `bootInit()`, with
  `assertSiteDefaultsCanonical` + `DatabaseSiteConfigRepository.seed`
  (async, idempotent).
- Starter blog manifests demo the parent/child pattern:
  `posts` + `post-translations`.
