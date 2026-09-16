# Minimal Worker reference

This is a directly authored, API-only application and executable consumer test.
It is not a Starter, template catalog or CLI generator. The notes Schema/View
is example business data; `mantle generate` never invents it.

For your own project, author package.json, manifests, Worker/provider config
and TypeScript settings for your requirements. Pin all selected `@aotter/mantle*`
dependencies to the same intended release. This reference records alpha.17 as
its last published baseline; Core's test runner substitutes its exact candidate
in a disposable copy, including during a future release.

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
is installed or rendered. Auth routes fail closed until auth is configured.
No provider resources or secrets are needed for this local reference.
The View declares a one-hour shared-cache hint and the Worker supplies the
stable `minimal-worker-local` cache scope; authenticated requests remain private.

`mantle-web` is optional runtime document composition; it does not generate a
home page. Add application-owned routes/templates/frontend only when needed.
Configure real D1 identity and the chosen auth mode before any remote deploy;
never copy test names over an existing project's bindings or commit secrets.

Maintainers run `pnpm check:worker-consumer` from the SDK root for exact packed
packages. The release controller also runs the same check against public npm
artifacts before promoting any public channel.
