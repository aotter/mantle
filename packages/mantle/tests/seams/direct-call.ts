/**
 * Application seam `input-conversion` (packages/mantle/tests/application-seams.ts): a host that calls generated functions directly
 * (a test harness, for example) applies the generated surfaces' own input conversion. Public imports only, no casts.
 */
import { convertInput } from "@aotter/mantle/contracts";
import { tools } from "./generated/mcp.js";
import { validate } from "./generated/validation/procedures/add-note.js";

/** The driver input the generated `add-note` Procedure binds, as its MCP tool would pass it. */
export function addNoteInput(raw: unknown): Record<string, unknown> {
  const input = validate(raw);
  convertInput(input, tools.find(tool => tool.target?.name === "add-note")?.convert);
  return input;
}
