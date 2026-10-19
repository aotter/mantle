import type { Caller } from "@aotter/mantle/contracts";
import { signInPage } from "./sign-in.js";

/**
 * App-owned routes, tried before REST. Return undefined to fall through. Paths under /admin and /mcp never reach here, and
 * neither do Better Auth's (/api/auth/*, /oauth/consent*, /.well-known/oauth-*). A root catch-all page (/:slug) must
 * still return undefined for the paths of the app's own HTTP Triggers (REST), or it shadows them.
 * GET /sign-in: member sign-in (src/sign-in.ts); a member page sends anonymous visitors there with signInRedirect.
 * AGENT: add visitor pages and callbacks/webhooks here. Visitor pages carry everything in `mantle help public-pages`
 * (canonical, Open Graph, JSON-LD, answer block, .md alternates, sitemap.xml, robots.txt, llms.txt; recipes example).
 * A callback must verify the raw Request (signature, timestamp) before it reads the body as JSON or calls a generated Procedure.
 */
export async function appRoutes(request: Request, _env: Env, _context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  if (new URL(request.url).pathname === "/sign-in" && request.method === "GET") return signInPage();
  return undefined;
}
