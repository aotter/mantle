import type { CredentialKind } from "../model/HandlerContext.js";

/** One MCP `tools/call` as seen by the dispatcher: who did what, with what
 *  outcome. Payloads are deliberately absent — an audit trail records the
 *  action, not the request body, which may carry personal data. */
export interface McpToolCallAuditEvent {
  /** Unix epoch milliseconds at dispatch start. */
  readonly at: number;
  readonly surface: "public" | "staff";
  /** `ctx.user.id`; null for an anonymous public caller. */
  readonly callerId: string | null;
  /** OAuth client that presented the credential, when known. */
  readonly clientId: string | null;
  readonly credential: CredentialKind | null;
  readonly tool: string;
  /** The string argument declared with `x-mcp-hint: idempotency-key`, or the
   *  conventional `operationId` when no hint is declared. Correlates retries
   *  across admitted and denied outcomes. */
  readonly operationId: string | null;
  /** `ok`, a runtime Diagnostic code, `UNKNOWN_TOOL`, `INVALID_PARAMS`, `INTERNAL`, or an
   *  adapter gate denial in the same UPPER_SNAKE vocabulary
   *  (`UNAUTHENTICATED`, `INVALID_TOKEN`, `INVALID_DPOP_PROOF`, `INSUFFICIENT_SCOPE`,
   *  `INSUFFICIENT_ROLE`). */
  readonly outcome: string;
  readonly durationMs: number;
}

/** Adapter-supplied audit trail for MCP tool calls. Absent by default: the
 *  dispatcher records nothing unless the composition root passes a sink.
 *  `record` runs off the response path (via `ctx.waitUntil` when the
 *  platform offers one); a rejected promise is logged, never surfaced. */
export interface AuditSink {
  record(event: McpToolCallAuditEvent): void | Promise<void>;
}
