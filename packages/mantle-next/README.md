# Mantle (experimental)

Generate typed native queries for Bun SQLite/PostgreSQL and Cloudflare D1/PostgreSQL
from closed v2 manifests. Compilation uses Core at build time.

```sh
pnpm --dir packages/mantle run build
pnpm --dir packages/mantle-next run build
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts
pnpm exec wrangler dev --local
```

Apply `schema.sql` to an empty development database; migrations are application-owned.
Import `views/<encoded-name>.ts` or
`procedures/<encoded-name>.ts` and pass `(db, caller, input)`. Supply a verified
Caller, validate external inputs, and use driver-ready values.

`store(db, caller).collection(tableName)` provides typed reads, keyset paging,
writes with OCC and atomic batches. SQLite/PostgreSQL support interactive
transactions; use the passed transaction Store. Workers generation configures
Wrangler's split build. Load Better Auth dynamically through the app's auth module.

See [query contracts](../../docs/next/contract.md),
[Store policy](../../docs/adr/0045-next-runtime-core.md),
[auth](../../docs/next/auth.md) and
[size/startup gates](../../docs/next/size-and-startup.md).
Published declarations omit duplicate JSDoc; source documentation remains.
This is not a release.
