/** Required application seam `input-conversion` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { convertInput } from "@aotter/mantle/contracts";
import { tools } from "./generated/mcp.js";
import { validate } from "./generated/validation/procedures/add-note.js";

export function converted(raw: unknown): Record<string, unknown> {
  const input = validate(raw);
  convertInput(input, tools.find(tool => tool.name === "add_note")?.convert);
  return input;
}
