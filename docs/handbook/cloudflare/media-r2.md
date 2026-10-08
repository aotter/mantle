---
description: Media uploads in Mantle 0.2.0 on Cloudflare R2 — site media purposes, r2MediaStorage, wiring Admin and staff MCP media tools, the presigned upload flow, and what to store in a Schema.
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
    media: { purposes: [{ name: "cover", required: ["image/webp", "image/jpeg,image/png"], maxBytes: { "image/webp": 2_000_000, "image/jpeg": 2_000_000, "image/png": 2_000_000 } }] },
  } }),
});

// in mount(): one media storage, shared by Admin and staff MCP
const media = r2MediaStorage({
  bucket: env.MEDIA,
  signer: new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, region: "auto", service: "s3" }),
  endpoint: env.R2_ENDPOINT,
  publicBase: env.MEDIA_PUBLIC_BASE,
});
const admin = guard(createAdminSurface(runtime, { basePath: "/admin", media, /* …the generated options… */ }));
const staffMcp = guard(createMcpSurface(runtime, {
  basePath: "/mcp/staff", surface: "staff", media, resourceMetadata,
}), { resourceMetadata });
```

`aws4fetch` is the application's dependency; Mantle only calls its `sign`.
Without both `media` and site defaults, every Admin media route answers 501
`MEDIA_NOT_CONFIGURED`, and MCP advertises no media tools. Public MCP never
advertises media tools. The generated preset does not invent bucket credentials;
add the same explicit adapter to its application-owned service composition.

## 3. The upload flow

All through Admin's API, `editor` role or higher:

1. `POST /admin/api/media/uploads` with
   `{ filename, purpose, variants: [{ mimeType, byteSize, role }], alt?, caption? }`.
   The purpose's MIME slots and per-type byte caps are checked here, and exactly one variant must be `role: "primary"`. The answer is
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

## Staff MCP upload flow

Connect the tenant's `/mcp/staff` using its own identity, with the `mcp` scope
and `editor` or `owner` role. Cloud project membership is not tenant staff.
The verified role is checked again on every call, as in Admin.

1. Call `get_media_upload_policy` to read the declared purpose MIME slots and
   byte caps. Obtain the chat attachment bytes in the agent environment and
   optimize/encode the required variants there; do not ask the user to run a
   terminal command.
2. Call `create_media_upload` with the same body as Admin's create endpoint.
3. PUT every variant's actual bytes to its capability URL using all returned
   `requiredHeaders`, before `expiresAt`. Bytes never travel as base64 MCP JSON.
4. Call `commit_media_upload` with `{ uploadGroupId, alt?, caption? }`.
   Verify success before using the returned permanent asset `id`.
5. Pass that ID to the application's content Procedure. Images are content
   operations, not a new Cloud source build or deploy.

`list_media_assets`, `get_media_asset`, `update_media_asset` (`id`, `alt?`,
`caption?`) and `delete_media_asset` (`id`) share the same library and editor
permission as Admin. A create refusal publishes nothing. Expired groups need
new capabilities; partial delete failures can retry the same ID. Keep upload
capabilities out of logs and persisted content.

## Storing media in a Schema

Store the committed asset ID, not its temporary capability URL:

```yaml
coverAssetId:
  type: string
  x-mantle-ref: media_assets
  x-mcp-hint: media-image
```

The string reference defaults to the native library's `id` and enables Admin's
existing MediaPicker. The hint alone does not enable the picker. Do not author
a replacement `media_assets` Schema: the site's library owns that table.

An asset ID is not an image URL. Resolve it with the existing site library in
an application-owned frontend handler, then use a variant's `publicUrl`:

```ts
// The same media adapter used by Admin and staff MCP.
const asset = await runtime.site!.media(media).get(post.coverAssetId);
const primary = asset.variants.find((variant) => variant.role === "primary")!;
// Render primary.publicUrl as the image src; asset.alt as its alt text.
```

A public frontend route must enforce the content's publication and visibility
before resolving its media. Return only public URLs/alt/variant metadata it
needs; never expose upload capabilities or a staff MCP credential. Native site
product tables are not manifest Store tables: do not query `media_assets` in
View/Procedure SQL or widen the SQL grammar to resolve them. A custom handler
can use the existing library capability while its content reads remain
caller-scoped.

## Stale uploads

A group created but never committed leaves objects under `uploads/` until its
URLs expire. The package skill `docs/skills/media-gc/SKILL.md` audits and
removes them.
