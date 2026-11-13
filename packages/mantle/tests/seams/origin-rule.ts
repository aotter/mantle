/** Required application seam `origin-rule-and-errors` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { checkOrigin, surfaceFailure, type Caller } from "@aotter/mantle/contracts";

export function guarded(request: Request, caller: Caller): Response {
  try {
    checkOrigin(request, caller);
    return new Response(null, { status: 204 });
  } catch (error) {
    return surfaceFailure(error);
  }
}
