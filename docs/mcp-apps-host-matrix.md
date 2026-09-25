# MCP Apps host matrix

Evidence for how Mantle's MCP surface and its interaction App behave on each target host (ADR-0029, #1119).

**Acceptance gate:**
- Both CI rows pass.
- Each real host has one recorded manual run.

Cells marked **not verified** have no evidence yet. Do not assume they behave like another host.

| Dimension | Official ext-apps host bridge (CI) | Official client, no UI (CI) | Claude (web, desktop) | ChatGPT |
|---|---|---|---|---|
| Protocol negotiated | 2025-11-25 stateless (client default) | 2026-07-28 (pinned) | not verified | not verified |
| `resources/list`, `resources/read` of the `ui://` App | ✅ `resources/read` returns the single-file HTML | n/a: `resources/*` not offered | not verified | not verified |
| Tool `_meta.ui.resourceUri` | ✅ present on the View tool | ✅ absent | not verified | not verified |
| Tool input and result reach the App | ✅ `sendToolInput`/`sendToolResult`; rows render | n/a | not verified | not verified |
| App calls tools (`tools/call`) | ✅ `read_entry`, `review_requisition`, then the View refresh | n/a | not verified | not verified |
| Model context updates | not used | n/a | not verified | not verified |
| External links | not used | n/a | not verified | not verified |
| CSP and nested iframes | ✅ App loaded in a `sandbox="allow-scripts"` iframe (no `allow-forms`, as in the reference host); the HTML is self-contained | n/a | not verified | not verified |
| Host theme and locale | ✅ `theme: "dark"` and `locale: "zh-TW"` from the host context: dark palette, `html lang`, Traditional Chinese strings | n/a | not verified | not verified |
| Success visibility | ✅ `structuredContent` rendered by the App | ✅ `structuredContent`, plus text naming the row actions in the tool description | not verified | not verified |
| Error visibility (`isError`, `CONFLICT`) | ✅ `CONFLICT` shown; input kept; "Load latest version" offered | ✅ `isError` with `{ diagnostics: [{ code: "CONFLICT" }] }` in text | not verified | not verified |
| Auth challenge (401 + `WWW-Authenticate`) | covered by the Cloudflare MCP tests, not in this host | covered by `mcp-sdk-client-conformance` | not verified | not verified |
| Hosts without MCP Apps | n/a | ✅ plain catalog; the same flow through plain tools | not verified | not verified |

## CI evidence

`packages/mantle-ui/test/basic-host-browser.test.ts` covers both CI rows.

**Host bridge row.** The test builds a host in the shape of the ext-apps `examples/basic-host`:
- It connects the official `@modelcontextprotocol/client` with the MCP Apps extension to a real `createMantleMcpHandler`.
- It reads the published App, `@aotter/mantle-ui/mcp-app`, from its `ui://` resource.
- It loads the App in a sandboxed iframe and connects it with the official `AppBridge`.

It then runs example A:
1. Staff lists pending requisitions.
2. Staff reviews one with the version it read.
3. A concurrent change makes a second decision conflict. The input is kept and no write happens.
4. The same App, reloaded with a dark theme and a `zh-TW` locale, follows both.

**No-UI row.** The same flow runs through the official client with no UI, over the 2026-07-28 era.

## Manual evidence

Record each real-host run here with the client version, the date and screenshots or logs. Use the same example A and the procurement member flow.

## What this changes

- Business failures travel as `isError` results carrying diagnostics (ADR-0029 D1). This is visible both to an App and to a model without UI, so no host-specific error path is needed.
- A stateless 2025-era request carries no client capabilities, so the App metadata is always sent there (ADR-0029 §10). The real-host runs should confirm that non-App hosts ignore it.
