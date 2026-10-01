---
description: The optional site capability in Mantle 0.2.0 — SiteDefaults passed to the storage adapter, the site_config table, which fields are seeded or synced, Admin's site routes and media purposes.
---
# Site defaults and `site_config`

Site settings and the media library are one optional capability. A service
turns it on by passing `SiteDefaults` to its storage adapter:

```ts
storage: (env) => d1Storage(env.DB, {
  site: {
    title: "Notes",
    brand: "Notes",
    description: "A small notebook.",
    origin: "https://notes.example.com",
    locales: ["en", "zh-TW"],
    icons: [{ src: "/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] }],
    media: { purposes: [{ name: "cover", required: ["primary"], maxBytes: { primary: 2_000_000 } }] },
  },
}),
```

With `site`, boot creates Mantle's product tables (`site_config`,
`media_assets`, `pending_media_uploads`), writes the defaults, and the runtime
carries `runtime.site`. Without it those tables are not created,
`runtime.site` is absent, Admin's `/site-settings` answers 501
`SITE_NOT_CONFIGURED` and its media routes 501 `MEDIA_NOT_CONFIGURED`. The generated preset does
not pass `site`; add it in `src/service.ts`.

## `SiteDefaults`

| Field | Kind | At boot |
|---|---|---|
| `title`, `brand`, `description` | operator | written once if the row is missing; after that the database wins, so an owner's edit in Admin is never overwritten by code |
| `origin` | deployment | synced every boot: the canonical absolute origin, no trailing slash |
| `locales` | deployment | synced every boot; the first is the canonical locale |
| `icons` | deployment | synced every boot: `[{ src, mimeType?, sizes?, theme? }]`, root-relative or absolute HTTPS. Without it the defaults are `/admin/favicon.png` and `/admin/favicon.svg`, served with the Admin console |
| `media.purposes` | deployment | synced every boot: `[{ name, required: [roles], maxBytes: { role: bytes } }]`; `name` is a lowercase slug |

A blank value is skipped, so it never clears a stored one. Boot validates the
defaults and refuses a malformed purpose or locale.

## Reading and editing

- `runtime.site.read()` returns `{ title, description, origin, locales,
  canonicalLocale, brand, icons, media: { purposes } }`.
- `runtime.site.updateSettings({ brand?, title?, description? })` edits the
  operator fields; an empty string clears one.
- Admin: `GET /admin/api/site` (any staff role) answers the site for the
  console, with `mcpEndpoints` from `createAdminSurface`'s
  `site: { mcpEndpoints }` (the preset passes `{ public: "/mcp", staff: null }`;
  default `null`). `GET` and `PATCH /admin/api/site-settings` (owner) read and
  edit the operator fields.

## Media purposes

A purpose names a kind of upload and the variants it needs: `required` lists
roles (`primary`, `alternate`, `fallback`), and `maxBytes` caps each role.
An upload request names its purpose; a role it lacks or a byte size over the
cap is refused before any upload URL is issued. See
[Media uploads with R2](../cloudflare/media-r2.md).
