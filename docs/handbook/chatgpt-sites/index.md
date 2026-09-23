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
| Agent access | Admin WebMCP, anonymous read-only public Views at `/api/mcp`, and Sites-session staff tools at `/api/mcp/staff`. |

Remote staff OAuth MCP and automatic ChatGPT connector registration are outside
the reference's current scope. Public media URLs are readable by anyone
who can reach the Site; this integration does not implement private media.
See the [host reference](./host-reference.md) for the exact trust and transport
boundaries.

## Start with the supported SDK

You need Node.js 22+, pnpm 9+, and Sites access with D1 and R2 available for your
project. Follow the reference's local build and smoke test before deployment.
Keep your application outside the SDK checkout. The included article schema is
a working example; adapt its fields and lifecycle to your team's content.

## Publish your first article

1. **Prepare the application.** Follow the
   [runnable reference](../../examples/host-chatgpt-sites/README.md#install-and-run).
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
   link to check the body and cover, then confirm the page head advertises
   its `.md` version with `rel="alternate"` and `type="text/markdown"`. For a public
   Site, repeat this while signed out. A restricted Site still enforces its
   audience settings before visitors reach these pages.
6. **Verify control.** Unpublish the article and confirm its detail page returns
   404. Revoke the second account's staff role and verify it can no longer edit.
   Published content and staff access should follow your changes immediately.

For later content edits, return to Mantle Admin. Changes to the application's
schema, code, or deployment settings follow the reference's migration and Sites
deployment workflow.

## Maintain content with an agent

The owner can use Admin WebMCP in a browser that supports it to let an agent
discover staff tools for drafts, publishing, and other permitted operations.
Open `/admin/dev/docs/webmcp` to see that browser surface and
`/admin/dev/docs/mcp` to see the Site's `/api/mcp` public read-only endpoint and `/api/mcp/staff`
staff endpoint. The latter uses the current Sites browser session and checks
the Mantle staff role on each request. It is useful to same-origin browser
code, but is not a remote OAuth MCP connector for a desktop agent. A remote
staff connector needs its own verified OAuth flow; see the [host reference](./host-reference.md#remote-mcp-is-a-separate-gate).

## Ask your agent to set it up

Install the Mantle agent plugin, or `@aotter/mantle` itself, then describe your
audience and content requirements:

```text
Build a content site with ChatGPT Sites and Mantle. Read
handbook/chatgpt-sites/index.md and examples/host-chatgpt-sites/README.md from the
installed Mantle docs, and follow that reference's install and run steps.
Adapt the article example to my content requirements. Include ChatGPT
sign-in, Mantle staff roles, cover uploads, and published article pages.
Run the local checks and show me a draft-to-publish walkthrough before
deploying through Sites. Keep remote staff OAuth MCP outside this scope.
```

For business rules beyond content, add: "use custom `ref` handlers and
application-owned tables as described in handbook/chatgpt-sites/equipment-checkout.md."

## Beyond content: operational workflows

Custom handlers can connect typed Mantle operations to application-owned
business rules and external services. See [Equipment checkout and external
notifications](./equipment-checkout.md) for a non-payment scenario: staff
approve equipment loans, atomically reserve a kit, and notify an equipment desk
in Slack without making approval depend on notification delivery.

This is an implementation guide and acceptance checklist, not an additional
feature installed by the article reference. It separates deployed integration
evidence from the equipment and Slack work still required in your application.

## Integration details

- [Host reference](./host-reference.md): identity, migrations, R2 routes, MCP, and deployment checks.
- [Equipment checkout](./equipment-checkout.md): custom business rules and external API delivery without payments.
- [Runnable application](../../examples/host-chatgpt-sites/README.md): installation, build artifacts, and smoke tests.
- [Conventional Cloudflare Worker](../cloudflare/conventional-worker.md): the separate path for a Worker you deploy directly.

## Source

- [Runnable Sites application](../../examples/host-chatgpt-sites/README.md)
- [Sites host reference](./host-reference.md)
- [OpenAI Sites documentation](https://learn.chatgpt.com/docs/sites)
