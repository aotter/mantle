---
description: Enable staff media uploads on R2 — presigned PUT flow through Staff MCP, media purposes, wrangler config, commit cost and cleanup.
---
# Media uploads with R2

R2-backed media is an optional post-launch capability for Workers whose staff or agents need to upload images and files. This page covers the upload flow, the Cloudflare and Worker configuration it needs, how a Schema references an asset, what a commit costs, and how to clean up.

## When to enable it

Turn this on only after the site already has a working deploy, staff auth configured, and a real need for staff-managed media. R2 setup may require billing, so it is deliberately not part of the first-deploy path. Everything on this page is inert until the bucket, credentials and at least one media purpose all exist.

Media maintenance also needs an agent that can read local files, process images and make outbound `PUT` requests to `*.r2.cloudflarestorage.com`. A sandboxed agent without egress cannot finish the flow.

## The upload flow

```txt
1. create_media_upload   staff MCP  -> purpose, variants, mime types, byte sizes
2. Mantle                           -> signed upload URLs + required headers
3. agent or browser                 -> PUT bytes directly to R2
4. commit_media_upload   staff MCP  -> validate, stamp, save the asset row
```

Bytes travel from the agent to R2 over a signed URL; the Worker sees policy, not payload. Never pass image bytes or base64 payloads through MCP tool arguments — the tool dispatchers count streamed JSON bytes and return `413` above the 1 MiB control-plane limit. The Worker validates; the agent runtime does the file work.

## Cloudflare setup

```sh
wrangler r2 bucket create <project>-media
wrangler r2 bucket dev-url enable <project>-media
```

Then create an R2 S3 API token in the dashboard: open **R2**, open **Manage R2 API Tokens**, create an **Object Read & Write** token, and copy the Access Key ID and Secret Access Key.

The R2 binding alone cannot issue presigned `PUT` URLs: presigning is an S3-protocol operation, so Mantle needs these credentials in addition to the binding. A deployment with the bucket bound but no credentials never registers the upload tools.

## Wrangler configuration

```toml
[vars]
R2_ACCOUNT_ID = "<account-id>"
MEDIA_PUBLIC_URL_BASE = "https://pub-<hash>.r2.dev"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "<project>-media"
```

A `wrangler.jsonc` project writes the same binding as an `"r2_buckets"` array; see [Bindings and primitives](./bindings.md#r2-media-bucket-optional) for the JSON form and the matching `Env` fields.

```sh
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

`MEDIA_PUBLIC_URL_BASE` is the origin public URLs are built from — the `r2.dev` development URL, or a custom domain in production. `R2_ACCOUNT_ID` builds the S3 endpoint, which is a different host from the public one.

## Wiring `R2MediaStorage`

Build the adapter from `env`, returning `undefined` when any part is missing so a half-configured environment degrades to no media rather than failing to boot:

```ts
import { R2MediaStorage } from "@aotter/mantle/cloudflare";
import { AwsClient } from "aws4fetch";

function buildMediaStorage(env: Env) {
  if (
    !env.MEDIA_BUCKET ||
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.MEDIA_PUBLIC_URL_BASE
  ) {
    return undefined;
  }

  const s3 = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });

  return new R2MediaStorage(
    env.MEDIA_BUCKET,
    s3,
    `https://<project>-media.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    env.MEDIA_PUBLIC_URL_BASE,
  );
}
```

Pass it through the `bindings` hook, spreading the conventional set:

```ts
export default createMantleWorker<Env>({
  plan,
  bindings: (env, conventional) => ({
    ...conventional,
    mediaStorage: buildMediaStorage(env),
  }),
});
```

`aws4fetch` is an application dependency; the adapter takes the signing client rather than embedding one. See [The conventional Worker](./conventional-worker.md#a-bindings-hook).

## Declaring media purposes

A purpose is the upload policy: which variants an asset must have, and how large each may be.

```ts
siteDefaults: {
  media: {
    purposes: [
      {
        name: "page-image",
        required: ["image/jpeg,image/png", "image/webp", "image/avif"],
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
```

`required` is slot-based, in the grammar of an `<input accept>` list. The example declares three slots: slot 0 takes exactly one fallback mime preserving source semantics (`image/jpeg` for opaque photos, `image/png` when alpha must survive), slot 1 a WebP variant, slot 2 an AVIF variant. That models a multi-variant `<picture>`. A narrower purpose may declare a single slot such as `["image/jpeg,image/png,image/webp,image/gif"]`, in which case the agent picks exactly one mime from that list and must not upload one variant per listed mime.

Purpose names are slugs (`^[a-z0-9]+(-[a-z0-9]+)*$`), every slot must be non-empty, slots may not overlap on a mime, and every `maxBytes` key must be a mime some slot accepts with a positive value. Violations fail at boot. SVG uploads are rejected unless the Worker sets `mediaAllowSvg`. See [Site defaults and site_config](../reference/site-config.md).

The runtime emits the policy summary into the `create_media_upload` tool description, so an agent reads the contract straight from `tools/list` without an extra round trip.

## Tool visibility

`create_media_upload` and `commit_media_upload` are registered only when **both** hold:

- `bindings.mediaStorage` is set;
- `siteDefaults.media.purposes` contains at least one purpose.

If either is missing the tools never appear in `tools/list`. That is the intended diagnostic: an agent that cannot see the tools is looking at a deployment where media is not configured, not at a permissions problem. A call that reaches a runtime without media storage answers `MEDIA_NOT_CONFIGURED`.

## Referencing an asset from a Schema

Entries store asset ids, not URLs. Mark the field with both existing v0.1 grammar extensions:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: pages
spec:
  title: Pages
  schema:
    type: object
    additionalProperties: false
    required: [slug, title]
    properties:
      slug: { type: string, pattern: "^[a-z0-9-]+$" }
      title: { type: string, minLength: 1 }
      coverAssetId:
        type: string
        x-mantle-ref: media_assets
        x-mcp-hint: media-image
```

`x-mantle-ref: media_assets` marks the string as an id in the media asset collection, which is what makes Admin show a media picker instead of a text box. `x-mcp-hint: media-image` tells an MCP client the field expects an image asset. Neither key is validated as a foreign key; they are informational. At render time, resolve ids to their variants with `runtime.media.resolve(id)` or `resolveMany(ids)`, which batches a render pass into one database round trip. No new manifest keys are involved; see [Schema](../reference/schema.md).

## What a commit costs

R2 has no metadata-only patch. To stamp `committedAt`, `role`, `uploadGroupId` and the filename markers, Mantle streams each uploaded object through a `GET` and a `PUT`. So a successful N-variant commit performs N `GET`s and N `PUT`s and rewrites the sum of the variant sizes.

- Commits validate the bundle shape before any I/O.
- Variants are processed in batches of at most three; a batch settles before the next starts or an error returns.
- A mime or size failure cancels the unused `GET` stream; a failed `PUT` also attempts cancellation while preserving the original error.
- The asset row is saved only after every variant succeeds. All-or-nothing.

Parallelism reduces waiting, not operation count or bytes. Keep variant counts and byte caps deliberate. A partial R2 failure leaves the pending D1 record in place so the commit can be retried before it expires; already stamped objects stay stamped.

## Cleanup

An upload can reach R2 and never be committed — an interrupted agent, a rejected commit. Remove those objects with the version-matched `media-gc` skill. It is opt-in and deliberately not projected into a repository by `mantle skills`, because it deletes remote objects.

Its posture is audit first, delete only what an operator confirmed. It treats an object as a candidate only when it is over 24 hours old, has no `committedAt` custom metadata, and matches the exact key layout `<purpose>/<group>/(primary|alternate|fallback).<ext>` for a purpose this project declares. It reports account, bucket, prefixes, cutoff, counts, bytes and a digest of the candidate set without printing keys or URLs; on confirmation it re-runs the same audit and stops if anything changed.

> **Do not use an R2 lifecycle rule**
> Committed and uncommitted media share the same purpose prefix, so an age-based rule deletes live assets. After a pending record expires, partially stamped orphans require an operator audit against D1 references: a missing pending record does not mean an object is unused.

## Diagnostics

| Code | HTTP | Raised when |
|---|---|---|
| `MEDIA_NOT_CONFIGURED` | 501 | No `mediaStorage` port is bound on this deployment |
| `MEDIA_PURPOSE_REJECTED` | 400 | The requested purpose is not declared; the declared set is returned so an agent can self-correct |
| `MEDIA_MIME_REJECTED` | 400 | A mime outside `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/gif` |
| `MEDIA_SIZE_EXCEEDED` | 400 | A declared byte size exceeds its cap |
| `MEDIA_SVG_REJECTED` | 400 | An SVG was offered while SVG is not allowed; object storage does not sanitize SVG payloads |
| `MEDIA_VARIANTS_INCOMPLETE` | 400 | The bundle misses a mime the purpose requires; the missing set is returned |
| `MEDIA_VARIANT_SIZE_EXCEEDED` | 400 | One variant exceeds the cap declared for its mime |
| `MEDIA_VARIANTS_SUSPICIOUS_SIZE` | 400 | A modern variant is larger than its fallback (AVIF above JPEG), so it looks unoptimized |
| `MEDIA_ASSET_NOT_FOUND` | 404 | No `media_assets` row matches the id |
| `MEDIA_UPLOAD_EXPIRED` | 410 | The upload capability's TTL elapsed, or it was never created |
| `MEDIA_OBJECT_NOT_FOUND` | 409 | A variant's bytes were never PUT before commit |

The full catalog is in [Diagnostic codes](../reference/diagnostics.md).

## Source
- [`docs/media-uploads.md`](../../../docs/media-uploads.md)
- [`docs/adr/0017-media-multi-variant-agent-side-optimization.md`](../../../docs/adr/0017-media-multi-variant-agent-side-optimization.md)
- [`packages/mantle-runtime/src/domain/port/MediaStorage.ts`](../../../packages/mantle-runtime/src/domain/port/MediaStorage.ts)
- [`packages/mantle-runtime/src/domain/port/MediaAssetRepository.ts`](../../../packages/mantle-runtime/src/domain/port/MediaAssetRepository.ts)
- [`packages/mantle-spec/src/domain/service/SiteDefaultsValidator.ts`](../../../packages/mantle-spec/src/domain/service/SiteDefaultsValidator.ts)
- [`packages/mantle-spec/src/kernel/diagnostic.ts`](../../../packages/mantle-spec/src/kernel/diagnostic.ts)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`skills/media-gc/SKILL.md`](../../../skills/media-gc/SKILL.md)
