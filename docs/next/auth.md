# Auth in Next

Next does not wrap Better Auth. Your application writes its own `auth.ts` with the official `betterAuth()` and
official plugins. Next supplies only what Better Auth cannot know:

| Next | What it does |
| --- | --- |
| `@aotter/mantle-next/auth/adapter` | `d1Adapter(env.DB)` / `bunSqlAdapter(sql)`: Better Auth's `database` on the same native handle as your data, no Kysely. Passes Better Auth's official adapter suite (`@better-auth/test-utils/adapter`). |
| `mantle-next generate … --auth ./auth.ts` | Adds the tables Better Auth declares for your options (`getSchema`) to `schema.sql`. |
| `@aotter/mantle-next/auth` | `authLoader` and `resolveCaller(request, loader, { audience })`: the `Caller` that generated queries take. |

## `auth.ts`

```ts
import { betterAuth } from "better-auth/minimal"; // the entry without Kysely
import { emailOTP, jwt } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { oauthProvider } from "@better-auth/oauth-provider";
import { d1Adapter } from "@aotter/mantle-next/auth/adapter";
import type { BetterAuthOptions } from "better-auth";

// Plain options: `mantle-next generate --auth` reads them without constructing Better Auth.
export const authOptions = (env: Env) => ({
  database: d1Adapter(env.DB),
  secret: env.AUTH_SECRET,
  // Include the auth path: the resource client checks a token's issuer against baseURL (#1462).
  baseURL: `${env.ORIGIN}/api/auth`,
  rateLimit: { enabled: true, storage: "database" },
  plugins: [
    // Better Auth hands you the code and its purpose: no parsing of a rendered email.
    emailOTP({ storeOTP: "hashed", sendVerificationOTP: ({ email, otp, type }) => env.MAIL.send({ email, otp, type }) }),
    admin(), // user.role: Mantle staff roles are "owner" | "editor" | "contributor"; other roles map to no staff role
    jwt(),
    // MCP clients get access tokens for your resource; pass the same value as resolveCaller's audience.
    oauthProvider({ loginPage: "/login", consentPage: "/consent", resources: [`${env.ORIGIN}/mcp`] }),
  ],
}) satisfies BetterAuthOptions;
export const createAuth = (env: Env) => betterAuth(authOptions(env));
```

Anything Mantle 0.2's `createMantleAuth` decided for you (first user becomes owner, invitations, cookie prefix) is now
ordinary Better Auth configuration (`databaseHooks`, `advanced.cookiePrefix`, plugin options) in this file.

## Worker entry

```ts
import { authLoader, resolveCaller } from "@aotter/mantle-next/auth";
import { views } from "./generated/generated.js";

let auth: ReturnType<typeof authLoader> | undefined;
export default {
  async fetch(request: Request, env: Env) {
    // import(): Better Auth stays out of the entry module (see Build)
    auth ??= authLoader(() => import("./auth.js").then(m => m.createAuth(env)));
    const url = new URL(request.url);
    if (url.pathname === "/catalog") return Response.json(await views.catalog(env.DB, { kind: "anonymous" }, {})); // public: no auth at all
    if (url.pathname.startsWith("/api/auth/")) return (await auth.get()).handler(request);
    const headers = new Headers(); // receives a refreshed session cookie, so the session slides
    const caller = await resolveCaller(request, auth, { audience: `${env.ORIGIN}/mcp`, responseHeaders: headers });
    // … generated Views and Procedures with `caller`, then: return Response.json(result, { headers })
  },
};
```

`resolveCaller` uses Better Auth's own API only. With no credentials it never loads Better Auth. A session cookie is
validated by `auth.api.getSession` without the cookie cache, so revocation and role changes apply on the next request.
A `Bearer` access token is verified by the official resource client for `audience`, and the user (role, ban) is read
from the database on every request. An invalid token is `UNAUTHENTICATED`, never anonymous. Public routes must not call it.

If you set `advanced.cookiePrefix`, pass the same value: `authLoader(load, "app")`. A renamed
`advanced.cookies.session_token.name` is refused, because Better Auth's `getSessionCookie` cannot find it.

## Build: keep Better Auth out of startup

Workers compiles an uploaded module only when it is imported. Better Auth in its own module therefore costs a cold
isolate nothing until a request needs it. Measured on production Workers (#1462), startup was 1 ms instead of 77 ms
eager or 32 ms for `import()` inside one bundle.
Wrangler's own bundler inlines every `import()` into one script, so bundle with splitting and upload the modules as
they are:

```sh
bun build src/worker.ts --splitting --format esm --target browser --minify --outdir dist
```

```jsonc
// wrangler.jsonc
{ "main": "dist/worker.js", "no_bundle": true, "find_additional_modules": true, "base_dir": "dist",
  "rules": [{ "type": "ESModule", "globs": ["**/*.js"] }] }
```

`tests/auth-split.test.ts` checks this shape: the entry plus every chunk it imports statically stays under 4 KiB.

## Schema

`mantle-next generate <target> <out> <manifest>… --auth ./auth.ts` calls the module's `authOptions` with an empty env
(the tables depend on plugins and options, not env values; nothing is constructed) and appends Better Auth's tables to `schema.sql`. Nothing runs DDL at runtime; migrations
are yours (#1463).
