# ADR-lite #861: Staff MCP through the Admin session

Status: Accepted for implementation following maintainer approval.

Admin WebMCP uses the canonical staff MCP catalog and JSON-RPC dispatcher.
`GET /admin/api/webmcp` supplies the same tool definitions plus UI route hints;
`POST /admin/api/mcp` carries MCP requests using the current Admin session.
Both endpoints check the current mutable staff role. POST retains Admin's
cross-origin mutation rejection and body limit. Procedure predicates still
see a session credential, never a fabricated OAuth scope. Public/member MCP
capabilities and HTTP-only staff procedures are not added to this catalog.
This extends ADR-0014/0019 without changing manifest grammar.

Descriptions, input schemas, OCC and error diagnostics come from the existing
MCP catalog/dispatcher. Media tools appear only with media storage and declared
purposes. Agents PUT binaries directly to the authorized upload URLs between
create_media_upload and commit_media_upload; WebMCP carries no binary payload.

Admin owns two UI-only tools: admin_get_context and admin_navigate. Successful
operations invalidate query data and navigate when a known result target is
available. Unknown custom operations stay on the current page. Failure never
triggers navigation or an automatic mutation retry. Navigation input must be
an Admin page, not an external URL or API/auth path.

The green indicator appears after document.modelContext registration succeeds.
Its dialog uses Admin i18n with the established English fallback. The initial
translations include English, Traditional Chinese and Simplified Chinese.
Registration uses AbortSignal lifetime cleanup. Browsers without WebMCP retain
the existing UI. The browser API is feature-detected, not polyfilled.

Only the explicitly marked, same-origin sandbox preview accepts the parent
message-port tool bridge. It reuses the same executor even in browsers without
native WebMCP. Canonical Admin refuses embedding and installs no parent bridge.
Builder keeps reset/seed/observe and member/anonymous sandbox tests; owner
staff calls traverse the iframe Admin executor and existing sandbox HTTP bridge.
Timeout/cancellation does not imply a write was rolled back; reconcile before
retry. Preview remains isolated from live network APIs.

Reference: https://webmachinelearning.github.io/webmcp/
