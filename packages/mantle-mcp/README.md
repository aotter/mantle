# @aotter/mantle-mcp

Optional MCP surface for Mantle, built on the official
[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

It registers one surface of a runtime capability catalog as MCP tools and
serves it over web-standard HTTP, for both the 2026-07-28 protocol era and
2025-era stateless clients. The SDK owns the protocol. Mantle owns
authorization, guards, OCC, validation and audit (ADR-0029).

```ts
import { bindCapabilities } from "@aotter/mantle-runtime";
import { createMantleMcpHandler } from "@aotter/mantle-mcp";

const invoker = bindCapabilities(runtime, plan, { surface: "public" });
const mcp = createMantleMcpHandler(invoker, {
  serverInfo: { name: "example.public" },
  unauthenticated: (request) => challenge(request), // your 401 + WWW-Authenticate
});

// Verify the caller first; the SDK never sees or checks a token.
const response = await mcp.fetch(request, handlerContext);
```

- **Results.** Success returns the value as JSON text, plus
  `structuredContent` when the value is an object. A business failure returns
  `isError: true` with `structuredContent: { diagnostics: [Diagnostic] }`.
  Protocol failures stay JSON-RPC errors.
- **Validation happens once.** Schemas are advertised unchanged and Runtime
  validates every argument and output. The SDK is given a pass-through
  validator, so Ajv is not bundled.
- **Identity.** When an anonymous caller calls a tool that requires identity,
  the handler answers with `unauthenticated(request)` before any tool runs.
- **Audit.** Every `tools/call` produces one `AuditSink` event, including
  unknown-tool probes and identity refusals.

`createMantleMcpServer(invoker, options).create(ctx)` returns a plain
`McpServer`, for hosts that wire their own transport.
