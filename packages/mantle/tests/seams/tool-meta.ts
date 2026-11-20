/** Required application seam `tool-meta` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { mcp, withResult, withResultMeta, type McpContentBlock, type Tool } from "@aotter/mantle/mcp";
import type { Caller } from "@aotter/mantle/contracts";
import type { store } from "./generated/generated.js";

type Db = Parameters<typeof store>[0];

export const tool: Tool<Db> = {
  name: "seam_tool",
  surface: "public",
  description: "A tool.",
  inputSchema: { type: "object", additionalProperties: false },
  validate: () => ({}),
  readOnly: true,
  meta: { "example/listed": { a: 1 } },
  run: async () => withResultMeta({ ok: true }, { "example/result": { b: 2 } }),
};

const block: McpContentBlock = { type: "image", data: "AA==", mimeType: "image/png" };
export const blocks: Tool<Db> = {
  ...tool,
  name: "seam_blocks",
  run: async () => withResult({ ok: true }, { content: [block], _meta: { "example/result": { b: 2 } } }),
};

export const serve = (db: Db, caller: Caller) => mcp([tool, blocks], { db: () => db, caller: () => caller });
