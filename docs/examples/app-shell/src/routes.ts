import type { Caller } from "@aotter/mantle/contracts";

/**
 * App-owned routes, tried before Admin, MCP and REST. Return undefined to fall through.
 * AGENT: add visitor pages (HTML, SEO, feeds) and callbacks/webhooks here. A callback must verify the raw Request
 * (signature, timestamp) before it reads the body as JSON or calls a generated Procedure.
 */
export async function appRoutes(_request: Request, _env: Env, _context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  return undefined;
}
