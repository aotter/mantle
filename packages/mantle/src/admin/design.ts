import type { DeveloperConsoleSnapshot } from "./developerConsole.js";

/** A projection of the caller's own draft, not an authenticated Admin or an execution surface. */
export function createAdminDesignSurface(snapshot: DeveloperConsoleSnapshot, options: { name: string; origin: string }) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
    if (url.origin !== options.origin || request.method !== "GET" || !url.pathname.startsWith("/admin/api/")) {
      return reply({ error: { code: "DESIGN_ONLY", message: "This design surface has no runtime. The host must provide a runtime surface to test data operations." } }, 403);
    }
    switch (url.pathname) {
      case "/admin/api/me": return reply({ role: null, login: null, image: null });
      case "/admin/api/site": return reply({ brand: options.name, icons: [], locales: [], canonicalLocale: null, publicUrl: null, capabilities: {} });
      case "/admin/api/developer-console": return reply(snapshot);
      case "/admin/api/webmcp": return reply({ tools: [], routes: {} });
      default: return reply({ error: { code: "DESIGN_ONLY", message: "Business data and operations require a runtime surface." } }, 403);
    }
  };
}
