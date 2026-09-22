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
  /** `ok`, a runtime Diagnostic code, `INVALID_PARAMS`, or `INTERNAL`. */
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
