import { diagnosticsOf, outputOf } from "../../../src/app/bridge";
import { toolName } from "./slots";
import type { AdminTransport, McpAppTransportOptions, McpToolResult, Reply } from "./hooks";

type Row = Readonly<Record<string, unknown>>;

/** At most this many distinct Views feed badges: `GET /admin/api/view-batch` reads that many in one request. */
export const MAX_BADGE_VIEWS = 20;

export const unavailable = { status: "unavailable" } as const;
export const ok = <T>(data: T): Reply<T> => ({ status: "ok", data });
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Tool failures the browser would have read as 403 or 404. */
const REFUSED = ["AUTH_DENIED", "NOT_FOUND"];


/** A host rejects a call it cannot make: a tool the caller's catalogue lacks (JSON-RPC InvalidParams) or a refused one (HTTP 403 or 404). */
const refusedCall = (error: unknown): boolean => isRecord(error) && (error["code"] === -32602 || error["status"] === 403 || error["status"] === 404);

async function invoke<T>(call: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>, tool: string, args: Record<string, unknown>, pick: (output: unknown) => T): Promise<Reply<T>> {
  let result: McpToolResult;
  try {
    result = await call(tool, args);
  } catch (error) {
    if (refusedCall(error)) return unavailable;
    throw error;
  }
  return answer(result, pick);
}

function answer<T>(result: McpToolResult, pick: (output: unknown) => T): Reply<T> {
  if (!result.isError) return ok(pick(outputOf(result)));
  const diagnostics = diagnosticsOf(result);
  if (diagnostics.some(d => REFUSED.includes(d.code))) return unavailable;
  throw new Error(diagnostics[0]?.message ?? "The tool failed without a diagnostic.");
}

/**
 * An MCP App: each View and operation is its admin MCP tool, called through the host (`tools/call`) under the caller's own
 * MCP authorization. A host without `serverTools` is unavailable; entries, totals and the signed-in user have no tool, so
 * they are unavailable too: an App declares the data it needs as an admin View.
 */
export function createMcpAppTransport({ call, host }: McpAppTransportOptions): AdminTransport {
  const live = call && host.capabilities["serverTools"] !== undefined ? call : undefined;
  return {
    surface: "mcp-app",
    host,
    writable: live !== undefined,
    view: async (name, input, page, rowNames) => {
      if (!live) return unavailable;
      const args = { ...input, ...(page.limit !== undefined ? { limit: page.limit } : {}), ...(page.cursor ? { cursor: page.cursor } : {}) };
      return invoke(live, toolName(name), args, output => {
        // the tool returns the SQL output names; the browser's route renames some, and the types are the browser's
        const rename = (row: Row): Row => rowNames ? Object.fromEntries(Object.entries(row).map(([key, value]) => [Object.prototype.hasOwnProperty.call(rowNames, key) ? rowNames[key]! : key, value])) : row;
        const rows = isRecord(output) && Array.isArray(output["rows"]) ? output["rows"].filter(isRecord).map(rename) : [];
        return { rows, ...(isRecord(output) && typeof output["nextCursor"] === "string" ? { nextCursor: output["nextCursor"] } : {}) };
      });
    },
    entries: async () => unavailable,
    entry: async () => unavailable,
    total: async () => unavailable,
    me: async () => unavailable,
    badges: async () => unavailable,
    run: async (name, input) => {
      if (!live) return unavailable;
      const reply = await invoke(live, toolName(name), { ...input }, output => output);
      // the model learns that it ran, not what it returned; a host that refuses the note does not undo the write
      if (reply.status === "ok") await host.updateModelContext({ content: [{ type: "text", text: `Ran ${name}.` }] }).catch(() => false);
      return reply;
    },
  };
}
