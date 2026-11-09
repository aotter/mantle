# ADR-lite: Sign-in methods beyond email OTP

**Status:** Accepted (revision 3), issue #1936. Builds on ADR-0014 (Better Auth owns sign-in) and keeps the app shell
passwordless by default. Revision 3 records the final scope: Core and Admin provide seams only. Admin ships no passkey
sign-in experience; applications build their own on the seams.

## Decision

1. **A `passkey` sign-in method entry.** `authRoutes` `methods` accepts `{ kind: "passkey" }` when the application
   enables `@better-auth/passkey` in its own `auth.ts`. Admin lists it to the slot below and renders nothing for it.
2. **A sign-in page slot.** `SignIn` receives the methods, the return path, the OAuth authorize query and the email
   field's `autocomplete`. An application adds or replaces methods there without forking Admin.
3. **A post-sign-in step.** `onSignedIn(next)` runs after an in-page sign-in. An application may run its own step and
   then continue to `next` unchanged: Better Auth's OAuth authorize continuation (for example an MCP connector's) or the
   return path.
4. **`rpID` defaults to the auth host.**

Email OTP stays the first sign-in and the recovery path in the app shell.

## Constraints recorded

- **`rpID`.** A passkey is usable by every origin under its `rpID`, so a parent-domain `rpID` is acceptable only when
  the deployment owns the whole registrable domain.
- **No enforced user verification.** Better Auth 1.7's passkey plugin verifies sign-in with
  `requireUserVerification: false`; a user-presence-only assertion signs in. Its sign-in endpoint therefore does not
  prove that the person is present and is not an approval verifier (ADR-lite #1937).
- **Fresh session.** The plugin registers a passkey only for a recent session. Where an application lets people add or
  remove passkeys, a short window (minutes), refusal under impersonation and a notice to the person are advisable.
- **One WebAuthn request at a time.** A browser runs one; a page that starts a conditional (autofill) request aborts it
  before starting another.

## Out of scope for Core and Admin

Passkey sign-in UI, autofill, an "add a passkey" prompt, passkey sign-in inside an OAuth authorize flow, passkey
management screens, and a password method. Password sign-in remains plain Better Auth configuration in an application's
own `auth.ts`; Core's grant revocation on password reset and change already applies.

## Acceptance

- `methods` with `{ kind: "passkey" }` reaches the slot; the default renders nothing for it.
- The slot changes the email input and adds a method without a fork, and still mounts with no methods.
- `onSignedIn` receives Better Auth's continuation unchanged.
- The handbook states the `rpID` rule and that the plugin's sign-in does not enforce user verification.
