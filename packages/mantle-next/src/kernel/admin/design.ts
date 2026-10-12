/** A host-owned draft projection; it provides no identity, database or execution surface. */
export interface DesignOptions { name: string; origin: string }
export function createAdminDesignSurface(snapshot: unknown, options: DesignOptions): (request: Request) => Promise<Response> {
  return async request => {
    const url = new URL(request.url);
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
    const refused = (message: string) => reply({ error: { code: "DESIGN_ONLY", message } }, 403);
    if (url.origin !== options.origin || request.method !== "GET" || !url.pathname.startsWith("/admin/api/"))
      return refused("This design surface has no runtime. The host must provide a runtime surface to test data operations.");
    switch (url.pathname) {
      case "/admin/api/me": return reply({ role: null, login: null, image: null });
      case "/admin/api/site": return reply({ brand: options.name, icons: [], locales: [], canonicalLocale: null, publicUrl: null, capabilities: {} });
      case "/admin/api/developer-console": return reply(snapshot);
      case "/admin/api/webmcp": return reply({ tools: [], routes: {} });
      default: return refused("Business data and operations require a runtime surface.");
    }
  };
}
