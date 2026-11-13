/** Required application seam `call-tool` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { callTool } from "@aotter/mantle/mcp";
import type { Caller } from "@aotter/mantle/contracts";
import { tools } from "./generated/mcp.js";
import type { store } from "./generated/generated.js";

export async function call(db: Parameters<typeof store>[0], caller: Caller, input: Record<string, unknown>) {
  const tool = tools.find(each => each.name === "add_note");
  if (!tool) throw new Error("add_note is not generated");
  return callTool(tool, input, db, caller, {});
}
