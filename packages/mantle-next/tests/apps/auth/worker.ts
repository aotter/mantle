/** Fixture: a Worker entry. Public routes never touch auth; others resolve the Caller lazily. */
import { authLoader, resolveCaller } from "../../../src/auth/caller.js";
const auth = authLoader(() => import("./auth.js").then(m => m.auth as never));
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/public") return new Response("public");
    return Response.json(await resolveCaller(request, auth, { audience: "https://app.example/mcp" }));
  },
};
