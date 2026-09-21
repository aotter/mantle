# @aotter/mantle-auth

Optional Better Auth identity for Mantle: staff roles, email OTP, magic link,
social sign-in, and the OAuth 2.1 / MCP authorization surface.

Host-neutral. It takes a Mantle `DatabaseDriver` for its own SQL and the Better
Auth schema migration, plus the **same** underlying store in whatever form
Better Auth accepts. Auth SQL is SQLite-shaped and expects JSON1; a
non-SQLite `DatabaseDriver` is not a supported auth backend in v0.1.

`database` and `driver` must wrap one store. Splitting them splits schema
migration from Better Auth's own reads.

Client IP / rate-limit identity is **required and fail-closed**. Pass only
headers the host ingress overwrites. Never default to client-controlled
`X-Forwarded-For`. Cloudflare `createAuth` supplies `cf-connecting-ip`. Bun
and Vercel hosts must pass their own trusted header(s) when they wire this
package — that adapter work is follow-up, not included here.

This package's `createMantleAuth.js` build output is listed under
`sideEffects` because it seeds Better Auth's AsyncLocalStorage stores at
import time. Do not mark that file side-effect-free.

```ts
import { createMantleAuth } from "@aotter/mantle-auth";
import { D1DatabaseDriver } from "@aotter/mantle-cloudflare";

const auth = createMantleAuth({
  database: env.DB,
  driver: new D1DatabaseDriver(env.DB), // same store as `database`
  ipAddressHeaders: ["cf-connecting-ip"],
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.PUBLIC_ORIGIN,
  methods: [{ kind: "email-otp", sender }],
});
```

On Cloudflare, `@aotter/mantle-cloudflare` wires this for you: `createAuth`
takes the D1 binding and an optional KV session cache, constructs
`D1DatabaseDriver` over that same binding, and passes
`ipAddressHeaders: ["cf-connecting-ip"]`.

Install it alongside the exact same version as every other `@aotter/mantle*`
package, and provide `better-auth` yourself.
