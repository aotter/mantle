/**
 * Application seams `json-body`, `origin-rule-and-errors` and `call-tool` (packages/mantle/tests/application-seams.ts): an
 * application's own route beside the generated surfaces. Public imports only, no casts.
 */
import { body } from "@aotter/mantle/rest";
import { callTool } from "@aotter/mantle/mcp";
import { checkOrigin, ContractError, surfaceFailure, type Caller } from "@aotter/mantle/contracts";
import { tools } from "./generated/mcp.js";
import type { store } from "./generated/generated.js";

type Db = Parameters<typeof store>[0];
const addNote = tools.find(tool => tool.target?.kind === "procedure" && tool.target.name === "add-note");

/** POST a note from the application's own form: its own size limit and error path, the generated tool's checks. */
export async function addNoteRoute(request: Request, db: Db, caller: Caller): Promise<Response> {
  try {
    if (!addNote) throw new Error("add-note has no generated tool");
    checkOrigin(request, caller);
    const input = await body(request, 2048, message => {
      throw new ContractError("INPUT_VALIDATION_FAILED", message, "note-form");
    });
    return Response.json(await callTool(addNote, input, db, caller, {}));
  } catch (error) {
    return surfaceFailure(error);
  }
}
