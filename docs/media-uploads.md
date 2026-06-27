# Optional R2 Media Uploads

Mantle supports staff media uploads through Staff MCP tools:
`create_media_upload` and `commit_media_upload`. This is an optional
post-launch feature for sites that need staff-managed images or files.

Do not make R2 part of the Day 1 launch path. Cloudflare R2 setup may
require billing or a credit card, so landing and the blank starter do not
provision it by default.

## When To Enable

Enable this after the site already has:

- a working Cloudflare Worker deploy;
- staff auth configured;
- a real need for staff or an agent to upload images/files.

Use Claude Code, Codex, Cursor, or another local/non-sandboxed coding
agent for media maintenance. Claude Cowork often cannot complete this
flow because the final upload is a direct HTTP PUT to
`*.r2.cloudflarestorage.com`; only use Cowork if its sandbox egress
allowlist includes that host.

## How It Works

The upload flow is deliberately split:

1. The agent calls Staff MCP `create_media_upload` with purpose, variant
   metadata, byte sizes, and mime types.
2. Mantle returns signed upload URLs and required headers.
3. The agent reads the local/chat attachment bytes and PUTs them directly
   to R2.
4. The agent calls `commit_media_upload`.

Do not pass image bytes or base64 payloads through MCP tool arguments.
The Worker validates policy; the agent runtime performs file processing
and upload.

## Cloudflare Setup

Create a bucket and public read URL:

```bash
wrangler r2 bucket create <project>-media
wrangler r2 bucket dev-url enable <project>-media
```

In the Cloudflare dashboard, create an R2 S3 API token:

1. Open **R2**.
2. Open **Manage R2 API Tokens**.
3. Create an Object Read & Write token.
4. Copy the Access Key ID and Secret Access Key.

The R2 binding alone cannot issue presigned PUT URLs; Mantle also needs
these S3-compatible credentials.

## `wrangler.toml`

```toml
[vars]
R2_ACCOUNT_ID = "<account-id>"
MEDIA_PUBLIC_URL_BASE = "https://pub-<hash>.r2.dev"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "<project>-media"
```

Set secrets:

```bash
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

## `src/mantleConfig.ts`

```ts
import { R2MediaStorage, type CmsConfig } from "@aotter/mantle/cloudflare";
import { AwsClient } from "aws4fetch";

export interface Env {
  readonly MEDIA_BUCKET?: R2Bucket;
  readonly R2_ACCOUNT_ID?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly MEDIA_PUBLIC_URL_BASE?: string;
}

function buildMediaStorage(env: Env): CmsConfig["bindings"]["mediaStorage"] {
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

Then wire it into the CMS config:

```ts
siteDefaults: {
  media: {
    purposes: [
      {
        name: "page-image",
        required: ["image/jpeg,image/png,image/webp,image/gif"],
        maxBytes: {
          "image/jpeg": 5_000_000,
          "image/png": 5_000_000,
          "image/webp": 5_000_000,
          "image/gif": 10_000_000,
        },
      },
    ],
  },
},
bindings: {
  mediaStorage: buildMediaStorage(env),
},
```

`required` is slot-based. The example above has one slot, so the agent
must choose exactly one mime type from the comma-separated list for that
slot. It should not upload one variant per listed mime unless the policy
declares multiple slots.

## Tool Visibility

The Staff MCP media tools are registered only when both are true:

- `bindings.mediaStorage` is set;
- `siteDefaults.media.purposes` contains at least one purpose.

If either side is missing, `create_media_upload` and
`commit_media_upload` will not appear in `tools/list`.

## Agent Guidance

For image maintenance, prefer Claude Code or another coding agent that can
read local files, process images, and make outbound PUT requests to R2.
Avoid Claude Cowork for this workflow unless its egress allowlist includes
`*.r2.cloudflarestorage.com`.

Preserve source semantics:

- photos may use JPEG/WebP variants;
- transparent logos must keep alpha;
- animated GIFs must stay animated;
- do not silently flatten, resize, or recompress user assets without
  asking.
