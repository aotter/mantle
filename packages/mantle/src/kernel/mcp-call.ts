import type { Caller } from "./contracts.js";
import { convert, invalid } from "./surface.js";
import { checkPageLimit } from "./paging.js";
import type { Tool } from "./mcp.js";

export async function callTool<Database, Handlers>(tool: Tool<Database, Handlers>, raw: Record<string, unknown>, db: Database, caller: Caller, handlers: Handlers): Promise<unknown> {
  return callToolLazy(tool, raw, () => db, caller, handlers);
}
/** Transport input is checked before acquiring an application-owned native handle. */
export async function callToolLazy<Database, Handlers>(tool: Tool<Database, Handlers>, raw: Record<string, unknown>, getDb: () => Database, caller: Caller, handlers: Handlers): Promise<unknown> {
  if (tool.page) {
    const { limit, cursor, ...input } = raw;
    if (limit !== undefined) checkPageLimit(limit, tool.path!);
    if (cursor !== undefined && typeof cursor !== "string") invalid("Invalid paging options.", tool.path!);
    await tool.validate(input);
    convert(input, tool.convert);
    return tool.page(getDb(), caller, input as never, { limit: limit as number | undefined, cursor: cursor as string | undefined });
  }
  const input = await tool.validate(raw);
  convert(input, tool.convert);
  return tool.run!(getDb(), caller, input as never, handlers);
}
