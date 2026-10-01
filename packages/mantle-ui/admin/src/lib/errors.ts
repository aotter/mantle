import { ApiError, refusalOf } from "./api";

/** Prefer the server's structured refusal over a generic HTTP status. */
export function asRenderable(error: unknown): unknown {
  const message = error instanceof ApiError ? refusalOf(error.body)?.message : undefined;
  return message ? new Error(message) : error;
}
