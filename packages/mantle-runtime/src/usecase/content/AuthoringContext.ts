import type { HandlerContext } from "../../domain/model/HandlerContext.js";

export function authoringContext(
  ctx: HandlerContext | undefined,
  authorId: string | null,
): HandlerContext {
  return ctx ?? {
    user: authorId ? { id: authorId } : null,
    staff: null,
    env: {},
  };
}
