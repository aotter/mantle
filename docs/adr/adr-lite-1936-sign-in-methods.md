# ADR-lite: Sign-in methods beyond email OTP

**Status:** Proposed (revision 2), issue #1936. Builds on ADR-0014 (Better Auth owns sign-in) and keeps the app shell
passwordless by default. Revision 2 narrows the record to the seams Core provides; the passkey experience itself is
built by applications and hosts on top of them.

## Decision

Core provides three seams and no passkey user experience of its own.

1. **A `passkey` sign-in method.** `authRoutes` `methods` accepts `{ kind: "passkey" }`. Sign-in goes through Better
   Auth's own passkey endpoints (the application enables `@better-auth/passkey` in its `auth.ts`); Core adds no UI beyond
   what the method contract already renders.
2. **A sign-in page extension slot.** An application can add a sign-in method and adjust the email input (for example
   `autocomplete="username webauthn"` for the browser's passkey autofill) without forking `auth-views.tsx`.
3. **A post-sign-in step before the OAuth continuation.** After a successful sign-in an application may run its own page
   or step; Core then resumes the pending authorize redirect, or the original return URL, unchanged. This is where an
   application offers to add a passkey right after an email-code sign-in, including inside an OAuth authorize flow such
   as an MCP connector's sign-in.

Email OTP stays the first sign-in and the recovery path in the app shell.

## Constraints recorded

- **`rpID` defaults to the auth host.** A passkey is usable by every origin under its `rpID`. Setting it to a parent
  domain under which other tenants are served lets any of them request assertions for those credentials. A
  parent-domain `rpID` is acceptable only when the deployment owns the whole registrable domain and nothing else is
  served beneath it; the recipe says so. Pages that verify a passkey (sign-in, and any approval page, ADR-lite #1937)
  are served on a host whose origin matches the `rpID`.
- **Register right after sign-in.** Better Auth's passkey plugin requires a fresh session to register (one day by
  default). Registration offered only on an account page later fails with "Session is not fresh"; the post-sign-in step
  (seam 3) is the reliable place.
- **No enforced user verification.** Better Auth 1.7's passkey plugin verifies with `requireUserVerification: false`;
  a user-presence-only assertion signs in. Acceptable for sign-in (still a phishing-resistant possession factor).
  Nothing in Core claims biometric or PIN verification at sign-in.
- **`Caller` does not record how a session was obtained.** Verified step-up claims are proposed as a host seam in
  ADR-lite #1937.

## Out of scope for Core

The enrolment prompt, its copy and dismissal policy, autofill behaviour, passkey management screens, and a password
method. Applications and hosts build these on the seams. Password sign-in remains plain Better Auth configuration in an
application's own `auth.ts`; Core's existing grant revocation on password reset and change already applies.

## Acceptance

- `methods` with `{ kind: "passkey" }` renders and signs in through Better Auth's endpoints.
- The slot changes the email input and adds a method without a fork.
- A post-sign-in step runs and the pending OAuth authorize redirect resumes unchanged.
- The handbook recipe states the `rpID` rule and the fresh-session rule.
