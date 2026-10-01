---
description: Media uploads in Mantle 0.2.0 on Cloudflare R2 — site media purposes, r2MediaStorage, wiring Admin's media routes, the presigned upload flow, and what to store in a Schema.
---
# Media uploads with R2

Media is optional. It needs three things in `src/service.ts`: site defaults
with media purposes, an `r2MediaStorage`, and both passed where they belong.
The bytes go from the uploader straight to R2; the Worker never proxies them.

## 1. A public bucket and S3 credentials

- An R2 bucket served publicly, from a custom domain or `pub-<hash>.r2.dev`.
  That URL is `publicBase`.
- An R2 API token with write access to the bucket, for presigning PUT URLs:
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker secrets.
- A CORS rule on the bucket that allows `PUT` with `Content-Type` from your
  Admin's origin, if a browser uploads.

```jsonc
// wrangler.jsonc
"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-media" }],
"vars": { "MEDIA_PUBLIC_BASE": "https://media.example.com", "R2_ENDPOINT": "https://my-media.<account>.r2.cloudflarestorage.com" }
```

## 2. Wire it

```ts
import { AwsClient } from "aws4fetch";
import { d1Storage, r2MediaStorage } from "@aotter/mantle/cloudflare";

// storage, with the purposes uploads may use
export const mantle = createMantle(service, {
  plan, schedules: true,
  storage: (env) => d1Storage(env.DB, { site: {
    title: "My site",
    media: { purposes: [{ name: "cover", required: ["primary"], maxBytes: { primary: 2_000_000 } }] },
  } }),
});

// in mount(): the media storage, handed to Admin
const media = r2MediaStorage({
  bucket: env.MEDIA,
  signer: new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, region: "auto", service: "s3" }),
  endpoint: env.R2_ENDPOINT,
  publicBase: env.MEDIA_PUBLIC_BASE,
});
const admin = guard(createAdminSurface(runtime, { basePath: "/admin", media, /* …the generated options… */ }));
```

`aws4fetch` is the application's dependency; Mantle only calls its `sign`.
Without both `media` and site defaults, every media route answers 501
`MEDIA_NOT_CONFIGURED`.

## 3. The upload flow

All through Admin's API, `editor` role or higher:

1. `POST /admin/api/media/uploads` with
   `{ filename, purpose, variants: [{ mimeType, byteSize, role }], alt?, caption? }`.
   The purpose's required roles and byte caps are checked here. The answer is
   `{ uploadGroupId, capabilities: [{ role, mimeType, method: "PUT", uploadUrl, requiredHeaders }], expiresAt }`.
2. `PUT` each variant's bytes to its `uploadUrl` with its `requiredHeaders`.
3. `POST /admin/api/media/uploads/{uploadGroupId}/commit` (optionally with
   `{ alt, caption }`). Commit checks every stored object's type and size,
   then copies each to a public key no upload URL can reach. A rejected group
   publishes nothing and its upload objects are deleted. An expired or unknown
   group is 410 `MEDIA_UPLOAD_EXPIRED`.

The committed asset is `{ id, variants: [{ role, mimeType, publicUrl, storageKey, byteSize }], alt?, caption?, createdAt }`.
`GET /admin/api/media` lists assets (`search`, `limit`, `cursor`); `GET`,
`PATCH` (`alt`, `caption`) and `DELETE /admin/api/media/{id}` manage one.
Delete removes the objects first, then the row, so a partial failure can be
retried.

Optimize images where they are made (in the browser or the agent), and upload
the variants; Mantle does not transform images.

## Storing media in a Schema

Store the asset's `publicUrl` (or its `id`) in a string field and mark it:

```yaml
cover: { type: string, x-mcp-hint: media-image }
```

The hint tells Admin and agents what the field holds. No MCP tool uploads
media in 0.2.0; an agent uploads through Admin's API with a staff session.

## Stale uploads

A group created but never committed leaves objects under `uploads/` until its
URLs expire. The package skill `docs/skills/media-gc/SKILL.md` audits and
removes them.
