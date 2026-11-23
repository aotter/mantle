/** Required application seam `procedure-input` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import type { Caller } from "@aotter/mantle/contracts";
import addDraft from "./generated/procedures/add-draft.js";
import { input } from "./generated/validation/procedures/add-draft.js";

export async function draft(db: Parameters<typeof addDraft>[0], caller: Caller, raw: unknown) {
  return addDraft(db, caller, input(raw));
}
