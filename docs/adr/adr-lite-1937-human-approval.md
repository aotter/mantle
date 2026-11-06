# ADR-lite: Human-approved Procedures (seams for step-up and MCP URL elicitation)

**Status:** Proposed (revision 2), issue #1937. Answers ADR-0029 §11 "Human approval (D3)" with seams, not a manifest
feature. Revision 2 drops the manifest declaration after a downstream implementation showed the gate is an application
design decision.

## Decision

**No manifest field.** Which actions need the person present, how long a request lives, single use, the summary a
person reviews, and the verifier are the application's (or host's) design. A declarative `stepUp: true` would pull all of
that into Core. Ordinary actions may still be confirmed by the user's own agent under the usual role, scope, stage and
version checks; gated actions produce a pending approval that only a person can complete.

Core provides three seams.

1. **Verified step-up claims on the Caller.** `HostProps` may carry step-up claims the host has already verified, such
   as `{ acr, auth_time, nonce }`, validated like the other props and exposed on the Caller (for example
   `caller.stepUp`). A Procedure compares `caller.stepUp.nonce` with the challenge the application stored for
   `caller.subject`, so both sides of every comparison come from one namespace and no host rewrites a request body to
   hand the nonce over. An application in host (gateway) mode never verifies identity-provider tokens itself.
2. **MCP URL elicitation.** The MCP tool wrapper recognises a marker error, `ApprovalRequired({ url, message,
   fallback })`: on a 2026-07-28 request that declares `elicitation.url` it answers `inputRequired.elicitUrl({ url,
   message })`, so the host opens the URL out of the model's view and retries the call; otherwise it answers the
   `fallback` result ("open `<url>`, then call this tool again"). Today the wrapper turns every thrown error into an
   `isError` result. The 2025-era `-32042` error is not used: a stateless 2025 request carries no client capabilities,
   and 2026-07-28 removes it.
3. **Documentation of two boundaries.**
   - `_meta.ui.visibility: ["app"]` hides a tool from the model's list; it is **not** an access boundary. Any client
     holding the same token can call an app-only tool. Anything that needs the person present is enforced server-side.
   - A host-side rule keyed on a URL must use the same canonicalisation as `matchTarget` (decoded, trailing slash
     normalised, encoded operation names refused); a rule on the raw path can be bypassed by an equivalent spelling.

## Guidance for applications (not Core)

- **Bind the approval to what was asked.** Freeze the input (a hash, including the target id and observed version)
  with a single-use nonce and an expiry. A moved version at execution is `CONFLICT`, never a silent rebind.
- **Own approvals by `author_id`**, the Core-stamped caller, never by a display name the user can edit.
- **Scope the approval records**, or refuse them on generic entry routes, so no role reads another user's challenge.
- **Carry the deadline.** The request passes its own expiry to the verifier, which refuses an expired request before
  offering a passkey; the application still enforces the expiry.
- **Spend a step-up only for the approval that asked for it**: re-show the summary and require an explicit action.
- **Treat a passkey change as a security event**: require a recent sign-in (minutes, not the plugin's one day), refuse
  it under impersonation, and notify the user. A verifier refuses impersonated sessions too.
- **Verify with user verification required.** Better Auth's passkey sign-in accepts a user-presence-only assertion, so
  its sign-in endpoint is not an approval verifier.

## Evidence

A prototype (Bun, better-auth with `@better-auth/passkey`, an approval endpoint on `@simplewebauthn/server`
`verifyAuthenticationResponse({ requireUserVerification: true })`, Playwright with Chromium's virtual authenticator)
passed: approval with user verification executes once; replay, a user-presence-only assertion (including a client that
downgrades to `discouraged`), a bearer-only request, a wrong Origin, a changed input and an expired approval are all
refused. Better Auth's own passkey sign-in accepted a user-presence-only assertion. Replay protection rests on the
single-use challenge, because synced passkeys usually report counter 0. A downstream application then ran the full
flow with real passkeys and a security review, which produced the guidance above.

## Non-goals

- A manifest declaration of gated Procedures.
- A Core verifier, approval page or approval Schema.
- Approval inside an MCP App iframe.

## Acceptance

- `HostProps` step-up claims are validated and reach the Caller; a Procedure can compare the nonce without a body rewrite.
- The MCP wrapper returns `inputRequired.elicitUrl` for a request that declares URL elicitation and the fallback result
  otherwise, with tests for both.
- The MCP Apps guide states that visibility is not an access boundary; the gateway guide states the canonicalisation
  rule.
