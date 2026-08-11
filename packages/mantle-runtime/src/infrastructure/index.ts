/**
 * `infrastructure/` — adapters that bind to ports + thin transport
 * layers. Per the clean-arch rule, MCP / HTTP adapters are thin: no
 * business logic, no validation, no transformation — just envelope
 * handling + delegation to a use case.
 */
export * from "./persistence/index.js";
export * from "./mcp/index.js";
export * from "./boot/index.js";
