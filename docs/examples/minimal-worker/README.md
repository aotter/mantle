# Minimal Worker reference

This is a directly authored, API-only application and executable consumer test.
It is not a template catalog or CLI generator. The notes Schema/View is example
business data; `mantle generate` never invents it.

For a human-facing first run, follow
[Start: a local Worker and Admin](../../handbook/start/quickstart-worker.md):
interview, local D1, then email-OTP sign-in to Admin. This reference stays
API-only so generate / validate / curl stay small. It has no visitor homepage
and no Admin login until you add `@aotter/mantle-admin-ui` and an `auth`
factory.

For your own project, author package.json, manifests, Worker/provider config
and TypeScript settings for your requirements. Pin all selected `@aotter/mantle*`
dependencies to the same intended release. Core's test runner substitutes its
exact candidate in a disposable copy.

Outside the SDK workspace, with Node 22+ and pnpm 9+:

```sh
pnpm install
pnpm check
pnpm dev
```

Commit the resolved lockfile in a real application and use frozen installs
subsequently. `generate` writes `.mantle/generated/mantle.ts`; `skills` separately
projects version-matched instructions. Public GET `/api/views/published-notes`
returns an empty result against fresh local D1. `/` is 404: no visitor frontend
is installed or rendered. Conventional Auth on this reference is incomplete on
purpose (`MANTLE_AUTH_MODE=self-managed` without GitHub credentials), so
`/admin` and `/mcp/staff` fail closed with `503 setup_incomplete`. That is not
the local Admin OTP path.

`mantle-web` is optional runtime document composition; it does not generate a
home page. Add application-owned routes/templates/frontend only when needed.
Configure real D1 identity and the chosen auth mode before any remote deploy;
never copy test names over an existing project's bindings or commit secrets.

Maintainers run `pnpm check:worker-consumer` from the SDK root for exact packed
packages. The release controller also runs the same check against public npm
artifacts before promoting any public channel.
