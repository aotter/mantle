import { ApiError } from "./api";

/** The server returns structured diagnostics; surface their `message`
 *  instead of the generic HTTP statusText. Extracted from
 *  `operations-view.tsx` (#426) once `collection-view.tsx`'s row-action
 *  dialog (#430) needed the exact same diagnostic-message unwrapping
 *  ahead of `ErrorBox`. */
export function asRenderable(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body as { diagnostic?: { message?: string } } | null;
    const message = body?.diagnostic?.message;
    if (message) return new Error(message);
  }
  return error;
}
