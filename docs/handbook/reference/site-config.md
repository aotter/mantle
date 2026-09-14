---
description: siteDefaults reference — locales, brand, icons, media purposes, the runtime SiteConfig read shape, site_config row ownership and what boot validates.
---
# Site config

Site config is a sibling of the Manifest grammar, not part of it. The four atoms describe content; `siteDefaults` describes the deployment: the locales the site publishes in, its brand and title, its canonical origin, its icons, its analytics ids and its media taxonomy. The deployment declares it as a TypeScript object and passes it to the adapter; the runtime seeds it into the `site_config` table and every render, MCP catalog build and Admin page reads it back from there.

## `siteDefaults`

| Key | Type | Required | Rules |
|---|---|---|---|
| `locales` | `string[]` | no | Ordered. `locales[0]` is the canonical locale. Empty or omitted turns the locale subsystem off site-wide. Every entry must canonicalize; see [Boot validation](#validated-at-boot). |
| `brand` | string | no | Operator-facing label for Admin chrome and MCP `serverInfo.title`. Distinct from `title`. |
| `title` | string | no | Site title — `<title>` suffix and `og:site_name`. |
| `description` | string | no | Default `<meta name="description">` and `og:description` for entries with none. |
| `origin` | string | no | Canonical absolute origin, no trailing slash, for example `https://example.com`. Used to build absolute URLs in `/llms.txt`, the `.md` mirrors and `/sitemap.xml`. An empty origin yields relative URLs. |
| `icons` | `SiteIcon[]` | no | One site identity reused by browser favicons, Admin chrome and MCP `serverInfo.icons`. Declaring an empty array is an error. |
| `ga4MeasurementId` | string | no | GA4 Measurement ID such as `G-XXXXXXXXXX`. When present the runtime injects the standard gtag snippet into rendered public HTML. |
| `facebookPixelId` | string | no | Meta Pixel ID. When present the runtime injects the standard Pixel base snippet. |
| `media.purposes` | `MediaPurposePolicy[]` | no | The upload taxonomy. Omitting the key, or declaring an empty array, keeps first-party media uploads disabled. |

Nothing in this object is validated for length or content beyond the rules above: `brand`, `title`, `description` and `origin` are free strings.

## `SiteIcon`

```ts
interface SiteIcon {
  readonly src: string;
  readonly mimeType?: "image/png" | "image/jpeg" | "image/svg+xml" | "image/webp";
  readonly sizes?: readonly string[];
  readonly theme?: "light" | "dark";
}
```

| Field | Rules |
|---|---|
| `src` | Either root-relative (starts with a single `/`, no whitespace, no backslash) or an absolute `https:` URL. Anything else is rejected. |
| `mimeType` | Optional. One of the four listed types. |
| `sizes` | Optional. When present, a non-empty array whose entries are `any` or `<width>x<height>` with non-zero decimal dimensions, for example `64x64`. |
| `theme` | Optional. `light` or `dark`. |

When the deployment declares no icons, the runtime stores `DEFAULT_SITE_ICONS`:

```ts
const DEFAULT_SITE_ICONS = [{
  src: "/_mantle/admin/favicon.svg",
  mimeType: "image/svg+xml",
  sizes: ["any"],
}];
```

Multiple renditions are allowed. Keep SVG as the source and add a PNG rendition when a target MCP client needs a baseline raster format. `GET /favicon.ico` resolves against this list; see [Surface](./surface.md).

## `MediaPurposePolicy`

```ts
interface MediaPurposePolicy {
  readonly name: string;
  readonly required: readonly string[];
  readonly maxBytes: Readonly<Record<string, number>>;
}
```

| Field | Rules |
|---|---|
| `name` | The slug callers pass as `purpose`. Must match `^[a-z0-9]+(-[a-z0-9]+)*$`: lowercase alphanumerics, dash-separated, no leading, trailing or repeated dashes. |
| `required` | Ordered list of acceptable mime **slots**, at least one. Each entry uses the HTML `<input accept>` grammar. |
| `maxBytes` | Per-mime byte cap keyed by fully expanded mime type. Must name every mime that appears in any slot after expansion, and every value must be a positive number. |

A slot entry is one of a full mime (`image/jpeg`), a comma-list of full mimes (`image/jpg,image/png`, meaning either is acceptable for that slot), or a shorthand subtype (`webp` expands to `image/webp`, `jpg` and `image/jpg` both expand to `image/jpeg`). Whitespace around commas is tolerated.

Slot position does not determine variant role. Per asset the uploading agent picks one mime per slot and independently declares exactly one supplied variant as `primary` — the format `<img>` falls back to — with the rest `alternate`, preferred through `<picture><source>`. Because a variant maps to a slot by its mime alone, mime sets across slots must not overlap; an overlap is rejected at boot rather than per upload.

## Runtime `SiteConfig`

`siteDefaults` is the author-time declaration. `SiteConfig` is the read shape that templates, the MCP catalog and Admin see after the seed has run and an operator has had a chance to edit.

| Field | Type | Value when the row is absent |
|---|---|---|
| `title` | string | `"CMS"` |
| `description` | string | `""` |
| `origin` | string | `""` |
| `brand` | string | `"AotterMantle"` |
| `locales` | `readonly string[]` | `[]` |
| `canonicalLocale` | `string \| null` | `locales[0]` or `null` when the list is empty |
| `icons` | `readonly SiteIcon[]` | `DEFAULT_SITE_ICONS` |
| `ga4MeasurementId` | `string \| undefined` | `undefined` (an empty stored value also reads as `undefined`) |
| `facebookPixelId` | `string \| undefined` | `undefined` |
| `media.purposes` | `readonly MediaPurposePolicy[]` | `[]` |

`canonicalLocale` is computed, never stored. Templates emit `<html lang>` only when it is non-null; silent omission is the correct behaviour for a zero-locale site, not a fabricated default.

## `site_config` rows

The table is a flat key/value store. Keys fall into two ownership classes, and the seed treats them differently.

| Key | Ownership | Written by seed | Source of truth |
|---|---|---|---|
| `brand` | UI-editable, seed-once | `INSERT … ON CONFLICT DO NOTHING` | The database, once the row exists |
| `title` | UI-editable, seed-once | `INSERT … ON CONFLICT DO NOTHING` | The database, once the row exists |
| `description` | UI-editable, seed-once | `INSERT … ON CONFLICT DO NOTHING` | The database, once the row exists |
| `ga4MeasurementId` | UI-editable, seed-once | `INSERT … ON CONFLICT DO NOTHING` | The database, once the row exists |
| `facebookPixelId` | UI-editable, seed-once | `INSERT … ON CONFLICT DO NOTHING` | The database, once the row exists |
| `origin` | Code-canonical, boot-synced | Upsert when the stored value differs | The declaration |
| `faviconUrl` | Code-canonical, boot-synced | Upsert when the stored value differs; holds the `icons` array as JSON | The declaration |
| `locales` | Code-canonical, boot-synced | Upsert when the stored value differs; holds the declared list as a comma-separated string | The declaration |
| `mediaPurposes` | Code-canonical, boot-synced | Upsert when the stored value differs; holds the purposes array as JSON | The declaration |

Blank values are skipped in both classes: an absent, empty or empty-array field never writes and never clears an existing row, so a partial declaration cannot clobber stored values. The boot-synced keys are read-compared before writing, so an unchanged deployment issues no write.

The seed-once keys have an Admin edit path at `PATCH /admin/api/site-settings` (owner only); the boot-synced keys do not, which is why the declaration wins on every boot. A custom-domain change therefore becomes canonical by editing the code and redeploying, with no manual database edit.

> **Warning**
> `mediaPurposes` is JSON. Rows written by pre-`#272` deployments used a CSV form and do not round-trip. Re-run the seed, or delete the row, after upgrading.

## Validated at boot

Storage preparation calls `assertSiteDefaultsCanonical(siteDefaults)` synchronously, before the runtime accepts traffic. It throws — it does not return diagnostics — so a typo rejects the deployment rather than corrupting the seed.

| Error | Thrown when |
|---|---|
| `InvalidSiteDefaultsError` | Any declared locale fails canonicalization. Carries `invalidLocales`; the message adds script-subtag guidance when one is present. |
| `InvalidSiteIconsError` | `icons` is declared as an empty array, or any icon fails the [`SiteIcon`](#siteicon) rules. Carries the offending icons. |
| `InvalidMediaPurposesError` | Any declared purpose fails a policy rule. Carries one issue per purpose. |

`InvalidMediaPurposesError` reports exactly one reason per purpose, checked in this order and stopping at the first hit:

| Reason | Meaning |
|---|---|
| `invalid-slug` | `name` does not match the slug pattern. |
| `empty-required` | `required` is an empty array. |
| `empty-required-slot` | A `required` entry parses to zero mimes. |
| `overlapping-slot-mimes` | Two slots accept the same mime, so a variant cannot be mapped to one slot. |
| `maxBytes-missing-mime` | `maxBytes` has no entry for a mime that some slot accepts. |
| `maxBytes-non-positive` | A `maxBytes` entry is not a positive number. |

Locale canonicalization accepts a 2- or 3-letter ISO 639 language plus an optional 2-letter ISO 3166 region, separated by `-` or `_`, or run together in the 2+2 form. Case is irrelevant: `zh-tw`, `ZH_TW` and `zhTW` all canonicalize to `zh-TW`. The canonicalized list is deduplicated, so `["zh-tw", "zh-TW"]` collapses to one entry. Script subtags are valid BCP 47 but deliberately unsupported in v0.1 — `zh-Hant`, `zh-Hans`, `sr-Latn` and `sr-Cyrl` are all rejected; use region tags such as `zh-TW` and `zh-CN`. Variants such as `de-1996` are likewise rejected. The `locales` row stores the declared list verbatim once it validates.

Deployment readiness runs alongside the seed and collects boot-phase diagnostics, throwing `BootValidationError` when any is an error.

| Check | Diagnostic |
|---|---|
| `checkSiteLocales`: the site locale list canonicalizes. | `INVALID_LOCALE` at `site_config/locales`, listing the invalid entries |
| `checkSiteLocales`: no Schema declares `localized: true` while the site has zero valid locales. | `SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES` |
| `translates` references resolve: the parent exists, is not itself localized, and declares the join field. | `TRANSLATES_PARENT_UNKNOWN`, `TRANSLATES_PARENT_IS_LOCALIZED`, `TRANSLATES_FIELD_NOT_IN_PARENT` |
| Every `handler.kind: ref` key is registered in the `handlers` map. The registered keys are attached as `candidates`. | `HANDLER_NOT_REGISTERED` |
| No HTTP Trigger path falls under an adapter-reserved prefix. | `TRIGGER_PATH_INVALID` |
| Every `sql` View's dialect is supported by the bound storage adapter. | `VIEW_DIALECT_UNSUPPORTED` |

## Checked per request

| Read | When |
|---|---|
| `siteConfig.load()` | Every public render, every `/llms.txt`, `.md` mirror and sitemap response, every MCP catalog build, the Admin site payload. Reads all rows and applies the fallbacks above. |
| `siteConfig.readLocales()` | Locale resolution on public routes and the write-time locale gate. Reads only the `locales` row; the value is memoized per repository instance once a prepared revision proves the code-owned locale policy is current. |
| `siteConfig.readMediaPurposes()` | Upload authorization. Always reads the canonical row, never a cached catalog snapshot. |

The `data.locale` write gate runs on every authoring path — Admin, Staff MCP and builtin Procedures — after stamping, against the locales read for that request. Its Schema-side rules are in [Schema](./schema.md#write-time-locale-gate).

| Condition | Result |
|---|---|
| Non-localized Schema and `data.locale` is present. | `INPUT_VALIDATION_FAILED` |
| Localized Schema and `data.locale` is missing or empty. | `INPUT_VALIDATION_FAILED`, skipped for partial draft saves; publish re-checks. |
| Localized Schema and `data.locale` is not in the site locales. | `INPUT_VALIDATION_FAILED` with the enabled locales as `candidates` |
| The site locale list is empty. | Membership is not checked. |

Media checks run per upload. `create_media_upload` and `commit_media_upload` are registered only when the runtime has a `mediaStorage` port bound **and** at least one purpose is declared; without both, the tools do not appear in `tools/list` at all.

| Condition | Diagnostic |
|---|---|
| `purpose` is not one of the declared slugs. The declared set is returned in `expected`. | `MEDIA_PURPOSE_REJECTED` |
| The variants manifest does not cover every required mime for the purpose. | `MEDIA_VARIANTS_INCOMPLETE` |
| A variant's declared `byteSize` exceeds its mime's `maxBytes`. | `MEDIA_VARIANT_SIZE_EXCEEDED` |
| A single upload exceeds its cap. | `MEDIA_SIZE_EXCEEDED` |
| A modern format is larger than its fallback, which means the uploader skipped optimization. | `MEDIA_VARIANTS_SUSPICIOUS_SIZE` |

The Cloudflare recipe for binding R2 is in [Media on R2](../cloudflare/media-r2.md).

## Example

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";
import { handlers } from "./handlers.js";

export default createMantleWorker({
  plan,
  handlers,
  siteDefaults: {
    locales: ["en", "zh-TW"],
    brand: "Northwind",
    title: "Northwind Supply",
    description: "Industrial parts, shipped the same day.",
    origin: "https://northwind.example.com",
    icons: [
      { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
      { src: "/site-icon.png", mimeType: "image/png", sizes: ["64x64"] },
    ],
    ga4MeasurementId: "G-XXXXXXXXXX",
    media: {
      purposes: [
        {
          name: "product-cover",
          required: ["image/jpg,image/png", "webp", "avif"],
          maxBytes: {
            "image/jpeg": 5_000_000,
            "image/png": 5_000_000,
            "image/webp": 3_000_000,
            "image/avif": 2_000_000,
          },
        },
      ],
    },
  },
});
```

`en` is canonical, so `/` redirects to `/en` and `zh-TW` is served at `/zh-tw`. Both icon files live in the project's `public/` directory. The one purpose declares three slots: the first accepts a JPEG or a PNG primary, the other two carry the modern alternates. See [Conventional Worker](../cloudflare/conventional-worker.md) for the surrounding bindings and [Public web](../cloudflare/public-web.md) for what the locale list turns on.

## Source

- [`packages/mantle-spec/src/domain/model/SiteConfig.ts`](../../../packages/mantle-spec/src/domain/model/SiteConfig.ts)
- [`packages/mantle-spec/src/domain/model/MediaMimeAccept.ts`](../../../packages/mantle-spec/src/domain/model/MediaMimeAccept.ts)
- [`packages/mantle-spec/src/domain/service/SiteDefaultsValidator.ts`](../../../packages/mantle-spec/src/domain/service/SiteDefaultsValidator.ts)
- [`packages/mantle-spec/src/domain/service/LocaleCanonicalizer.ts`](../../../packages/mantle-spec/src/domain/service/LocaleCanonicalizer.ts)
- [`packages/mantle-spec/src/domain/service/CrossSchemaChecker.ts`](../../../packages/mantle-spec/src/domain/service/CrossSchemaChecker.ts)
- [`packages/mantle-runtime/src/infrastructure/persistence/DatabaseSiteConfigRepository.ts`](../../../packages/mantle-runtime/src/infrastructure/persistence/DatabaseSiteConfigRepository.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/mantle-runtime/src/usecase/media/diagnostics.ts`](../../../packages/mantle-runtime/src/usecase/media/diagnostics.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts)
- [`packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts`](../../../packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`docs/media-uploads.md`](../../../docs/media-uploads.md)
