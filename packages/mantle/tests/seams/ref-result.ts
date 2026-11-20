/** Required application seam `ref-handler-result` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { callTool, resultData, withResult, type McpContentBlock } from "@aotter/mantle/mcp";
import type { Caller } from "@aotter/mantle/contracts";
import { store, type Handlers } from "./generated-handlers/generated.js";
import { mcp, tools } from "./generated-handlers/mcp.js";
import { rest } from "./generated-handlers/rest.js";

type Db = Parameters<typeof store>[0];

const card: McpContentBlock = { type: "image", data: "AA==", mimeType: "image/png" };
export const handlers: Handlers = {
  "note-card": async (ctx, input) => {
    const row = await ctx.store.collection("notes").insert({ title: input.title });
    return withResult({ title: row.title }, { content: [card], _meta: { "example/card": { title: row.title } } });
  },
  "note-card-copy": async (ctx, input) => {
    const { title } = await ctx.store.procedures["note-card"](input);
    return { title: `${title} (copy)` };
  },
};

export const added = (db: Db, caller: Caller, title: string) =>
  store(db, caller, { handlers }).procedures["note-card"]({ title });
export const copied = (db: Db, caller: Caller, title: string) =>
  store(db, caller, { handlers }).procedures["note-card-copy"]({ title });
export async function called(db: Db, caller: Caller, title: string) {
  const tool = tools.find(each => each.name === "note_card");
  if (!tool) throw new Error("note_card is not generated");
  const result = await callTool(tool, { title }, db, caller, handlers);
  return { result, data: resultData(result) };
}
export const serveMcp = (db: Db, caller: Caller) => mcp({ db: () => db, caller: () => caller, handlers });
export const serveRest = (db: Db, caller: Caller) => rest({ db: () => db, caller: () => caller, handlers });
