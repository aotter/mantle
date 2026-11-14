---
description: "Before the first deploy, pick how the application's users sign in: email code, GitHub or email and password. What each costs, and a recipe for each from the `mantle init` app."
---
# Choose how users sign in

`mantle init` signs users in with a one-time code by email. Locally the code prints in the `pnpm dev` log, so nothing
needs setting up. A deployment cannot print codes: before the first deploy, pick one of the three methods below and
apply its recipe to the files `init` wrote, which are yours. Pick before real users sign up: moving users from one
method to another is not covered here, and an account made with a password cannot later sign in with GitHub on the same
address (Better Auth answers "account not linked").

| | Email one-time code | GitHub sign-in (recommended) | Email and password |
| --- | --- | --- | --- |
| You set up | An email sender ([below](#email-one-time-code)) | A GitHub OAuth App: client ID, client secret, callback URL | Nothing outside the app |
| The app stores | Hashed one-time codes, for minutes | No password: the GitHub account id, profile and GitHub's access token, encrypted | A hash of every password |
| Who can join | Anyone who receives mail at the address, unless `src/signup.ts` restricts it | Anyone with a GitHub account, unless `src/signup.ts` restricts it | Anyone who types an address: addresses are not checked |
| What it costs | A sender; Cloudflare's own needs your domain on Cloudflare | Every user needs a GitHub account | Workers Paid, from $5 a month ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)); you make the first admin by hand in a terminal; only an admin can reset a password |
| If it is misconfigured | No code arrives: nobody signs in, the admin included | GitHub refuses the callback or the secret: nobody signs in | On Workers Free, sign-up and sign-in fail on the CPU limit |

**Recommended: GitHub sign-in.** The application never holds a password, so a copied database or log leaks none, and
GitHub checks the address and can require two-factor sign-in. Email code also holds no password, but needs a sender.

Each recipe starts from a fresh `mantle init` app. Template edits are diffs; new files are complete. Then run
`pnpm generate`, `pnpm types`, `pnpm check` and `pnpm smoke`, and follow
[the first deploy](deploy-and-operate.md#before-the-first-deploy).

## Email one-time code

Keep the template; replace the console sender in `src/auth.ts` (`AGENT:` marks it) with a real one, wired as in
[transactional email](../guides/email.md). `ADMIN_EMAIL`'s first sign-in becomes the admin: the code proves the
address.

- **Cloudflare Email Service** (the `send_email` binding): "You must be using Cloudflare DNS to use Email Service", so
  the sending domain is a zone on your account ([send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/)).
  Sending to any recipient needs Workers Paid; on Free it reaches only verified addresses of your own account
  ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)). It is in beta.
- **Another provider's HTTP API**, called from your `EmailSender`: the domain need not be on Cloudflare; the provider's
  domain rules apply, and its API key is one more secret.

Verified: the dev-log code with `pnpm smoke` and `pnpm accept`; no production sender was exercised.

## GitHub sign-in

`src/auth.ts` adds GitHub, encrypts GitHub's token at rest with `BETTER_AUTH_SECRET`, and keeps the dev-log code only
on a local origin, so `pnpm smoke` and `pnpm accept` still sign in without GitHub:

```diff
+  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
   const plugins = [
     admin({ … }),
-    emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ email, otp }) => {
+    // The dev-log code stays for local runs (pnpm smoke, pnpm accept); a deployment signs in with GitHub only.
+    ...(local ? [emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ email, otp }) => {
       …
-    } }),
+    } })] : []),
   …
   return { database: d1Adapter(env.DB), secret, baseURL: origin, basePath: "/api/auth", plugins,
+    // Sign in with GitHub: an OAuth App whose callback URL is ${PUBLIC_ORIGIN}/api/auth/callback/github.
+    socialProviders: { github: { clientId: env.GITHUB_CLIENT_ID || "schema-generation-placeholder", clientSecret: env.GITHUB_CLIENT_SECRET || "schema-generation-placeholder" } },
+    account: { encryptOAuthTokens: true },
   …
-  if (!env.BETTER_AUTH_SECRET || !env.PUBLIC_ORIGIN || !env.ADMIN_EMAIL) throw new Error("Authentication setup is incomplete.");
+  if (!env.BETTER_AUTH_SECRET || !env.PUBLIC_ORIGIN || !env.ADMIN_EMAIL || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error("Authentication setup is incomplete.");
```

`src/service.ts` lists the methods Admin's sign-in page shows:

```diff
-authRoutes(auth!, { methods: [{ kind: "email-otp" }], resolver: caller })
+authRoutes(auth!, { methods: [{ kind: "social", provider: "github" }, ...(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(env.PUBLIC_ORIGIN) ? [{ kind: "email-otp" as const }] : [])], resolver: caller })
```

`wrangler.jsonc` makes a deploy refuse to upload without the two secrets. Add both to `.dev.vars`, then run
`pnpm types`. Placeholder values are enough locally, because local runs sign in with the code:

```diff
       "PUBLIC_ORIGIN",
-      "ADMIN_EMAIL"
+      "ADMIN_EMAIL",
+      "GITHUB_CLIENT_ID",
+      "GITHUB_CLIENT_SECRET"
```

```sh
printf 'GITHUB_CLIENT_ID=local-placeholder\nGITHUB_CLIENT_SECRET=local-placeholder\n' >> .dev.vars
```

The OAuth App ([GitHub's steps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)):
Settings → Developer settings → OAuth Apps → New OAuth App, with Homepage URL `PUBLIC_ORIGIN` and Authorization callback
URL `PUBLIC_ORIGIN` followed by `/api/auth/callback/github`; then generate a client secret, which GitHub shows once.
Create the production one at the deploy, once the origin is settled
([step 6](deploy-and-operate.md#before-the-first-deploy)). To try the GitHub button locally, create a second one for
`http://127.0.0.1:8787` and put its values in `.dev.vars`; the production secret never goes there.

**The first admin.** The unchanged rule promotes `ADMIN_EMAIL` when GitHub reports that address as verified: the
account's public email, else its primary one. To name the GitHub username instead, store it and let only GitHub's
callback set it ([`guardGithubLogin`](authentication.md#auth-ts)). `mantle generate` then adds a `githubLogin` column
(a deployed database needs a migration), and `ADMIN_GITHUB_LOGIN` joins `secrets.required` and `.dev.vars`:

```diff
-import { authHardening, hashEmailOtp } from "@aotter/mantle/auth/hardening";
+import { authHardening, guardGithubLogin, hashEmailOtp } from "@aotter/mantle/auth/hardening";
…
-  const bootstrap = env.ADMIN_EMAIL ? d1BootstrapAdmin(env.DB, { match: "email", value: env.ADMIN_EMAIL }, () => ({ options: { plugins } })) : async () => {};
+  const bootstrap = env.ADMIN_GITHUB_LOGIN ? d1BootstrapAdmin(env.DB, { match: "github-login", value: env.ADMIN_GITHUB_LOGIN }, () => ({ options: { plugins } })) : async () => {};
…
-    socialProviders: { github: { clientId: …, clientSecret: … } },
+    socialProviders: { github: { clientId: …, clientSecret: …,
+      mapProfileToUser: profile => ({ githubLogin: profile.login }) } },
+    user: { additionalFields: { githubLogin: { type: "string", required: false, input: false } } },
…
-    databaseHooks: { user: { create: { before: admit, after: bootstrap }, update: { after: bootstrap } } },
+    databaseHooks: { user: {
+      // Only GitHub's own callback may set githubLogin, which the bootstrap rule trusts.
+      create: { before: async (user, context) => { await admit(user); return guardGithubLogin(user, context); }, after: bootstrap },
+      update: { before: async (user, context) => guardGithubLogin(user, context), after: bootstrap } } },
```

> **Verification status:** the GitHub social-provider recipe has not yet been exercised end to end against a real
> GitHub OAuth App. Verified locally: everything short of GitHub's own redirect and callback.

## Email and password

Admin's sign-in page has no password form, so the application adds one through the Admin `SignIn` slot
([Customising Admin](../guides/native-admin.md#sign-in)) and turns on Better Auth's `emailAndPassword`. What that means:

- **Workers Paid.** Better Auth hashes each password with scrypt; one hash took 70–100 ms of CPU in local workerd, and
  every sign-up and sign-in computes one. Workers Free allows 10 ms of CPU per request, Paid 30 s
  ([limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)). Do not lower the hash cost to fit.
- **Addresses are not checked.** Without an email sender nothing proves an address, so whoever types one first owns it,
  even one that `src/signup.ts` allows by exact address. Do not trust `email` for access. For a closed group, turn off
  sign-up after the first admin exists and create accounts as an admin ([below](#a-closed-group)).
- **Guessing.** Better Auth allows 3 sign-in or sign-up requests per 10 seconds per client IP; nothing limits one
  account across many IPs. On a custom domain, a Cloudflare
  [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on `/api/auth/sign-in` adds one.

### The recipe

`src/auth.ts` drops the email code and turns on passwords. `mantle generate` adds nothing to `schema.sql`:
`account.password` is already there.

```diff
-import { admin, emailOTP, jwt } from "better-auth/plugins";
+import { admin, jwt } from "better-auth/plugins";
…
-import { authHardening, hashEmailOtp } from "@aotter/mantle/auth/hardening";
+import { authHardening } from "@aotter/mantle/auth/hardening";
…
-    emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ email, otp }) => {
-      …
-    } }),
…
   return { database: d1Adapter(env.DB), secret, baseURL: origin, basePath: "/api/auth", plugins,
+    emailAndPassword: { enabled: true, minPasswordLength: 12 },
…
-    // Trusted client IP header and Better Auth's database rate limiter (3 OTP requests per minute per IP).
+    // Trusted client IP header and Better Auth's database rate limiter (3 sign-in or sign-up requests per 10 seconds per IP).
```

`src/service.ts` lists no built-in method, so Admin shows only the slot; `src/signup.ts` stops promising a verified
address:

```diff
-authRoutes(auth!, { methods: [{ kind: "email-otp" }], resolver: caller })
+authRoutes(auth!, { methods: [], resolver: caller })
```

```diff
- * Who may create an account. Better Auth calls this (through `databaseHooks.user.create.before` in auth.ts) only when a
- * verified email has no user yet; existing users and ADMIN_EMAIL always sign in. Return false to refuse sign-up (403).
+ * Who may create an account. Better Auth calls this (through `databaseHooks.user.create.before` in auth.ts) when an
+ * account is created. Passwords check no address: whoever types an address first gets it. Return false to refuse (403).
```

The Admin form passes `oauthQuery` on, so an MCP connector's sign-in continues to its consent page:

```tsx
// src/password-sign-in.tsx
import * as React from "react";
import type { SignInProps } from "@aotter/mantle-admin/app";

const failure = (mode: "sign-in" | "sign-up", status: number) =>
  status === 429 ? "Too many attempts. Wait a few seconds and try again."
    : mode === "sign-in" ? (status === 403 ? "This account is blocked." : "Wrong email or password.")
    : status === 422 ? "An account with this email already exists."
    : status === 403 ? "This email cannot sign up here." : "Could not create the account.";

/** Email and password on /admin/sign-in, through Better Auth's own endpoints. */
export function PasswordSignIn({ oauthQuery, returnTo, onSignedIn }: SignInProps) {
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")), password = String(form.get("password"));
    const body = { email, password, ...(mode === "sign-up" ? { name: email.split("@")[0] } : {}),
      // An MCP connector's sign-in continues its OAuth authorization: Better Auth answers with that URL.
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}) };
    const response = await fetch(`/api/auth/${mode}/email`, { method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (response.ok) return onSignedIn(((await response.json()) as { url?: string }).url ?? returnTo);
    setError(failure(mode, response.status));
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      <label className="grid gap-1 text-sm">Email
        <input name="email" type="email" autoComplete="email" required className="rounded-md border px-3 py-2" />
      </label>
      <label className="grid gap-1 text-sm">Password
        <input name="password" type="password" minLength={12} maxLength={128} required
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"} className="rounded-md border px-3 py-2" />
      </label>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-2 text-primary-foreground">
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
      <button type="button" className="text-sm underline" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
        {mode === "sign-in" ? "Create an account" : "I already have an account"}
      </button>
    </form>
  );
}
```

```tsx
// src/admin.tsx (or add SignIn to the components of the one you have)
import { defineAdmin } from "@aotter/mantle-admin/app";
import { admin } from "../generated/admin-client.js";
import { PasswordSignIn } from "./password-sign-in.js";

export default defineAdmin(admin, { components: { SignIn: PasswordSignIn } });
```

The member page at `/sign-in` signs in, creates an account, or changes a password (it signs in with the current one
first, then signs out every other device):

```ts
// src/sign-in.ts
/**
 * Member sign-in for app pages (Admin has its own at /admin/sign-in): email and password through Better Auth's own
 * endpoints, then back to `?return=`. A member page calls `signInRedirect(request)` when `await caller()` is anonymous.
 */
export function signInRedirect(request: Request): Response {
  const url = new URL(request.url);
  return new Response(null, { status: 303, headers: { location: `/sign-in?return=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
}

export function signInPage(): Response {
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in</title>
<h1>Sign in</h1>
<form id="sign-in"><label>Email <input type="email" name="email" autocomplete="email" required></label>
<label>Password <input type="password" name="password" autocomplete="current-password" minlength="12" maxlength="128" required></label>
<label>New password, to change it <input type="password" name="next" autocomplete="new-password" minlength="12" maxlength="128"></label>
<button value="sign-in">Sign in</button> <button value="sign-up">Create account</button> <button value="change">Change password</button></form>
<p id="status" role="status"></p>
<script type="module">
const status = document.getElementById("status"), form = document.getElementById("sign-in");
// Only same-site paths: an open redirect would hand the fresh session's tab to another site.
const back = new URLSearchParams(location.search).get("return");
const target = back && new URL(back, location.origin).origin === location.origin ? back : "/";
// Better Auth takes JSON at its own endpoints.
const post = (path, body) => fetch("/api/auth/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
form.onsubmit = async event => {
  event.preventDefault();
  const action = event.submitter.value, email = form.email.value, password = form.password.value;
  if (action === "change" && !form.next.value) return void (status.textContent = "Type the new password.");
  let response = await post(action === "sign-up" ? "sign-up/email" : "sign-in/email", { email, password, name: email.split("@")[0] });
  if (response.ok && action === "change") response = await post("change-password", { currentPassword: password, newPassword: form.next.value, revokeOtherSessions: true });
  if (response.ok) return location.assign(target);
  status.textContent = response.status === 429 ? "Too many attempts. Wait a few seconds and try again."
    : action === "sign-up" ? (response.status === 422 ? "An account with this email already exists." : response.status === 403 ? "This email cannot sign up here." : "Could not create the account.")
    : response.status === 403 ? "This account is blocked." : "Wrong email or password, or the new password is too short.";
};
</script>
`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
```

The acceptance kit signs in with a password and promotes the owner by id, as on a deployment. In `smoke-kit.mjs`,
replace `signIn`; `pnpm smoke` and `pnpm accept` need nothing else:

```js
/** Email and password: create the account on first use, sign in; the owner is promoted by id, as on a deployment. Returns the cookie header. */
const signIn = async email => {
  const ip = ipOf(email), password = `local-password-${email}`;
  const created = await call("POST", "/api/auth/sign-up/email", { body: { email, password, name: email.split("@")[0] }, ip });
  assert.ok(created.status === 200 || created.status === 422, JSON.stringify(created.body));
  const signed = await call("POST", "/api/auth/sign-in/email", { body: { email, password }, ip });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  if (email === owner) await sql(`UPDATE "user" SET role = 'admin' WHERE id = '${signed.body.user.id}' AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')`);
  return signed.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
};
```

### The first admin

The bootstrap rule needs a proven address, so it never promotes a password account. Right after the first deploy:

1. On `/admin/sign-in`, choose **Create an account** and sign up with `ADMIN_EMAIL`. If it says an account with this
   email already exists, someone else took the address: delete that account from your terminal, then sign up again
   right away.

   ```sh
   pnpm exec wrangler d1 execute DB --remote --command "DELETE FROM \"user\" WHERE email = 'you@example.com'"
   ```

2. Open `/api/auth/get-session` in the same browser and copy `user.id`.
3. Promote exactly that account:

   ```sh
   pnpm exec wrangler d1 execute DB --remote --command "UPDATE \"user\" SET role = 'admin' WHERE id = '<user.id>' AND email = 'you@example.com' AND NOT EXISTS (SELECT 1 FROM \"user\" WHERE role = 'admin')"
   ```

More admins: the person signs up, you confirm with them that they made that account (a matching address proves
nothing), then **More → Members** grants Admin. **More → Administrators** invitations do not work with passwords.

### A closed group

Once you are admin, set `emailAndPassword: { enabled: true, minPasswordLength: 12, disableSignUp: true }` and deploy
again. Sign-up then answers 400, and an admin creates each account with a temporary password
([below](#forgotten-passwords-and-new-accounts)); the person changes it on `/sign-in`.

### Forgotten passwords and new accounts

There is no self-service reset: a reset link needs an email sender, and Admin has no reset button. An admin sets a
temporary password, tells the person, and the person changes it on `/sign-in`. Both calls run in the browser console on
an `/admin` page while you are signed in as admin; type them yourself and never paste code someone sends you. The id
comes from `/admin/api/members?search=<email>`:

```js
// a new account (closed group)
await fetch("/api/auth/admin/create-user", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "<email>", name: "<name>", password: "<temporary password>", role: "user" }) });
// a forgotten password: also signs that person out everywhere and ends their MCP connections
await fetch("/api/auth/admin/set-user-password", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: "<id>", newPassword: "<temporary password>" }) });
```

Verified on `wrangler dev --local`: every step of this recipe, with `--local` for `--remote`; not CPU time on Cloudflare.
