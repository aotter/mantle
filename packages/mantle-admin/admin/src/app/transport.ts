import { ApiError, api } from "../lib/api";
import { diagnosticsOf, outputOf } from "../../../src/app/bridge";
import { toolName } from "./slots";
import type { AdminEntry, AdminMe, AdminTransport, McpAppTransportOptions, McpToolResult, Reply } from "./hooks";

type Row = Readonly<Record<string, unknown>>;

const unavailable = { status: "unavailable" } as const;
const ok = <T>(data: T): Reply<T> => ({ status: "ok", data });

/** A 403 or 404 reads as unavailable, so the front end cannot tell a refusal from absence. `also` adds statuses a route uses to say "not here". */
async function read<T>(fetch: () => Promise<T>, also: readonly number[] = []): Promise<Reply<T>> {
  try {
    return ok(await fetch());
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404 || also.includes(error.status))) return unavailable;
    throw error;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const path = (name: string): string => encodeURIComponent(name);

/** The browser: the caller-authorized `/admin/api` routes, with the Admin session cookie. No route is added for the hooks. */
export const browserTransport: AdminTransport = {
  surface: "browser",
  host: null,
  writable: true,
  view: (name, input, page) => read(() => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...input, limit: page.limit, cursor: page.cursor })) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const suffix = query.toString();
    return api.get<{ rows: Row[]; nextCursor?: string }>(`/views/${path(name)}${suffix ? `?${suffix}` : ""}`);
  }),
  entries: (collection, options) => read(async () => {
    const query = new URLSearchParams({ collection });
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.search) query.set("search", options.search);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.filter) { query.set("filter_field", options.filter.field); query.set("filter_value", options.filter.value); }
    const page = await api.get<{ items: AdminEntry<Row>[]; next_cursor: string | null }>(`/entries?${query}`);
    return { items: page.items, ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}) };
  }),
  // a caller the policy refuses to read the Schema gets a stub with no `data`: that is a refusal, not an entry
  entry: async (collection, id) => {
    const reply = await read(async () => (await api.get<{ entry: AdminEntry<Row> }>(`/entries/${path(id)}?collection=${path(collection)}`)).entry);
    return reply.status === "ok" && !isRecord(reply.data.data) ? unavailable : reply;
  },
  // a collection without statistics answers 501 whatever the caller: it has no total to show
  total: collection => read(async () => (await api.get<{ total: number }>(`/collections/${path(collection)}/statistics?range=7d`)).total, [501]),
  me: () => read(() => api.get<AdminMe>("/me")),
  run: (name, input) => read(async () => (await api.post<{ ok: boolean; output: unknown }>(`/operations/${path(name)}`, input)).output),
};

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
    run: async (name, input) => {
      if (!live) return unavailable;
      const reply = await invoke(live, toolName(name), { ...input }, output => output);
      // the model learns that it ran, not what it returned; a host that refuses the note does not undo the write
      if (reply.status === "ok") await host.updateModelContext({ content: [{ type: "text", text: `Ran ${name}.` }] }).catch(() => false);
      return reply;
    },
  };
}
