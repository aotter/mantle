---
description: Generate a blank Mantle app for ChatGPT Sites, apply D1 migrations, and verify local Admin and MCP.
---
# Generate a ChatGPT Sites app

`mantle generate --host chatgpt-sites` creates a blank home, a D1-backed Runtime,
public API and MCP, and Mantle Admin. It adds no article Schema, media bucket, or
demo content. Edit `src/home.ts` and add your own manifests and handlers as needed.

```sh
mkdir my-site && cd my-site
npm init -y
npm pkg set type=module
npm install --save-exact @aotter/mantle
npx mantle generate --host chatgpt-sites
npm install
npx mantle generate
npm run build
npx wrangler d1 migrations apply my-site --local
```

The first generate declares the exact Mantle package versions it needs; the
second runs after those packages are installed. Review `drizzle/0000_mantle.sql`
before applying it. The D1 name comes from `wrangler.jsonc`. Generation does not
apply a migration, provision a Site, or publish one. `npm run build` removes the
old `dist` before copying the current migrations and Admin assets.

For local Admin, copy `.dev.vars.example` to `.dev.vars`, set `OWNER_EMAIL` to
the email of the ChatGPT account that will own this Site, and keep
`PUBLIC_ORIGIN` equal to the local URL. Run `npm run dev`, then open `/admin`.
To exercise the Sites identity contract locally, set `MANTLE_TEST_OWNER_EMAIL`
to the same email and run `npm run smoke:local`. That script refuses non-loopback
targets. Its identity headers are a local simulation; the production Worker
contains no identity-injection path and must run behind Sites' trusted
identity-stripping dispatcher. The generated Wrangler config disables the
independent `workers.dev` URL; do not add a direct Worker route. A passing local smoke does not verify a deployed
ChatGPT sign-in.

Without `OWNER_EMAIL`, sign-in grants no Mantle staff role. If the intended
owner signed in before configuration, their existing `sites_users` row remains
unprivileged. Configure the owner email and deliberately assign `role='owner'`
to that account's exact email and `chatgpt:` ID in D1, or reset a disposable
local database and sign in again. Mantle never gives ownership to the first
visitor.

The anonymous public MCP endpoint is `/api/mcp`; it discovers only public
manifest capabilities. `/api/mcp/staff` uses the current Sites browser session
and a Mantle staff role. Admin advertises these endpoints, and Admin WebMCP
works in supporting browsers. The staff endpoint is not a remote OAuth MCP
connector. A remote agent needs a separately implemented verified OAuth flow.

When a Schema changes, run `npx mantle generate --check` to detect drift, then
`npx mantle generate`. Review the newly appended SQL and apply pending D1
migrations before deploying code that expects the new Schema. Previous
migration files remain untouched; an unapplied migration keeps the old database
fingerprint, and managed boot refuses to use an older database. Sites owns
`.openai/hosting.json` project metadata and production D1 migration delivery.

For a complete article, media, and publishing example, use the
[Sites reference](../../examples/host-chatgpt-sites/README.md).

## Source

- [Sites generator](../../../packages/mantle/src/cli/generate-sites.ts)
- [Generated Sites templates](../../../packages/mantle/templates/chatgpt-sites)
- [Runnable Sites reference](../../examples/host-chatgpt-sites/README.md)
