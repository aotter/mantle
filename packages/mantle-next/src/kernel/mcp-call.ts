/** Shared generated-tool invocation for MCP and the cookie-only Admin boundary. */
import type { Caller } from "./contracts.js";
import type { Tool } from "./mcp.js";
import { convert, invalid } from "./surface.js";

export async function callTool<Database, Handlers>(tool: Tool<Database, Handlers>, raw: Record<string, unknown>, db: Database, caller: Caller, handlers: Handlers): Promise<unknown> {
  if (tool.page) {
    const { limit, cursor, ...input } = raw;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500) || cursor !== undefined && typeof cursor !== "string") invalid("Invalid paging options.", tool.path!);
    tool.validate(input);
    convert(input, tool.convert);
    return tool.page(db, caller, input as never, { limit: limit as number | undefined, cursor: cursor as string | undefined });
  }
  const input = tool.validate(raw);
  convert(input, tool.convert);
  return tool.run!(db, caller, input as never, handlers);
}
