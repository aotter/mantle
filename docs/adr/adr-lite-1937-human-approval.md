# ADR-lite: Human-approved Procedures (passkey gate, MCP URL elicitation)

**Status:** Proposed, issue #1937. A first, application-level answer to ADR-0029 §11 "Human approval (D3)", which stays
deferred for Core grammar. Evidence: a prototype run (see Evidence).

## Decision

An app-shell pattern and a handbook recipe, with one small Core change. No grammar change.

1. **Request.** A gated handler, called with an `oauth` Caller and no approved approval, records a pending approval in
   an app-owned `operational`, root-`readOnly` Schema: subject, tenant, tool, a hash of the frozen input (including the
   target id and observed version), expiry, single-use nonce, requesting OAuth client. It answers "approval required"
   with a first-party URL `https://<origin>/approve/<opaque id>` that carries no credential.
2. **Channel.** On a 2026-07-28 request that declares `elicitation.url`, the answer is `inputRequired.elicitUrl({ url,
   message })`; the host opens the URL out of the model's view and retries the same call. On any other request the
   answer is an ordinary tool result: "Approval required: open <url>, then call this tool again." The 2025-era `-32042`
   error is not used: a stateless 2025 request carries no client capabilities, and 2026-07-28 removes it.
3. **Approval.** The page accepts only a cookie session whose subject is the requester's; any `Authorization` header is
   refused and Origin is checked. It renders the frozen input from the stored row, never model-written text. It requires
   a WebAuthn assertion with `requireUserVerification: true` against the user's Better Auth-registered passkeys; the
   challenge is derived from approval id, input hash and nonce and is consumed atomically.
4. **Execution, once.** The retried call finds the approved row, compares the input hash, and moves the row from
   approved to executing in the same transaction as the write. The approver's session Caller executes (same subject);
   the requesting client is recorded. OCC uses the frozen `expectedVersion`: a moved version is `CONFLICT`. An uncertain
   outcome is never re-run.
5. **Core change.** The MCP tool wrapper's `catch` (`packages/mantle/src/kernel/mcp-handler.ts`) converts every thrown
   error into an `isError` result. Core exports a marker error (`ApprovalRequired({ url, message, fallback })`); the
   wrapper turns it into `inputRequired.elicitUrl` when the request declares URL elicitation and into its `fallback`
   result otherwise. Nothing else in Core changes.

## Evidence

Prototype: Bun, better-auth 1.7.7 with `@better-auth/passkey` 1.7.7, an approval endpoint on `@simplewebauthn/server`
`verifyAuthenticationResponse`, driven by Playwright with Chromium's CDP virtual authenticator. All cases pass:
registration through Better Auth; approval with user verification executes once; replay refused (409/401); a
user-presence-only assertion, including a client that downgrades to `discouraged`, refused (401 "User verification
required"); a bearer-only request refused (401) and a wrong Origin refused (403); a changed input refused (409); an
expired approval refused (410). Better Auth's own passkey sign-in accepts a user-presence-only assertion, which is why
its endpoints are not the gate.

Learned: replay protection rests on the single-use challenge, because synced passkeys usually report counter 0;
`passkey.publicKey` is standard-base64 COSE (decode with `@better-auth/utils/base64` on Workers); a passkey registered
without user verification can never approve. Not yet run on workerd; the `@simplewebauthn/server` import graph has no
`node:` specifiers.

## Threats

Approval phishing (frozen, server-rendered input only); confused deputy (approver subject equals requester subject);
CSRF (`checkOrigin`, WebAuthn origin and RP-ID binding); cross-tenant (Schema scope); replay (single-use challenge);
a browser-driving agent holding a session cookie (the user-verification gesture); approval fatigue (gate only declared
high-risk Procedures, no "approve all"). Not covered: a compromised user device; macOS accepts the login password when
Touch ID is unavailable.

## Non-goals

- A grammar declaration (`spec.approval`): proposed only after the recipe is proven, as an ADR-0029 §11 amendment.
- A `Caller` field for "verified at T" (a later ADR may generalise `checkFresh`).
- Approval inside an MCP App iframe; Admin approval UI beyond the page.

## Acceptance

Recipe with the cases above against a real app (aotter/project-mantle-geosun `sign_billing`), the Core change with tests
for both answers, the approval table's atomic consume on D1, a workerd run, and manual host checks of URL elicitation
(Claude Code on 2026-07-28; others recorded as found).
