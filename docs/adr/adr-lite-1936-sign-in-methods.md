# ADR-lite: Sign-in methods beyond email OTP

**Status:** Proposed, issue #1936. Builds on ADR-0014 (Better Auth owns sign-in) and keeps the app shell passwordless by default.

## Decision

- **Passkey is the recommended fast path; email OTP stays the first sign-in and the recovery path.** The app enables
  Better Auth's `@better-auth/passkey` plugin in its own `auth.ts`. Right after an OTP sign-in (a fresh session, which
  the plugin requires for registration by default) Admin offers to add a passkey; later sign-ins use the browser's
  passkey autofill, with "use an email code instead" always available. Admin gets list, rename and delete for passkeys.
- **Password is opt-in only**, and only together with `requireEmailVerification: true`, a minimum length of at least 12,
  Better Auth's `haveibeenpwned` plugin and `twoFactor` for admins.
- **Contract:** `authRoutes` `methods` gains `{ kind: "passkey" }` and `{ kind: "password" }`; Admin's sign-in page
  renders them. The WebAuthn browser client is loaded lazily, inside the UI size budgets.
- **Delivery:** the app shell default does not change (email OTP). Both opt-ins are handbook recipes under Cloudflare
  authentication; the passkey table comes from `mantle generate --auth` (Better Auth's `getSchema`).

## Constraints recorded

- Better Auth 1.7.7's passkey plugin verifies registration and sign-in with `requireUserVerification: false` and
  `userVerification: "preferred"`. A user-presence-only assertion signs in (spike for #1937, case h). This is accepted
  for member sign-in: a passkey is still a phishing-resistant possession factor. Requiring user verification for
  admins needs an upstream option; until then it is not claimed.
- `rpID` defaults to the `baseURL` host. A deployment with several hosts chooses one host or a shared registrable
  parent domain; a passkey works only there.
- `Caller` does not record how a session was obtained, so step-up for sensitive actions is not part of this record
  (see ADR-lite #1937).
- Password hashing is Better Auth's native scrypt on workerd (N=16384, r=16, about 32 MB per hash); its CPU cost on the
  Workers plans is measured and documented before the password recipe ships.

## Non-goals

- Changing the app shell default, or password sign-in for Admin by default.
- Mantle-owned credential storage or hashing: Better Auth owns them.
- Biometric enforcement for sign-in.

## Acceptance

- OTP sign-in, then passkey registration, then passkey sign-in; deleting the passkey falls back to OTP.
- Password: verification required before sign-in; reset ends sessions and OAuth grants (`oauthGrantRevocation`, already
  covered); rate limits per Better Auth's sign-in rule.
- `@simplewebauthn/server` exercised on workerd in the packed-consumer check.
