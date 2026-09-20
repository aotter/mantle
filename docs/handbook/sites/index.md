---
description: "Build with ChatGPT Sites. Manage content and publishing with Mantle."
---
# Mantle on ChatGPT Sites

**Build with ChatGPT Sites. Manage content and publishing with Mantle.**

Give your Site an editorial workflow: sign in, invite editors, upload a cover
image, save a draft, and publish an article. Mantle connects the Admin console,
public pages, and agent tools to the same content model, so your team can keep
the site current after the first build.

ChatGPT Sites is a first-class integration in Mantle's official documentation,
with a runnable reference and a repeatable verification flow maintained in this
repository. Sites owns hosting, visitor access, and ChatGPT sign-in; Mantle owns
the content model, staff roles, and publishing workflow. For platform access and
sharing options, see [OpenAI's Sites documentation](https://learn.chatgpt.com/docs/sites).

## What you get

| Capability | In the Mantle Sites reference |
|---|---|
| Content management | Admin for drafting, editing, publishing, and unpublishing articles stored in D1. |
| Staff access | ChatGPT sign-in with Mantle owner, editor, and contributor roles. Site visitor access grants no Mantle staff role. |
| Images | Admin uploads through the Site's R2 binding, with public URLs for committed images. No R2 S3 credentials required. |
| Public pages | Published article HTML and Markdown, cover images, canonical metadata, JSON-LD, sitemap, and `llms.txt`. |
| Agent access | Admin WebMCP through the browser session; anonymous, read-only public Views at `/api/mcp`. |

Remote staff MCP with OAuth and automatic ChatGPT connector registration are
outside the reference's current scope. Public media URLs are readable by anyone
who can reach the Site; this integration does not implement private media.
See the [host reference](./host-reference.md) for the exact trust and transport
boundaries.

## Start with the supported SDK

**Release status:** this revision needs the new host-declared MCP endpoint
support. Published `0.1.2-alpha.6` does not contain it. Use the
[packed-checkout installation](../../examples/host-chatgpt-sites/README.md#local-reproduction)
to build this exact SDK and its reference application together. It records the
source commit and package hashes. A registry-only installation becomes the
starting path after a release includes this support and the example's dependency
versions and lockfile are updated together.

You need Node.js 22+, pnpm 9+, and Sites access with D1 and R2 available for your
project. Follow the reference's local build and smoke test before deployment.
Keep your application outside the SDK checkout. The included article schema is
a working example; adapt its fields and lifecycle to your team's content.

## Publish your first article

1. **Prepare the application.** Follow the
   [runnable reference](../../examples/host-chatgpt-sites/README.md#local-reproduction).
   Its local test verifies content, roles, images, public pages, and MCP together.
2. **Connect Sites.** Follow [Publish with Sites](../../examples/host-chatgpt-sites/README.md#publish-with-sites)
   to provision D1 and R2, set the production origin and first owner's email,
   and review the database migrations. Save a version, then deploy it through
   Sites for the intended audience.
3. **Sign in as the owner.** Open `/admin/sign-in` and use the configured owner's
   ChatGPT account. Give a second account an editor role in Mantle when you want
   someone else to manage content. Sites sharing and Mantle staff roles are
   separate controls.
4. **Create a draft.** In Admin, create an article with a title, summary, and
   Markdown body. Upload an image in the media library and select it as the
   article's cover. The draft's public article URL should return 404.
5. **Publish and read.** Publish the article and open `/articles`. Follow its
   link to check the body and cover, then open its `.md` version. For a public
   Site, repeat this while signed out. A restricted Site still enforces its
   audience settings before visitors reach these pages.
6. **Verify control.** Unpublish the article and confirm its detail page returns
   404. Revoke the second account's staff role and verify it can no longer edit.
   Published content and staff access should follow your changes immediately.

For later content edits, return to Mantle Admin. Changes to the application's
schema, code, or deployment settings follow the reference's migration and Sites
deployment workflow.

## Ask your agent to set it up

Give your agent the SDK checkout containing this integration and describe your
audience and content requirements:

```text
Build a content site with ChatGPT Sites and Mantle. Read
docs/handbook/sites/index.md and docs/examples/host-chatgpt-sites/README.md
from the matching Mantle SDK. Follow the documented installation path,
including packed-checkout installation while release support is pending.
Adapt the article example to my content requirements. Include ChatGPT
sign-in, Mantle staff roles, cover uploads, and published article pages.
Run the local checks and show me a draft-to-publish walkthrough before
deploying through Sites. Keep remote staff OAuth MCP outside this scope.
```

## Integration details

- [Host reference](./host-reference.md): identity, migrations, R2 routes, MCP, and deployment checks.
- [Runnable application](../../examples/host-chatgpt-sites/README.md): installation, build artifacts, and smoke tests.
- [Conventional Cloudflare Worker](../cloudflare/conventional-worker.md): the separate path for a Worker you deploy directly.

## Source

- [Runnable Sites application](../../examples/host-chatgpt-sites/README.md)
- [Sites host reference](./host-reference.md)
- [OpenAI Sites documentation](https://learn.chatgpt.com/docs/sites)
