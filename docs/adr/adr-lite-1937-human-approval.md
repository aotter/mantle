# ADR-lite: Human-approved actions

**Status:** Accepted (revision 3), issue #1937. Answers ADR-0029 §11 "Human approval (D3)": Core adds no grammar, API
or runtime feature for it. Revision 3 records the final split, which a downstream application ran in production with a
real passkey; it supersedes the approval error and MCP URL-elicitation answer that revisions 1 and 2 proposed.

## Decision

**Core adds nothing.** No manifest field, no approval error or MCP URL-elicitation answer, no approval page or verifier,
and no new Caller or host-contract field.

The split, for applications and hosts:

- **The application decides what is approved.** Which actions need the person present is its own design. It freezes the
  request (a hash of the input, including the target id and observed version) with a single-use nonce and an expiry in
  its own records, and shows the summary on its own page.
- **The host's identity service answers only "is this the person".** A generic verification page runs a passkey
  assertion with user verification required over the nonce, refuses an expired request before offering a passkey, and
  returns a short-lived step-up token. It renders no business content.
- **The gateway hands the application only the proven nonce.** It verifies the token against the person's own session
  (subject, audience, authentication context, age) and passes the nonce on in the request. The application never
  verifies identity-provider tokens, so every comparison it makes stays in its own subject namespace.
- **MCP never carries the step-up.** No MCP result returns the nonce or token, so an agent holding the user's credential
  cannot complete the approval.

A host-verified step-up claim on the Caller may be proposed later if a host needs it. It is not planned.

Core documents two boundaries:

- `_meta.ui.visibility: ["app"]` hides a tool from the model's list; it is not an access boundary. Any client holding
  the same credential can call an App-only tool, so an action that needs the person present is enforced on the server.
- A host-side rule keyed on a request must use the same canonicalisation as `matchTarget`; a rule on the raw path can be
  bypassed by an equivalent spelling.

## Guidance for applications

- **Bind the approval to what was asked.** A moved version at execution is `CONFLICT`, never a silent rebind.
- **Own approvals by `author_id`**, the Core-stamped caller, never by an editable display name.
- **Scope the approval records**, or refuse them on generic entry routes, so no role reads another person's challenge.
- **Carry the deadline** to the verifier; the application still enforces the expiry.
- **Spend a step-up only for the approval that asked for it**: show the summary again and require an explicit action.
- **Treat adding or removing a passkey as a security event**: a recent sign-in, never under impersonation, and a notice
  to the person.
- **Require user verification.** Better Auth's passkey sign-in accepts a user-presence-only assertion, so its sign-in
  endpoint is not an approval verifier (ADR-lite #1936).

## Evidence

A prototype (passkey assertions verified with `requireUserVerification: true`, driven by a virtual authenticator)
showed that a single-use challenge refuses replay, a user-presence-only assertion, a changed input and an expired
request; synced passkeys usually report counter 0, so the challenge is the replay guard. A downstream application then
ran the split above end to end with a real passkey and a security review, which produced the guidance.

## Non-goals

- A manifest declaration of gated Procedures, or any Core runtime support for approvals.
- Approval inside an MCP App iframe.

## Acceptance

- The MCP Apps guide states that visibility is not an access boundary; the describe reference states the
  canonicalisation rule.
