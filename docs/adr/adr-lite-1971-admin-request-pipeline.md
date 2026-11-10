# ADR-lite #1971: Admin uses the kernel request pipeline

Status: Accepted (Option B).

Admin's API is one `nativeRest` mount at `/admin/api`. Each request runs the
kernel router's steps once, in its order: canonical path, route match, target,
caller, mount admission, host admission, Origin, authorize, dry run, dispatch.
Admin's earlier gate-before-route order (authenticate, admit and check Origin
before matching any route) is dropped. Core gains no "gate before routing" or
"Origin on every call" policy. `nativeRest` gains five small inputs instead:
`base`, `admission`, a route's access `variant`, `prepare` for dry runs, and an
authorize target computed from the decoded request, with `authorize` and
`authorized` bound to the caller for handlers.

Consequences, each pinned by Admin's request matrix:

- A. An unmatched path under `/admin/api`, and the bare base, is 404
  `NOT_FOUND` for every caller, before any caller is resolved.
- B. A method mismatch on an existing route is 405 `METHOD_NOT_ALLOWED` with
  `allow`, before any caller is resolved. An `OPTIONS` preflight is one.
- C. A malformed path (`%2F`, `%5C`, `%00`, `\`, a bad escape) is 400
  `INPUT_VALIDATION_FAILED` before authentication. For A-C the error names
  `rest`, and an access event's target is `rest:<METHOD> /admin/api/...`.
- D. A forwarded session caller's read-only operation passes the Origin rule
  (`originChecked`), as reads already did; writes keep it. This is safe
  only while no Admin response carries an `access-control-*` header and an
  Admin read changes nothing; the matrix asserts both for its fixture.
- E. Within a matched route, refusals keep their order and answers.

Matched routes keep their `admin:` ids, the `minimumRole` 403 body, freshness,
target pinning and dry-run answers.
