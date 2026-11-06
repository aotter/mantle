/** Request-only: loaded by handlers that gate an action, and by the MCP wrapper when a call fails. */
import { ContractError } from "./contract-error.js";

/**
 * Thrown by a handler whose action needs the person present, after it has recorded the pending approval (outside any
 * transaction the throw rolls back). MCP answers a 2026-07-28 request that declares `elicitation.url` with
 * `inputRequired.elicitUrl({ url, message })`, so the host opens `url` out of the model's view and retries the call; any
 * other request gets an error result whose text is `fallback`. Other surfaces answer 428 `APPROVAL_REQUIRED` with `url`.
 * `url` is an absolute http(s) URL without credentials: it reaches the model on the fallback path, so it must not
 * grant anything by itself.
 */
export class ApprovalRequired extends ContractError {
  readonly url: string;
  readonly fallback: string;
  constructor(options: { readonly url: string; readonly message: string; readonly fallback?: string }, path = "") {
    let url: URL | undefined;
    try { url = new URL(options.url); } catch {}
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new TypeError("ApprovalRequired: url must be an absolute http(s) URL without credentials.");
    super("APPROVAL_REQUIRED", options.message, path, { status: 428, fields: { url: url.href } });
    this.name = "ApprovalRequired";
    this.url = url.href;
    this.fallback = options.fallback ?? `${options.message} Open ${url.href}, then call this tool again.`;
  }
}
