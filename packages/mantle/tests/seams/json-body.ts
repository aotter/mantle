/** Required application seam `json-body` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { body } from "@aotter/mantle/rest";
import { ContractError } from "@aotter/mantle/contracts";

export const read = (request: Request) =>
  body(request, 64, message => {
    throw new ContractError("INPUT_VALIDATION_FAILED", message, "seam");
  });
