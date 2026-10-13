# Reference service

A directly authored shop using the single `@aotter/mantle` native SDK and the
`@aotter/mantle-admin` server/SPA and the pure `@aotter/mantle-ui` kit. The release gate runs this service from
exact packed tarballs (`scripts/check-worker-consumer.mjs`).

- `manifests/`: scoped orders, a stock CHECK, joins, grouping, native full-text
  search, atomic SQL Procedures, typed ref Procedures, REST and MCP exposure.
- `src/auth.ts`: app-owned Better Auth options and verified-email admin bootstrap;
  Better Auth loads dynamically, and local-only email OTPs print to the log.
- `src/handlers.ts`: scoped cancellation and stock restoration in one native
  batch. Order activity runs after commit with the actual caller, best effort,
  preserving the old after-hook semantics. Generated lifecycle Triggers are
  refused; this effect also covers the app's Admin entry writers.
- `src/pages.ts`: app-owned keysets for relevance and aggregate ordering outside
  the generator's automatic paging proofs. SQL applies cursors and LIMIT; the
  application does not read all rows and then paginate them.
- `src/service.ts` and `src/index.ts`: app-mounted auth, Admin, REST and both MCP
  surfaces, lazy MCP App HTML, and a bounded native weekly digest (20 pages).
  Scheduling belongs to the app, rather than a manifest schedule Trigger.
- `smoke.mjs`: explicitly applies deployment DDL to a fresh local D1, starts
  Wrangler, and exercises OTP, both user roles, REST, both MCP surfaces, Admin
  assets/editor save, search, scope, stock rollback, locks, activity and cron.

Outside the SDK workspace, use Node 22.22+ and pnpm 9+; pin all three packages to
one exact version. Then:

```sh
pnpm install
pnpm generate                   # lists required Handlers keys
pnpm exec tsc --noEmit           # implement listed handlers, then typecheck again
pnpm check                      # generation/check, typecheck, real local D1 smoke
cp .dev.vars.example .dev.vars  # set ADMIN_EMAIL and a random BETTER_AUTH_SECRET
pnpm exec wrangler d1 execute mantle-reference --local --file generated/schema.sql
pnpm dev                        # /admin; local OTP codes appear in this log
```

Apply initial DDL only to an empty development database. Production migrations
are reviewed application-owned artifacts; imports and requests do no schema
convergence. Configure a real email sender before deployment. `ADMIN_EMAIL`
receives the OSS `admin` role only after email verification; ordinary members
receive 403 from Admin.

Commit every generated TypeScript/SQL file and Wrangler edit; regenerate instead
of hand-editing them, and keep `dist/` untracked. The release gate replaces the
registry pins with exact tarballs; it does not use workspace links or an old Core
fallback. Follow the installed SDK README and native contract, not historical
plan-based `createMantle` instructions. Bare integers retain their driver's native
contract; the selected surfaces own wire conversions.
