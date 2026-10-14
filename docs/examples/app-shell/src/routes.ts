import type { Caller } from "@aotter/mantle/contracts";
import { signInPage } from "./sign-in.js";

/**
 * App-owned routes, tried before Admin, MCP and REST. Return undefined to fall through.
 * GET /sign-in: member sign-in (src/sign-in.ts); a member page sends anonymous visitors there with signInRedirect.
 * AGENT: add visitor pages (HTML, SEO, feeds) and callbacks/webhooks here. A callback must verify the raw Request
 * (signature, timestamp) before it reads the body as JSON or calls a generated Procedure.
 */
export async function appRoutes(request: Request, _env: Env, _context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  if (new URL(request.url).pathname === "/sign-in" && request.method === "GET") return signInPage();
  return undefined;
}
