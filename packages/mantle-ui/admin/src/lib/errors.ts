import { ApiError } from "./api";

/** Prefer the server's structured diagnostic over a generic HTTP status. */
export function asRenderable(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body as { diagnostic?: { message?: string } } | null;
    const message = body?.diagnostic?.message;
    if (message) return new Error(message);
  }
  return error;
}
